/**
 * Request-handling guardrails, kept in one place on purpose.
 *
 * Everything else about request handling is open to strategies through hooks and primitives (strategy.ts):
 * timing, pacing, concurrency, retries, sticky/rotating sessions, cooldown length and scope, and recovery from
 * proxy failures. These three rules are deliberately not configurable:
 *
 *  1. IDENTITY HEADERS: user-agent and sec-ch-ua* never come from a strategy. Static paths only: USER_AGENT in
 *     config, or a connector's headers for sources listed in CONNECTOR_IDENTITY_HEADERS (pinned per source).
 *  2. COOLDOWN FLOOR: a throttle or block from the target always ends in a cooldown at least as long as the
 *     Retry-After header or policy value, at least as wide as the gateway's scope. Strategies may lengthen or widen it,
 *     never skip or shorten it.
 *  3. IDENTITY CHANGES: session rotation is offered only after proxy-side failures (a dead exit node), never in
 *     response to anything the target said. Whether a source goes through the proxy is config (PROXY_SOURCES).
 *
 * Why: these are the levers that turn "back off when the site says no" into "get past the site saying no".
 * Each time a rule applies, a `guardrail.applied` event is emitted so its effect is visible in measurements.
 */

export type GuardrailRule = 'identity-headers' | 'cooldown-floor' | 'identity-change';

/** Rule 1: headers a site uses to tell which browser is calling. */
export const IDENTITY_HEADERS = /^(user-agent|sec-ch-ua(-.*)?)$/i;

export type CooldownScope = 'search' | 'source';
export interface CooldownPlan {
  ms: number;
  scope: CooldownScope;
}

/** Rule 2: the effective cooldown is never shorter or narrower than the floor. */
export function applyCooldownFloor(requested: CooldownPlan, floor: CooldownPlan): { plan: CooldownPlan; clamped: boolean } {
  const plan: CooldownPlan = {
    ms: Math.max(requested.ms, floor.ms),
    scope: requested.scope === 'source' || floor.scope === 'source' ? 'source' : 'search',
  };
  return { plan, clamped: plan.ms !== requested.ms || plan.scope !== requested.scope };
}

/** Rule 3: whether identity controls may be offered for a failure on this side. */
export const identityChangeAllowed = (side: 'proxy' | 'network' | 'target') => side === 'proxy';
