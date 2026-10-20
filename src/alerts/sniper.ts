/**
 * Personal deal sniper: after each crawl of a watch's feed, alert on listings that are new *to that feed* and pass
 * the watch's filters. New-to-feed (not new-to-database) so a listing first found by another watch still alerts here.
 *
 *  - Baseline: a feed's first crawl records what's already up and alerts only on listings posted within maxAgeMin.
 *  - Once per listing: a listing matching several watches alerts once (first watch to see it wins).
 *  - Fresh only: listings older than the watch's maxAgeMin are skipped (renewed posts, catch-up after downtime).
 *  - Local: listings placed outside the area radius, or in another state/region, are skipped. Unknown position = kept.
 */
import type { Redis } from 'ioredis';
import { searchId } from '../connectors/flow';
import type { CrawlTask } from '../connectors/types';
import type { ListingDraft } from '../domain';
import { distanceKm } from '../geo/places';
import { logger } from '../runtime';
import type { SniperArea, Watch } from '../watches';
import type { ListingAlert, Notifier } from './notify';

const KM_PER_MI = 1.609344;

/** What the sniper needs to remember. Redis in production; in memory for tests. */
export interface SniperStore {
  /** Record these ids as seen in a feed. Returns which were new to it, and whether the feed had never been seen. */
  markSeen(feed: string, ids: string[]): Promise<{ firstCrawl: boolean; fresh: Set<string> }>;
  /** True the first time an alert is claimed for a listing. */
  claimAlert(listingKey: string): Promise<boolean>;
}

export type Evaluation = { ok: true; distanceMi: number | null; ageMin: number | null } | { ok: false; reason: string };

export function evaluate(watch: Watch, d: ListingDraft, area: SniperArea | null, now = Date.now()): Evaluation {
  if (d.status !== 'active') return { ok: false, reason: d.status };
  const dollars = d.priceCents / 100;
  if (watch.minPrice !== undefined && dollars < watch.minPrice) return { ok: false, reason: `under $${watch.minPrice}` };
  if (watch.maxPrice !== undefined && dollars > watch.maxPrice) return { ok: false, reason: `over $${watch.maxPrice}` };

  const title = d.title.toLowerCase();
  const missing = (watch.include ?? []).find((w) => !title.includes(w.toLowerCase()));
  if (missing) return { ok: false, reason: `missing "${missing}"` };
  const banned = (watch.exclude ?? []).find((w) => title.includes(w.toLowerCase()));
  if (banned) return { ok: false, reason: `contains "${banned}"` };

  const ageMin = d.postedAt ? Math.max(0, (now - d.postedAt.getTime()) / 60_000) : null;
  if (ageMin !== null && ageMin > watch.maxAgeMin) return { ok: false, reason: `${Math.round(ageMin)} min old` };

  let distanceMi: number | null = null;
  if (area && d.location) {
    const region = (d.location.region ?? '').toLowerCase();
    const allowed = area.states.map((s) => s.toLowerCase());
    if (region && !allowed.includes(region) && !(region === 'california' && allowed.includes('ca'))) {
      return { ok: false, reason: `in ${d.location.region}` };
    }
    if (d.location.precision !== 'area') {
      distanceMi = distanceKm(area, d.location) / KM_PER_MI;
      if (distanceMi > area.radiusMi) return { ok: false, reason: `${Math.round(distanceMi)} mi away` };
    }
  }
  return { ok: true, distanceMi, ageMin };
}

export class Sniper {
  private log = logger('sniper');

  constructor(private store: SniperStore, private notifiers: Notifier[], private area: SniperArea | null) {}

  /** Called once per finished crawl of a watch feed, with every listing that crawl returned. */
  async onCrawl(task: CrawlTask, listings: ListingDraft[], now = Date.now()): Promise<ListingAlert[]> {
    const watch = task.watch;
    if (!watch) return [];
    const feed = searchId(task);
    const { firstCrawl, fresh } = await this.store.markSeen(feed, listings.map((d) => d.externalId));
    // First check of a feed: everything on page 1 is "new to us", so only the genuinely fresh ones (posted within
    // maxAgeMin) alert; the rest become the baseline. After that, anything new to the feed is a candidate.
    const candidates = firstCrawl ? listings : listings.filter((x) => fresh.has(x.externalId));
    if (firstCrawl) this.log(`${feed}: first check, ${listings.length} listings up; alerting on those from the last ${watch.maxAgeMin} min`);

    const sent: ListingAlert[] = [];
    for (const d of candidates) {
      const verdict = evaluate(watch, d, this.area, now);
      if (!verdict.ok) {
        if (!firstCrawl) this.log(`${feed}: skip "${d.title}" (${verdict.reason})`);
        continue;
      }
      if (!(await this.store.claimAlert(`${d.source}:${d.externalId}`))) continue;
      const alert: ListingAlert = {
        watchId: watch.id,
        source: d.source,
        title: d.title,
        priceCents: d.priceCents,
        originalPriceCents: d.originalPriceCents,
        city: d.location?.city,
        region: d.location?.region,
        distanceMi: verdict.distanceMi,
        ageMin: verdict.ageMin,
        postedAt: d.postedAt?.toISOString(),
        url: d.url,
        imageUrl: d.imageUrls[0],
      };
      for (const n of this.notifiers) {
        await n.send(alert).catch((err: Error) => this.log(`${n.name} failed: ${err.message}`));
      }
      sent.push(alert);
    }
    return sent;
  }
}

export function redisSniperStore(redis: Redis): SniperStore {
  const ttl = 3 * 86_400;
  return {
    async markSeen(feed, ids) {
      const key = `swipr:sniper:seen:${feed}`;
      const firstCrawl = (await redis.exists(key)) === 0;
      if (firstCrawl) await redis.sadd(key, '__baseline__');   // marks the feed as seen even when page 1 was empty
      const fresh = new Set<string>();
      for (const id of ids) if ((await redis.sadd(key, id)) === 1) fresh.add(id);
      await redis.expire(key, ttl);
      return { firstCrawl, fresh };
    },
    async claimAlert(listingKey) {
      return (await redis.set(`swipr:sniper:alerted:${listingKey}`, '1', 'EX', 7 * 86_400, 'NX')) === 'OK';
    },
  };
}

export function memorySniperStore(): SniperStore {
  const seen = new Map<string, Set<string>>();
  const alerted = new Set<string>();
  return {
    async markSeen(feed, ids) {
      const firstCrawl = !seen.has(feed);
      const set = seen.get(feed) ?? new Set<string>();
      const fresh = new Set(ids.filter((id) => !set.has(id)));
      ids.forEach((id) => set.add(id));
      seen.set(feed, set);
      return { firstCrawl, fresh };
    },
    async claimAlert(listingKey) {
      if (alerted.has(listingKey)) return false;
      alerted.add(listingKey);
      return true;
    },
  };
}
