/**
 * Public API: search (Typesense), listing detail (Postgres), saved searches + their hits (Postgres).
 */
import Fastify, { type FastifyRequest } from 'fastify';
import { config } from '../config';
import { pool } from '../db';
import { isMain, logger, runMain } from '../runtime';
import { buildSearch, distanceKm, nextCursor, type SearchInput } from '../search/query';
import { searchDocs, typesenseHealthy } from '../search/typesense';

const log = logger('api');
const CONDITIONS = ['new', 'used', 'refurbished', 'unknown'];
const idParams = { params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } };

/**
 * BETA AUTH: callers identify themselves with an `x-user-id` header and nothing verifies it.
 * EXTENSION POINT: replace with real auth (session cookie / JWT) and derive the user id from it.
 */
function userId(req: FastifyRequest): string {
  const id = req.headers['x-user-id'];
  if (typeof id !== 'string' || !id.trim()) throw Object.assign(new Error('x-user-id header required (Beta auth)'), { statusCode: 401 });
  return id.trim();
}

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export function buildApp() {
  const app = Fastify({ logger: false });

  app.get('/health', async () => {
    const pg = await pool.query('select 1').then(() => true, () => false);
    return { ok: pg && (await typesenseHealthy()), postgres: pg, typesense: await typesenseHealthy() };
  });

  // ── Search: keyword + geo radius + filters + cursor pagination ──
  app.get<{ Querystring: SearchInput }>(
    '/search',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 200 },
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lng: { type: 'number', minimum: -180, maximum: 180 },
            radius_km: { type: 'number', minimum: 1, maximum: 500, default: 25 },
            min_price: { type: 'number', minimum: 0 },
            max_price: { type: 'number', minimum: 0 },
            condition: { type: 'string', enum: CONDITIONS },
            source: { type: 'string', maxLength: 50 },
            category: { type: 'string', maxLength: 50 },
            sort: { type: 'string', enum: ['relevance', 'newest', 'price_asc', 'price_desc', 'distance'] },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
            cursor: { type: 'string', maxLength: 500 },
          },
          dependencies: { lat: ['lng'], lng: ['lat'] },
        },
      },
    },
    async (req) => {
      const input = req.query;
      const { params, sort, page } = buildSearch(input);
      const result = await searchDocs(params);
      const docs = result.hits.map((h) => h.document);
      return {
        sort,
        total: input.cursor ? undefined : result.found,      // with a keyset cursor, `found` only counts what's left
        next_cursor: nextCursor(sort, page, docs, input.limit, result.found),
        items: docs.map((d) => ({
          id: d.seq,
          title: d.title,
          price: d.price / 100,
          currency: d.currency,
          condition: d.condition,
          city: d.city,
          region: d.region,
          source: d.source,
          image: d.image,
          url: d.url,
          posted_at: new Date(d.posted_at * 1000).toISOString(),
          distance_km:
            d.location && input.lat !== undefined && input.lng !== undefined
              ? Math.round(distanceKm(d.location, input.lat, input.lng) * 10) / 10
              : undefined,
        })),
      };
    },
  );

  // ── Listing detail with images, seller and price history ──
  app.get<{ Params: { id: number } }>(
    '/listings/:id',
    { schema: idParams },
    async (req) => {
      const { rows } = await pool.query(
        `select l.id, l.source, l.external_id, l.url, l.title, l.description, l.price_cents, l.currency, l.condition,
                l.category, l.status, l.lat, l.lng, l.city, l.region, l.country, l.posted_at, l.first_seen_at,
                l.last_seen_at, l.cluster_key, s.display_name as seller_name, s.kind as seller_kind
         from listings l left join sellers s on s.id = l.seller_id where l.id = $1`,
        [req.params.id],
      );
      if (!rows.length) throw httpError(404, 'listing not found');
      const [images, prices] = await Promise.all([
        pool.query(`select position, source_url as url from listing_images where listing_id = $1 order by position`, [req.params.id]),
        pool.query(`select price_cents, currency, observed_at from price_history where listing_id = $1 order by observed_at`, [req.params.id]),
      ]);
      return { ...rows[0], images: images.rows, price_history: prices.rows };
    },
  );

  // ── Saved searches ──
  interface SavedSearchBody {
    name: string;
    query?: string;
    lat?: number;
    lng?: number;
    radius_km?: number;
    min_price?: number;
    max_price?: number;
    condition?: string;
    source?: string;
  }
  const SAVED_COLUMNS = `id, name, query, min_price_cents, max_price_cents, condition, source, radius_km, active, created_at,
    st_y(center::geometry) as lat, st_x(center::geometry) as lng`;

  app.post<{ Body: SavedSearchBody }>(
    '/saved-searches',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            query: { type: 'string', maxLength: 200 },
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lng: { type: 'number', minimum: -180, maximum: 180 },
            radius_km: { type: 'number', minimum: 1, maximum: 500 },
            min_price: { type: 'number', minimum: 0 },
            max_price: { type: 'number', minimum: 0 },
            condition: { type: 'string', enum: CONDITIONS },
            source: { type: 'string', maxLength: 50 },
          },
          dependencies: { lat: ['lng'], lng: ['lat'] },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const cents = (v?: number) => (v === undefined ? null : Math.round(v * 100));
      const { rows } = await pool.query(
        `insert into saved_searches (user_id, name, query, min_price_cents, max_price_cents, condition, source, radius_km, center)
         values ($1, $2, $3, $4, $5, $6, $7, $8,
                 case when $9::float8 is null then null else st_setsrid(st_makepoint($10::float8, $9::float8), 4326)::geography end)
         returning ${SAVED_COLUMNS}`,
        [userId(req), b.name, b.query?.trim() || null, cents(b.min_price), cents(b.max_price), b.condition ?? null,
         b.source ?? null, b.radius_km ?? 25, b.lat ?? null, b.lng ?? null],
      );
      return reply.code(201).send(rows[0]);
    },
  );

  app.get('/saved-searches', async (req) => {
    const { rows } = await pool.query(`select ${SAVED_COLUMNS} from saved_searches where user_id = $1 order by id desc`, [userId(req)]);
    return { items: rows };
  });

  app.get<{ Params: { id: number } }>('/saved-searches/:id/hits', { schema: idParams }, async (req) => {
    const { rows } = await pool.query(
      `select h.created_at as matched_at, l.id, l.title, l.price_cents, l.currency, l.city, l.status, l.url
       from saved_search_hits h
       join saved_searches s on s.id = h.saved_search_id
       join listings l on l.id = h.listing_id
       where s.id = $1 and s.user_id = $2
       order by h.created_at desc limit 100`,
      [req.params.id, userId(req)],
    );
    return { items: rows };
  });

  app.delete<{ Params: { id: number } }>('/saved-searches/:id', { schema: idParams }, async (req, reply) => {
    const { rowCount } = await pool.query(`delete from saved_searches where id = $1 and user_id = $2`, [req.params.id, userId(req)]);
    if (!rowCount) throw httpError(404, 'saved search not found');
    return reply.code(204).send();
  });

  return app;
}

export async function start() {
  const app = buildApp();
  await app.listen({ port: config.apiPort, host: '127.0.0.1' });
  log(`listening on http://localhost:${config.apiPort}`);
  return () => app.close();
}

if (isMain(import.meta.url)) runMain(start);
