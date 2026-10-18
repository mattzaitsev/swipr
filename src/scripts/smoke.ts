/**
 * End-to-end check against a running Beta (`npm run dev` in another terminal):
 * health -> saved search -> search + cursors + filters -> listing detail -> saved-search hit arrives.
 */
import { config } from '../config';
import { runMain, sleep } from '../runtime';

const API = `http://localhost:${config.apiPort}`;
const AUSTIN = { lat: 30.2672, lng: -97.7431 };
async function get(path: string, init?: RequestInit) {
  const headers: Record<string, string> = { 'x-user-id': 'smoke-user' };
  if (init?.body) headers['content-type'] = 'application/json';
  const res = await fetch(API + path, { headers, ...init });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body as any;
}
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
}
async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await sleep(3_000);
  }
  check(label, false, 'timed out');
}

runMain(async () => {
  const health = await get('/health');
  check('health', health.ok, JSON.stringify(health));

  // Saved searches match listings that arrive *after* they're created (reverse search on new listings).
  const saved = await get('/saved-searches', {
    method: 'POST',
    body: JSON.stringify({ name: 'Anything near Austin under $2000', ...AUSTIN, radius_km: 30, max_price: 2000 }),
  });
  check('create saved search', saved.id > 0, `#${saved.id}`);

  const first = await waitFor('listings indexed', async () => {
    const r = await get(`/search?q=couch&lat=${AUSTIN.lat}&lng=${AUSTIN.lng}&radius_km=30`);
    return r.items.length ? r : undefined;
  });
  if (first) check('keyword + geo search', first.items.every((i: any) => i.distance_km <= 30), `${first.total} couches within 30 km of Austin`);

  // Keyset pagination: three pages, no duplicates, newest first.
  const seen: number[] = [];
  let cursor: string | null = null;
  const posted: string[] = [];
  for (let page = 0; page < 3; page++) {
    const r: any = await get(`/search?sort=newest&limit=5${cursor ? `&cursor=${cursor}` : ''}`);
    seen.push(...r.items.map((i: any) => i.id));
    posted.push(...r.items.map((i: any) => i.posted_at));
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  check('cursor pagination (no duplicates)', new Set(seen).size === seen.length, `${seen.length} items over 3 pages`);
  check('newest-first order', posted.every((p, i) => i === 0 || p <= posted[i - 1]));

  const cheap = await get('/search?sort=price_asc&max_price=300&condition=used&limit=10');
  const prices = cheap.items.map((i: any) => i.price);
  check('price filter + price_asc', prices.every((p: number, i: number) => p <= 300 && (i === 0 || p >= prices[i - 1])), prices.join(', '));

  if (first) {
    const detail = await get(`/listings/${first.items[0].id}`);
    check('listing detail', detail.images.length > 0 && detail.price_history.length > 0,
      `${detail.title}, ${detail.images.length} images, ${detail.price_history.length} price points`);
  }

  const hits = await waitFor('saved-search hit', async () => {
    const r = await get(`/saved-searches/${saved.id}/hits`);
    return r.items.length ? r : undefined;
  });
  if (hits) check('saved-search hit', true, `${hits.items[0].title} $${hits.items[0].price_cents / 100}`);

  await get(`/saved-searches/${saved.id}`, { method: 'DELETE' });
});
