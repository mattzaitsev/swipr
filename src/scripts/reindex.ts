/**
 * Zero-downtime full reindex: build listings_v{n+1} from Postgres, point the `listings` alias at it,
 * drop the old collection. Use after changing the Typesense schema or the document shape.
 * Changes indexed into the old collection during the copy are re-applied by replaying the outbox
 * (or just run the indexer again): every event re-reads current state, so replay is safe.
 */
import { pool } from '../db';
import { isMain, logger, runMain } from '../runtime';
import { allDocs } from '../search/documents';
import { aliasTarget, createCollection, dropCollection, pointAlias, upsertDocs } from '../search/typesense';
import { config } from '../config';

const log = logger('reindex');

async function reindex() {
  const current = await aliasTarget();
  const version = Number(current?.match(/_v(\d+)$/)?.[1] ?? 0) + 1;
  const next = `${config.typesense.alias}_v${version}`;

  await createCollection(next);
  let count = 0;
  for await (const batch of allDocs(pool)) {
    await upsertDocs(batch, next);
    count += batch.length;
  }
  await pointAlias(next);
  if (current) await dropCollection(current);
  log(`${count} listings -> ${next}; alias "${config.typesense.alias}" now points at it`);
}

if (isMain(import.meta.url)) runMain(() => reindex().finally(() => pool.end()));
