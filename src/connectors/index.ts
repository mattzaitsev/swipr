import { config } from '../config';
import { logger } from '../runtime';
import { createFacebookConnector } from './facebook';
import { createMarketplaceConnector } from './marketplace';
import { OFFERUP_PENDING } from './offerup';
import type { Connector } from './types';

/** The local mock marketplace (src/dev/mock-source.ts): same wire shape as the real connector, zero cost. */
export const mockConnector = createMarketplaceConnector({
  source: 'mock',
  endpoint: `${config.mock.url}/api/graphql/`,
  docIds: { search: 'mock-search-v1' },
  listingUrl: (id) => `${config.mock.publicUrl}/marketplace/item/${id}/`,
  cadence: { newEveryMs: config.mock.newEveryMs, refreshEveryMs: config.mock.refreshEveryMs },
  maxPages: 4,
  pageSize: 8,                       // small pages so the incremental stop is visible locally
  stopAfterKnown: 5,
});

/**
 * ─── EXTENSION POINT: register connectors here ───
 * SOURCES picks which ones run (default: mock only). The personal sniper runs SOURCES=facebook;
 * watches in watches.json choose what each one searches for.
 */
const available: Record<string, () => Connector> = {
  mock: () => mockConnector,
  facebook: () => createFacebookConnector(),
};
const pending: Record<string, string> = { offerup: OFFERUP_PENDING };

export const connectors: Connector[] = config.sources.flatMap((source) => {
  if (available[source]) return [available[source]()];
  logger('ingest')(`SOURCES includes "${source}": ${pending[source] ?? 'no connector with that name'}; skipping it`);
  return [];
});

export function getConnector(source: string): Connector {
  const connector = connectors.find((c) => c.source === source);
  if (!connector) throw new Error(`no connector registered for source "${source}"`);
  return connector;
}

export type { Connector, CrawlTask, RawItem, SearchSpec } from './types';
