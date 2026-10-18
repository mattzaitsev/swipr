/** Applies db/migrations/*.sql in name order, each once, each in its own transaction. */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool, tx } from '../db';
import { isMain, logger, runMain } from '../runtime';

const log = logger('migrate');
const dir = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

export async function migrate() {
  await pool.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set((await pool.query<{ name: string }>(`select name from schema_migrations`)).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(dir + file, 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query(`insert into schema_migrations (name) values ($1)`, [file]);
    });
    log(`applied ${file}`);
  }
  log('schema up to date');
}

if (isMain(import.meta.url)) runMain(() => migrate().finally(() => pool.end()));
