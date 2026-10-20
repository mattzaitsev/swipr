// Facebook connector against a sanitized copy of a real logged-out search page (test/fixtures/facebook-search.html).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classifyFacebook, extractFacebookListings, facebookSearchUrl } from '../src/connectors/facebook';
import { parseMarketplaceListing } from '../src/connectors/marketplace';

const html = readFileSync(new URL('./fixtures/facebook-search.html', import.meta.url), 'utf8');
const area = { label: 'couch', lat: 32.7157, lng: -117.1611, radiusKm: 64.4, country: 'US', region: 'CA', city: 'San Diego' };

const drafts = () =>
  extractFacebookListings(html)!.map((l) =>
    parseMarketplaceListing(
      { externalId: String(l.id), payload: l, context: { query: 'couch', area } },
      'facebook',
      (id) => `https://www.facebook.com/marketplace/item/${id}/`,
    ),
  );

test('extracts the 24 page-1 listings embedded in a logged-out search page', () => {
  assert.equal(extractFacebookListings(html)?.length, 24);
});

test('returns null when the page has no embedded results', () => {
  assert.equal(extractFacebookListings('<html><script type="application/json">{"a":1}</script></html>'), null);
});

test('parses real listing fields: price, city, creation time, photo expiry, string ids', () => {
  const all = drafts();
  assert.ok(all.every((d) => d !== null));
  const first = all[0]!;
  assert.equal(first.priceCents, 159_900);
  assert.equal(first.location?.city, 'Oceanside');
  assert.equal(first.location?.precision, 'city');          // no coordinates in search results: city centroid
  assert.equal(first.status, 'active');
  assert.equal(first.postedAt?.getTime(), 1_792_470_188_000);
  assert.match(first.imageUrls[0], /[?&]oe=[0-9A-Fa-f]+/);
  assert.ok(all.every((d) => typeof d!.externalId === 'string' && /^\d{16}$/.test(d!.externalId)));
  assert.equal(all.filter((d) => d!.location?.precision === 'area').length, 0, 'every city in the fixture is in the places table');
});

test('classifier: embedded results are ok even with the login form present', () => {
  assert.equal(classifyFacebook(200, Buffer.from(html)), 'ok');
});

test('classifier: login form without results = blocked; anything else without results = changed', () => {
  assert.equal(classifyFacebook(200, Buffer.from('<html><form id="login_form"></form></html>')), 'blocked');
  assert.equal(classifyFacebook(200, Buffer.from('<html><body>something else entirely</body></html>')), 'changed');
  assert.equal(classifyFacebook(429, Buffer.from('')), 'ok');   // status codes are the gateway's job
});

test('search URL asks for newest first, with price bounds', () => {
  const u = new URL(facebookSearchUrl('https://www.facebook.com', 'sandiego', 'herman miller', 50, 400));
  assert.equal(u.pathname, '/marketplace/sandiego/search/');
  assert.equal(u.searchParams.get('query'), 'herman miller');
  assert.equal(u.searchParams.get('sortBy'), 'creation_time_descend');
  assert.equal(u.searchParams.get('minPrice'), '50');
  assert.equal(u.searchParams.get('maxPrice'), '400');
});
