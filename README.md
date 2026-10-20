# swipr

A marketplace aggregator, built to connect to Facebook Marketplace. It runs as a single-machine local MVP. It crawls location-scoped searches through a fetch gateway, normalizes listings into Postgres/PostGIS, indexes them in Typesense, and alerts saved searches when new matches appear.

```
                     ┌──────────────────────── ingest worker (BullMQ) ─────────────────────────┐
 schedules ─jobs─►   connector.crawl() ─flow─► gateway (strategy hooks, proxy, pacing) ─► source │
 (new + refresh)     │      │ raw items                                                         │
                     │      ▼                                                                   │
                     │  normalize(): raw_events, listings, sellers, images, price_history       │
                     │               + outbox  (one transaction)                                │
                     └──────┬──────────────────────────────────────────────────────────────────┘
                            │ outbox (one row per consumer topic)
              ┌─────────────┴──────────────┐
              ▼ 'search'                   ▼ 'alerts'
    indexer ──► Typesense           matcher ──► saved_search_hits ──► Redis pub/sub
              ▲                                                         (email/push later)
    api: /search ─┘ (+ fresh image URLs from Postgres)    /listings/:id, /saved-searches ──► Postgres
```

## Local MVP

You need Docker Desktop. Node is optional and only used for the host-side scripts.

| | Command |
|---|---|
| Start everything (build + run) | `docker compose up -d --build` |
| Open the UI | http://localhost:4200/ui |
| Watch logs | `docker compose logs -f app` |
| Check the pipeline end to end | `docker compose exec app node --import tsx src/scripts/smoke.ts` |
| Stop (keeps data) | `docker compose down` |
| Reset (wipes all data) | `docker compose down -v` |
| Apply code changes | `docker compose restart app` (`src/` is mounted) |

With Node installed, the npm shortcuts are `npm run up | logs | down | reset | smoke`.

- **What runs:** Postgres + PostGIS, Redis, Typesense, and one app container. The app container runs the mock marketplace, the ingest worker, the indexer, the matcher and the API.
- **Ports:** everything binds to `127.0.0.1` only. The API is http://localhost:4200 and the mock marketplace is http://localhost:4210.
- **Cost:** none. The only source is a local mock marketplace. It speaks the same wire shape as the real connector and behaves the way Marketplace does: listings appear, prices drop, items sell, image URLs expire, and it can rate-limit.
- **Running the app on the host instead:** `docker compose up -d postgres redis typesense`, then `npm install && npm run dev`. Stop the `app` container first so the two don't crawl twice.

**What to search** is set in `search.config.json` as queries × areas, where each area is a point, a radius, and a country/region. **Everything else** is in `.env`; copy `.env.example`. Every setting has a default that works locally.

## Personal deal sniper (Facebook Marketplace)

The sniper watches Facebook Marketplace for new listings near you and alerts your phone within minutes, with no login. Each watch in `watches.json` is a newest-first search. The sniper reads only page 1, which is what a logged-out visitor sees, and alerts on listings that weren't there last time.

1. **Edit `watches.json`.** Set the area (default: Downtown San Diego, 40 mi) and your watches: `query`, plus optional `minPrice`/`maxPrice`, `include`/`exclude` words, `everySec` (at least 60) and `maxAgeMin`.
2. **Phone alerts.** Install the ntfy app and subscribe to a topic name nobody could guess. Set `NTFY_TOPIC` to that name. Without it, alerts appear only in `docker compose logs -f app`.
3. **Test offline first.** This runs the real Facebook connector against the local mock, so no Facebook requests are made:
   `SOURCES=facebook FACEBOOK_BASE_URL=http://localhost:4210 docker compose up -d`
4. **Go live.** Set `SOURCES=facebook` and leave `FACEBOOK_BASE_URL` unset. Then check the logs during the first few minutes (see "First live run").

