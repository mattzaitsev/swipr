import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Connector, RawItem } from '../connectors';
import { tx } from '../db';
import type { ListingDraft } from '../domain';
import { emit } from '../outbox';

export type NormalizeResult = 'created' | 'updated' | 'unchanged' | 'skipped';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Image identity without the signature: Marketplace CDN URLs change their query string on every response. */
export const imageKey = (url: string) => url.split('?')[0];

/** Expiry of a signed CDN URL (Facebook-style `oe=` hex unix timestamp), or null if it doesn't say. */
export function imageExpiry(url: string): Date | null {
  try {
    const oe = new URL(url).searchParams.get('oe');
    return oe && /^[0-9a-f]{6,10}$/i.test(oe) ? new Date(parseInt(oe, 16) * 1000) : null;
  } catch {
    return null;
  }
}

/**
 * Hash of what users care about. Volatile parts (image signatures, area-fallback geo) are left out on purpose.
 * EXTENSION POINT: once a detail fetch fills description/condition/photos, hash search-visible fields separately
 * so thinner search results don't register as changes.
 */
export function contentHash(d: ListingDraft): string {
  const loc = d.location && d.location.precision !== 'area' ? [d.location.lat.toFixed(3), d.location.lng.toFixed(3)] : null;
  return sha256(
    JSON.stringify([
      d.title, d.description ?? null, d.priceCents, d.originalPriceCents ?? null, d.currency, d.condition,
      d.category ?? null, d.status, loc, d.location?.city ?? null, d.seller?.externalId ?? null, d.imageUrls.map(imageKey),
    ]),
  );
}

/**
 * Crude cross-post grouping key: same normalized title, similar price, same ~5 km cell.
 * EXTENSION POINT: real dedupe (trigram/MinHash on text + perceptual hashes of images) assigns cluster ids.
 */
export function clusterKey(d: ListingDraft): string | null {
  if (!d.location) return null;
  const title = d.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const priceBucket = Math.round(d.priceCents / 2_500);         // $25 buckets
  const cell = `${d.location.lat.toFixed(2)},${d.location.lng.toFixed(2)}`;
  return sha256(`${title}|${priceBucket}|${cell}`).slice(0, 24);
}

interface PrevRow {
  id: number;
  content_hash: string;
  price_cents: number;
  status: string;
  lat: number | null;
  lng: number | null;
  geo_precision: string | null;
}

/**
 * Raw item -> raw_events + listings/sellers/images/price_history + outbox, in one transaction.
 * Idempotent: replaying the same payload changes nothing but last_seen_at and image URL signatures.
 */
