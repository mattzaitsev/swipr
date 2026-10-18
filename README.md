# swipr (Beta)

A marketplace aggregator skeleton. It crawls listings through a fetch gateway, normalizes them into Postgres, projects them into Typesense for search, and alerts saved searches when matching listings appear.

```
                    ┌──────────────── ingest worker (BullMQ) ────────────────┐
 scheduler ─jobs─►  connector.crawl() ──► gateway.fetch() ──► source        │
                    │      │ raw items                                      │
                    │      ▼                                                │
                    │  normalize(): raw_events, listings, sellers, images,  │
                    │               price_history + outbox  (one tx)        │
                    └──────┬─────────────────────────────────────────────────┘
                           │ outbox (one row per consumer topic)
             ┌─────────────┴──────────────┐
             ▼ topic 'search'             ▼ topic 'alerts'
   indexer ──► Typesense            matcher ──► saved_search_hits ──► Redis pub/sub "swipr:alerts"
             ▲                                                          (email/push plugs in here)
   api: /search ─┘   /listings/:id, /saved-searches ──► Postgres
```

## Run it locally

Prerequisites: Node 22 or newer, and Docker Desktop.

```bash
npm install
npm run up         # Postgres+PostGIS (host port 5433), Redis (6379), Typesense (8108)
npm run migrate
npm run dev        # mock marketplace + ingest worker + indexer + matcher + API, in one terminal
```

In a second terminal:

```bash
npm run smoke      # end-to-end check: search, cursors, filters, detail, saved-search alert
```

The API is at http://localhost:4200. Nothing touches a real site: the demo connector crawls a local fake marketplace (`src/dev/mock-source.ts`, port 4210). The mock posts new listings every 8 seconds, drops prices and marks items sold, so updates, price history and alerts all run on their own.

Each process can also run on its own, which is how you'd deploy them: `npm run api`, `npm run worker`, `npm run indexer`, `npm run matcher`, `npm run mock`.

Settings and defaults are in `.env.example`. Copy it to `.env` to override any of them.

## Where the ingestion gateway plugs in

`src/gateway/index.ts` is the only seam:

- **The interface.** Connectors call `ctx.gateway.fetch(req)` and nothing else. They never see proxies, sessions or health state.
- **Swapping in the real gateway.** `createGateway()` returns `DirectGateway`, a stand-in that does plain HTTP with a timeout. On a 429 or 403 it throws `RetryLater`. Replace that one line with the real `FetchGateway`.
- **`RetryLater`.** When the gateway throws it (throttled, blocked or cooling down), the ingest worker stores a per-task "not before" marker in Redis. Scheduled runs skip that task until the marker expires. Nothing fails, and no requests go out during the wait. Run with `MOCK_FAIL_RATE=0.5` to see this.
- **Per-source policy.** The gateway selects its policy by `GatewayRequest.source`, which is the connector id. A source-specific body check (e.g. throttling reported inside an HTTP 200) belongs in that policy's `classifyBody`, not in the connector.

## Adding a real connector

1. Implement `Connector` (`src/connectors/types.ts`):
   - `tasks()`: what to poll (query × area).
   - `crawl()`: page through results with `ctx.gateway.fetch` and yield `{ externalId, payload }` as the source returned it.
   - `parse()`: a pure mapping from payload to `ListingDraft`.
2. Register it in `src/connectors/index.ts`.
3. Give it a policy in the gateway.

`parse()` is kept separate from `crawl()` because raw payloads are stored in `raw_events`. After a parser fix you can re-parse them without refetching.

## Data model (`db/migrations/001_init.sql`)

| Table | Purpose |
|---|---|
| `listings` | One row per `(source, external_id)`. `content_hash` detects real changes. `geog` (PostGIS) and `search_tsv` support alert matching. |
| `sellers` | Minimal seller identity per source. This is personal data, so keep it lean. |
| `listing_images` | Source image URLs by position. `content_hash` and `storage_key` are reserved for an image mirror. |
| `price_history` | A row on first sight and on every price change. |
| `raw_events` | Each distinct payload stored once, for replay and debugging. |
| `outbox` | Change events written in the same transaction as the listing, one row per consumer topic. |
| `saved_searches`, `saved_search_hits` | Alert definitions and their matches. `notified_at` is for delivery. |

**Dedupe and change detection:**
- **Re-crawls.** The same payload is stored once in `raw_events`, and an unchanged `content_hash` only bumps `last_seen_at`. A changed hash triggers an update, a price-history row if the price moved, and an outbox event.
- **Cross-posts.** `cluster_key` (normalized title + price bucket + ~5 km cell) is a crude grouping key. Real dedupe goes there.

## API

Saved-search routes need an `x-user-id` header. That's Beta-only auth; see `userId()` in `src/api/server.ts`.

```bash
# keyword + geo + filters (prices in dollars); sort: relevance|newest|price_asc|price_desc|distance
curl "localhost:4200/search?q=couch&lat=30.2672&lng=-97.7431&radius_km=25&max_price=500&condition=used"
curl "localhost:4200/search?sort=newest&limit=20&cursor=<next_cursor from the previous page>"
curl "localhost:4200/listings/1"

curl -X POST localhost:4200/saved-searches -H "x-user-id: me" -H "content-type: application/json" \
  -d '{"name":"Cheap couches","query":"couch","lat":30.2672,"lng":-97.7431,"radius_km":25,"max_price":400}'
curl -H "x-user-id: me" localhost:4200/saved-searches/1/hits
```

**Pagination:**
- `newest`, `price_asc` and `price_desc` use keyset cursors on `(field, seq)`. These stay stable while new listings arrive.
- `relevance` and `distance` use page cursors, because Typesense can't keyset on score or computed distance.

**Saved searches** match listings that arrive after the search is created. This is a reverse search on each new listing (`src/alerts/matcher.ts`).

## Operations

- `npm run reindex`: builds `listings_v{n+1}` from Postgres, swaps the `listings` alias to it, and drops the old collection. Searches always go through the alias.
- The outbox, indexer and matcher are at-least-once and idempotent. The indexer always reads current Postgres state, so replays and reordering are harmless.
- `npm run down` stops the containers. Add `-v` to `docker compose down` to wipe their data.

## Extension points (marked `EXTENSION POINT` in the code)

| Where | What goes there |
|---|---|
| `src/gateway/index.ts` | The real FetchGateway |
| `src/connectors/index.ts` | Real connectors |
| `src/ingest/worker.ts` | Per-source cadence; retiring schedulers for removed tasks |
| `src/ingest/normalize.ts` | Real cross-post dedupe; price-drop alerts |
| `src/search/documents.ts` | Serve mirrored images from your CDN instead of source URLs |
| `src/outbox.ts` | LISTEN/NOTIFY for lower latency; pruning processed rows |
| `src/alerts/matcher.ts` | Email/push delivery; batched or geo-sharded matching at scale |
| `src/api/server.ts` | Real auth |

## Known Beta gaps

- **Removal detection.** A listing missing from search results is not proof that it was removed: it may have just fallen past the pages crawled. Marking listings `removed` needs a per-listing refresh (detail fetch) for items whose `last_seen_at` has gone stale. It's deliberately not inferred here.
- **Images.** Images are referenced at the source, not mirrored. Source image URLs often expire.
- **No frontend, rate limiting on the API, or real auth yet.**
