import type pg from 'pg';
import { tx } from './db';
import { logger, sleep } from './runtime';

export type OutboxTopic = 'search' | 'alerts';
export type OutboxEvent = 'listing.created' | 'listing.updated' | 'listing.removed';

export interface OutboxRow {
  id: number;
  topic: OutboxTopic;
  event: OutboxEvent;
  listing_id: number;
  payload: Record<string, unknown>;
  created_at: Date;
}

/** Write one outbox row per consumer topic, inside the caller's transaction. */
export async function emit(c: pg.PoolClient, topics: OutboxTopic[], event: OutboxEvent, listingId: number, payload: object = {}) {
  await c.query(
    `insert into outbox (topic, event, listing_id, payload)
     select t, $2, $3, $4 from unnest($1::text[]) as t`,
    [topics, event, listingId, payload],
  );
}

/**
 * Claim up to `batchSize` pending rows for `topic` and hand them to `handle` in the same transaction.
 * Rows are marked processed only if `handle` succeeds; SKIP LOCKED lets several consumers run in parallel.
 * Delivery is at-least-once, so handlers must be idempotent.
 */
async function consumeBatch(topic: OutboxTopic, batchSize: number, handle: (rows: OutboxRow[], c: pg.PoolClient) => Promise<void>) {
  return tx(async (c) => {
    const { rows } = await c.query<OutboxRow>(
      `select * from outbox where topic = $1 and processed_at is null order by id limit $2 for update skip locked`,
      [topic, batchSize],
    );
    if (rows.length) {
      await handle(rows, c);
      await c.query(`update outbox set processed_at = now() where id = any($1)`, [rows.map((r) => r.id)]);
    }
    return rows.length;
  });
}

/**
 * Poll a topic until stopped. EXTENSION POINT: add LISTEN/NOTIFY to cut idle latency, and a cron that
 * deletes processed rows older than a few days.
 */
export function runConsumer(
  name: string,
  topic: OutboxTopic,
  handle: (rows: OutboxRow[], c: pg.PoolClient) => Promise<void>,
  { batchSize = 200, idleMs = 1_000 } = {},
): () => void {
  const log = logger(name);
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const n = await consumeBatch(topic, batchSize, handle);
        if (n === 0) await sleep(idleMs);
      } catch (err) {
        log(`batch failed, retrying in 5s: ${(err as Error).message}`);
        await sleep(5_000);
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
