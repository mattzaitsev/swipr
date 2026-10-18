import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Connector, RawItem } from '../connectors';
import { tx } from '../db';
import type { ListingDraft } from '../domain';
import { emit } from '../outbox';

export type NormalizeResult = 'created' | 'updated' | 'unchanged' | 'skipped';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Hash of the fields that matter to users. Same hash as last time => only bump last_seen_at. */
export function contentHash(d: ListingDraft): string {
  return sha256(
    JSON.stringify([
      d.title, d.description ?? null, d.priceCents, d.currency, d.condition, d.category ?? null, d.status,
      d.location ? [d.location.lat.toFixed(5), d.location.lng.toFixed(5), d.location.city ?? null] : null,
      d.seller?.externalId ?? null, d.imageUrls,
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

/**
 * Raw item -> raw_events + listings/sellers/images/price_history + outbox, in one transaction.
 * Idempotent: replaying the same payload changes nothing but last_seen_at.
 */
export async function normalize(connector: Connector, item: RawItem): Promise<NormalizeResult> {
  const draft = connector.parse(item);

  return tx(async (c) => {
    // Serialize concurrent work on the same listing (two crawl tasks can return the same item).
    await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`${connector.source}:${item.externalId}`]);

    await c.query(
      `insert into raw_events (source, external_id, payload, payload_hash) values ($1, $2, $3, $4)
       on conflict do nothing`,
      [connector.source, item.externalId, JSON.stringify(item.payload), sha256(JSON.stringify(item.payload))],
    );
    if (!draft) return 'skipped';

    const hash = contentHash(draft);
    const { rows } = await c.query<{ id: number; content_hash: string; price_cents: number; status: string }>(
      `select id, content_hash, price_cents, status from listings where source = $1 and external_id = $2`,
      [draft.source, draft.externalId],
    );
    const prev = rows[0];

    if (prev && prev.content_hash === hash) {
      await c.query(`update listings set last_seen_at = now() where id = $1`, [prev.id]);
      return 'unchanged';
    }

    const sellerId = draft.seller ? await upsertSeller(c, draft) : null;
    const values = [
      draft.source, draft.externalId, draft.url, sellerId, draft.title, draft.description ?? null,
      draft.priceCents, draft.currency, draft.condition, draft.category ?? null, draft.status,
      draft.location?.lat ?? null, draft.location?.lng ?? null, draft.location?.city ?? null,
      draft.location?.region ?? null, draft.location?.country ?? null, draft.postedAt ?? null, hash, clusterKey(draft),
    ];
    const geog = `case when $12::float8 is null then null else st_setsrid(st_makepoint($13::float8, $12::float8), 4326)::geography end`;

    let listingId: number;
    if (!prev) {
      const inserted = await c.query<{ id: number }>(
        `insert into listings (source, external_id, url, seller_id, title, description, price_cents, currency, condition,
                               category, status, lat, lng, city, region, country, posted_at, content_hash, cluster_key, geog)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, ${geog})
         returning id`,
        values,
      );
      listingId = inserted.rows[0].id;
    } else {
      listingId = prev.id;
      await c.query(
        `update listings set url = $3, seller_id = $4, title = $5, description = $6, price_cents = $7, currency = $8,
                condition = $9, category = $10, status = $11, lat = $12, lng = $13, city = $14, region = $15,
                country = $16, posted_at = coalesce($17, posted_at), content_hash = $18, cluster_key = $19,
                geog = ${geog}, last_seen_at = now(), updated_at = now()
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
       set display_name = excluded.display_name, kind = excluded.kind, last_seen_at = now()
     returning id`,
    [d.source, s.externalId, s.displayName ?? null, s.kind],
  );
  return rows[0].id;
}

/** Upsert images by position; keep mirror info (content_hash/storage_key) when the URL didn't change. */
async function syncImages(c: pg.PoolClient, listingId: number, urls: string[]) {
  await c.query(
    `insert into listing_images (listing_id, position, source_url)
     select $1, ord - 1, url from unnest($2::text[]) with ordinality as t(url, ord)
     on conflict (listing_id, position) do update set
       source_url   = excluded.source_url,
       content_hash = case when listing_images.source_url = excluded.source_url then listing_images.content_hash end,
       storage_key  = case when listing_images.source_url = excluded.source_url then listing_images.storage_key end`,
    [listingId, urls],
  );
  await c.query(`delete from listing_images where listing_id = $1 and position >= $2`, [listingId, urls.length]);
}
