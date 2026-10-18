export type ListingStatus = 'active' | 'pending' | 'sold' | 'removed';
export type Condition = 'new' | 'used' | 'refurbished' | 'unknown';
export type SellerKind = 'individual' | 'business' | 'unknown';
/** approximate = the source's (fuzzed) coordinates; city = city centroid; area = centre of the search that found it. */
export type GeoPrecision = 'approximate' | 'city' | 'area';

/** One listing in source-neutral shape. Connectors produce these from raw payloads (Connector.parse). */
export interface ListingDraft {
  source: string;
  externalId: string;                // string, always (Marketplace ids exceed 2^53)
  url: string;                       // canonical listing URL, derived from the id
  title: string;
  description?: string;              // usually absent from search results; comes from a detail fetch
  priceCents: number;                // 0 = free
  originalPriceCents?: number;       // seller-shown struck-through "was" price
  currency: string;                  // ISO 4217
  condition: Condition;
  category?: string;
  status: ListingStatus;
  location?: { lat: number; lng: number; precision: GeoPrecision; city?: string; region?: string; country?: string };
  postedAt?: Date;
  seller?: { externalId: string; displayName?: string; kind: SellerKind };   // display info only
  imageUrls: string[];               // signed CDN URLs; they expire (see normalize.ts imageExpiry)
}
