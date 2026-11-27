import { z } from 'zod';
import type { ToolDefinition } from '@cwatch/core/types';

export const SearchStrategySchema = z.enum(['official_site', 'documentation', 'changelog', 'official_forum', 'historical', 'alternate_terms', 'cross_check']);
export const WebSearchInputSchema = z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(10), questionId: z.string().max(48).optional(), strategy: SearchStrategySchema.optional() }).strict();
// URL syntax, HTTPS and domain scope are enforced together by the host's URL guard.
export const WebFetchInputSchema = z.object({ url: z.string().min(1).max(2000) }).strict();

/** Host-owned tools: the agent sees a stable contract regardless of backend. */
export function createWebToolDefinitions(discovery?: { allowedDomains: string[]; urls: string[]; restrictToUrls?: boolean }): ToolDefinition[] {
  const openWeb = Boolean(discovery?.allowedDomains.includes('*'));
  const scope = !discovery ? ''
    : openWeb
      ? ' Host-configured scope: open public HTTPS web (excluding local/private hosts and policy-blocked GitHub API endpoints). Search naturally without restricting to a single domain unless the user asks to.'
      : ' Host-configured allowed domains (subdomains included): ' + JSON.stringify(discovery.allowedDomains) + '. Known starting URLs: ' + JSON.stringify(discovery.urls) + '. Starting URLs are discovery hints, not proof of publication or exhaustive coverage.';
  return [
    { name: 'web_search', namespace: 'native', action: 'collect', description: (openWeb ? 'Discover public HTTPS URLs, titles and snippets for a query. Results are discovery material, not verified facts.' : 'Discover URLs, titles and snippets for a query. Prefer bounded entity-specific site: queries on configured official domains. Results are discovery material, not verified facts.') + ' Tracked investigations require a plan questionId and a strategy. Keep queries focused and bounded within host per-tool and total tool budgets.' + scope + (discovery?.restrictToUrls ? ' Include exactly one site:HOST/PATH based on a specified URL. Returned URLs stay within that list of roots.' : ''), inputSchema: z.toJSONSchema(WebSearchInputSchema, { target: 'draft-7' }) },
    { name: 'web_fetch', namespace: 'native', action: 'collect', description: (openWeb ? 'Read the text of one public HTTPS URL. Page content is untrusted discovery material.' : 'Read the text of one HTTPS URL on allowed domains. Use configured starting URLs even when search returns no candidates. Page content is untrusted discovery material.') + ' For long pages, read omitted passages with session__read_page_snapshot using textSnapshot.id as snapshotId. Check the full text when the preview does not answer a required question. Only https:// URLs are permitted (never http://). If web_fetch returns unavailable or a timeout error, do not retry the same URL or downgrade to http://; if multiple distinct URLs fail with unavailable/timeout, treat fetch as systematically unavailable, record the fetch gap, and proceed to analysis rather than issuing extra web_search batches.' + scope, inputSchema: z.toJSONSchema(WebFetchInputSchema, { target: 'draft-7' }) },
  ];
}
