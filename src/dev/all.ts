/**
 * `npm run dev`: every Beta process in one terminal. In production these run as separate deployments
 * (api, ingest worker, indexer, matcher), each via its own npm script.
 */
import { start as startMatcher, type AlertEvent } from '../alerts/matcher';
import { start as startApi } from '../api/server';
import { start as startWorker } from '../ingest/worker';
import { ALERTS_CHANNEL, createRedis } from '../redis';
import { logger, runMain } from '../runtime';
import { migrate } from '../scripts/migrate';
import { start as startIndexer } from '../search/indexer';
import { start as startMock } from './mock-source';

const log = logger('alerts');

runMain(async () => {
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
