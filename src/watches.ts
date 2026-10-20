/**
 * Personal deal-sniper watches (watches.json): what to look for, where, and how often.
 * Each watch becomes one newest-first, page-1 feed per source; new listings that pass its filters trigger an alert.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface SniperArea {
  label: string;
  city: string;
  region: string;
  country: string;
  lat: number;
  lng: number;
  radiusMi: number;                  // alerts only for listings placed within this distance (when their city is known)
  states: string[];                  // listing states/regions allowed (e.g. keeps Tijuana out of a San Diego area)
  facebookLocation: string;          // Facebook Marketplace location slug, e.g. "sandiego"
}

export interface Watch {
  id: string;
  query: string;
  sources: string[];                 // which connectors run this watch: "facebook", "offerup"
  minPrice?: number;                 // dollars
  maxPrice?: number;
  include?: string[];                // every word/phrase must appear in the title (case-insensitive)
  exclude?: string[];                // none may appear in the title
  everySec: number;                  // how often to check (floored per source by the gateway policy)
  maxAgeMin: number;                 // ignore listings older than this (renewed/bumped posts, catch-up after downtime)
}

export interface WatchFile {
  area: SniperArea;
  watches: Watch[];
}

const path = process.env.WATCHES_CONFIG || fileURLToPath(new URL('../watches.json', import.meta.url));

function fail(msg: string): never {
  throw new Error(`watches.json: ${msg}`);
}

export function loadWatches(): WatchFile | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    area?: Partial<SniperArea>;
    defaults?: Partial<Watch>;
    watches?: Array<Partial<Watch>>;
  };
  const a = raw.area ?? fail('missing "area"');
  for (const k of ['label', 'city', 'region', 'country', 'facebookLocation'] as const) if (typeof a[k] !== 'string') fail(`area.${k} must be a string`);
  for (const k of ['lat', 'lng', 'radiusMi'] as const) if (typeof a[k] !== 'number') fail(`area.${k} must be a number`);
  const area = { ...a, states: a.states ?? [a.region!] } as SniperArea;

  const d = raw.defaults ?? {};
  const ids = new Set<string>();
  const watches = (raw.watches ?? []).map((w, i): Watch => {
    if (typeof w.id !== 'string' || !/^[a-z0-9-]+$/.test(w.id)) fail(`watches[${i}].id must be lowercase letters, digits and dashes`);
    if (ids.has(w.id)) fail(`duplicate watch id "${w.id}"`);
    ids.add(w.id);
    if (typeof w.query !== 'string' || !w.query.trim()) fail(`watch "${w.id}" needs a query`);
    return {
      id: w.id,
      query: w.query.trim(),
      sources: w.sources ?? d.sources ?? ['facebook'],
      minPrice: w.minPrice ?? d.minPrice,
      maxPrice: w.maxPrice ?? d.maxPrice,
      include: w.include ?? d.include,
      exclude: w.exclude ?? d.exclude,
      everySec: Math.max(5, w.everySec ?? d.everySec ?? 120),
      maxAgeMin: w.maxAgeMin ?? d.maxAgeMin ?? 60,
    };
  });
  return { area, watches };
}