**How it behaves:**
- **Baseline.** A watch's first check records what's already up and alerts only on listings younger than `maxAgeMin`. After that, any listing new to the feed is a candidate.
- **One alert per listing**, even when several watches match it.
- **Filters.** A listing must be active, within your price range and words, younger than `maxAgeMin`, and within the radius. Facebook only gives a city, so position uses a city table in `src/geo/places.ts`. Listings in other states (e.g. Tijuana) are skipped.
- **Politeness.** At least 4 s between requests and at least 60 s between checks of one watch.
- **Login wall.** A page with no results is treated as a login wall and pauses all Facebook checks for 60 minutes.
- **Changed page.** If the page shape changes, you get one alert and Facebook checks pause for 30 minutes.

**What the first live run showed (2026-10-19):**
- **It works.** The request headers return 24 embedded listings per search, and the `minPrice`/`maxPrice` URL parameters are applied by Facebook.
- **Logged-out results are delayed.** Facebook treats cookie-less requests as a crawler and serves them a search snapshot that runs **1–2 hours behind** what a signed-in browser sees. Its responses are marked `no-store`, so this is deliberate, not a cache. Fresh results are reserved for the browser path. Getting them would mean disguising the agent as a browser, which this project doesn't do.
- **What that means for alerts.** Alerts arrive roughly 1–2 hours after posting. Set `maxAgeMin` to at least 120, or nothing qualifies. For real-time alerts, use Facebook's own saved-search notifications in the app.

Price is also enforced locally, so the second is harmless if Facebook ignores it. If the logs show `response shape changed`, adjust the headers.

**OfferUp** isn't fitted yet. It needs one saved logged-out search page; see `src/connectors/offerup.ts`.

**Boundaries:** logged out, page 1 only, cooldowns on throttles and blocks, no browser impersonation. Automated collection is against Facebook's terms; this is for personal use.

## UI and live web search

http://localhost:4200/ui is a single page (`web/index.html`, no build step) with two tabs. Both centre on the first area in `search.config.json`: Downtown San Diego, 40 mi.

- **Web:** live results from the Oxylabs Web API through `GET /web-search` (`src/integrations/oxylabs.ts`).
  - The key stays on the server.
  - Results rank for the area's country and add the city to the query.
  - Marketplace sites are tagged, and prices are pulled out of the snippets.
  - Results are cached for 10 minutes, and searches are capped at 30 per minute, because every upstream call spends credits.
- **Listings:** swipr's own index (`GET /search`) within the area radius, with sort and "Load more".

**Enabling web search:** set `OXYLABS_WEB_API_KEY` as a user environment variable, then run `docker compose up -d` from a shell that has it. Compose passes it into the app container. Without it the Web tab says it isn't configured.

## Adding a residential proxy later (no code changes)

```env
PROXY_URL=http://gate.your-provider.example:7000
PROXY_USERNAME=...
PROXY_PASSWORD=...
PROXY_USERNAME_TEMPLATE={user}-country-{country}[-region-{region}][-session-{session}-sesstime-{ttl}]
PROXY_SOURCES=facebook        # only these sources use the proxy; the mock never does
PROXY_DAILY_MB=200            # hard daily cap on proxied bandwidth
```

- **Username template.** Copy the exact format from your provider's docs. `[…]` marks optional parts, dropped when a placeholder inside them is empty. That way one template covers both rotating requests (no session) and sticky ones.
- **Sticky sessions.** These come from connector flows: every page of one search shares a session, so one exit IP serves the whole search. The exit location follows the search area.
- **Budget.** Proxied bytes are counted per day in Redis. When `PROXY_DAILY_MB` runs out, crawling pauses until midnight UTC.

## Shaped for Facebook Marketplace

