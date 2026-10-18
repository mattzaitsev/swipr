/**
 * Saved-search matcher: outbox topic 'alerts' -> saved_search_hits -> Redis pub/sub "new listing" events.
 * A reverse search: for each new listing, find the saved searches it satisfies (one SQL statement).
 */
import { ALERTS_CHANNEL, createRedis } from '../redis';
import { runConsumer } from '../outbox';
import { isMain, logger, runMain } from '../runtime';

const log = logger('matcher');

export interface AlertEvent {
  type: 'saved_search.match';
  saved_search_id: number;
  saved_search_name: string;
  user_id: string;
  listing_id: number;
  title: string;
  price_cents: number;
  city: string | null;
}

// Keyword matching uses Postgres full-text search (close to, but not identical with, Typesense's /search).
// EXTENSION POINT at scale: shard saved searches by geo cell, or batch new listings per minute and match
// in bulk, instead of one statement per listing.
const MATCH_SQL = `
  with hits as (
    insert into saved_search_hits (saved_search_id, listing_id)
    select s.id, l.id
    from listings l
    join saved_searches s on s.active
    where l.id = $1
      and l.status = 'active'
      and (s.query is null or l.search_tsv @@ websearch_to_tsquery('english', s.query))
      and (s.min_price_cents is null or l.price_cents >= s.min_price_cents)
      and (s.max_price_cents is null or l.price_cents <= s.max_price_cents)
      and (s.condition is null or l.condition = s.condition)
      and (s.source is null or l.source = s.source)
      and (s.center is null or st_dwithin(l.geog, s.center, s.radius_km * 1000))
    on conflict do nothing
    returning saved_search_id, listing_id
  )
  select h.saved_search_id, s.name as saved_search_name, s.user_id, h.listing_id, l.title, l.price_cents, l.city
  from hits h
  join saved_searches s on s.id = h.saved_search_id
  join listings l on l.id = h.listing_id`;

export async function start() {
  const redis = createRedis();
  const stop = runConsumer('matcher', 'alerts', async (rows, c) => {
    for (const row of rows) {
      if (row.event !== 'listing.created') continue;
      const { rows: hits } = await c.query<Omit<AlertEvent, 'type'>>(MATCH_SQL, [row.listing_id]);
      for (const hit of hits) {
        // At-least-once: if this transaction rolls back after publishing, the event can repeat.
        // Delivery workers dedupe on (saved_search_id, listing_id) and set saved_search_hits.notified_at.
        // EXTENSION POINT: email / push delivery subscribes to ALERTS_CHANNEL (or polls notified_at is null).
        const event: AlertEvent = { type: 'saved_search.match', ...hit };
        await redis.publish(ALERTS_CHANNEL, JSON.stringify(event));
      }
      if (hits.length) log(`listing ${row.listing_id} matched ${hits.length} saved search(es)`);
    }
  });
  log('consuming outbox topic "alerts"');
  return async () => {
    stop();
    await redis.quit();
  };
}

if (isMain(import.meta.url)) runMain(start);
