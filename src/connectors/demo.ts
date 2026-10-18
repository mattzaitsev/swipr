/**
 * Example connector against the local mock marketplace (src/dev/mock-source.ts).
 * The mock deliberately uses its own field names, so parse() shows the mapping a real connector does.
 */
import { config } from '../config';
import type { Condition, ListingDraft } from '../domain';
import type { Connector, CrawlTask } from './types';

/** The mock's wire format: what a real source's JSON would look like before normalization. */
export interface MockItem {
  id: string;
  title: string;
  body: string;
  price: { amount: string; currency: string };
  state: 'available' | 'pending' | 'sold';
  condition: 'new' | 'used_like_new' | 'used_good' | 'used_fair' | 'refurbished';
  category: string;
  lat: number;
  lng: number;
  city: string;
  region: string;
  created: string;
  seller: { id: string; handle: string; business: boolean };
  photos: string[];
  permalink: string;
}
export interface MockPage {
  items: MockItem[];
  next_cursor: string | null;
}

const AREAS: CrawlTask['area'][] = [
  { label: 'austin', lat: 30.2672, lng: -97.7431, radiusKm: 30, country: 'US', region: 'TX' },
  { label: 'phoenix', lat: 33.4484, lng: -112.074, radiusKm: 30, country: 'US', region: 'AZ' },
  { label: 'seattle', lat: 47.6062, lng: -122.3321, radiusKm: 30, country: 'US', region: 'WA' },
];

const CONDITION: Record<MockItem['condition'], Condition> = {
  new: 'new',
  used_like_new: 'used',
  used_good: 'used',
  used_fair: 'used',
  refurbished: 'refurbished',
};

export const demoConnector: Connector = {
  source: 'demo',

  tasks() {
    return config.demoQueries.flatMap((query) => AREAS.map((area) => ({ source: 'demo', query, area, maxPages: 3 })));
  },

  async *crawl(task, { gateway }) {
    let cursor: string | null = null;
    for (let page = 0; page < task.maxPages; page++) {
      const url = new URL('/api/search', config.mock.url);
      url.searchParams.set('q', task.query);
      url.searchParams.set('lat', String(task.area.lat));
      url.searchParams.set('lng', String(task.area.lng));
      url.searchParams.set('radius_km', String(task.area.radiusKm));
      if (cursor) url.searchParams.set('cursor', cursor);

      const res = await gateway.fetch({
        source: this.source,
        url: url.toString(),
        headers: { accept: 'application/json' },
        geo: { country: task.area.country, region: task.area.region },
      });
      if (res.status !== 200) throw new Error(`demo source returned HTTP ${res.status}`);

      const data = JSON.parse(res.body.toString('utf8')) as MockPage;
      for (const item of data.items) yield { externalId: item.id, payload: item };
      cursor = data.next_cursor;
      if (!cursor) break;
    }
  },

  parse({ payload }): ListingDraft | null {
    const m = payload as MockItem;
    if (!m?.id || !m.title) return null;
    return {
      source: 'demo',
      externalId: m.id,
      url: m.permalink,
      title: m.title.trim(),
      description: m.body?.trim() || undefined,
      priceCents: Math.round(Number(m.price.amount) * 100),
      currency: m.price.currency,
      condition: CONDITION[m.condition] ?? 'unknown',
      category: m.category,
      status: m.state === 'available' ? 'active' : m.state,
      location: { lat: m.lat, lng: m.lng, city: m.city, region: m.region, country: 'US' },
      postedAt: new Date(m.created),
      seller: { externalId: m.seller.id, displayName: m.seller.handle, kind: m.seller.business ? 'business' : 'individual' },
      imageUrls: m.photos,
    };
  },
};
