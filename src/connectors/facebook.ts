/**
 * Facebook Marketplace, logged out: page 1 of a newest-first search, read from the data Facebook embeds in the page.
 *
 * Verified 2026-10-19 against a real logged-out San Diego search (plain HTTP client, no browser headers):
 *  - GET /marketplace/sandiego/search/?query=couch&sortBy=creation_time_descend returned 24 listings embedded as
 *    JSON under marketplace_search.feed_units.edges[].node.listing: the same fields parseMarketplaceListing() reads
 *    (id, marketplace_listing_title, listing_price.amount, strikethrough_price, creation_time, is_sold/is_pending,
 *    location.reverse_geocode.city/state, primary_listing_photo with an expiring `oe=` URL). No coordinates.
 *  - Listings were minutes old ("Listed 18 minutes ago"); scrolling past page 1 needs a login.
 * So this connector never paginates: watches are narrow enough that page 1 holds everything new.
 *
 * Live run, 2026-10-19:
 *  - the headers below return the embedded results, and Facebook applies minPrice/maxPrice;
 *  - cookie-less requests are treated as a crawler and get a search snapshot 1-2 hours behind what a browser sees
 *    (responses are no-store, so it's deliberate, not a cache). This connector stays on that path: getting live
 *    results would mean passing as a browser, which this project doesn't do. Set watch maxAgeMin to at least 120.
 */
import { config } from '../config';
import { SourceChanged, type Verdict } from '../gateway';
import { loadWatches } from '../watches';
import { parseMarketplaceListing, type MarketplaceListing } from './marketplace';
import type { Connector, SearchSpec } from './types';

const SOURCE = 'facebook';
const SCRIPT_JSON = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;

export function facebookSearchUrl(base: string, location: string, query: string, minPrice?: number, maxPrice?: number): string {
  const u = new URL(`/marketplace/${encodeURIComponent(location)}/search/`, base);
  u.searchParams.set('query', query);
  u.searchParams.set('sortBy', 'creation_time_descend');   // newest first: the whole point
  u.searchParams.set('exact', 'false');
  if (minPrice !== undefined) u.searchParams.set('minPrice', String(Math.floor(minPrice)));
  if (maxPrice !== undefined) u.searchParams.set('maxPrice', String(Math.ceil(maxPrice)));
  return u.toString();
}

/** Listings embedded in a logged-out search page, or null when the page carries no search results. */
export function extractFacebookListings(html: string): MarketplaceListing[] | null {
  let found: MarketplaceListing[] | null = null;
  const visit = (o: unknown): void => {
    if (found || !o || typeof o !== 'object') return;
    const feed = (o as { marketplace_search?: { feed_units?: { edges?: unknown } } }).marketplace_search?.feed_units;
    if (feed && Array.isArray(feed.edges)) {
      found = (feed.edges as Array<{ node?: { __typename?: string; listing?: MarketplaceListing } }>)
        .filter((e) => e.node?.__typename === 'MarketplaceFeedListingStoryObject' && e.node.listing?.id)
        .map((e) => e.node!.listing!);
      return;
    }
    for (const v of Object.values(o)) visit(v);
  };
  for (const [, json] of html.matchAll(SCRIPT_JSON)) {
    if (!json.includes('marketplace_search')) continue;     // skip the ~45 unrelated blocks without parsing them
    try {
      visit(JSON.parse(json));
    } catch {
      // not JSON after all; keep looking
    }
    if (found) break;
  }
  return found;
}

/**
 * Logged-out pages always contain a login form, so its presence alone means nothing. What matters is whether the
 * search results are embedded: no results + a login form = login wall (blocked); no results otherwise = the page
 * changed shape (connector needs updating).
 */
export function classifyFacebook(status: number, body: Buffer): Verdict {
  if (status !== 200) return 'ok';                          // 429/403/5xx are handled by status code in the gateway
  const html = body.toString('utf8');
  if (html.includes('"marketplace_search"')) return 'ok';
  if (/id="login_form"|\/login\/\?next=|log in to continue/i.test(html)) return 'blocked';
  return 'changed';
}

export function createFacebookConnector(): Connector {
  const file = loadWatches();
  const area = file?.area;

  return {
    source: SOURCE,
    cadence: { newEveryMs: 120_000, refreshEveryMs: 0 },     // no refresh runs: page 2+ needs a login

    searches(): SearchSpec[] {
      if (!file || !area) return [];
      return file.watches
        .filter((w) => w.sources.includes(SOURCE))
        .map((w) => ({
          source: SOURCE,
          query: w.query,
          maxPages: 1,
          watch: w,
          everyMs: w.everySec * 1000,
          area: { label: w.id, lat: area.lat, lng: area.lng, radiusKm: area.radiusMi * 1.609344, country: area.country, region: area.region, city: area.city },
        }));
    },

    async *crawl(task, ctx) {
      if (!area) return;
      const page = ctx.openFlow('search');
      const res = await page.fetch({
        url: facebookSearchUrl(config.facebook.baseUrl, area.facebookLocation, task.query, task.watch?.minPrice, task.watch?.maxPrice),
      });
      const listings = extractFacebookListings(res.body.toString('utf8'));
      if (!listings) throw new SourceChanged(SOURCE, 'no marketplace_search results embedded in the search page');

      // Freshness check: how old is the newest listing on page 1, and what do the cache headers say?
      // A page whose newest listing keeps aging while new posts exist on Facebook is a stale (cached) copy.
      const newest = Math.max(0, ...listings.map((l) => l.creation_time ?? 0));
      const h = (k: string) => [res.headers[k]].flat()[0] ?? '-';
      ctx.log(`${task.query}: page 1 newest ${newest ? Math.round((Date.now() / 1000 - newest) / 60) + ' min old' : 'unknown'}` +
        ` · age=${h('age')} cache-control=${h('cache-control')} expires=${h('expires')}`);
      for (const listing of listings) {
        yield { externalId: String(listing.id), payload: listing, context: { query: task.query, area: task.area } };
      }
    },

    parse: (item) => parseMarketplaceListing(item, SOURCE, (id) => `${config.facebook.baseUrl}/marketplace/item/${id}/`),

    // Mirrors the verified request: ask for HTML, no compression. Static per source; no identity headers.
    // no-cache: standard HTTP "revalidate, don't hand me a stored copy". Without it, cookie-less requests got a
    // cached search page that stayed ~40 min behind what a browser saw.
    requestHeaders: () => ({
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'identity',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    }),

    classifyResponse: (status, body) => classifyFacebook(status, body),
  };
}
