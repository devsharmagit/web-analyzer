// Location extraction — Phase 4. Answers Q9: how many locations, and their info.
// Structured sources are gathered together and deduplicated: JSON-LD
// LocalBusiness on the homepage, locations.kml (a Rank Math / Yoast Local SEO
// file that the local-sitemap.xml child sitemap Phase 1 discovers points at),
// and JSON-LD on dedicated per-location pages. Only when none of those has
// anything: a /locations/ or /contact/ page, then a footer address.

import type { AnalyzedPage } from "./crawl.js";
import { fetchHtml, extractJsonLd } from "./scrapeLite.js";

export interface Location {
  name: string;
  /** The full address on one line, as the site gives it. */
  address: string;
  phone: string;
  // Structured parts: taken from JSON-LD's PostalAddress when present,
  // otherwise parsed from `address` — US-format addresses only, and left
  // undefined for any part that can't be determined confidently.
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface LocationsResult {
  count: number | "unknown";
  source: string | null;
  list: Location[];
  reason?: string; // set when count is "unknown", explains why detection stopped
}

// Dedicated per-location pages to read JSON-LD from, capped so a site with a
// page per city can't blow the phase's timeout.
const MAX_LOCATION_PAGES = 10;

const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY".split(" ")
);
const STREET_SUFFIX =
  "Street|St|Avenue|Ave|Blvd|Boulevard|Road|Rd|Drive|Dr|Way|Lane|Ln|Highway|Hwy|Circle|Cir|Court|Ct|Parkway|Pkwy|Pike|Place|Pl|Trail|Trl|Terrace|Ter|Square|Sq|Plaza";
const UNIT = String.raw`(?:\s+(?:Suite|Ste|Unit|Bldg|Building|#)\.?\s*#?[\w-]+|\s+#\s*[\w-]+|\s+[A-Z]?\d+[A-Z]?)?`;
// "... Main St. Norman" / "... Road Ste 104 Chattanooga": the city is whatever
// follows the last street-type word (and an optional unit).
const STREET_THEN_CITY_RE = new RegExp(String.raw`^(.*\b(?:${STREET_SUFFIX})\.?${UNIT})\s+([A-Za-z][A-Za-z .'-]*)$`, "i");

/** Best-effort split of a one-line US address into street / city / state / zip. */
export function parseUsAddress(address: string): Pick<Location, "street" | "city" | "state" | "zip"> {
  const a = address.replace(/\s+/g, " ").trim().replace(/,?\s*(USA|US|United States)$/i, "");
  const tail = a.match(/,?\s*\b([A-Z]{2})\b\s*,?\s*(\d{5}(?:-\d{4})?)?\s*$/);
  if (!tail || !US_STATES.has(tail[1]!)) return {};
  const state = tail[1]!;
  const zip = tail[2];
  const rest = a.slice(0, tail.index).replace(/,\s*$/, "").trim();

  const lastComma = rest.lastIndexOf(",");
  if (lastComma !== -1) {
    const city = rest.slice(lastComma + 1).trim();
    const street = rest.slice(0, lastComma).trim();
    return { street: street || undefined, city: city || undefined, state, zip };
  }
  const m = rest.match(STREET_THEN_CITY_RE);
  if (m) return { street: m[1]!.trim(), city: m[2]!.trim(), state, zip };
  return { state, zip };
}

function withParsedParts(l: Location): Location {
  if (l.city && l.state) return l;
  const parsed = parseUsAddress(l.address);
  return {
    ...l,
    street: l.street || parsed.street,
    city: l.city || parsed.city,
    state: l.state || parsed.state,
    zip: l.zip || parsed.zip,
  };
}

