import type { RetrievalResult } from '@cwatch/core/types';
import { allowedUrl } from '../sources/web.ts';

export interface DiscoveryQuery { query: string; limit: number; result: RetrievalResult; returned?: number; filteredOutsideScope?: number }
export interface DiscoveryFetch { url: string; result: RetrievalResult }
export function discoveryUrl(value: string, domains: string[]): string {
  const url = allowedUrl(value, domains); url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (url.hostname === 'github.com') { const parts = url.pathname.split('/'); if (parts.length >= 3) { parts[1] = parts[1].toLowerCase(); parts[2] = parts[2].toLowerCase(); url.pathname = parts.join('/'); } }
  return url.toString(); // Only GitHub owner/repo are case-insensitive; other paths, tags and queries remain distinct.
}

/** Fixed reference-entry coverage, never an estimate of full-site or publication recall. */
export function summarizeDiscovery(referenceUrls: string[], domains: string[], queries: DiscoveryQuery[], fetches: DiscoveryFetch[]) {
  const reference = [...new Set(referenceUrls.map(url => discoveryUrl(url, domains)))];
  if (!reference.length) throw new Error('discovery_reference_required');
  const candidates = new Set<string>();
  let rejectedOutsideScope = 0;
  for (const query of queries) for (const hit of query.result.searchResults ?? []) {
    try { candidates.add(discoveryUrl(hit.url, domains)); } catch { rejectedOutsideScope++; }
  }
  const readable = new Set<string>();
  for (const fetch of fetches) {
    if (fetch.result.status !== 'success_with_data') continue;
    let expected: string; try { expected = discoveryUrl(fetch.url, domains); } catch { continue; }
    const page = fetch.result.pages?.find(page => { try { return discoveryUrl(page.url, domains) === expected && page.text.trim().length > 0; } catch { return false; } });
    if (page) readable.add(expected);
  }
  const searchMatched = reference.filter(url => candidates.has(url));
  const textAvailable = reference.filter(url => readable.has(url));
  const unionMatched = reference.filter(url => candidates.has(url) || readable.has(url));
  return {
    scope: 'fixed reference URL entries only; not full-site or event recall', referenceUrls: reference, referenceCount: reference.length,
    queries: queries.map(query => ({ query: query.query, limit: query.limit, status: query.result.status, returned: query.returned ?? null,
      filteredOutsideScope: query.filteredOutsideScope ?? null, accepted: query.result.searchResults?.length ?? 0 })),
    queryCount: queries.length, uniqueWhitelistCandidates: candidates.size, candidateUrls: [...candidates], rejectedOutsideScope,
    upstreamReturned: queries.every(query => query.returned !== undefined) ? queries.reduce((sum, query) => sum + query.returned!, 0) : null,
    upstreamFilteredOutsideScope: queries.every(query => query.filteredOutsideScope !== undefined) ? queries.reduce((sum, query) => sum + query.filteredOutsideScope!, 0) : null,
    searchReferenceCoverage: { count: searchMatched.length, total: reference.length, matchedUrls: searchMatched },
    referenceTextAvailability: { count: textAvailable.length, total: reference.length, matchedUrls: textAvailable },
    combinedReferenceReach: { count: unionMatched.length, total: reference.length, matchedUrls: unionMatched },
    missingReferenceText: reference.filter(url => !readable.has(url)),
    unreviewedNonReferenceCandidates: [...candidates].filter(url => !reference.includes(url)),
    // Only actual signals are counted; URL/snippet/page counts never become facts.
    structuredSignalsFromWebResults: [...queries.map(query => query.result), ...fetches.map(fetch => fetch.result)].reduce((sum, result) => sum + result.signals.length, 0),
  };
}
