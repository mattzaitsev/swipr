import type { ListingDraft } from '../domain';
import type { Gateway } from '../gateway';
import type { Logger } from '../runtime';

/** One repeating unit of crawl work: a query in an area. The scheduler turns each into a BullMQ job. */
export interface CrawlTask {
  source: string;
  query: string;
  area: { label: string; lat: number; lng: number; radiusKm: number; country: string; region?: string };
  maxPages: number;
}

/** A payload exactly as the source returned it. Stored in raw_events before parsing. */
export interface RawItem {
  externalId: string;
  payload: unknown;
}

export interface ConnectorContext {
  gateway: Gateway;                  // the only way a connector may touch the network
  log: Logger;
}

export interface Connector {
  readonly source: string;

  /** What to poll, and how often is set by the scheduler (INGEST_EVERY_MS). */
  tasks(): CrawlTask[];

  /** Fetch one task's results through ctx.gateway and yield raw items, page by page.
   *  Let RetryLater from the gateway propagate; the worker reschedules the job. */
  crawl(task: CrawlTask, ctx: ConnectorContext): AsyncIterable<RawItem>;

  /** Pure function: raw payload -> ListingDraft, or null to skip (ads, malformed rows).
   *  Kept separate from crawl() so stored raw_events can be re-parsed after a parser fix. */
  parse(item: RawItem): ListingDraft | null;
}