function typesOf(block: any): string[] {
  const t = block?.["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

// LocalBusiness and the subtypes med-spa sites actually use. Checked against
// EVERY listed type: Yoast emits ["HealthAndBeautyBusiness", "Organization"],
// which the old string-only check skipped entirely.
const BUSINESS_TYPE_RE = /LocalBusiness|MedicalBusiness|MedicalClinic|MedicalOrganization|Organization|HealthAndBeautyBusiness|DaySpa|BeautySalon|Physician/i;

function fromPostalAddress(addr: any): Pick<Location, "address" | "street" | "city" | "state" | "zip"> | null {
  if (!addr) return null;
  if (typeof addr === "string") return { address: addr.trim() };
  if (typeof addr !== "object") return null;
  // Trailing separators are trimmed: culturemedspa.com's streetAddress is
  // "116 Concord Road Suite #100," — joined as-is it produced ",,".
  const part = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim().replace(/[,\s]+$/, "") : "");
  const street = part(addr.streetAddress);
  const city = part(addr.addressLocality);
  const state = part(addr.addressRegion);
  const zip = part(addr.postalCode);
  const address = [street, city, state, zip].filter(Boolean).join(", ");
  if (!address) return null;
  return { address, street: street || undefined, city: city || undefined, state: state || undefined, zip: zip || undefined };
}

export function fromJsonLd(blocks: any[]): Location[] {
  const out: Location[] = [];
  for (const b of blocks) {
    if (!typesOf(b).some((t) => BUSINESS_TYPE_RE.test(t))) continue;
    const name = typeof b.name === "string" ? b.name : "";
    const phone = typeof b.telephone === "string" ? b.telephone : "";
    // One business can list several addresses (address: [...]): each is a location.
    const addresses = (Array.isArray(b.address) ? b.address : [b.address]).map(fromPostalAddress).filter(Boolean);
    if (addresses.length) {
      for (const a of addresses) out.push({ name, phone, ...a! });
    } else if (phone) {
      out.push({ name, address: "", phone });
    }
  }
  return out;
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

// Last resort: a street address + phone sitting in the footer with no JSON-LD,
// no KML, no /locations/ page. Deliberately conservative — only fires when
// nothing structured was found, and only trusts a real street-address shape
// (number + street-type word + city, state zip), not a bare phone number alone,
// since a phone with no address is too weak to call "a location."
// Matched against text with whitespace already collapsed, and the house number
// can't start mid-way through another number: on skinmedhealth.com the match
// used to begin at "0098" — the end of the phone number printed just before
// the address — and swallow the tabs and newlines between them.
const ADDRESS_RE = new RegExp(
  String.raw`(?<![\d\-.()/])\d{1,6}\s+[A-Za-z0-9.' ]{2,40}(?:${STREET_SUFFIX}|Suite|Ste)[.,]?\s*[A-Za-z0-9#., ]{0,50},\s*[A-Za-z ]+,?\s*[A-Z]{2}(?:\s*\d{5})?`,
  "i"
);
const PHONE_RE = /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, " ");
}

export function fromFooterHeuristic(html: string): Location[] {
  const text = htmlToText(html);
  const addressMatch = text.match(ADDRESS_RE);
  if (!addressMatch) return []; // no address shape found = too weak to report a location
  const phoneMatch = text.match(PHONE_RE);
  return [{ name: "", address: addressMatch[0].trim(), phone: phoneMatch?.[0] || "" }];
}

