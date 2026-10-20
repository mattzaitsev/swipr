/**
 * A connector for Marketplace-style GraphQL search: POST {doc_id, variables} -> feed_units edges + page_info.
 * The local mock speaks this shape, so the whole pipeline is exercised at zero proxy cost, and the real
 * Facebook connector (src/connectors/facebook.ts) is meant to be this same factory pointed at Facebook.
 *
 * The request variables and response field paths are modeled on Facebook's publicly documented 2022 search
 * shape. Treat them as a starting point: verify every path against captured live responses before relying on it.
 */
import { config, type Area } from '../config';
import type { Condition, ListingDraft } from '../domain';
import { placeCentroid } from '../geo/places';
import { SourceChanged, type Verdict } from '../gateway';
import type { Connector, CrawlTask, RawItem, SearchSpec } from './types';

export interface MarketplaceConnectorOptions {
  source: string;
  endpoint: string;                                  // GraphQL endpoint
  docIds: { search: string };                        // persisted query ids; they rotate on real sources
  headers?: Record<string, string>;                 // static per-source protocol headers
  listingUrl: (id: string) => string;                // canonical URL from the id
  cadence: Connector['cadence'];
  maxPages: number;                                  // refresh-mode depth per search
  pageSize: number;
  stopAfterKnown: number;                            // new mode: stop after this many consecutive known listings
}

/** Listing node as it appears in search results (thin: no description, usually no condition or extra photos). */
export interface MarketplaceListing {
  id: string;
  marketplace_listing_title?: string;
  listing_price?: { amount?: string; formatted_amount?: string; currency?: string } | null;
  strikethrough_price?: { amount?: string; formatted_amount?: string } | null;
  is_pending?: boolean;
  is_sold?: boolean;
  is_hidden?: boolean;
  primary_listing_photo?: { image?: { uri?: string } } | null;
  listing_photos?: Array<{ image?: { uri?: string } }>;   // detail responses only
  location?: {
    latitude?: number;
    longitude?: number;
    reverse_geocode?: { city?: string; state?: string; city_page?: { display_name?: string } };
  } | null;
  marketplace_listing_seller?: { __typename?: string; id?: string; name?: string } | null;
  creation_time?: number;                                  // unix seconds
  condition?: string;                                      // detail responses only
}

interface SearchResponse {
  data?: {
    marketplace_search?: {
      feed_units?: {
        edges?: Array<{ node?: { __typename?: string; listing?: MarketplaceListing } }>;
        page_info?: { has_next_page?: boolean; end_cursor?: string | null };
      };
    };
  };
}

/**
 * Marketplace-style GraphQL responses report most failures inside an HTTP 200:
 *  - `{"errors":[{"message":"Rate limit exceeded"}]}`      -> throttled
 *  - an HTML page instead of JSON: login wall / checkpoint  -> blocked, anything else -> changed
 *  - unknown persisted query / missing doc_id                -> changed (the connector needs updating)
 * EXTENSION POINT (Facebook): confirm these signals against captured real responses and add the ones you see.
 */
export function classifyMarketplace(status: number, body: Buffer): Verdict {
  if (status !== 200) return 'ok';                       // 429/403/5xx are handled by status code in the gateway
  const text = body.toString('utf8', 0, 4096).replace(/^for \(;;\);/, '').trimStart();
  if (text.startsWith('<')) return /log ?in|checkpoint/i.test(text) ? 'blocked' : 'changed';
  if (!/"errors"\s*:/.test(text)) return 'ok';
  if (/rate limit/i.test(text)) return 'throttled';
  if (/persisted ?query|doc_?id/i.test(text)) return 'changed';
  return 'ok';                                            // partial errors: the connector decides from the data
}

/** Responses can carry an anti-JSON-hijacking `for (;;);` prefix and several JSON objects, one per line. */
export function parseGraphql<T>(body: Buffer, source: string): T {
  const text = body.toString('utf8').replace(/^for \(;;\);/, '');
  const first = text.split('\n').find((line) => line.trim());
  try {
    return JSON.parse(first ?? '') as T;
  } catch {
    throw new SourceChanged(source, 'response is not JSON');
  }
}

function searchVariables(task: CrawlTask, cursor: string | null, pageSize: number) {
  return {
    count: pageSize,
    ...(cursor ? { cursor } : {}),
    params: {
      bqf: { callsite: 'COMMERCE_MKTPLACE_WWW', query: task.query },
      browse_request_params: {
        filter_location_latitude: task.area.lat,
        filter_location_longitude: task.area.lng,
        filter_radius_km: task.area.radiusKm,
        commerce_search_sort_by: 'CREATION_TIME_DESCEND',   // newest first: what makes the incremental stop work
      },
      custom_request_params: { surface: 'SEARCH' },
    },
  };
}

/** "$1,150" / "150.00" / "Free" -> cents; null when there's no usable price. */
function priceCents(p?: { amount?: string; formatted_amount?: string } | null): number | null {
  if (!p) return null;
  if (p.amount !== undefined && p.amount !== '' && Number.isFinite(Number(p.amount))) return Math.round(Number(p.amount) * 100);
  const text = p.formatted_amount ?? '';
  if (/free/i.test(text)) return 0;
  const n = Number(text.replace(/[^0-9.]/g, ''));
  return /\d/.test(text) && Number.isFinite(n) ? Math.round(n * 100) : null;
}