| Marketplace reality | How swipr handles it |
|---|---|
| Search is a GraphQL POST (`doc_id` + `variables`) with location, radius and cursor pages | `createMarketplaceConnector()` in `src/connectors/marketplace.ts`. The mock speaks the same shape. |
| You re-crawl the same searches all day | Each search has two schedules. **new** (frequent) sorts newest first and stops after `stopAfterKnown` listings it already has in a row. **refresh** (rare) walks every page to catch price drops and sold items. |
| Paging should look like one visit | A connector opens a **flow** per search. Its requests share one session (one exit IP when proxied) and the search's geo. |
| Ids are numeric strings longer than 2^53 | They are stored as text everywhere and never parsed as numbers. |
| Search results have approximate coordinates, or only a city | `geo_precision` records which: `approximate` when the source gave coordinates, `area` when it falls back to the search area's centre. A fallback never overwrites known coordinates. |
| Sellers show a struck-through "was" price | `original_price_cents`, alongside our own observed `price_history`. |
| Image URLs are signed and expire (`oe=`) | `listing_images.expires_at`. The signature is left out of change detection, so a new signature isn't counted as an update. URLs stay out of the search index; the API reads fresh ones from Postgres. |
| Failures arrive inside HTTP 200 (rate limits, login walls), and `doc_id`s rotate | The connector's `classifyResponse` reads these signals and the gateway acts. Throttled pauses the search. Blocked pauses the whole source. A changed shape fails, alerts once, and pauses the source until a restart. |
| Sellers are people | Display name and kind only. The crawler never follows sellers to their profiles. |

## Facebook Marketplace: where it plugs in

1. **Connector:** `src/connectors/facebook.ts` holds the intended shape and a checklist: verify field paths against captured responses, keep the `doc_id` in env, add a detail fetch. Then register it in `src/connectors/index.ts`.
2. **Response signals:** `classifyMarketplace()` in `src/connectors/marketplace.ts`. Confirm it against real throttle and block responses.
3. **Pacing and cooldowns:** the `facebook` entry in `src/gateway/policies.ts`.
4. **Recovery:** a strategy's `onVerdict` / `onRetryableError` hooks, using the recovery primitives. The full FetchGateway (health tracking, cooldown → probe → ramp) replaces `HttpGateway` in `createGateway()` (`src/gateway/index.ts`).
5. **Request strategies:** `src/gateway/strategy.ts`. Register one and select it with `REQUEST_STRATEGY=facebook=<name>`.
6. **Proxy:** the env vars above. Add `facebook` to `PROXY_SOURCES`; it's already the default.
7. **Alerts to a human:** the `SourceChanged` handler in `src/ingest/worker.ts`.

Boundaries in the design:
- Logged-out access to public listings only.
- No accounts, no CAPTCHA solving, no browser-fingerprint headers.
- On a block, wait out the cooldown. Identity changes only after proxy-side failures.

## Request strategies

**Connectors declare, the gateway decides.** A connector states its URLs, search area, flows (which requests share a session), protocol headers and how to read its source's responses. Every request-handling decision lives in the gateway's strategy layer (`src/gateway/strategy.ts`). Adding or swapping a strategy never touches connectors, the normalizer, outbox, indexer or API: register it and select it with `REQUEST_STRATEGY=<source>=<name>`.

| Hook | When | What a strategy can do |
|---|---|---|
| `beforeRequest` | Before every attempt | Add ordinary headers, add delay, choose a sticky or rotating session |
| `afterResponse` | After the response is classified | Observe; adjust pacing or concurrency for later requests |
| `onVerdict` | Throttled or blocked | Choose cooldown length and scope at or above the floor; slow the source |
| `onRetryableError` | Proxy/network failure or target 5xx | Retry (bounded by `REQUEST_MAX_ATTEMPTS`) or give up. `rotateSession` is present only for proxy-side failures |

**Recovery primitives** are available in every hook, bound to the request's source. They're also public on the gateway for ops tooling:
- `setMinInterval`: pacing, never below the policy value.
- `setConcurrency`: 1 up to the policy's `maxConcurrency`.
- `delayNext`: a one-shot delay before the next request.

Cooldowns are set through `onVerdict`. Session rotation is offered in `onRetryableError`. Built-in examples, registered but off by default:
- `retry-proxy-once`: retries a proxy failure once on a fresh session.
- `conservative-backoff`: doubles the throttle cooldown and drops concurrency to 1.

