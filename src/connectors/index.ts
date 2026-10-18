import { demoConnector } from './demo';
import type { Connector } from './types';

/**
 * EXTENSION POINT: register real connectors here. Each one implements Connector (tasks/crawl/parse),
 * calls only ctx.gateway.fetch(), and gets its own policy in the gateway keyed by `source`.
 */
export const connectors: Connector[] = [demoConnector];

export function getConnector(source: string): Connector {
  const connector = connectors.find((c) => c.source === source);
  if (!connector) throw new Error(`no connector registered for source "${source}"`);
  return connector;
}

export type { Connector, CrawlTask, RawItem } from './types';
