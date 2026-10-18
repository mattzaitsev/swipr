/**
 * A fake marketplace so the Beta runs end to end offline (and never touches a real site during development).
 * It has its own JSON shape (see MockItem), and it changes over time: new listings appear every tick,
 * some prices drop, some items go pending or sold. Set MOCK_FAIL_RATE to inject 429s.
 */
import http from 'node:http';
import { config } from '../config';
import type { MockItem, MockPage } from '../connectors/demo';
import { isMain, logger, runMain } from '../runtime';

const log = logger('mock');
const BASE = config.mock.url;
const PAGE_SIZE = 20;

const CITIES = [
  { city: 'Austin', region: 'TX', lat: 30.2672, lng: -97.7431 },
  { city: 'Phoenix', region: 'AZ', lat: 33.4484, lng: -112.074 },
  { city: 'Seattle', region: 'WA', lat: 47.6062, lng: -122.3321 },
];
const CATALOG: Record<string, Array<[string, number]>> = {
  furniture: [['Sectional couch', 450], ['Leather couch', 380], ['Mid-century sofa couch', 520], ['IKEA Kallax shelf', 60],
    ['Standing desk', 220], ['Solid oak desk', 180], ['Ergonomic office chair', 140], ['Corner desk with drawers', 95]],
  bikes: [['Trek mountain bike', 650], ['Road bike 56cm', 480], ['Kids bike 20 inch', 70], ['Electric bike', 1100], ['Fixie bike', 210]],
  electronics: [['PS5 with two controllers', 420], ['55 inch 4K TV', 300], ['MacBook Air M2', 750], ['Nintendo Switch OLED', 260]],
};
const NOTES = ['Great condition.', 'Barely used.', 'Moving sale, must go this week.', 'Smoke-free, pet-free home.',
  'Pickup only.', 'Small scuff on one side, otherwise perfect.', 'Selling because I upgraded.'];
const CONDITIONS: MockItem['condition'][] = ['new', 'used_like_new', 'used_good', 'used_good', 'used_fair', 'refurbished'];

// Deterministic PRNG so the seeded catalogue is identical across restarts (stable ids => no duplicates).
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const items: MockItem[] = [];
const bootId = Date.now().toString(36);
let counter = 0;

function makeItem(id: string, createdAt: Date): MockItem {
  const place = pick(CITIES);
  const category = pick(Object.keys(CATALOG));
  const [title, base] = pick(CATALOG[category]);
  const price = Math.max(5, Math.round((base * (0.6 + rand() * 0.7)) / 5) * 5);
  const sellerN = 1 + Math.floor(rand() * 400);
  const photos = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => `${BASE}/img/${id}-${i}.svg`);
  return {
    id,
    title,
    body: `${pick(NOTES)} ${pick(NOTES)}`,
    price: { amount: price.toFixed(2), currency: 'USD' },
    state: 'available',
    condition: pick(CONDITIONS),
    category,
    lat: place.lat + (rand() - 0.5) * 0.5,          // within ~25 km of the city centre
    lng: place.lng + (rand() - 0.5) * 0.5,
    city: place.city,
    region: place.region,
    created: createdAt.toISOString(),
    seller: { id: `s${sellerN}`, handle: `seller_${sellerN}`, business: rand() < 0.1 },
    photos,
    permalink: `${BASE}/item/${id}`,
  };
}

// Seed: 150 listings spread over the last 3 days, with stable ids m1..m150.
const now = Date.now();
for (let i = 1; i <= 150; i++) items.push(makeItem(`m${i}`, new Date(now - rand() * 3 * 86_400_000)));

/** Every tick: new listings appear, a few prices drop, an item or two goes pending/sold. */
function tick() {
  const fresh = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < fresh; i++) items.push(makeItem(`m${bootId}-${++counter}`, new Date()));
  const available = items.filter((it) => it.state === 'available');
  for (let i = 0; i < 2; i++) {
    const it = pick(available);
    it.price.amount = Math.max(5, Math.round((Number(it.price.amount) * 0.9) / 5) * 5).toFixed(2);
  }
  if (rand() < 0.5) pick(available).state = rand() < 0.5 ? 'pending' : 'sold';
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function search(params: URLSearchParams): MockPage {
  const terms = (params.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const lat = Number(params.get('lat'));
  const lng = Number(params.get('lng'));
  const radius = Number(params.get('radius_km') ?? 40);
  const offset = Number(Buffer.from(params.get('cursor') ?? '', 'base64url').toString() || 0);

  const matches = items
    .filter((it) => it.state !== 'sold' || rand() < 0.5)               // sold items linger for a while, like real sites
    .filter((it) => terms.every((t) => `${it.title} ${it.body} ${it.category}`.toLowerCase().includes(t)))
    .filter((it) => !Number.isFinite(lat) || !Number.isFinite(lng) || distanceKm(lat, lng, it.lat, it.lng) <= radius)
    .sort((a, b) => b.created.localeCompare(a.created));
  const page = matches.slice(offset, offset + PAGE_SIZE);
  const next = offset + PAGE_SIZE < matches.length ? Buffer.from(String(offset + PAGE_SIZE)).toString('base64url') : null;
  return { items: page, next_cursor: next };
}

function placeholderSvg(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <rect width="600" height="600" fill="hsl(${hue} 55% 82%)"/><circle cx="300" cy="260" r="120" fill="hsl(${hue} 50% 62%)"/>
  <text x="300" y="480" font-family="sans-serif" font-size="32" text-anchor="middle" fill="hsl(${hue} 40% 25%)">${name}</text></svg>`;
}

export async function start() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', BASE);
    if (url.pathname === '/api/search') {
      if (config.mock.failRate > 0 && rand() < config.mock.failRate) {
        res.writeHead(429, { 'retry-after': '30', 'content-type': 'application/json' }).end('{"error":"slow down"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(search(url.searchParams)));
    } else if (url.pathname.startsWith('/img/')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' })
        .end(placeholderSvg(url.pathname.slice(5).replace(/\.svg$/, '')));
    } else if (url.pathname.startsWith('/item/')) {
      const it = items.find((x) => x.id === url.pathname.slice(6));
      res.writeHead(it ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
        .end(it ? `<h1>${it.title}</h1><p>$${it.price.amount} · ${it.city}</p><p>${it.body}</p>` : 'not found');
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(config.mock.port, '127.0.0.1', resolve));
  const timer = setInterval(tick, config.mock.tickMs);
  log(`fake marketplace on ${BASE} (${items.length} seeded listings, new ones every ${config.mock.tickMs / 1000}s)`);
  return () => {
    clearInterval(timer);
    server.close();
  };
}

if (isMain(import.meta.url)) runMain(start);
