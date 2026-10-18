/** Builds flows for a crawl task: shared session + geo, connector headers and classifier on every request. */
import type { Gateway } from '../gateway';
import type { Connector, CrawlTask, Flow, FlowOptions } from './types';

export const searchId = (s: { source: string; query: string; area: { label: string } }) => `${s.source}:${s.query}:${s.area.label}`;

export function openFlow(gateway: Gateway, connector: Connector, task: CrawlTask, kind: string, options: FlowOptions = {}): Flow {
  const sessionKey = options.sessionKey === undefined ? searchId(task) : options.sessionKey;
  const geo = options.geo ?? { country: task.area.country, region: task.area.region, city: task.area.city };
  const classify = connector.classifyResponse
    ? (status: number, body: Buffer) => connector.classifyResponse!(status, body, { kind })
    : undefined;

  return {
    kind,
    sessionKey,
    fetch: (req) =>
      gateway.fetch({
        source: connector.source,
        url: req.url,
        method: req.method,
        body: req.body,
        headers: { ...connector.requestHeaders?.(req, { kind, task }), ...req.headers },
        geo,
        sessionKey: sessionKey ?? undefined,
        flow: kind,
        classify,
      }),
  };
}
