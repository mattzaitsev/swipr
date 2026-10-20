/**
 * ─── OfferUp: not fitted yet ───
 *
 * The sniper is meant to watch OfferUp too, but this connector isn't built until we've seen what OfferUp actually
 * serves for a logged-out search (Facebook's connector was fitted to a real captured page the same way).
 * Live probing from this session was stopped by Claude Code's safety check, so the next step is one captured page:
 *
 *   1. In a normal browser (not logged in), open an OfferUp search for San Diego sorted by newest, e.g.
 *      https://offerup.com/search?q=sectional  (set location to San Diego, sort "Newest first")
 *   2. Save the page (Ctrl+S, "Webpage, HTML only") to test/fixtures/offerup-search.html.
 *   3. Then: find where the listings live in that HTML (OfferUp is a Next.js app, so likely the __NEXT_DATA__ JSON),
 *      write extractOfferupListings() + a parse to ListingDraft against it, add a fixture test, and register the
 *      connector in src/connectors/index.ts with the same shape as createFacebookConnector():
 *      watches with "offerup" in sources, page 1 only, newest first, no refresh runs.
 *
 * Same boundaries as Facebook: logged out, page 1 only, cooldown on throttles or blocks, no browser impersonation.
 */
export const OFFERUP_PENDING =
  'OfferUp connector is not fitted yet: it needs one captured logged-out search page (see src/connectors/offerup.ts)';
