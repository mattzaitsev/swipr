export type ListingStatus = 'active' | 'pending' | 'sold' | 'removed';
export type Condition = 'new' | 'used' | 'refurbished' | 'unknown';
export type SellerKind = 'individual' | 'business' | 'unknown';

/** One listing in source-neutral shape. Connectors produce these from raw payloads (Connector.parse). */
export interface ListingDraft {
  source: string;
  externalId: string;
  url: string;
  title: string;
  description?: string;
  priceCents: number;                // 0 = free
  currency: string;                  // ISO 4217
  condition: Condition;
  category?: string;
  status: ListingStatus;
  location?: { lat: number; lng: number; city?: string; region?: string; country?: string };
  postedAt?: Date;
  seller?: { externalId: string; displayName?: string; kind: SellerKind };
  imageUrls: string[];
}
