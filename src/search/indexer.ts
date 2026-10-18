/**
 * Indexer process: outbox topic 'search' -> Typesense.
 * Loads each listing's *current* row and upserts it, so duplicate or out-of-order events are harmless.
 */
import { runConsumer } from '../outbox';
import { isMain, logger, runMain } from '../runtime';
import { loadDocs } from './documents';
import { deleteDoc, ensureCollection, upsertDocs } from './typesense';

const log = logger('indexer');

export async function start() {
  await ensureCollection();
  const stop = runConsumer('indexer', 'search', async (rows, c) => {
    const ids = [...new Set(rows.map((r) => r.listing_id))];
    const docs = await loadDocs(c, ids);
    const live = docs.filter((d) => d.status !== 'removed');
    const liveIds = new Set(live.map((d) => d.id));

    await upsertDocs(live);
    for (const id of ids) if (!liveIds.has(String(id))) await deleteDoc(String(id));
    log(`indexed ${live.length}, removed ${ids.length - live.length}`);
  });
  log('consuming outbox topic "search"');
  return stop;
}

if (isMain(import.meta.url)) runMain(start);