const CONDITIONS: Record<string, Condition> = {
  new: 'new', used_like_new: 'used', used_good: 'used', used_fair: 'used', used: 'used', refurbished: 'refurbished',
};

export function parseMarketplaceListing(item: RawItem, source: string, listingUrl: (id: string) => string): ListingDraft | null {
  const l = item.payload as MarketplaceListing;
  const id = l?.id === undefined ? '' : String(l.id);
  const title = l?.marketplace_listing_title?.trim();
  const price = priceCents(l?.listing_price);
  if (!id || !title || price === null) return null;

  const rg = l.location?.reverse_geocode;
  const city = rg?.city ?? rg?.city_page?.display_name?.split(',')[0];
  const area: Area = item.context.area;
  // Best available position: the source's (fuzzed) coordinates, else the city's centroid, else the search area's centre.
  const centroid = placeCentroid(city, rg?.state);
  const location = typeof l.location?.latitude === 'number' && typeof l.location?.longitude === 'number'
    ? { lat: l.location.latitude, lng: l.location.longitude, precision: 'approximate' as const, city, region: rg?.state, country: area.country }
    : centroid
      ? { ...centroid, precision: 'city' as const, city, region: rg?.state, country: area.country }
      : { lat: area.lat, lng: area.lng, precision: 'area' as const, city: city ?? area.city, region: rg?.state ?? area.region, country: area.country };

  const seller = l.marketplace_listing_seller;
  const images = [l.primary_listing_photo?.image?.uri, ...(l.listing_photos ?? []).map((p) => p.image?.uri)]
    .filter((u): u is string => !!u);

  return {
    source,
    externalId: id,
    url: listingUrl(id),
    title,
    priceCents: price,
    originalPriceCents: priceCents(l.strikethrough_price) ?? undefined,
    currency: l.listing_price?.currency ?? 'USD',
    condition: (l.condition && CONDITIONS[l.condition]) || 'unknown',
    status: l.is_sold ? 'sold' : l.is_pending ? 'pending' : l.is_hidden ? 'removed' : 'active',
    location,
    postedAt: l.creation_time ? new Date(l.creation_time * 1000) : undefined,
    // Display info only. Sellers without an id can't be tracked across listings, so they're left off.
    seller: seller?.id ? { externalId: String(seller.id), displayName: seller.name, kind: seller.__typename === 'User' ? 'individual' : 'business' } : undefined,
    imageUrls: [...new Set(images)],
  };
}

export function createMarketplaceConnector(opts: MarketplaceConnectorOptions): Connector {
  const { source } = opts;
  return {
    source,
    cadence: opts.cadence,

    searches(): SearchSpec[] {
      return config.search.queries.flatMap((query) => config.search.areas.map((area) => ({ source, query, area, maxPages: opts.maxPages })));
    },

    async *crawl(task, ctx) {
      // One flow for the whole search: every page shares a session (one exit IP when proxied), like one person scrolling.
      const search = ctx.openFlow('search');
      let cursor: string | null = null;
      let knownStreak = 0;
      for (let page = 0; page < task.maxPages; page++) {
        const res = await search.fetch({
          url: opts.endpoint,
          method: 'POST',
          body: new URLSearchParams({ doc_id: opts.docIds.search, variables: JSON.stringify(searchVariables(task, cursor, opts.pageSize)) }).toString(),
        });
        const feed = parseGraphql<SearchResponse>(res.body, source).data?.marketplace_search?.feed_units;
        if (!feed || !Array.isArray(feed.edges)) throw new SourceChanged(source, 'missing data.marketplace_search.feed_units');

        // Feeds mix in non-listing units (ads, separators); keep listing stories only.
        const listings = feed.edges
          .map((e) => e.node)
          .filter((n) => n?.__typename === 'MarketplaceFeedListingStoryObject' && n.listing?.id)
          .map((n) => n!.listing!);
        const known = await ctx.known(listings.map((l) => String(l.id)));

        for (const listing of listings) {
          const id = String(listing.id);
          knownStreak = known.has(id) ? knownStreak + 1 : 0;
          yield { externalId: id, payload: listing, context: { query: task.query, area: task.area } };
        }
        // EXTENSION POINT (detail fetches): for new listings, fetch details in a flow that shares this search's session:
        //   const detail = ctx.openFlow('detail');            // same sessionKey by default
        //   await detail.fetch({ url: opts.endpoint, method: 'POST', body: ...detail doc_id + { targetId: id } });
        if (task.mode === 'new' && knownStreak >= opts.stopAfterKnown) return;   // caught up: the rest is already stored
        if (!feed.page_info?.has_next_page || !feed.page_info.end_cursor) return;
        cursor = feed.page_info.end_cursor;
      }
    },

    parse: (item) => parseMarketplaceListing(item, source, opts.listingUrl),

    // Source-specific request headers live here (per flow kind if needed).
    requestHeaders: (req) => ({
      ...(req.method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      accept: '*/*',
      ...opts.headers,
    }),

    // Source-specific response signals live here; the gateway turns verdicts into cooldowns/pauses/alerts.
    classifyResponse: (status, body) => classifyMarketplace(status, body),
  };
}
