/** Postgres rows -> Typesense documents. The index always reflects current Postgres state, never event payloads. */
import type { Db } from '../db';
import type { ListingDoc } from './typesense';

const DOC_SQL = `
  select l.id, l.source, l.title, l.description, l.price_cents, l.currency, l.condition, l.category, l.status,
         l.lat, l.lng, l.city, l.region, l.url, l.geo_precision, s.kind as seller_kind,
         extract(epoch from coalesce(l.posted_at, l.first_seen_at))::bigint as posted_at
  from listings l
  left join sellers s on s.id = l.seller_id`;

interface DocRow {
  id: number; source: string; title: string; description: string | null; price_cents: number; currency: string;
  condition: string; category: string | null; status: string; lat: number | null; lng: number | null;
  city: string | null; region: string | null; url: string; geo_precision: string | null; seller_kind: string | null; posted_at: number;
}

export function toDoc(r: DocRow): ListingDoc {
  const doc: ListingDoc = {
    id: String(r.id),
    seq: r.id,
    source: r.source,
    title: r.title,
    price: r.price_cents,
    currency: r.currency,
    condition: r.condition,
    status: r.status,
    posted_at: r.posted_at,
    url: r.url,
  };
  if (r.description) doc.description = r.description;
  if (r.category) doc.category = r.category;
  if (r.lat !== null && r.lng !== null) doc.location = [r.lat, r.lng];
  if (r.city) doc.city = r.city;
  if (r.region) doc.region = r.region;
  if (r.geo_precision) doc.geo_precision = r.geo_precision;
  if (r.seller_kind) doc.seller_kind = r.seller_kind;
  return doc;
}

export async function loadDocs(db: Db, ids: number[]): Promise<ListingDoc[]> {
  const { rows } = await db.query<DocRow>(`${DOC_SQL} where l.id = any($1)`, [ids]);
  return rows.map(toDoc);
}

/** Every indexable listing, in id order, `batchSize` at a time (for full reindexes). */
export async function* allDocs(db: Db, batchSize = 1_000): AsyncGenerator<ListingDoc[]> {
  let after = 0;
  for (;;) {
    const { rows } = await db.query<DocRow>(
      `${DOC_SQL} where l.id > $1 and l.status <> 'removed' order by l.id limit $2`,
      [after, batchSize],
    );
    if (!rows.length) return;
    yield rows.map(toDoc);
    after = rows[rows.length - 1].id;
  }
}
