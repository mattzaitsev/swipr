/**
 * A fake marketplace that speaks the same wire shape as the Marketplace connector expects, so the whole pipeline
 * runs locally at zero proxy cost. It reproduces the realities a Facebook Marketplace connector must handle:
 *  - POST /api/graphql/ with form fields doc_id + variables; unknown doc_id -> 200 with "PersistedQueryNotFound"
 *  - location-scoped search (lat/lng/radius), newest first, opaque end_cursor pagination
 *  - 16-digit numeric-string listing ids (above 2^53), non-listing units (ads) mixed into the feed
 *  - approximate coordinates (2 decimals), and some listings with only a city
 *  - signed image URLs with an `oe=` hex expiry; expired URLs return 403
 *  - price drops with a struck-through "was" price, pending/sold flags, seller display names only
 *  - rate limiting reported inside an HTTP 200 (MOCK_FAIL_RATE), with a `for (;;);` prefix
 * Listings change over time: new ones every MOCK_TICK_MS, some prices drop, some go pending or sold.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { config } from '../config';
import type { MarketplaceListing } from '../connectors/marketplace';
import { isMain, logger, runMain } from '../runtime';

const log = logger('mock');
const PUBLIC = config.mock.publicUrl;
const ACCEPTED_DOC_ID = process.env.MOCK_ACCEPT_DOC_ID || 'mock-search-v1';   // change it to simulate a rotation

const CITIES = [
  { city: 'Austin', region: 'TX', lat: 30.2672, lng: -97.7431 },
  { city: 'Phoenix', region: 'AZ', lat: 33.4484, lng: -112.074 },
  { city: 'Seattle', region: 'WA', lat: 47.6062, lng: -122.3321 },
];
const CATALOG: Array<[string, number]> = [
  ['Sectional couch', 450], ['Leather couch', 380], ['Mid-century sofa couch', 520], ['IKEA Kallax shelf', 60],
  ['Standing desk', 220], ['Solid oak desk', 180], ['Ergonomic office chair', 140], ['Corner desk with drawers', 95],
  ['Trek mountain bike', 650], ['Road bike 56cm', 480], ['Kids bike 20 inch', 70], ['Electric bike', 1100],
  ['Fixie bike', 210], ['PS5 with two controllers', 420], ['55 inch 4K TV', 300], ['Nintendo Switch OLED', 260],
];

interface Item {
  id: string;
  title: string;
  priceCents: number;
  wasCents?: number;
  status: 'available' | 'pending' | 'sold';
  soldAt?: number;
  lat: number;
  lng: number;
  hasCoords: boolean;
  city: string;
  region: string;
  created: number;                   // unix seconds
  seller: { id: string; name: string; business: boolean } | null;
}

// Deterministic PRNG: the seeded catalogue (ids included) is identical across restarts, so nothing duplicates.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seeded = mulberry32(42);

function makeItem(rand: () => number, created: number): Item {
  const place = CITIES[Math.floor(rand() * CITIES.length)];
  const [title, base] = CATALOG[Math.floor(rand() * CATALOG.length)];
  const free = rand() < 0.03;
  const sellerN = 1 + Math.floor(rand() * 400);
  return {
    id: `${1 + Math.floor(rand() * 8)}${String(Math.floor(rand() * 1e15)).padStart(15, '0')}`,   // 16 digits, > 2^53
    title,
    priceCents: free ? 0 : Math.max(5, Math.round((base * (0.6 + rand() * 0.7)) / 5) * 5) * 100,
    status: 'available',
    lat: place.lat + (rand() - 0.5) * 0.5,
    lng: place.lng + (rand() - 0.5) * 0.5,
    hasCoords: rand() < 0.8,
    city: place.city,
    region: place.region,
    created,
    seller: rand() < 0.85 ? { id: String(100000 + sellerN), name: `Seller ${sellerN}`, business: rand() < 0.1 } : null,
  };
}

const items: Item[] = [];
const nowSec = () => Math.floor(Date.now() / 1000);
for (let i = 0; i < 150; i++) items.push(makeItem(seeded, nowSec() - Math.floor(seeded() * 3 * 86_400)));

/** Every tick: new listings appear, a few prices drop (with a "was" price), an item may go pending or sold. */
function tick() {
  for (let i = 0, n = 1 + Math.floor(Math.random() * 3); i < n; i++) items.push(makeItem(Math.random, nowSec()));
  const available = items.filter((it) => it.status === 'available');
  for (let i = 0; i < 2; i++) {
    const it = available[Math.floor(Math.random() * available.length)];
    if (!it || it.priceCents === 0) continue;
    it.wasCents ??= it.priceCents;
    it.priceCents = Math.max(500, Math.round((it.priceCents * 0.9) / 500) * 500);
  }
  if (Math.random() < 0.5) {
    const it = available[Math.floor(Math.random() * available.length)];
    if (it) Object.assign(it, Math.random() < 0.5 ? { status: 'pending' } : { status: 'sold', soldAt: Date.now() });
  }
}

const money = (cents: number) => (cents === 0 ? 'Free' : `$${(cents / 100).toLocaleString('en-US')}`);

/** A signed, expiring image URL, in the style of a Marketplace CDN URL. */
function imageUrl(id: string): string {
  const oe = Math.floor(Date.now() / 1000 + config.mock.imageTtlMin * 60).toString(16).toUpperCase();
  const oh = createHash('md5').update(id + oe).digest('hex').slice(0, 16);
  return `${PUBLIC}/v/t45.5328-4/${id}_n.svg?_nc_cat=1&oh=00_${oh}&oe=${oe}`;
}

