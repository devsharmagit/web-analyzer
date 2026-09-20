// Location extraction — Phase 4. Answers Q9: how many locations, and their info.
// JSON-LD LocalBusiness first, then locations.kml (a Rank Math / Yoast Local
// SEO sitemap of <Placemark> entries — the local-sitemap.xml child sitemap
// Phase 1 already discovers points here), then a /locations/ page.

import type { AnalyzedPage } from "./crawl.js";
import { fetchHtml, extractJsonLd } from "./scrapeLite.js";

export interface Location {
  name: string;
  address: string;
  phone: string;
}

export interface LocationsResult {
  count: number | "unknown";
  source: string | null;
  list: Location[];
}

function addressToString(addr: any): string {
  if (!addr) return "";
  if (typeof addr === "string") return addr;
  const parts = [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean);
  return parts.join(", ");
}

function fromJsonLd(blocks: any[]): Location[] {
  const businesses = blocks.filter(
    (b) => typeof b["@type"] === "string" ? /LocalBusiness|MedicalBusiness|MedicalClinic|Organization/i.test(b["@type"]) : false
  );
  return businesses
    .map((b) => ({
      name: b.name || "",
      address: addressToString(b.address),
      phone: b.telephone || "",
    }))
    .filter((l) => l.address || l.phone);
}

// <Placemark><name>..</name><address>..</address><phoneNumber>..</phoneNumber></Placemark>
function fromKml(xml: string): Location[] {
  const out: Location[] = [];
  for (const m of xml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/gi)) {
    const block = m[1]!;
    const name = block.match(/<name>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/name>/i)?.[1]?.trim() || "";
    const address = block.match(/<address>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/address>/i)?.[1]?.trim() || "";
    const phone = block.match(/<phoneNumber>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/phoneNumber>/i)?.[1]?.trim() || "";
    if (address || phone) out.push({ name, address, phone });
  }
  return out;
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function dedupe(locations: Location[]): Location[] {
  const seen = new Set<string>();
  const out: Location[] = [];
  for (const l of locations) {
    const key = normalizeAddress(l.address) || l.phone;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(l);
  }
  return out;
}

/**
 * Find and extract location info: JSON-LD LocalBusiness on the homepage first,
 * then locations.kml (found via a `local`-sourced sitemap URL, if Phase 1 saw
 * one), then a /locations/ page.
 */
export async function detectLocations(
  origin: string,
  pages: AnalyzedPage[],
  sitemaps: string[] = []
): Promise<LocationsResult> {
  const homeHtml = await fetchHtml(origin + "/");
  let found = fromJsonLd(extractJsonLd(homeHtml));
  let source = "/";

  const kmlSitemap = sitemaps.find((s) => /local-sitemap|\.kml/i.test(s));
  if (!found.length && kmlSitemap) {
    const xml = await fetchHtml(kmlSitemap);
    // local-sitemap.xml is itself a sitemap pointing at the real locations.kml file.
    const kmlUrl = xml.match(/<loc>([^<]*\.kml)<\/loc>/i)?.[1] || (kmlSitemap.endsWith(".kml") ? kmlSitemap : null);
    if (kmlUrl) {
      const kml = await fetchHtml(kmlUrl);
      found = fromKml(kml);
      source = new URL(kmlUrl).pathname;
    }
  }

  const locationsPage = pages.find((p) => /^\/(locations?|our-locations)\/?$/i.test(p.path));
  if (!found.length && locationsPage) {
    const html = await fetchHtml(locationsPage.url);
    found = fromJsonLd(extractJsonLd(html));
    source = locationsPage.path;
  }

  // A dedicated /locations/ page existing but yielding no structured data still
  // tells us there's at least one location — count it as unknown detail rather
  // than zero.
  if (!found.length) {
    if (locationsPage) return { count: "unknown", source: locationsPage.path, list: [] };
    return { count: "unknown", source: null, list: [] };
  }

  const deduped = dedupe(found);
  return { count: deduped.length, source, list: deduped };
}
