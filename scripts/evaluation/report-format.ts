import { z } from 'zod';

export const REPORT_COLUMNS = ['事件ID', '产品', '版本', '发布时间', '结论', '来源'] as const;
export const ReportContractSchema = z.object({ kind: z.literal('markdown_report'), sections: z.array(z.string().trim().min(1).max(60).regex(/^[^#\r\n|]+$/)).min(4).max(12),
  factsSection: z.string().min(1),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.sections).size !== v.sections.length || !v.sections.includes(v.factsSection)) ctx.addIssue({ code: 'custom', message: 'report sections must be unique and contain factsSection' });
});
export type ReportContract = z.infer<typeof ReportContractSchema>;
export function reportContractInstruction(contract: ReportContract): string {
  return `最终交付完整 Markdown 报告，按顺序使用这些二级标题：${contract.sections.map(s => '## ' + s).join('；')}。每节须有非空正文。`
    + `在“${contract.factsSection}”节提供唯一事实表，列名与顺序固定为：${REPORT_COLUMNS.join(' | ')}。`
    + '事件ID、产品、版本、发布时间保留材料原值；缺失值填 -。结论简明且有依据。来源列仅使用 Markdown HTTP(S) 链接，多来源用分号分隔；每行至少一个来源。'
    + '按事件ID字典序排列；没有可确认事实时保留表头和分隔行但不编造事实行。冲突未解决时版本填 - 并保留双方来源。'
    + '表外正文说明范围、依据、未知和来源失败，不能将单页或空结果说成全面覆盖。不得使用包裹整份报告的代码围栏。宿主会将最终答复保存为本地 Markdown 产物。';
}
const splitRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(s => s.trim());
export function inspectMarkdownReport(text: string, contract: ReportContract) {
  const source = text.replaceAll('\r\n', '\n');
  let fence:{char:string;length:number}|null = null;
  const lines = source.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) {
        if (marker[1][0] === '`' && marker[2].includes('`')) return line;
        fence = {char:marker[1][0],length:marker[1].length};
      } else if (fence.char === marker[1][0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return '';
    }
    return fence ? '' : line;
  });
  const headings = lines.flatMap((line, index) => /^##\s+(.+?)\s*$/.test(line) ? [{ title: /^##\s+(.+?)\s*$/.exec(line)![1], index }] : []);
  const positions = contract.sections.map(title => headings.findIndex(h => h.title === title));
  const sectionsValid = positions.every((n, i) => n >= 0 && (i === 0 || n > positions[i - 1]))
    && contract.sections.every(title => headings.filter(h => h.title === title).length === 1)
    && contract.sections.every(title => { const i = headings.findIndex(h => h.title === title); return i >= 0 && lines.slice(headings[i].index + 1, headings[i + 1]?.index).some(line => line.trim()); });
  const factIndex = headings.findIndex(h => h.title === contract.factsSection);
  const block = factIndex < 0 ? [] : lines.slice(headings[factIndex].index + 1, headings[factIndex + 1]?.index);
  const tableLines = block.filter(line => line.trim().startsWith('|'));
  let tableValid = tableLines.length >= 2 && JSON.stringify(splitRow(tableLines[0])) === JSON.stringify(REPORT_COLUMNS)
    && splitRow(tableLines[1]).length === 6 && splitRow(tableLines[1]).every(cell => /^:?-{3,}:?$/.test(cell));
  const rows: Array<{ eventId: string; product: string; version: string | null; publishedAt: string | null; sourceUrls: string[] }> = [];
  for (const line of tableLines.slice(2)) {
    const cells = splitRow(line); if (cells.length !== 6 || cells.some(cell => !cell)) { tableValid = false; continue; }
    const [eventId, product, version, publishedAt, claim, sources] = cells;
    const links = [...sources.matchAll(/\[[^\]\r\n]+\]\((https?:\/\/[^\s()]+)\)/g)];
    const remainder = sources.replace(/\[[^\]\r\n]+\]\(https?:\/\/[^\s()]+\)/g, '').replace(/[;；\s]/g, '');
    const sourceUrls = links.map(link => link[1]);
    if (!sourceUrls.length || remainder || !claim || (publishedAt !== '-' && !z.string().datetime({ offset: true }).safeParse(publishedAt).success)) tableValid = false;
    rows.push({ eventId, product, version: version === '-' ? null : version, publishedAt: publishedAt === '-' ? null : publishedAt, sourceUrls: [...new Set(sourceUrls)].sort() });
  }
  if (new Set(rows.map(row => row.eventId)).size !== rows.length || rows.some((row, i) => i > 0 && row.eventId.localeCompare(rows[i - 1].eventId) < 0)) tableValid = false;
  return { formatValid: sectionsValid && tableValid && fence === null, sectionsValid, tableValid, rows, rowCount: rows.length };
}