function toListing(it: Item): MarketplaceListing {
  return {
    id: it.id,
    marketplace_listing_title: it.title,
    listing_price: { amount: (it.priceCents / 100).toFixed(2), formatted_amount: money(it.priceCents), currency: 'USD' },
    strikethrough_price: it.wasCents ? { amount: (it.wasCents / 100).toFixed(2), formatted_amount: money(it.wasCents) } : null,
    is_pending: it.status === 'pending',
    is_sold: it.status === 'sold',
    is_hidden: false,
    primary_listing_photo: { image: { uri: imageUrl(it.id) } },
    location: {
      ...(it.hasCoords ? { latitude: Math.round(it.lat * 100) / 100, longitude: Math.round(it.lng * 100) / 100 } : {}),
      reverse_geocode: { city: it.city, state: it.region, city_page: { display_name: `${it.city}, ${it.region}` } },
    },
    marketplace_listing_seller: it.seller ? { __typename: it.seller.business ? 'Page' : 'User', id: it.seller.id, name: it.seller.name } : null,
    creation_time: it.created,
  };
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

interface SearchVariables {
  count?: number;
  cursor?: string;
  params?: {
    bqf?: { query?: string };
    browse_request_params?: { filter_location_latitude?: number; filter_location_longitude?: number; filter_radius_km?: number };
  };
}

function search(v: SearchVariables) {
  const terms = (v.params?.bqf?.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const geo = v.params?.browse_request_params ?? {};
  const count = Math.min(Math.max(v.count ?? 24, 1), 50);
  const offset = v.cursor ? Number(JSON.parse(Buffer.from(v.cursor, 'base64url').toString()).o) || 0 : 0;
  const soldCutoff = Date.now() - 10 * 60_000;                 // sold listings linger ~10 minutes, then vanish

  const matches = items
    .filter((it) => it.status !== 'sold' || (it.soldAt ?? 0) > soldCutoff)
    .filter((it) => terms.every((t) => it.title.toLowerCase().includes(t)))
    .filter((it) => geo.filter_location_latitude === undefined || geo.filter_location_longitude === undefined ||
      distanceKm(geo.filter_location_latitude, geo.filter_location_longitude, it.lat, it.lng) <= (geo.filter_radius_km ?? 40))
    .sort((a, b) => b.created - a.created);
  const page = matches.slice(offset, offset + count);

  const edges: Array<{ node: { __typename: string; listing?: MarketplaceListing } }> = [];
  page.forEach((it, i) => {
    if (i > 0 && i % 10 === 0) edges.push({ node: { __typename: 'MarketplaceFeedAdStory' } });   // non-listing unit
    edges.push({ node: { __typename: 'MarketplaceFeedListingStoryObject', listing: toListing(it) } });
  });
  const hasNext = offset + count < matches.length;
  return {
    data: {
      marketplace_search: {
        feed_units: {
          edges,
          page_info: { has_next_page: hasNext, end_cursor: hasNext ? Buffer.from(JSON.stringify({ o: offset + count })).toString('base64url') : null },
        },
      },
    },
  };
}

function placeholderSvg(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <rect width="600" height="600" fill="hsl(${hue} 55% 82%)"/><circle cx="300" cy="260" r="120" fill="hsl(${hue} 50% 62%)"/>
  <text x="300" y="480" font-family="sans-serif" font-size="30" text-anchor="middle" fill="hsl(${hue} 40% 25%)">${name}</text></svg>`;
}

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });

export async function start() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', PUBLIC);
    const json = (body: unknown, prefix = '') =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(prefix + JSON.stringify(body));

    if (url.pathname === '/api/graphql/' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      if (config.mock.failRate > 0 && Math.random() < config.mock.failRate) {
        return json({ errors: [{ message: 'Rate limit exceeded', severity: 'CRITICAL' }] }, 'for (;;);');
      }
      if (form.get('doc_id') !== ACCEPTED_DOC_ID) return json({ errors: [{ message: 'PersistedQueryNotFound' }] });
      let variables: SearchVariables;
      try {
        variables = JSON.parse(form.get('variables') ?? '{}');
      } catch {
        return json({ errors: [{ message: 'invalid variables' }] });
      }
      return json(search(variables));
    }

    if (url.pathname.startsWith('/v/')) {
      const oe = parseInt(url.searchParams.get('oe') ?? '0', 16);
      if (!oe || oe * 1000 < Date.now()) return res.writeHead(403, { 'content-type': 'text/plain' }).end('URL signature expired');
      const id = url.pathname.split('/').pop()!.replace(/_n\.svg$/, '');
      const it = items.find((x) => x.id === id);
      return res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' }).end(placeholderSvg(it?.title ?? id));
    }

    const item = url.pathname.match(/^\/marketplace\/item\/(\d+)\/?$/);
    if (item) {
      const it = items.find((x) => x.id === item[1]);
      return res.writeHead(it ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
        .end(it ? `<h1>${it.title}</h1><p>${money(it.priceCents)} · ${it.city}, ${it.region}</p>` : 'This listing is no longer available.');
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(config.mock.port, config.bindHost, resolve));
  const timer = setInterval(tick, config.mock.tickMs);
  log(`fake marketplace on ${PUBLIC} (${items.length} seeded listings, new ones every ${config.mock.tickMs / 1000}s)`);
  return () => {
    clearInterval(timer);
    server.close();
  };
}

if (isMain(import.meta.url)) runMain(start);