**Guardrails** (`src/gateway/guardrails.ts`) are three fixed rules; everything else is open:
1. **Identity headers.** `user-agent` and `sec-ch-ua*` never come from a strategy. The static ways to set them are `USER_AGENT`, or a connector's headers for sources listed in `CONNECTOR_IDENTITY_HEADERS` (pinned per source, and logged at startup).
2. **Cooldown floor.** A throttle or block always ends in a cooldown at least as long as `Retry-After` or the policy value, and at least as wide as the gateway's scope. Strategies can lengthen or widen it.
3. **Identity changes.** Session rotation happens only after proxy-side failures, never in response to the target. Proxy routing is config (`PROXY_SOURCES`).

Each time a rule applies, a `guardrail.applied` event records it.

**Settings** live in the `RequestStrategySettings` type in `src/config.ts`: session mode, headers, timing ranges, retries and event logging. They load from env, and the defaults change nothing. Per-source baselines and floors are in `src/gateway/policies.ts`.

**Events** (`src/gateway/events.ts`) are labelled `origin: baseline | strategy` with `by: <strategy name>`. They cover:
- requests and their verdicts
- session starts and rotations
- headers (names only)
- timing, pacing and concurrency changes
- cooldown decisions
- error classification and retries
- guardrail applications

Set `GATEWAY_EVENTS=log` to print them.

## API

Saved-search routes need an `x-user-id` header. That's Beta auth; see `userId()` in `src/api/server.ts`.

```bash
# keyword + geo + filters (prices in dollars); sort: relevance|newest|price_asc|price_desc|distance
curl "localhost:4200/search?q=couch&lat=32.7157&lng=-117.1611&radius_km=64.4&max_price=500"
curl "localhost:4200/search?sort=newest&limit=20&cursor=<next_cursor>"
curl "localhost:4200/listings/1"
curl -X POST localhost:4200/saved-searches -H "x-user-id: me" -H "content-type: application/json" \
  -d '{"name":"Cheap couches","query":"couch","lat":32.7157,"lng":-117.1611,"radius_km":64.4,"max_price":400}'
curl -H "x-user-id: me" localhost:4200/saved-searches/1/hits
```

**Pagination:**
- `newest`, `price_asc` and `price_desc` use keyset cursors, which stay stable while new listings arrive.
- `relevance` and `distance` use page cursors.

**Saved searches** match listings that arrive after the search is created.

## Testing failure modes against the mock (zero cost)

| Set in `.env`, then `docker compose up -d` | You should see |
|---|---|
| `MOCK_FAIL_RATE=0.5` | "Rate limit exceeded" inside HTTP 200s, and `… paused 30s: mock throttled (in-body)` |
| `MOCK_ACCEPT_DOC_ID=mock-search-v2` | A rotated doc_id. One `ALERT … response shape changed`, then the source pauses |
| `MOCK_IMAGE_TTL_MIN=1` | Images expire quickly; refresh crawls renew them |
| `GATEWAY_EVENTS=log` | Every gateway event, labelled baseline or strategy |

## Data model

`db/migrations/001_init.sql` and `002_marketplace.sql`:

| Table | Purpose |
|---|---|
| `listings` | Keyed by `(source, external_id)`. `content_hash` (excluding volatile fields) detects real changes. Also holds `geo_precision` and `original_price_cents`. |
| `sellers` | Display name and kind only. |
| `listing_images` | Signed source URLs with `expires_at`. `content_hash`/`storage_key` are reserved for mirroring. |
| `price_history` | A row on first sight and on every observed price change. |
| `raw_events` | Each distinct payload stored once, plus the search that found it, for replay and debugging. |
| `outbox` | Change events, one row per consumer topic, written in the same transaction as the listing. |
| `saved_searches`, `saved_search_hits` | Alert definitions and matches. |

`npm run reindex` rebuilds the Typesense collection behind the `listings` alias with no downtime.

## Known gaps

- **Removal detection.** A listing missing from search results isn't proof it was removed. Marking listings `removed` needs a detail fetch for listings whose `last_seen_at` has gone stale.
- **Thin search results.** They carry no description, condition or extra photos; those also come from a detail fetch.
- **Images.** They aren't mirrored yet: expired ones show as `image: null` until a refresh crawl renews them.
- **Auth and frontend.** There's no real auth and no frontend yet.
