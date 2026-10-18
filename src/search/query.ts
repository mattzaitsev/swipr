/**
 * Search request -> Typesense parameters, with opaque cursors.
 *  - newest / price_asc / price_desc: keyset cursor on (sort field, seq). Stable while new listings arrive.
 *  - relevance / distance: page cursor (Typesense can't keyset on text-match score or computed distance).
 */
import type { ListingDoc } from './typesense';

export type Sort = 'relevance' | 'newest' | 'price_asc' | 'price_desc' | 'distance';

export interface SearchInput {
  q?: string;
  lat?: number;
  lng?: number;
  radius_km: number;
  min_price?: number;                // dollars
  max_price?: number;
  condition?: string;
  source?: string;
  category?: string;
  sort?: Sort;
  limit: number;
  cursor?: string;
}

type Cursor = { k: [number, number] } | { p: number };

const KEYSET = {
  newest: { field: 'posted_at', dir: 'desc' },
  price_asc: { field: 'price', dir: 'asc' },
  price_desc: { field: 'price', dir: 'desc' },
} as const;
type KeysetSort = keyof typeof KEYSET;
const isKeyset = (s: Sort): s is KeysetSort => s in KEYSET;

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(c.k) && c.k.length === 2 && c.k.every(Number.isFinite)) return { k: [c.k[0], c.k[1]] };
    if (Number.isInteger(c.p) && c.p > 1) return { p: c.p };
  } catch {
    // fall through
  }
  throw Object.assign(new Error('invalid cursor'), { statusCode: 400 });
}

/** Backtick-quote a filter value (Typesense's escaping for strings with spaces/punctuation). */
const quote = (v: string) => '`' + v.replace(/`/g, '') + '`';

export function buildSearch(input: SearchInput) {
  const hasGeo = input.lat !== undefined && input.lng !== undefined;
  let sort: Sort = input.sort ?? (input.q ? 'relevance' : 'newest');
  if (sort === 'relevance' && !input.q) sort = 'newest';
  if (sort === 'distance' && !hasGeo) sort = 'newest';
  const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;

  const filters = ['status:=active'];
  if (hasGeo) filters.push(`location:(${input.lat}, ${input.lng}, ${input.radius_km} km)`);
  if (input.min_price !== undefined) filters.push(`price:>=${Math.round(input.min_price * 100)}`);
  if (input.max_price !== undefined) filters.push(`price:<=${Math.round(input.max_price * 100)}`);
  if (input.condition) filters.push(`condition:=${quote(input.condition)}`);
  if (input.source) filters.push(`source:=${quote(input.source)}`);
  if (input.category) filters.push(`category:=${quote(input.category)}`);

  let sortBy: string;
  let page = 1;
  if (isKeyset(sort)) {
    const { field, dir } = KEYSET[sort];
    sortBy = `${field}:${dir},seq:${dir}`;
    if (cursor && 'k' in cursor) {
      const [value, seq] = cursor.k;
      const op = dir === 'desc' ? '<' : '>';
      filters.push(`(${field}:${op}${value} || (${field}:=${value} && seq:${op}${seq}))`);
    }
  } else {
    sortBy = sort === 'distance' ? `location(${input.lat}, ${input.lng}):asc,seq:desc` : '_text_match:desc,posted_at:desc,seq:desc';
    if (cursor && 'p' in cursor) page = cursor.p;
  }

  return {
    sort,
    page,
    params: {
      q: input.q?.trim() || '*',
      query_by: 'title,description',
      filter_by: filters.join(' && '),
      sort_by: sortBy,
      per_page: String(input.limit),
      page: String(page),
      exclude_fields: 'description',
    },
  };
}

export function nextCursor(sort: Sort, page: number, docs: ListingDoc[], limit: number, found: number): string | null {
  if (docs.length < limit) return null;
  if (isKeyset(sort)) {
    const last = docs[docs.length - 1];
    return encodeCursor({ k: [last[KEYSET[sort].field], last.seq] });
  }
  return page * limit < found ? encodeCursor({ p: page + 1 }) : null;
}

export function distanceKm(a: [number, number], lat: number, lng: number): number {
  const rad = Math.PI / 180;
  const dLat = (a[0] - lat) * rad;
  const dLng = (a[1] - lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(a[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