export async function normalize(connector: Connector, item: RawItem): Promise<NormalizeResult> {
  const draft = connector.parse(item);

  return tx(async (c) => {
    // Serialize concurrent work on the same listing (overlapping searches return the same item).
    await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`${connector.source}:${item.externalId}`]);

    const payload = JSON.stringify(item.payload);
    await c.query(
      `insert into raw_events (source, external_id, payload, payload_hash, context) values ($1, $2, $3, $4, $5)
       on conflict do nothing`,
      [connector.source, item.externalId, payload, sha256(payload), { query: item.context.query, area: item.context.area.label }],
    );
    if (!draft) return 'skipped';

    const { rows } = await c.query<PrevRow>(
      `select id, content_hash, price_cents, status, lat, lng, geo_precision from listings where source = $1 and external_id = $2`,
      [draft.source, draft.externalId],
    );
    const prev = rows[0];

    // A search-area fallback location never overrides a location we already have (it depends on which search found it).
    if (prev && draft.location?.precision === 'area' && prev.lat !== null && prev.lng !== null) {
      draft.location = { ...draft.location, lat: prev.lat, lng: prev.lng, precision: (prev.geo_precision ?? 'area') as 'area' };
    }

    const hash = contentHash(draft);
    if (prev && prev.content_hash === hash) {
      await c.query(`update listings set last_seen_at = now() where id = $1`, [prev.id]);
      await syncImages(c, prev.id, draft.imageUrls);    // fresh signatures; search reads images from Postgres
      return 'unchanged';
    }

    const sellerId = draft.seller ? await upsertSeller(c, draft) : null;
    const values = [
      draft.source, draft.externalId, draft.url, sellerId, draft.title, draft.description ?? null,
      draft.priceCents, draft.currency, draft.condition, draft.category ?? null, draft.status,
      draft.location?.lat ?? null, draft.location?.lng ?? null, draft.location?.city ?? null,
      draft.location?.region ?? null, draft.location?.country ?? null, draft.postedAt ?? null, hash, clusterKey(draft),
      draft.location?.precision ?? null, draft.originalPriceCents ?? null,
    ];
    const geog = `case when $12::float8 is null then null else st_setsrid(st_makepoint($13::float8, $12::float8), 4326)::geography end`;

    let listingId: number;
    if (!prev) {
      const inserted = await c.query<{ id: number }>(
        `insert into listings (source, external_id, url, seller_id, title, description, price_cents, currency, condition,
                               category, status, lat, lng, city, region, country, posted_at, content_hash, cluster_key,
                               geo_precision, original_price_cents, geog)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, ${geog})
         returning id`,
        values,
      );
      listingId = inserted.rows[0].id;
    } else {
      listingId = prev.id;
      await c.query(
        `update listings set url = $3, seller_id = coalesce($4, seller_id), title = $5, description = coalesce($6, description),
                price_cents = $7, currency = $8, condition = case when $9 = 'unknown' then condition else $9 end,
                category = coalesce($10, category), status = $11, lat = $12, lng = $13, city = $14, region = $15,
                country = $16, posted_at = coalesce($17, posted_at), content_hash = $18, cluster_key = $19,
                geo_precision = $20, original_price_cents = $21, geog = ${geog}, last_seen_at = now(), updated_at = now()
         where source = $1 and external_id = $2`,
        values,
      );
    }

    if (!prev || prev.price_cents !== draft.priceCents) {
      await c.query(`insert into price_history (listing_id, price_cents, currency) values ($1, $2, $3)`, [
        listingId, draft.priceCents, draft.currency,
      ]);
    }
    await syncImages(c, listingId, draft.imageUrls);

    if (!prev) {
      await emit(c, ['search', 'alerts'], 'listing.created', listingId);
    } else {
      // EXTENSION POINT: also send price drops to 'alerts' for "notify me when it gets cheaper".
      const event = draft.status === 'removed' ? 'listing.removed' : 'listing.updated';
      await emit(c, ['search'], event, listingId, {
        price: [prev.price_cents, draft.priceCents],
        status: [prev.status, draft.status],
      });
    }
    return prev ? 'updated' : 'created';
  });
}

async function upsertSeller(c: pg.PoolClient, d: ListingDraft): Promise<number> {
  const s = d.seller!;
  const { rows } = await c.query<{ id: number }>(
    `insert into sellers (source, external_id, display_name, kind) values ($1, $2, $3, $4)
     on conflict (source, external_id) do update
       set display_name = coalesce(excluded.display_name, sellers.display_name), kind = excluded.kind, last_seen_at = now()
     returning id`,
    [d.source, s.externalId, s.displayName ?? null, s.kind],
  );
  return rows[0].id;
}

/**
 * Upsert images by position with their signed URL and expiry. Mirror info (content_hash/storage_key) survives
 * while the image identity (URL without signature) is unchanged. Search results carry only the primary photo,
 * so a one-photo update refreshes position 0 and leaves photos from a detail fetch alone.
 */
async function syncImages(c: pg.PoolClient, listingId: number, urls: string[]) {
  if (!urls.length) return;
  await c.query(
    `insert into listing_images (listing_id, position, source_url, expires_at)
     select $1, ord - 1, t.url, t.expires_at
     from unnest($2::text[], $3::timestamptz[]) with ordinality as t(url, expires_at, ord)
     on conflict (listing_id, position) do update set
       source_url   = excluded.source_url,
       expires_at   = excluded.expires_at,
       content_hash = case when split_part(listing_images.source_url, '?', 1) = split_part(excluded.source_url, '?', 1)
                           then listing_images.content_hash end,
       storage_key  = case when split_part(listing_images.source_url, '?', 1) = split_part(excluded.source_url, '?', 1)
                           then listing_images.storage_key end`,
    [listingId, urls, urls.map(imageExpiry)],
  );
  if (urls.length > 1) await c.query(`delete from listing_images where listing_id = $1 and position >= $2`, [listingId, urls.length]);
}
