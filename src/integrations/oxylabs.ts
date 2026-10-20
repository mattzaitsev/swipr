/**
 * Oxylabs Web API: live web search (POST /v1/search), server-side only.
 * The key comes from OXYLABS_WEB_API_KEY and never reaches the browser; the UI calls our /web-search route.
 * Results are cached in memory for a few minutes because every upstream call spends credits.
 */
const BASE_URL = 'https://webapi.oxylabs.io';
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;

export interface WebSearchInput {
  query: string;                     // 1-2048 chars, keyword-shaped works best
  maxResults: number;                // 1-20
  location?: string;                 // ISO 3166-1 alpha-2, e.g. "US"
}

/** One organic result, plus what swipr derives from it. */
export interface WebResult {
  position: number;
  title: string;
  url: string;
  domain: string;
  outline: string[];                 // snippet strings from the search engine (truncated, not page content)
  marketplace: string | null;        // e.g. "Facebook Marketplace" when the URL is a known listings site
  prices: string[];                  // "$1,150"-style amounts spotted in the snippets
}

export interface WebSearchResult {
  query: string;
  location: string | null;
  results: WebResult[];
  ms: number;
  cached: boolean;
}

interface RawResponse {
  state?: string;
  results?: Array<{ title?: string; url?: string; outline?: string[] | string; metadata?: { position?: number } }>;
}

const MARKETPLACES: Array<[RegExp, string]> = [
  [/(^|\.)facebook\.com$/, 'Facebook Marketplace'],
  [/(^|\.)craigslist\.org$/, 'Craigslist'],
  [/(^|\.)offerup\.com$/, 'OfferUp'],
  [/(^|\.)ebay\.[a-z.]+$/, 'eBay'],
  [/(^|\.)mercari\.com$/, 'Mercari'],
  [/(^|\.)nextdoor\.com$/, 'Nextdoor'],
  [/(^|\.)kijiji\.ca$/, 'Kijiji'],
  [/(^|\.)gumtree\.[a-z.]+$/, 'Gumtree'],
  [/(^|\.)poshmark\.com$/, 'Poshmark'],
  [/(^|\.)depop\.com$/, 'Depop'],
];

export class WebSearchError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'WebSearchError';
  }
}

const cache = new Map<string, { at: number; value: Omit<WebSearchResult, 'cached'> }>();

export const webSearchConfigured = () => !!process.env.OXYLABS_WEB_API_KEY;

export async function webSearch(input: WebSearchInput): Promise<WebSearchResult> {
  const key = process.env.OXYLABS_WEB_API_KEY;
  if (!key) throw new WebSearchError('Web search is not configured: set OXYLABS_WEB_API_KEY for the API process.', 503);

  const location = input.location?.toUpperCase() || null;
  const cacheKey = JSON.stringify([input.query.trim().toLowerCase(), input.maxResults, location]);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };

  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: input.query.trim(), max_results: input.maxResults, ...(location ? { location } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new WebSearchError(`Could not reach Oxylabs: ${(err as Error).message}`, 502);
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new WebSearchError('Oxylabs rejected the API key (401/403). Check or rotate OXYLABS_WEB_API_KEY.', 502);
    if (res.status === 429) throw new WebSearchError('Oxylabs rate limit or credit limit reached (429). Try again later.', 429);
    throw new WebSearchError(`Oxylabs returned HTTP ${res.status}: ${detail}`, 502);
  }

  const raw = (await res.json()) as RawResponse;
  const results = (raw.results ?? []).map((r, i) => toWebResult(r, i)).filter((r): r is WebResult => r !== null);
  const value = { query: input.query.trim(), location, results, ms: Math.round(performance.now() - started) };

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, { at: Date.now(), value });
  return { ...value, cached: false };
}

function toWebResult(r: NonNullable<RawResponse['results']>[number], index: number): WebResult | null {
  if (!r.url || !r.title) return null;
  let domain = '';
  try {
    domain = new URL(r.url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  const outline = (Array.isArray(r.outline) ? r.outline : r.outline ? [r.outline] : []).map((s) => s.trim()).filter(Boolean);
  const prices = [...new Set(outline.join(' ').match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) ?? [])].map((p) => p.replace(/\s/g, '')).slice(0, 8);
  return {
    position: r.metadata?.position ?? index + 1,
    title: r.title.trim(),
    url: r.url,
    domain,
    outline,
    marketplace: MARKETPLACES.find(([re]) => re.test(domain))?.[1] ?? null,
    prices,
  };
}
