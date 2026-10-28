import { WebFailure } from './web-errors.ts';
import { normalizeWebResult } from './web-results.ts';

type Block = { type: string; text?: string; uri?: string; name?: string; resource?: { uri?: string; text?: string } };
type Envelope = { content?: unknown; structuredContent?: unknown; [key: string]: unknown };
const fail = (reason: string): never => { throw new WebFailure('parse_failed', 'search_mcp_' + reason); };
function decode(result: Envelope): { data: any; text: string; blocks: Block[] } {
  const blocks = Array.isArray(result.content) ? result.content as Block[] : [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
  if (result.structuredContent !== undefined) return { data: result.structuredContent, text, blocks };
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  try { return { data: JSON.parse(trimmed), text, blocks }; }
  catch (error) { if (error instanceof WebFailure) throw error; if (/^(?:\{|\[\s*(?:[\[{"\]\d]|true|false|null))/.test(trimmed)) fail('invalid_json_result'); }
  return { data: undefined, text, blocks };
}

/** MCP wire decoding is separate from shared web result normalization. */
export function normalizeMcpResult(name: string, args: Record<string, unknown>, result: Envelope, checkUrl: (url: string) => unknown) {
  const payload = decode(result);
  return normalizeWebResult(name, args, { ...payload, raw: JSON.stringify(result) }, checkUrl, 'mcp.remote');
}
