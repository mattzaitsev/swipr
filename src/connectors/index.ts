import { config } from '../config';
import { createMarketplaceConnector } from './marketplace';
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
 * ─── EXTENSION POINT: register real connectors here ───
 * Facebook Marketplace: build `facebookConnector` in ./facebook.ts (checklist there), then add it below.
 */
export const connectors: Connector[] = [mockConnector];

export function getConnector(source: string): Connector {
  const connector = connectors.find((c) => c.source === source);
  if (!connector) throw new Error(`no connector registered for source "${source}"`);
  return connector;
}

export type { Connector, CrawlTask, RawItem, SearchSpec } from './types';
