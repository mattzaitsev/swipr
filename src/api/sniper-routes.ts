/**
 * GET /sniper: what the UI's Sniper tab shows. The latest alerts, and for each watch the newest listings its feed
 * returned, each marked with whether it passes the watch's filters (and why not).
 */
import type { FastifyInstance } from 'fastify';
import { ALERT_LOG_KEY } from '../alerts/notify';
import { evaluate } from '../alerts/sniper';
import { pool } from '../db';
import type { GeoPrecision, ListingDraft } from '../domain';
import { createRedis } from '../redis';
import { loadWatches } from '../watches';

interface FeedRow {
  id: number; source: string; external_id: string; title: string; price_cents: number; original_price_cents: number | null;
  city: string | null; region: string | null; lat: number | null; lng: number | null; geo_precision: GeoPrecision | null;
  status: ListingDraft['status']; url: string; posted_at: Date | null; image: string | null;
}

// Newest listings a watch's feed returned (raw_events.context.area holds the watch id), with a fresh primary image.
const FEED_SQL = `
  select * from (
    select distinct on (l.id) l.id, l.source, l.external_id, l.title, l.price_cents, l.original_price_cents, l.city, l.region,
           l.lat, l.lng, l.geo_precision, l.status, l.url, l.posted_at,
           (select i.source_url from listing_images i
             where i.listing_id = l.id and i.position = 0 and (i.expires_at is null or i.expires_at > now())) as image
    from listings l
    join raw_events r on r.source = l.source and r.external_id = l.external_id
    where l.source = any($1) and r.context->>'area' = $2
    order by l.id
  ) t
  order by posted_at desc nulls last
  limit $3`;

export function registerSniperRoutes(app: FastifyInstance) {
  let redis: ReturnType<typeof createRedis> | null = null;

  app.get<{ Querystring: { per: number } }>(
    '/sniper',
    { schema: { querystring: { type: 'object', properties: { per: { type: 'integer', minimum: 1, maximum: 24, default: 8 } } } } },
    async (req) => {
      const file = loadWatches();
      if (!file) return { enabled: false, area: null, watches: [], alerts: [] };
      redis ??= createRedis();
      const now = Date.now();

      const alerts = (await redis.lrange(ALERT_LOG_KEY, 0, 49)).map((s) => JSON.parse(s));
      const watches = await Promise.all(
        file.watches.map(async (w) => {
          const { rows } = await pool.query<FeedRow>(FEED_SQL, [w.sources, w.id, req.query.per]);
          return {
            ...w,
            listings: rows.map((r) => {
              const draft = {
                source: r.source, externalId: r.external_id, url: r.url, title: r.title, priceCents: r.price_cents,
                currency: 'USD', condition: 'unknown', status: r.status, imageUrls: [],
                postedAt: r.posted_at ?? undefined,
                location: r.lat !== null && r.lng !== null
                  ? { lat: r.lat, lng: r.lng, precision: r.geo_precision ?? 'area', city: r.city ?? undefined, region: r.region ?? undefined }
                  : undefined,
              } satisfies ListingDraft;
              const verdict = evaluate(w, draft, file.area, now);
              return {
                id: r.id,
                source: r.source,
                title: r.title,
                priceCents: r.price_cents,
                originalPriceCents: r.original_price_cents,
                city: r.city,
                region: r.region,
                url: r.url,
                image: r.image,
                postedAt: r.posted_at,
                distanceMi: verdict.ok ? verdict.distanceMi : null,
                match: verdict.ok,
                reason: verdict.ok ? null : verdict.reason,
              };
            }),
          };
        }),
      );
      return { enabled: true, area: file.area, watches, alerts };
    },
  );
}
