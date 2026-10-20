/**
 * City centroids for Southern California (and the border), to place listings that only carry a city name.
 * Facebook Marketplace search results give "Oceanside, CA" but no coordinates, and a "San Diego" search reaches far
 * past 40 miles (Anaheim, Riverside, Tijuana), so the sniper uses these to enforce its radius.
 * Approximate (2-decimal) centroids: good to ~1-2 km, plenty for a 40-mile cut. Add cities as they show up in logs.
 */
const PLACES: Record<string, [number, number]> = {
  // San Diego County
  'san diego|ca': [32.72, -117.16], 'la jolla|ca': [32.83, -117.27], 'pacific beach|ca': [32.8, -117.24],
  'chula vista|ca': [32.64, -117.08], 'national city|ca': [32.68, -117.1], 'imperial beach|ca': [32.58, -117.11],
  'coronado|ca': [32.69, -117.18], 'bonita|ca': [32.66, -117.03], 'spring valley|ca': [32.74, -116.99],
  'lemon grove|ca': [32.74, -117.03], 'la mesa|ca': [32.77, -117.02], 'el cajon|ca': [32.79, -116.96],
  'santee|ca': [32.84, -116.97], 'lakeside|ca': [32.86, -116.92], 'alpine|ca': [32.84, -116.77],
  'jamul|ca': [32.72, -116.88], 'poway|ca': [32.96, -117.04], 'ramona|ca': [33.04, -116.87],
  'escondido|ca': [33.12, -117.09], 'san marcos|ca': [33.14, -117.17], 'vista|ca': [33.2, -117.24],
  'carlsbad|ca': [33.16, -117.35], 'oceanside|ca': [33.2, -117.38], 'encinitas|ca': [33.04, -117.29],
  'solana beach|ca': [32.99, -117.27], 'del mar|ca': [32.96, -117.27], 'rancho santa fe|ca': [33.02, -117.2],
  'valley center|ca': [33.22, -117.03], 'bonsall|ca': [33.29, -117.23], 'fallbrook|ca': [33.38, -117.25],
  'camp pendleton|ca': [33.31, -117.35],
  // Riverside County (south)
  'temecula|ca': [33.49, -117.15], 'murrieta|ca': [33.55, -117.21], 'wildomar|ca': [33.6, -117.28],
  'lake elsinore|ca': [33.67, -117.33], 'menifee|ca': [33.73, -117.15], 'perris|ca': [33.78, -117.23],
  'hemet|ca': [33.75, -116.97], 'riverside|ca': [33.95, -117.4], 'corona|ca': [33.88, -117.57],
  // Orange County
  'san clemente|ca': [33.43, -117.61], 'dana point|ca': [33.47, -117.7], 'san juan capistrano|ca': [33.5, -117.66],
  'laguna niguel|ca': [33.52, -117.71], 'aliso viejo|ca': [33.57, -117.73], 'mission viejo|ca': [33.6, -117.67],
  'laguna hills|ca': [33.61, -117.71], 'rancho santa margarita|ca': [33.64, -117.6], 'lake forest|ca': [33.65, -117.69],
  'irvine|ca': [33.68, -117.83], 'tustin|ca': [33.75, -117.83], 'santa ana|ca': [33.75, -117.87],
  'costa mesa|ca': [33.64, -117.92], 'newport beach|ca': [33.62, -117.93], 'huntington beach|ca': [33.66, -118.0],
  'garden grove|ca': [33.77, -117.94], 'orange|ca': [33.79, -117.85], 'anaheim|ca': [33.84, -117.91],
  'fullerton|ca': [33.87, -117.92], 'fountain valley|ca': [33.71, -117.95], 'westminster|ca': [33.75, -117.99],
  'buena park|ca': [33.87, -118.0], 'cypress|ca': [33.82, -118.04], 'placentia|ca': [33.87, -117.87],
  'brea|ca': [33.92, -117.9], 'yorba linda|ca': [33.89, -117.81], 'laguna beach|ca': [33.54, -117.78],
  'laguna woods|ca': [33.61, -117.73], 'seal beach|ca': [33.74, -118.1],
  // Inland Empire, desert and LA area (outside 40 mi of San Diego, but they show up in its feeds)
  'redlands|ca': [34.06, -117.18], 'san bernardino|ca': [34.11, -117.29], 'moreno valley|ca': [33.94, -117.23],
  'fontana|ca': [34.09, -117.44], 'rancho cucamonga|ca': [34.11, -117.59], 'ontario|ca': [34.06, -117.65],
  'beaumont|ca': [33.93, -116.98], 'banning|ca': [33.93, -116.88], 'palm springs|ca': [33.83, -116.55],
  'palm desert|ca': [33.72, -116.37], 'indio|ca': [33.72, -116.22], 'long beach|ca': [33.77, -118.19],
  'los angeles|ca': [34.05, -118.24], 'torrance|ca': [33.84, -118.34], 'pomona|ca': [34.06, -117.75],
  // Imperial County / Baja California
  'el centro|ca': [32.79, -115.56], 'tijuana|baja california': [32.51, -117.04], 'rosarito|baja california': [32.36, -117.06],
};

const STATE_ABBR: Record<string, string> = { california: 'ca' };

/** Centroid for "City" + "State" as Facebook reports them ("Oceanside", "CA" or "California"), or null. */
export function placeCentroid(city?: string, state?: string): { lat: number; lng: number } | null {
  if (!city) return null;
  const s = (state ?? '').trim().toLowerCase();
  const key = `${city.trim().toLowerCase()}|${STATE_ABBR[s] ?? s}`;
  const hit = PLACES[key];
  return hit ? { lat: hit[0], lng: hit[1] } : null;
}

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
