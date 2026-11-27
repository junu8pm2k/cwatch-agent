import { now, RetrievalSchema, type RetrievalResult } from "@cwatch/core/types";
import { WebFailure } from './web-errors.ts';

type Block = { type: string; text?: string; uri?: string; name?: string; resource?: { uri?: string; text?: string } };
export interface WebResultPayload { data?: unknown; text?: string; blocks?: Block[]; raw: string }
const string = (...values: unknown[]): string | undefined => values.find(v => typeof v === 'string' && v.trim()) as string | undefined;
const fail = (reason: string): never => { throw new WebFailure('parse_failed', 'web_result_' + reason); };
const emptyText = (text: string): boolean => /^(?:no (?:search )?results?(?: found)?|no matches(?: found)?|nothing found|未找到(?:相关)?结果)[.!。\s]*$/i.test(text.trim());
function unwrap(value: any): any {
  for (let i = 0; i < 3 && value && typeof value === 'object' && !Array.isArray(value); i++) {
    if (value.error || value.error_code || value.success === false) throw new WebFailure('unknown', 'web_result_error');
    if (
      value.results !== undefined || value.hits !== undefined || value.items !== undefined ||
      value.searchResults !== undefined || value.web?.results !== undefined ||
      value.organic !== undefined || value.organic_results !== undefined ||
      value.webPages?.value !== undefined || value.webpages !== undefined
    ) break;
    if (value.data !== undefined) value = value.data;
    else if (value.result !== undefined) value = value.result;
    else break;
  }
  return value;
}
function links(text: string): Array<{ url: string; title: string; snippet: string }> {
  const hits: Array<{ url: string; title: string; snippet: string }> = [];
  for (const match of text.matchAll(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g)) hits.push({ title: match[1], url: match[2], snippet: text.slice(match.index! + match[0].length, match.index! + match[0].length + 1000).split(/\n\s*\n/)[0].trim() });
  if (!hits.length) for (const match of text.matchAll(/https:\/\/[^\s<>"\])]+/g)) {
    const before = text.slice(0, match.index), title = /(?:^|\n)(?:Title:\s*)?([^\n]+)\n(?:URL:\s*)?$/i.exec(before)?.[1] ?? new URL(match[0].replace(/[.,;]+$/, '')).hostname;
    hits.push({ url: match[0].replace(/[.,;]+$/, ''), title, snippet: text.slice(match.index!, match.index! + 1000) });
  }
  return hits;
}
/** Common result shapes are decoded as data. Source text never grants tool permissions. */
export function normalizeWebResult(name: string, args: Record<string, unknown>, payload: WebResultPayload, checkUrl: (url: string) => unknown, backend: string): { result: RetrievalResult; returned: number; filteredOutsideScope: number } {
  if (!['web_search', 'web_fetch'].includes(name)) throw new WebFailure('unsupported', 'web_operation_not_supported');
  const data = unwrap(payload.data), text = payload.text ?? '', blocks = payload.blocks ?? [], raw = payload.raw;
  if (name === 'web_search') {
    let candidates: any[];
    if (data !== undefined) {
      const items = Array.isArray(data)
        ? data
        : data?.results ?? data?.hits ?? data?.items ?? data?.searchResults ??
          (Array.isArray(data?.web) ? data.web : data?.web?.results) ??
          data?.organic ?? data?.organic_results ?? data?.webPages?.value ?? data?.webpages;
      if (!Array.isArray(items)) fail('missing_search_results'); candidates = items;
    } else {
      candidates = blocks.flatMap(b => b.type === 'resource_link' ? [{ url: b.uri, title: b.name ?? b.uri, snippet: '' }] : b.type === 'resource' && b.resource?.uri ? [{ url: b.resource.uri, title: b.resource.uri, snippet: b.resource.text ?? '' }] : []);
      candidates.push(...links(text));
      if (!candidates.length && !emptyText(text)) fail('unrecognized_search_text');
    }
    let filteredOutsideScope = 0;
    const accepted = candidates.flatMap(item => {
      const url = string(item?.url, item?.link, item?.uri, item?.href), title = string(item?.title, item?.name, item?.headline) ?? url;
      if (!url || !title) return fail('invalid_search_hit');
      try { checkUrl(url); } catch { filteredOutsideScope++; return []; }
      return [{ url, title, snippet: (string(item.snippet, item.description, item.text, item.content, item.summary, item.markdown) ?? '').slice(0, 2000), published_at: null, retrieved_at: now() }];
    });
    const hits = [...new Map(accepted.map(item => [item.url, item])).values()].slice(0, Number(args.limit));
    return { result: RetrievalSchema.parse({ status: hits.length ? 'success_with_data' : 'success_empty', signals: [], raw, provenance: 'live', backend, searchResults: hits }), returned: candidates.length, filteredOutsideScope };
  }
  let page = data;
  if (page && typeof page === 'object' && Object.hasOwn(page, 'page')) {
    // Structured fetch envelopes (including StepSearch) carry the authorized page here.
    // A failed envelope must not expose an attached stale page as a successful fetch.
    if (page.code !== undefined && page.code !== 0) throw new WebFailure('unknown', 'web_result_error');
    page = page.page;
  }
  if (Array.isArray(page)) { if (page.length !== 1) fail('fetch_requires_one_page'); page = page[0]; }
  if (Array.isArray(page?.results)) { if (page.results.length !== 1) fail('fetch_requires_one_page'); page = page.results[0]; }
  const resource = blocks.find(b => b.type === 'resource' && typeof b.resource?.text === 'string')?.resource;
  const reportedUrl = string(page?.url, page?.uri, page?.metadata?.sourceURL, page?.metadata?.url, resource?.uri);
  if (reportedUrl && reportedUrl !== args.url) fail('fetch_url_mismatch');
  const content = data !== undefined ? string(page?.markdown, page?.raw_content, page?.text, page?.content, page?.html) : string(resource?.text, text);
  if (!content) return fail('missing_page_text');
  const url = String(args.url); checkUrl(url);
  return { result: RetrievalSchema.parse({ status: 'success_with_data', signals: [], raw, provenance: 'live', backend, pages: [{ url, title: string(page?.title, page?.metadata?.title) ?? '', text: content, published_at: null, retrieved_at: now(), truncated: false }] }), returned: 1, filteredOutsideScope: 0 };
}
