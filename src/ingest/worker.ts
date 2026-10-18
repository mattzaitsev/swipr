/**
 * Ingest process: schedules every connector task as a repeating BullMQ job, then runs them:
 *   connector.crawl() --gateway--> source  =>  raw items  =>  normalize()  =>  Postgres + outbox
 */
import { Queue, Worker } from 'bullmq';
import { config } from '../config';
import { connectors, getConnector, type CrawlTask } from '../connectors';
import { createGateway, RetryLater } from '../gateway';
import { bullConnection, createRedis } from '../redis';
import { isMain, logger, runMain } from '../runtime';
import { normalize, type NormalizeResult } from './normalize';

const log = logger('ingest');
const taskId = (t: CrawlTask) => `${t.source}:${t.query}:${t.area.label}`;
const deferKey = (t: CrawlTask) => `swipr:defer:${taskId(t)}`;

export async function start() {
  const queue = new Queue<CrawlTask>('ingest', { connection: bullConnection });
  const redis = createRedis();

  // Scheduler: one repeating job per task. Upserting on every boot keeps the schedule in sync with code.
  // EXTENSION POINT: per-source cadence (hot queries more often), and removing schedulers for retired tasks.
  for (const connector of connectors) {
    for (const task of connector.tasks()) {
      await queue.upsertJobScheduler(taskId(task), { every: config.ingest.everyMs }, {
        name: 'crawl',
        data: task,
        opts: { removeOnComplete: 100, removeOnFail: 500 },
      });
    }
  }

  const gateway = createGateway();
  const worker = new Worker<CrawlTask>(
    'ingest',
    async (job) => {
      const task = job.data;
      // Still inside a "not before" window from an earlier RetryLater: skip this run without a request.
      if (await redis.exists(deferKey(task))) return { deferred: true };

      const connector = getConnector(task.source);
      const counts: Record<NormalizeResult, number> = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
      try {
        for await (const item of connector.crawl(task, { gateway, log })) {
          counts[await normalize(connector, item)]++;
        }
      } catch (err) {
        // The gateway said "not now" (throttled, blocked, cooling down). Don't fail the job, and don't park
        // it either: the scheduler would keep adding runs behind it. Remember "not before" for this task
        // and let scheduled runs skip until then. Items already normalized are kept (normalize is idempotent).
        if (err instanceof RetryLater) {
          const waitMs = Math.max(1_000, err.retryAt - Date.now());
          await redis.set(deferKey(task), err.reason, 'PX', waitMs);
          log(`${taskId(task)} deferred ${Math.round(waitMs / 1000)}s: ${err.reason}`);
          return { ...counts, deferred: true };
        }
        throw err;
      }
      if (counts.created || counts.updated) log(taskId(task), counts);
      return counts;
    },
    { connection: bullConnection, concurrency: config.ingest.concurrency },
  );
  worker.on('failed', (job, err) => log(`${job ? taskId(job.data) : '?'} failed: ${err.message}`));

  log(`scheduled ${connectors.reduce((n, c) => n + c.tasks().length, 0)} crawl tasks every ${config.ingest.everyMs / 1000}s`);
  return async () => {
    await worker.close();
    await queue.close();
    await redis.quit();
  };
}

if (isMain(import.meta.url)) runMain(start);
