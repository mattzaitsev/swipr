/**
 * Beta gateway: direct or proxied HTTP (per source), per-source pacing, cooldowns from response verdicts,
 * a daily byte budget for proxied traffic, and request-strategy hooks with structured events.
 *
 * Per attempt:  baseline plan -> [beforeRequest] -> pace + send -> classify -> [afterResponse] -> verdict handling
 *               transport error or 5xx -> [onRetryableError] -> retry (bounded) or the baseline outcome
 * With the default strategy every hook is inert, so behavior is the baseline.
 */
import type { Redis } from 'ioredis';
import { fetch } from 'undici';
import { config } from '../config';
import { sleep } from '../runtime';
import { RetryLater, SourceChanged } from './errors';
import { gatewayEvents, type EventInput, type Side, type Verdict } from './events';
import type { Gateway, GatewayRequest, GatewayResponse } from './index';
import { policyFor } from './policies';
import { proxyAgentFor, proxyEnabled, rotateSession, sessionIdFor } from './proxy';
import { strategyFor, type Failure, type RequestContext, type RequestStrategy, type RetryDecision } from './strategy';

const REQUEST_OVERHEAD_BYTES = 2_048;                    // rough headers + TLS share; providers bill both directions
/**
 * Identity headers: what a site uses to tell which browser is calling. Supported ways to set them:
 *  1. USER_AGENT in config (all sources), or
 *  2. a connector's requestHeaders()/flow headers, for sources listed in CONNECTOR_IDENTITY_HEADERS (pinned per source).
 * Anything else (an unlisted connector, any strategy) is stripped and reported as headers.rejected.
 */
const IDENTITY_HEADERS = /^(user-agent|sec-ch-ua(-.*)?)$/i;

const BASELINE = { by: 'baseline', origin: 'baseline' } as const;

export class HttpGateway implements Gateway {
  private nextSlot = new Map<string, number>();         // pacing per source
  private slowNext = new Map<string, number>();         // one-shot slowdowns requested in afterResponse
  private seenSessions = new Set<string>();
  private pinnedIdentity = new Map<string, Record<string, string>>();   // source -> connector identity headers
  private settings = config.requestStrategy;

  constructor(private redis: Redis) {}

