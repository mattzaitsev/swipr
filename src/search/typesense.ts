/** Thin Typesense client over its REST API (no SDK, so every call is visible). */
import { config } from '../config';

const { url: baseUrl, apiKey, alias } = config.typesense;

export interface ListingDoc {
  id: string;
  seq: number;                       // Postgres listing id, numeric tie-breaker for keyset cursors
  source: string;
  title: string;
  description?: string;
  price: number;                     // cents
  currency: string;
  condition: string;
  category?: string;
  status: string;
  location?: [number, number];       // [lat, lng]
  city?: string;
  region?: string;
  posted_at: number;                 // epoch seconds
  url: string;
  image?: string;
  seller_kind?: string;
}

export interface SearchResult {
  found: number;
  hits: Array<{ document: ListingDoc; geo_distance_meters?: { location?: number } }>;
}

const FIELDS = [
  { name: 'seq', type: 'int64', sort: true },
  { name: 'source', type: 'string', facet: true },
  { name: 'title', type: 'string' },
  { name: 'description', type: 'string', optional: true },
  { name: 'price', type: 'int64', sort: true },
  { name: 'currency', type: 'string', index: false, optional: true },
  { name: 'condition', type: 'string', facet: true },
  { name: 'category', type: 'string', facet: true, optional: true },
  { name: 'status', type: 'string', facet: true },
  { name: 'location', type: 'geopoint', optional: true },
  { name: 'city', type: 'string', facet: true, optional: true },
  { name: 'region', type: 'string', facet: true, optional: true },
  { name: 'posted_at', type: 'int64', sort: true },
  { name: 'url', type: 'string', index: false, optional: true },
  { name: 'image', type: 'string', index: false, optional: true },
  { name: 'seller_kind', type: 'string', facet: true, optional: true },
];

async function call(path: string, init: RequestInit = {}, allow: number[] = []): Promise<Response> {
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: { 'X-TYPESENSE-API-KEY': apiKey, 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok && !allow.includes(res.status)) {
    throw new Error(`typesense ${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res;
}

export async function aliasTarget(): Promise<string | null> {
  const res = await call(`/aliases/${alias}`, {}, [404]);
  return res.ok ? ((await res.json()) as { collection_name: string }).collection_name : null;
}

/** First boot: create listings_v1 and point the `listings` alias at it. */
export async function ensureCollection(): Promise<void> {
  if (await aliasTarget()) return;
  const name = `${alias}_v1`;
  const existing = await call(`/collections/${name}`, {}, [404]);
  if (existing.status === 404) await createCollection(name);
  await pointAlias(name);
}

export async function createCollection(name: string): Promise<void> {
  await call('/collections', { method: 'POST', body: JSON.stringify({ name, fields: FIELDS, default_sorting_field: 'posted_at' }) });
}

export async function dropCollection(name: string): Promise<void> {
  await call(`/collections/${name}`, { method: 'DELETE' }, [404]);
}

export async function pointAlias(collection: string): Promise<void> {
  await call(`/aliases/${alias}`, { method: 'PUT', body: JSON.stringify({ collection_name: collection }) });
}

/** Bulk upsert (JSONL import). Throws if any document is rejected. */
export async function upsertDocs(docs: ListingDoc[], collection = alias): Promise<void> {
  if (!docs.length) return;
  const res = await call(`/collections/${collection}/documents/import?action=upsert`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: docs.map((d) => JSON.stringify(d)).join('\n'),
  });
  const results = (await res.text()).trim().split('\n').map((line) => JSON.parse(line) as { success: boolean; error?: string });
  const failed = results.filter((r) => !r.success);
  if (failed.length) throw new Error(`typesense import: ${failed.length}/${docs.length} rejected, first: ${failed[0].error}`);
}

export async function deleteDoc(id: string): Promise<void> {
  await call(`/collections/${alias}/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }, [404]);
}

export async function searchDocs(params: Record<string, string>): Promise<SearchResult> {
  const res = await call(`/collections/${alias}/documents/search?${new URLSearchParams(params)}`);
  return (await res.json()) as SearchResult;
}

export async function typesenseHealthy(): Promise<boolean> {
  try {
    return (await fetch(`${baseUrl}/health`)).ok;
  } catch {
    return false;
  }
}
