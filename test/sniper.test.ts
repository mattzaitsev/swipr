// Sniper decisions: filters, freshness, radius, baseline and once-per-listing alerts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAlert, NtfyNotifier, type ListingAlert, type Notifier } from '../src/alerts/notify';
import { evaluate, memorySniperStore, Sniper } from '../src/alerts/sniper';
import type { CrawlTask } from '../src/connectors/types';
import type { ListingDraft } from '../src/domain';
import { placeCentroid } from '../src/geo/places';
import type { SniperArea, Watch } from '../src/watches';

const NOW = Date.UTC(2026, 9, 19, 20, 0, 0);
const area: SniperArea = {
  label: 'san-diego', city: 'San Diego', region: 'CA', country: 'US',
  lat: 32.7157, lng: -117.1611, radiusMi: 40, states: ['CA'], facebookLocation: 'sandiego',
};
const watch: Watch = { id: 'couch', query: 'couch', sources: ['facebook'], maxPrice: 300, exclude: ['cover'], everySec: 120, maxAgeMin: 60 };

function draft(id: string, over: Partial<ListingDraft> & { city?: string; state?: string; ageMin?: number } = {}): ListingDraft {
  const { city = 'San Diego', state = 'CA', ageMin = 5, ...rest } = over;
  const c = placeCentroid(city, state);
  return {
    source: 'facebook', externalId: id, url: `https://www.facebook.com/marketplace/item/${id}/`, title: 'Grey couch',
    priceCents: 25_000, currency: 'USD', condition: 'unknown', status: 'active',
    location: c ? { ...c, precision: 'city', city, region: state } : { lat: area.lat, lng: area.lng, precision: 'area', city, region: state },
    postedAt: new Date(NOW - ageMin * 60_000), imageUrls: [], ...rest,
  };
}

test('evaluate: passes a fresh, local, in-budget listing and reports distance and age', () => {
  const r = evaluate(watch, draft('1', { city: 'Chula Vista' }), area, NOW);
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(r.distanceMi! > 5 && r.distanceMi! < 10);
    assert.equal(Math.round(r.ageMin!), 5);
  }
});

test('evaluate: skips over budget, excluded words, stale, far away, other states, and sold', () => {
  const reason = (d: ListingDraft) => { const r = evaluate(watch, d, area, NOW); return r.ok ? 'ok' : r.reason; };
  assert.equal(reason(draft('a', { priceCents: 45_000 })), 'over $300');
  assert.equal(reason(draft('b', { title: 'Couch cover, grey' })), 'contains "cover"');
  assert.equal(reason(draft('c', { ageMin: 90 })), '90 min old');
  assert.match(reason(draft('d', { city: 'Temecula' })), /mi away/);
  assert.equal(reason(draft('e', { city: 'Tijuana', state: 'Baja California' })), 'in Baja California');
  assert.equal(reason(draft('f', { status: 'sold' })), 'sold');
});

test('evaluate: a listing with no known position is kept (better a stray alert than a missed deal)', () => {
  const r = evaluate(watch, draft('g', { city: 'Somewhere New' }), area, NOW);
  assert.ok(r.ok && r.distanceMi === null);
});

test('sniper: first crawl alerts only fresh listings, then alerts once per new listing', async () => {
  const sent: ListingAlert[] = [];
  const notifier: Notifier = { name: 'test', send: async (a) => void sent.push(a) };
  const sniper = new Sniper(memorySniperStore(), [notifier], area);
  const task = { source: 'facebook', query: 'couch', maxPages: 1, mode: 'new', watch,
    area: { label: 'couch', lat: area.lat, lng: area.lng, radiusKm: 64.4, country: 'US' } } as CrawlTask;

  // First check: two old listings (baseline, silent) and one posted 2 minutes ago (alerted).
  const first = await sniper.onCrawl(task, [draft('1', { ageMin: 120 }), draft('2', { ageMin: 300 }), draft('0', { ageMin: 2 })], NOW);
  assert.equal(first.length, 1);
  sent.length = 0;
  const second = await sniper.onCrawl(task, [draft('3'), draft('1'), draft('2'), draft('4', { priceCents: 99_000 })], NOW);
  assert.deepEqual(second.map((a) => a.title), ['Grey couch']);                              // only #3; #4 over budget
  assert.equal(sent.length, 1);
  assert.equal((await sniper.onCrawl(task, [draft('3'), draft('1')], NOW)).length, 0);       // seen: no repeat

  // Another watch seeing the same listing doesn't alert again.
  const other = { ...task, query: 'grey couch', area: { ...task.area, label: 'grey-couch' }, watch: { ...watch, id: 'grey-couch' } } as CrawlTask;
  await sniper.onCrawl(other, [draft('9')], NOW);                                            // its baseline
  assert.equal((await sniper.onCrawl(other, [draft('3'), draft('9')], NOW)).length, 0);
});

test('sniper: an empty first page still counts as the baseline', async () => {
  const sniper = new Sniper(memorySniperStore(), [], area);
  const task = { source: 'facebook', query: 'rare', maxPages: 1, mode: 'new', watch,
    area: { label: 'rare', lat: area.lat, lng: area.lng, radiusKm: 64.4, country: 'US' } } as CrawlTask;
  assert.equal((await sniper.onCrawl(task, [], NOW)).length, 0);
  assert.equal((await sniper.onCrawl(task, [draft('42')], NOW)).length, 1);
});

test('alert text reads well on a phone', () => {
  const { title, message } = formatAlert({
    watchId: 'couch', source: 'facebook', title: 'Beige sectional couch', priceCents: 25_000, originalPriceCents: 40_000,
    city: 'San Diego', region: 'CA', distanceMi: 6.2, ageMin: 4, url: 'https://www.facebook.com/marketplace/item/1/',
  });
  assert.equal(title, '$250 · Beige sectional couch');
  assert.equal(message, 'San Diego, CA · 6 mi · 4 min ago\nFacebook · watch: couch · was $400');
});

test('ntfy notifier publishes JSON with topic, title, click-through and priority', async () => {
  let body: Record<string, unknown> = {};
  let url = '';
  const fakeFetch = (async (u: string, init: RequestInit) => {
    url = u;
    body = JSON.parse(String(init.body));
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  await new NtfyNotifier('https://ntfy.example', 'my-topic', fakeFetch).send({
    watchId: 'ps5', source: 'facebook', title: 'PS5 disc', priceCents: 30_000, distanceMi: 3, ageMin: 2,
    url: 'https://www.facebook.com/marketplace/item/7/', imageUrl: 'https://img.example/p.jpg',
  });
  assert.equal(url, 'https://ntfy.example');
  assert.equal(body.topic, 'my-topic');
  assert.equal(body.title, '$300 · PS5 disc');
  assert.equal(body.click, 'https://www.facebook.com/marketplace/item/7/');
  assert.equal(body.attach, 'https://img.example/p.jpg');
  assert.equal(body.priority, 4);
});
