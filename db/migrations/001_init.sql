-- swipr Beta schema. Postgres is the source of truth; Typesense is a rebuildable projection of it.
create extension if not exists postgis;

-- Sellers as the source shows them. Keep this minimal: it's personal data about private individuals.
create table sellers (
  id            bigserial primary key,
  source        text not null,
  external_id   text not null,
  display_name  text,
  kind          text not null default 'unknown' check (kind in ('individual', 'business', 'unknown')),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (source, external_id)
);

create table listings (
  id            bigserial primary key,
  source        text not null,                       -- connector id: 'demo', 'facebook', ...
  external_id   text not null,                       -- the listing's id at the source
  url           text not null,
  seller_id     bigint references sellers(id),
  title         text not null,
  description   text,
  price_cents   bigint not null,                     -- 0 = free
  currency      char(3) not null default 'USD',
  condition     text not null default 'unknown' check (condition in ('new', 'used', 'refurbished', 'unknown')),
  category      text,
  status        text not null default 'active' check (status in ('active', 'pending', 'sold', 'removed')),
  lat           double precision,
  lng           double precision,
  geog          geography(Point, 4326),              -- set from lat/lng by the normalizer
  city          text,
  region        text,
  country       char(2),
  posted_at     timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  content_hash  text not null,                       -- hash of the normalized fields; same hash = nothing changed
  cluster_key   text,                                -- crude cross-post grouping key (see normalize.ts)
  search_tsv    tsvector generated always as
                  (to_tsvector('english', title || ' ' || coalesce(description, ''))) stored,
  unique (source, external_id)
);
create index listings_geog_idx      on listings using gist (geog);
create index listings_tsv_idx       on listings using gin (search_tsv);
create index listings_cluster_idx   on listings (cluster_key);
create index listings_last_seen_idx on listings (source, last_seen_at) where status <> 'removed';

create table listing_images (
  listing_id   bigint not null references listings(id) on delete cascade,
  position     int not null,
  source_url   text not null,
  content_hash text,                                 -- filled by an image mirror worker (not in the Beta)
  storage_key  text,                                 -- e.g. images/<sha256>.webp on R2/S3 once mirrored
  primary key (listing_id, position)
);

create table price_history (
  id          bigserial primary key,
  listing_id  bigint not null references listings(id) on delete cascade,
  price_cents bigint not null,
  currency    char(3) not null,
  observed_at timestamptz not null default now()
);
create index price_history_listing_idx on price_history (listing_id, observed_at);

-- Raw connector payloads, stored once per distinct payload, so parsers can be fixed and replayed
-- without refetching. Prune on a schedule; move to object storage when it gets big.
create table raw_events (
  id           bigserial primary key,
  source       text not null,
  external_id  text not null,
  payload      jsonb not null,
  payload_hash text not null,
  fetched_at   timestamptz not null default now(),
  unique (source, external_id, payload_hash)
);

-- Transactional outbox: written in the same transaction as the listing change, one row per consumer
-- topic ('search' -> indexer, 'alerts' -> saved-search matcher). Consumers claim rows with SKIP LOCKED.
create table outbox (
  id           bigserial primary key,
  topic        text not null,
  event        text not null,                        -- listing.created | listing.updated | listing.removed
  listing_id   bigint not null,
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);
create index outbox_pending_idx on outbox (topic, id) where processed_at is null;

create table saved_searches (
  id              bigserial primary key,
  user_id         text not null,
  name            text not null,
  query           text,                              -- websearch syntax: couch -leather "mid century"
  min_price_cents bigint,
  max_price_cents bigint,
  condition       text,
  source          text,
  center          geography(Point, 4326),
  radius_km       double precision not null default 25,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
create index saved_searches_user_idx   on saved_searches (user_id);
create index saved_searches_center_idx on saved_searches using gist (center) where active;

create table saved_search_hits (
  saved_search_id bigint not null references saved_searches(id) on delete cascade,
  listing_id      bigint not null references listings(id) on delete cascade,
  created_at      timestamptz not null default now(),
  notified_at     timestamptz,                       -- set by the delivery worker (email/push), not in the Beta
  primary key (saved_search_id, listing_id)
);
