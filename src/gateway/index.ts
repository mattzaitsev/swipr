/**
 * ─── PLUG POINT: the ingestion fetch gateway ───────────────────────────────────────────────
 * Connectors depend only on the `Gateway` interface below and never see proxies, sessions or
 * health state. The real FetchGateway (proxy pools, sticky sessions, breaker, recovery
 * strategies, byte metering) is developed separately; swap it in inside `createGateway()`.
 * Nothing else in the Beta needs to change.
 */

export interface Geo {
  country: string;
  region?: string;
  city?: string;
}

export interface GatewayRequest {
  source: string;                    // connector id; the gateway picks its policy by this
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  geo?: Geo;                         // where the request should appear to come from, if it matters
  sessionKey?: string;               // set => sticky session; omit => rotating
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface Gateway {
  fetch(req: GatewayRequest): Promise<GatewayResponse>;
}

/** "Not now": the ingest worker catches this and reschedules the job for `retryAt` instead of failing it. */
export class RetryLater extends Error {
  constructor(public retryAt: number, public reason: string) {
    super(`retry later: ${reason}`);
    this.name = 'RetryLater';
  }
}

/**
 * Beta stand-in: direct HTTP with a timeout and a polite reaction to 429/403 (back off, don't push).
 * No proxies, no per-source rate limits, no breaker. Those live in the real gateway.
 */
export class DirectGateway implements Gateway {
  constructor(private timeoutMs = 15_000) {}

  async fetch(req: GatewayRequest): Promise<GatewayResponse> {
    const res = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status === 429 || res.status === 403) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5 * 60_000;
      throw new RetryLater(Date.now() + waitMs, `${req.source} HTTP ${res.status}`);
    }
    return { status: res.status, headers: Object.fromEntries(res.headers), body };
  }
}

export function createGateway(): Gateway {
  // Replace with the real gateway, e.g.:
  //   return new FetchGateway(provider, policies, health, sessions, usage, emit);
  return new DirectGateway();
}
