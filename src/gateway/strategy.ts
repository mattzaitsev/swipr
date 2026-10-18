/**
 * Request strategies: pluggable behavior at three points of every gateway request.
 *
 *   beforeRequest   -> may add ordinary headers, add delay, pick sticky/rotating session (incl. on retries)
 *   afterResponse   -> observes the classified response; may slow down the *next* request to this source
 *   onRetryableError-> decides retry vs give up for proxy-side failures, network errors and target 5xx
 *
 * Boundaries the gateway enforces, whatever a strategy does:
 *  - Throttled / blocked responses never reach onRetryableError: they always end in the policy cooldown
 *    (RetryLater). Strategies observe them in afterResponse; they can't retry through them or shorten them.
 *  - Identity controls (session rotation) are handed out only for proxy-side failures, never for target signals.
 *  - Strategies can't set identity headers (user-agent, sec-ch-ua*), with or without any opt-in. The supported
 *    paths are static: USER_AGENT in config, or a connector's headers for sources listed in
 *    CONNECTOR_IDENTITY_HEADERS (pinned per source). See IDENTITY_HEADERS in http-gateway.ts.
 *  - Delay can only be added (capped by config), and attempts never exceed requestStrategy.retry.maxAttempts.
 */
import type { RequestStrategySettings } from '../config';
import type { GatewayRequest } from './index';
import type { Side, Verdict } from './events';
import type { SourcePolicy } from './policies';

/** Read-only view of the request being made. */
export interface RequestContext {
  readonly req: Readonly<GatewayRequest>;
  readonly attempt: number;                       // 0 on the first try
  readonly policy: Readonly<SourcePolicy>;
  readonly settings: Readonly<RequestStrategySettings>;
  readonly proxied: boolean;
  readonly sessionMode: 'sticky' | 'rotating';    // current plan (baseline: sticky when the request has a sessionKey)
  readonly headers: Readonly<Record<string, string>>;   // headers planned so far (baseline + connector)
}

export interface ResponseInfo {
  status: number;
  verdict: Verdict;
  ms: number;
  bytes: number;
}

export interface Failure {
  side: Side;                                     // 'proxy' (exit node/provider), 'network' (direct), 'target' (5xx)
  kind: string;                                   // e.g. 'timeout', 'proxy_auth', 'econnreset', 'http_502'
  message: string;
}

export type RetryDecision = { action: 'retry'; delayMs: number; reason: string } | { action: 'give_up' };

interface NoteActions {
  /** Emit a strategy.note event (labels show up in GATEWAY_EVENTS=log and any metrics subscriber). */
  note(name: string, labels?: Record<string, string | number>): void;
}

export interface BeforeActions extends NoteActions {
  /** Add an ordinary header. Identity headers (user-agent, sec-ch-ua*) are always rejected and reported (headers.rejected). */
  setHeader(name: string, value: string, reason: string): void;
  /** Wait this much longer before sending (added on top of policy pacing; capped by settings.timing.maxStrategyDelayMs). */
  addDelay(ms: number, reason: string): void;
  /** Sticky = keep the flow's exit IP; rotating = new exit IP per request. */
  useSessionMode(mode: 'sticky' | 'rotating', reason: string): void;
}

export interface AfterActions extends NoteActions {
  /** Delay the next request to this source by `ms` (one-shot, capped). Slowing down is the only lever here. */
  slowDownNext(ms: number, reason: string): void;
}

export interface ProxyFailureActions extends NoteActions {
  /** Move this flow to a fresh proxy session (new exit IP). Only offered for proxy-side failures. */
  rotateSession(reason: string): void;
}

export interface RequestStrategy {
  readonly name: string;
  beforeRequest?(ctx: RequestContext, act: BeforeActions): void | Promise<void>;
  afterResponse?(ctx: RequestContext, res: ResponseInfo, act: AfterActions): void | Promise<void>;
  /** `act` includes rotateSession only when failure.side === 'proxy'. */
  onRetryableError?(ctx: RequestContext, failure: Failure, act: NoteActions | ProxyFailureActions): RetryDecision | Promise<RetryDecision>;
}

/**
 * Default: no hooks act, so behavior is exactly the baseline (no retries, no extra delay, no extra headers).
 * EXTENSION POINT: write new strategies next to this one and register them below; pick per source with
 * REQUEST_STRATEGY=facebook=<name>. Natural places for later logic:
 *  - beforeRequest: per-flow session preference (e.g. rotating for one-off detail fetches), accept-language
 *    matching the search area, extra politeness delay from settings.timing.extraDelayMs.
 *  - afterResponse: slow down a source when latency climbs or partial GraphQL errors appear.
 *  - onRetryableError: retry proxy timeouts once on a fresh session; retry 5xx with backoff.
 */
export const defaultStrategy: RequestStrategy = {
  name: 'default',
  onRetryableError: () => ({ action: 'give_up' }),
};

/** Example of a small strategy built on the hooks (registered, not enabled by default). */
export const retryProxyFailuresOnce: RequestStrategy = {
  name: 'retry-proxy-once',
  onRetryableError(ctx, failure, act) {
    if (failure.side !== 'proxy' || ctx.attempt > 0) return { action: 'give_up' };
    if ('rotateSession' in act) act.rotateSession(`${failure.kind} on attempt ${ctx.attempt}`);
    return { action: 'retry', delayMs: ctx.settings.retry.baseDelayMs, reason: failure.kind };
  },
};

const registry = new Map<string, RequestStrategy>([
  [defaultStrategy.name, defaultStrategy],
  [retryProxyFailuresOnce.name, retryProxyFailuresOnce],
]);

export function registerStrategy(strategy: RequestStrategy): void {
  registry.set(strategy.name, strategy);
}

export function strategyFor(source: string, settings: RequestStrategySettings): RequestStrategy {
  const name = settings.strategyBySource[source] ?? settings.strategyBySource['*'] ?? 'default';
  return registry.get(name) ?? defaultStrategy;
}
