-- Facebook Marketplace realities.
--
-- Listing ids: Marketplace ids are numeric strings longer than 2^53. external_id stays text; never parse it as a number.
-- Geo: search results carry approximate coordinates at best, sometimes only a city. Record how precise ours are.
-- Prices: sellers show a struck-through "was" price; we also keep our own observed history in price_history.
-- Images: CDN URLs are signed and expire (e.g. an `oe=` hex timestamp). Store the expiry, never index the URLs,
--         and refresh them from crawls. Mirroring to our own storage is a later step (content_hash/storage_key).
-- Sellers: display info only (name, kind). Never follow sellers to their profiles.

alter table listings
  add column geo_precision text check (geo_precision in ('approximate', 'city', 'area')),
  add column original_price_cents bigint;               -- seller-shown "was" price, if any

comment on column listings.geo_precision is
  'approximate = source coordinates (fuzzed); city = city centroid; area = centre of the search area that found it';
comment on column listings.external_id is 'source listing id as text (Marketplace ids exceed 2^53)';

alter table listing_images
  add column expires_at timestamptz;                    -- parsed from the signed URL; null = unknown

alter table raw_events
  add column context jsonb not null default '{}';       -- which query + area found it (geo fallback, debugging)

create index listing_images_expiry_idx on listing_images (expires_at) where expires_at is not null;
