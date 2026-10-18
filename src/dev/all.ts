/**
 * Every swipr process in one: what the app container runs, and `npm run dev` on the host.
 * In production these become separate deployments (api, ingest worker, indexer, matcher).
 */
import { start as startMatcher, type AlertEvent } from '../alerts/matcher';
import { start as startApi } from '../api/server';
import { pool } from '../db';
import { start as startWorker } from '../ingest/worker';
import { ALERTS_CHANNEL, createRedis } from '../redis';
import { logger, runMain, sleep } from '../runtime';
import { migrate } from '../scripts/migrate';
import { start as startIndexer } from '../search/indexer';
import { typesenseHealthy } from '../search/typesense';
import { start as startMock } from './mock-source';

const log = logger('alerts');

/** Wait for Postgres, Redis and Typesense (Typesense takes a few seconds after its container starts). */
async function waitForDeps() {
  const redis = createRedis();
  for (let attempt = 1; ; attempt++) {
    const [pg, rd, ts] = await Promise.all([
      pool.query('select 1').then(() => true, () => false),
      redis.ping().then(() => true, () => false),
      typesenseHealthy(),
    ]);
    if (pg && rd && ts) break;
    if (attempt === 40) throw new Error(`dependencies not ready: postgres=${pg} redis=${rd} typesense=${ts}`);
    await sleep(1_500);
  }
  await redis.quit();
}

runMain(async () => {
  await waitForDeps();
  await migrate();
  await startMock();
  await startIndexer();
  await startMatcher();
  await startApi();
  await startWorker();

  // Stand-in for email/push delivery: print saved-search matches as they happen.
  const sub = createRedis();
  await sub.subscribe(ALERTS_CHANNEL);
  sub.on('message', (_channel, message) => {
    const e = JSON.parse(message) as AlertEvent;
    log(`[${e.user_id}] "${e.saved_search_name}" -> #${e.listing_id} ${e.title} $${e.price_cents / 100} (${e.city})`);
  });
});
