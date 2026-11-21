import { escapeHtml, safeUrl } from './state.ts';

function renderInline(raw: string): string {
  const codeTokens: string[] = [];
  const withCodePlaceholders = raw.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const token = `\u0000CODE${codeTokens.length}\u0000`;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  const linkTokens: string[] = [];
  const withLinkPlaceholders = withCodePlaceholders.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    const safe = safeUrl(href);
    const token = `\u0000LINK${linkTokens.length}\u0000`;
    if (safe) {
      linkTokens.push(`<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${formatEmphasis(escapeHtml(label))}</a>`);
    } else {
      linkTokens.push(escapeHtml(label));
    }
    return token;
  });

  let html = formatEmphasis(escapeHtml(withLinkPlaceholders));
  html = html.replace(/\u0000LINK(\d+)\u0000/g, (_m, idx: string) => linkTokens[Number(idx)] ?? '');
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => codeTokens[Number(idx)] ?? '');
  return html;
}

function formatEmphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>');
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

/**
 * XSS-safe Markdown renderer (zero raw HTML passthrough, strict URL protocol allowlist).
 * Supports fenced code blocks, headings, tables, lists, blockquotes, horizontal rules, and inline formatting.
 */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block
    const fence = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(line.trim());
    if (fence) {
      const lang = fence[1] || 'text';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push(
        `<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">${escapeHtml(lang)}</span><button type="button" class="md-copy-btn" data-copy-code>复制代码</button></div><pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre></div>`,
      );
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Heading (h1 - h4)
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(4, Math.max(1, heading[1].length));
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${quoteLines.map(q => q.trim() ? `<p>${renderInline(q)}</p>` : '').join('')}</blockquote>`);
      continue;
    }

    // GFM Table
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headers.map(h => `<th>${renderInline(h)}</th>`).join('')}</tr></thead>`;
      const tbody = rows.length
        ? `<tbody>${rows.map(row => `<tr>${headers.map((_h, idx) => `<td>${renderInline(row[idx] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`
        : '';
      out.push(`<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push(`<ul>${items.map(item => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol>${items.map(item => `<li>${renderInline(item)}</li>`).join('')}</ol>`);
      continue;
    }

    // Paragraph (collect consecutive plain lines)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i].trim()) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      out.push(`<p>${paraLines.map(renderInline).join('<br>')}</p>`);
    }
  }

  return out.join('');
}