function fromContactOrLocationHtml(html: string): Location[] {
  let name = "";
  let address = "";

  // 1. Google Maps embed: <iframe src="...maps.google.com/maps?q=..."> or iframe title
  const mapEmbed = html.match(/maps\.google\.com\/maps\?[^"']*q=([^&"']+)/i);
  const iframeTitle = html.match(/<iframe[^>]+title=["']([^"']+)["']/i)?.[1];
  let mapQuery = "";
  if (mapEmbed) {
    try {
      mapQuery = decodeURIComponent(mapEmbed[1]!.replace(/\+/g, " "));
    } catch {
      mapQuery = mapEmbed[1]!.replace(/\+/g, " ");
    }
  }

  // 2. Google Maps link: <a href="https://maps.app.goo.gl/..." or maps.google.com>...</a>
  const mapsLink = html.match(/<a[^>]+href=["']https?:\/\/(?:maps\.app\.goo\.gl|maps\.google\.com|www\.google\.com\/maps)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  const linkAddress = mapsLink ? htmlToText(mapsLink[1]!).trim() : "";

  // 3. Tel link or phone pattern
  const telMatch = html.match(/href=["']tel:([0-9+\-(). ]+)["']/i);
  const phoneMatch = htmlToText(html).match(PHONE_RE);
  const phone = telMatch ? telMatch[1]!.trim() : phoneMatch ? phoneMatch[0].trim() : "";

  const linkMatch = linkAddress.match(ADDRESS_RE);
  if (linkMatch) address = linkMatch[0].trim();

  const rawMap = (mapQuery || iframeTitle || "").replace(/\s+/g, " ");
  if (rawMap) {
    const match = rawMap.match(ADDRESS_RE);
    if (match) {
      if (!address) address = match[0].trim();
      const extractedName = rawMap.replace(match[0], "").replace(/[, -]+$/, "").trim();
      if (extractedName && !name) name = extractedName;
    }
  }

  if (!address) {
    const match = htmlToText(html).match(ADDRESS_RE);
    if (match) address = match[0].trim();
  }

  if (address || phone) {
    return [{ name, address, phone }];
  }
  return [];
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const DIRECTIONAL_RE = /^(n|s|e|w|ne|nw|se|sw|north|south|east|west)\.?$/i;

// Identity of a physical location. One site routinely spells the same address
// several ways across its own structured data — confirmed on
// inspiremedicalspas.com: "10420 Rubicon Rd B104" and "10420 S. Rubicon Road
// Suite B104" in two JSON-LD blocks on the same homepage. House number +
// street name (skipping a leading directional) survives Rd/Road, abbreviations,
// a missing suite or zip; a full-string comparison doesn't.
export function locationKey(l: Location): string {
  const words = (l.street || l.address).trim().split(/[\s,]+/);
  const num = words[0]?.match(/^\d{1,6}[A-Za-z]?$/)?.[0];
  const streetName = words
    .slice(1)
    .find((w) => !DIRECTIONAL_RE.test(w))
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (num && streetName) return `${num.toLowerCase()}|${streetName}`;
  return normalizeAddress(l.address) || l.phone.replace(/\D/g, "");
}

// Keeps one entry per location key, filling in any field the first sighting
// lacked from later ones (one block has the phone, another the zip).
export function dedupe(locations: Location[]): Location[] {
  const byKey = new Map<string, Location>();
  const out: Location[] = [];
  for (const l of locations) {
    const key = locationKey(l);
    const existing = key ? byKey.get(key) : undefined;
    if (!existing) {
      const copy = { ...l };
      if (key) byKey.set(key, copy);
      out.push(copy);
      continue;
    }
    for (const field of ["name", "address", "phone", "street", "city", "state", "zip"] as const) {
      if (!existing[field] && l[field]) existing[field] = l[field];
    }
  }
  return out;
}

// A page commonly carries more than one JSON-LD block describing the SAME
// business (e.g. an Organization block and a LocalBusiness block from
// different plugins), each with only PART of the info — one has an address
// but no phone, the other has a phone but no address. Exact-key dedupe above
// can't catch this (there's no shared non-empty field to key on), so it was
// reporting 2 locations for culturemedspa.com's single physical address.
// Merge conservatively: only when there's exactly one addressless entry and
// exactly one phoneless-but-addressed entry, on the assumption this is one
// business described twice, not two real locations (a page with genuinely
// multiple locations reports more than one complete address, which this
// leaves alone).
function mergeComplementaryPartials(locations: Location[]): Location[] {
  const addressless = locations.filter((l) => !l.address && l.phone);
  const phoneless = locations.filter((l) => l.address && !l.phone);
  if (addressless.length !== 1 || phoneless.length !== 1) return locations;

  const merged: Location = {
    ...phoneless[0]!,
    name: phoneless[0]!.name || addressless[0]!.name,
    phone: addressless[0]!.phone,
  };
  const rest = locations.filter((l) => l !== addressless[0] && l !== phoneless[0]);
  return [merged, ...rest];
}

// A site's per-location pages: a Local SEO plugin's location post type
// (rank_math_locations-sitemap.xml, wpseo_locations-sitemap.xml), or children
// of a /locations/ hub. Deliberately NOT the "med-spa-near-{town}" local-SEO
// landing pages: those target towns the clinic serves, not places it has —
// inspiremedicalspas.com has six of them and one physical address.
function locationPages(pages: AnalyzedPage[]): AnalyzedPage[] {
  return pages
    .filter((p) => p.sources.some((s) => /locations?$/i.test(s)) || /^\/(locations?|our-locations?)\/[^/]+\/$/i.test(p.path))
    .slice(0, MAX_LOCATION_PAGES);
}

/**
 * Find and extract location info. Pass the homepage HTML the crawl already
 * fetched to avoid requesting it again; it's only fetched here when empty.
 */
export async function detectLocations(
  origin: string,
  pages: AnalyzedPage[],
  sitemaps: string[] = [],
  homeHtml = ""
): Promise<LocationsResult> {
  const kmlSitemap = sitemaps.find((s) => /local-sitemap|\.kml/i.test(s));
  const perLocationPages = locationPages(pages);

  const [homepage, kml, perPage] = await Promise.all([
    homeHtml ? Promise.resolve(homeHtml) : fetchHtml(origin + "/"),
    (async (): Promise<{ list: Location[]; path: string } | null> => {
      if (!kmlSitemap) return null;
      // local-sitemap.xml is itself a sitemap pointing at the real locations.kml file.
      const xml = kmlSitemap.endsWith(".kml") ? "" : await fetchHtml(kmlSitemap);
      const kmlUrl = xml.match(/<loc>([^<]*\.kml)<\/loc>/i)?.[1] || (kmlSitemap.endsWith(".kml") ? kmlSitemap : null);
      if (!kmlUrl) return null;
      let path = kmlUrl;
      try {
        path = new URL(kmlUrl).pathname;
      } catch {
        /* keep the raw value */
      }
      return { list: fromKml(await fetchHtml(kmlUrl)), path };
    })(),
    Promise.all(perLocationPages.map(async (p) => ({ path: p.path, list: fromJsonLd(extractJsonLd(await fetchHtml(p.url))) }))),
  ]);

  // Every structured source together, so a multi-location site's homepage
  // JSON-LD (usually just the main location) can't hide the rest.
  const found: Location[] = [];
  const sources: string[] = [];
  const fromHome = fromJsonLd(extractJsonLd(homepage));
  if (fromHome.length) {
    found.push(...fromHome);
    sources.push("/");
  }
  if (kml?.list.length) {
    found.push(...kml.list);
    sources.push(kml.path);
  }
  const pagesWithData = perPage.filter((p) => p.list.length);
  for (const p of pagesWithData) found.push(...p.list);
  if (pagesWithData.length) sources.push(`${pagesWithData.length} location page${pagesWithData.length === 1 ? "" : "s"}`);

  if (found.length) {
    const list = mergeComplementaryPartials(dedupe(found)).map(withParsedParts);
    return { count: list.length, source: sources.join(" + "), list };
  }

  // Check dedicated location or contact pages (from crawl or directly on origin)
  const contactOrLocationPages = pages.filter((p) =>
    /^\/(locations?|our-locations?|contact|contact-us|contact_us|contactus)\/?$/i.test(p.path)
  );
  if (!contactOrLocationPages.length) {
    contactOrLocationPages.push({ url: origin + "/contact/", path: "/contact/", source: "page", sources: ["page"], isPage: true, title: "Contact" });
    contactOrLocationPages.push({ url: origin + "/locations/", path: "/locations/", source: "page", sources: ["page"], isPage: true, title: "Locations" });
  }

  let fetchedPage: string | null = null;
  for (const page of contactOrLocationPages) {
    const html = await fetchHtml(page.url);
    if (!html) continue;
    fetchedPage ??= page.path;
    let list = fromJsonLd(extractJsonLd(html));
    if (!list.length) list = fromContactOrLocationHtml(html);
    if (list.length) {
      const deduped = mergeComplementaryPartials(dedupe(list)).map(withParsedParts);
      return { count: deduped.length, source: page.path, list: deduped };
    }
  }

  // Last resort: an address-shaped string in the footer/homepage, no structured
  // data anywhere. Single-location only (a footer NAP block never lists more
  // than the one address), and lower-confidence than every source above it.
  const heuristic = fromFooterHeuristic(homepage);
  if (heuristic.length) {
    return { count: heuristic.length, source: "footer (heuristic)", list: heuristic.map(withParsedParts) };
  }

  // A /locations/ or /contact/ page that exists but yields no structured data
  // still tells us there's at least one location — count it as unknown detail
  // rather than zero.
  if (fetchedPage) {
    return { count: "unknown", source: fetchedPage, list: [], reason: `found ${fetchedPage} but no address or map coordinates could be identified` };
  }
  return { count: "unknown", source: null, list: [], reason: "no JSON-LD, locations.kml, contact/locations page, or footer address found" };
}