  async fetch(req: GatewayRequest): Promise<GatewayResponse> {
    const policy = policyFor(req.source);
    const strategy = strategyFor(req.source, this.settings);
    const proxied = policy.proxy && proxyEnabled();
    const emit = (e: EventInput) => gatewayEvents.emit({ ...e, source: req.source, flow: req.flow } as Parameters<typeof gatewayEvents.emit>[0]);
    const byStrategy = { by: strategy.name, origin: 'strategy' } as const;

    for (let attempt = 0; ; attempt++) {
      // ── Baseline plan: static config headers, then the connector's per-request headers ──
      const { identity, rest } = splitIdentity(lowerKeys(req.headers ?? {}));
      const headers: Record<string, string> = {
        ...(this.settings.headers.userAgent ? { 'user-agent': this.settings.headers.userAgent } : {}),
        ...(this.settings.headers.acceptLanguage ? { 'accept-language': this.settings.headers.acceptLanguage } : {}),
        ...rest,
        ...this.connectorIdentity(req.source, identity, attempt === 0 ? emit : () => {}),
      };
      let sessionMode = this.settings.session.mode;
      let extraDelayMs = 0;
      const ctx: RequestContext = { req, attempt, policy, settings: this.settings, proxied, sessionMode, headers: { ...headers } };

      // ── Hook 1: beforeRequest ──
      // EXTENSION POINT: session preference per flow, extra ordinary headers, politeness delay (settings.timing).
      await strategy.beforeRequest?.(ctx, {
        setHeader: (name, value, reason) => {
          if (IDENTITY_HEADERS.test(name)) {
            emit({ type: 'headers.rejected', names: [name.toLowerCase()],
              reason: `strategies can't set identity headers; use USER_AGENT or CONNECTOR_IDENTITY_HEADERS (${reason})`, ...byStrategy });
            return;
          }
          headers[name.toLowerCase()] = value;
          emit({ type: 'headers.applied', names: [name.toLowerCase()], ...byStrategy });
        },
        addDelay: (ms, reason) => {
          const d = Math.min(Math.max(0, ms), this.settings.timing.maxStrategyDelayMs);
          extraDelayMs += d;
          emit({ type: 'timing.adjusted', delayMs: d, reason, ...byStrategy });
        },
        useSessionMode: (mode, reason) => {
          if (mode === sessionMode) return;
          sessionMode = mode;
          emit({ type: 'session.mode', mode, reason, ...byStrategy });
        },
        note: (name, labels = {}) => emit({ type: 'strategy.note', name, labels, ...byStrategy }),
      });

      // ── Send ──
      await this.waitTurn(req.source, policy.minIntervalMs, extraDelayMs);
      if (proxied) await this.checkBudget(req.source);
      const sticky = !!req.sessionKey && sessionMode === 'sticky';
      const sessionId = proxied && sticky ? sessionIdFor(req) : undefined;
      if (sessionId && !this.seenSessions.has(sessionId)) {
        this.trackSession(sessionId);
        emit({ type: 'session.started', sessionId, reason: 'new flow', ...BASELINE });
      }
      emit({ type: 'request.sent', attempt, proxied, session: !proxied ? 'direct' : sticky ? 'sticky' : 'rotating', sessionId, ...BASELINE });

      const started = performance.now();
      let status: number;
      let resHeaders: Headers;
      let body: Buffer;
      try {
        const res = await fetch(req.url, {
          method: req.method ?? 'GET',
          headers,
          body: req.body,
          dispatcher: proxied ? proxyAgentFor(req, sessionId) : undefined,
          signal: AbortSignal.timeout(policy.timeoutMs),
        });
        status = res.status;
        resHeaders = res.headers as unknown as Headers;
        body = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        // ── Hook 3a: transport failure (timeout, refused, proxy error) ──
        const failure = classifyError(err, proxied);
        emit({ type: 'error.classified', attempt, side: failure.side, kind: failure.kind, message: failure.message, ...BASELINE });
        const decision = await this.decide(strategy, ctx, failure, req, emit);
        if (decision.action === 'retry') {
          await sleep(decision.delayMs);
          continue;
        }
        throw err;                                       // baseline: the job fails; the next scheduled run tries again
      }

      const ms = Math.round(performance.now() - started);
      if (proxied) await this.meter(body.length + (req.body?.length ?? 0) + REQUEST_OVERHEAD_BYTES);
      const verdict: Verdict = status === 429 ? 'throttled' : status === 403 ? 'blocked' : (req.classify?.(status, body) ?? 'ok');
      emit({ type: 'request.completed', attempt, status, verdict, ms, bytes: body.length, ...BASELINE });

      // ── Hook 2: afterResponse (observe; may only slow down later requests) ──
      // EXTENSION POINT: adapt pacing to latency or partial errors per source/flow.
      await strategy.afterResponse?.(ctx, { status, verdict, ms, bytes: body.length }, {
        slowDownNext: (delayMs, reason) => {
          const d = Math.min(Math.max(0, delayMs), this.settings.timing.maxStrategyDelayMs);
          this.slowNext.set(req.source, Math.max(this.slowNext.get(req.source) ?? 0, d));
          emit({ type: 'timing.adjusted', delayMs: d, reason: `next request: ${reason}`, ...byStrategy });
        },
        note: (name, labels = {}) => emit({ type: 'strategy.note', name, labels, ...byStrategy }),
      });

      // ── Verdicts: fixed baseline handling that strategies can't override ──
      // EXTENSION POINT (Marketplace recovery): with the full gateway these feed health tracking and the
      // RecoveryStrategy (cooldown -> probe -> ramp) instead of fixed cooldowns.
      const retryAfterSec = Number(resHeaders.get('retry-after'));
      const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : undefined;
      if (verdict === 'throttled') {
        throw new RetryLater(Date.now() + (retryAfterMs ?? policy.throttledCooldownMs), `${req.source} throttled (${status === 429 ? 'HTTP 429' : 'in-body'})`);
      }
      if (verdict === 'blocked') {
        throw new RetryLater(Date.now() + (retryAfterMs ?? policy.blockedCooldownMs), `${req.source} blocked (${status === 403 ? 'HTTP 403' : 'login wall/checkpoint'})`, 'source');
      }
      if (verdict === 'changed') throw new SourceChanged(req.source, 'unexpected response body');

      if (status >= 500) {
        // ── Hook 3b: target server error ──
        const failure: Failure = { side: 'target', kind: `http_${status}`, message: `${req.source} HTTP ${status}` };
        emit({ type: 'error.classified', attempt, side: 'target', kind: failure.kind, message: failure.message, ...BASELINE });
        const decision = await this.decide(strategy, ctx, failure, req, emit);
        if (decision.action === 'retry') {
          await sleep(decision.delayMs);
          continue;
        }
        throw new RetryLater(Date.now() + policy.serverErrorCooldownMs, failure.message);
      }
      return { status, headers: Object.fromEntries(resHeaders), body };
    }
  }

  /** Ask the strategy about a retryable failure; enforce the attempt cap and delay cap. */
  private async decide(strategy: RequestStrategy, ctx: RequestContext, failure: Failure, req: GatewayRequest,
                       emit: (e: EventInput) => void): Promise<RetryDecision> {
    const byStrategy = { by: strategy.name, origin: 'strategy' } as const;
    const note = (name: string, labels: Record<string, string | number> = {}) => emit({ type: 'strategy.note', name, labels, ...byStrategy });
    // Identity controls only for proxy-side failures (a dead exit node), never for anything the target said.
    const act = failure.side === 'proxy'
      ? {
          note,
          rotateSession: (reason: string) => {
            if (!req.sessionKey) return;                 // rotating requests get a new exit IP anyway
            const sessionId = rotateSession(req);
            this.trackSession(sessionId);
            emit({ type: 'session.rotated', sessionId, reason, ...byStrategy });
          },
        }
      : { note };
    const decision = (await strategy.onRetryableError?.(ctx, failure, act)) ?? { action: 'give_up' as const };
    if (decision.action !== 'retry') return decision;
    if (ctx.attempt + 1 >= this.settings.retry.maxAttempts) {
      emit({ type: 'retry.refused', attempt: ctx.attempt, side: failure.side, reason: `REQUEST_MAX_ATTEMPTS=${this.settings.retry.maxAttempts}`, ...byStrategy });
      return { action: 'give_up' };
    }
    const delayMs = Math.min(Math.max(0, decision.delayMs), this.settings.timing.maxStrategyDelayMs);
    emit({ type: 'retry.scheduled', attempt: ctx.attempt, side: failure.side, delayMs, reason: decision.reason, ...byStrategy });
    return { ...decision, delayMs };
  }

  /** Space requests to one source at least `minIntervalMs` apart (per process), plus any strategy delay. */
  private async waitTurn(source: string, minIntervalMs: number, extraDelayMs: number) {
    const oneShot = this.slowNext.get(source) ?? 0;
    this.slowNext.delete(source);
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(source) ?? 0) + extraDelayMs + oneShot;
    this.nextSlot.set(source, slot + Math.max(0, minIntervalMs));
    if (slot > now) await sleep(slot - now);
  }

  /**
   * Connector-supplied identity headers. Default: stripped + headers.rejected. With the source listed in
   * CONNECTOR_IDENTITY_HEADERS: the first values seen are pinned for that source and applied to every request;
   * a later, different value is rejected (restart to change), so the opt-in can't turn into per-request rotation.
   */
  private connectorIdentity(source: string, offered: Record<string, string>, emit: (e: EventInput) => void): Record<string, string> {
    const names = Object.keys(offered);
    const byConnector = { by: 'connector', origin: 'baseline' } as const;
    if (!this.settings.headers.connectorIdentitySources.includes(source)) {
      if (names.length) emit({ type: 'headers.rejected', names, reason: `identity headers from a connector need CONNECTOR_IDENTITY_HEADERS=${source}`, ...byConnector });
      return {};
    }
    const pinned = this.pinnedIdentity.get(source) ?? {};
    const added = names.filter((n) => !(n in pinned));
    const changed = names.filter((n) => n in pinned && pinned[n] !== offered[n]);
    for (const n of added) pinned[n] = offered[n];
    this.pinnedIdentity.set(source, pinned);
    if (added.length) emit({ type: 'headers.applied', names: added, ...byConnector });
    if (changed.length) emit({ type: 'headers.rejected', names: changed, reason: 'identity headers are pinned per source; restart to change them', ...byConnector });
    return pinned;
  }

  private trackSession(sessionId: string) {
    this.seenSessions.add(sessionId);
    if (this.seenSessions.size > 10_000) this.seenSessions.delete(this.seenSessions.values().next().value!);
  }

  private budgetKey = () => `swipr:proxy-bytes:${new Date().toISOString().slice(0, 10)}`;

  private async checkBudget(source: string) {
    if (config.proxy.dailyMb <= 0) return;
    const used = Number(await this.redis.get(this.budgetKey())) || 0;
    if (used >= config.proxy.dailyMb * 1024 * 1024) {
      const tomorrow = new Date();
      tomorrow.setUTCHours(24, 0, 0, 0);
      throw new RetryLater(tomorrow.getTime(), `${source}: proxy budget of ${config.proxy.dailyMb} MB/day used`, 'source');
    }
  }

  private async meter(bytes: number) {
    const key = this.budgetKey();
    await this.redis.multi().incrby(key, bytes).expire(key, 3 * 86_400).exec();
  }
}

const lowerKeys = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

function splitIdentity(h: Record<string, string>) {
  const identity: Record<string, string> = {};
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) (IDENTITY_HEADERS.test(k) ? identity : rest)[k] = v;
  return { identity, rest };
}

/**
 * Transport errors. Through a proxy we can't always tell a dead exit node from a reset by the target, so anything
 * that fails before an HTTP response counts as proxy-side; direct failures are 'network'.
 */
function classifyError(err: unknown, proxied: boolean): Failure {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  const message = String(e?.cause?.message ?? e?.message ?? err).replace(/\/\/[^@/\s]+@/g, '//***@');
  const code = String(e?.cause?.code ?? e?.code ?? e?.name ?? 'error');
  const kind = /timeout|abort/i.test(code) ? 'timeout' : /\b407\b/.test(message) ? 'proxy_auth' : code.toLowerCase();
  const side: Side = proxied ? 'proxy' : 'network';
  return { side, kind, message };
}
