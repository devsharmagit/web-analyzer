// Page discovery — the backbone of the analyzer. Everything downstream (page
// counts, service/condition split, store size) reads the list this produces.
//
// Ported from the legacy server.js `crawlSiteInventory()`, with three deliberate
// changes (see ANALYZER-SCOPE.md for why each matters on ruma.com):
//   1. ALL sources are kept per URL, not just the first one seen.
//   2. The winning source is decided by an explicit rank, not by whichever
//      sitemap happened to be fetched first.
//   3. Products, product categories and videos are separated from real pages so
//      they can never inflate the headline page count.

// Honest, identifiable bot UA (same shape as Googlebot's own — a name plus a
// contact/info URL), not a spoofed browser string. A prior version of this
// file impersonated a real Chrome/Windows browser specifically to "bypass
// WAFs" — reverted: (1) it doesn't even work against the actual block this
// vertical hits in practice (Cloudflare/hosting-provider blocking by IP/ASN,
// confirmed live — ruma.com 403'd EVERY request from Render's IP regardless
// of UA, while working fine from other networks), and (2) deliberately
// disguising automated traffic to get past a site's bot-detection is a
// posture this tool doesn't take. See the 403-detection warning below for
// how a real block like this is now surfaced instead. The UA itself is
// ANALYZER_UA in fetchWithFallback.ts, shared by every module.
// Sitemap candidates tried in order when robots.txt doesn't declare a Sitemap: directive.
// robots.txt is always checked first (see below) — these are only the fallback probes.
const SITEMAP_CANDIDATES = [
  "/sitemap.xml",
  "/wp-sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/sitemap/",          // Squarespace default
  "/sitemap.php",       // Some custom PHP CMS
  "/sitemaps.xml",      // Ghost + others
  "/sitemap1.xml",      // Common flat-file patterns
  "/news-sitemap.xml",  // Additional WordPress SEO plugin sitemaps
];
const MAX_CHILD_SITEMAPS = 25;
export const ASSET_RE = /\.(xml|kml|jpe?g|png|webp|gif|svg|pdf|css|js|ico|zip|mp4|webm|json|webmanifest|md|txt|csv|woff2?|ttf|otf|eot|fon|ttc|mp3|wav|ogg|m4a|avi|mov)(?:[?#/]|$)/i;
// Technical/infrastructure paths that a homepage's own <a href> links
// routinely include (RSS feed links, well-known service-discovery endpoints,
// REST API roots, login/XML-RPC) — never actual content a salesperson would
// want counted. Confirmed live: lunamedspawi.com's homepage links to
// /.well-known/api-catalog and /feed/, both of which reached the Crawlee
// content-fetch step (wasting a MAX_CONTENT_FETCH slot) and errored on their
// non-HTML content type before this filter existed.
// "feed" can appear as the leading segment (/feed/) or trailing on a content
// path (/comments/feed/, /category/botox/feed/) — WordPress adds a feed link
// to nearly every archive and single post. Match it in either position.
const NON_PAGE_PATH_RE = /^\/(wp-json|wp-login\.php|xmlrpc\.php|\.well-known)(\/|$)|\/feed\/?$/i;
// WordPress date archive paths (e.g. /2025/, /2025/10/, /2025/10/28/) are
// pagination/index archive pages — not real content pages. On many sites they
// simply redirect back to the homepage, so they bloat the blog count with
// URLs that resolve to "/". Drop them before they enter the pipeline.
// Pattern: path that starts with /YYYY/ and optionally continues with /MM/ and /DD/
const DATE_ARCHIVE_PATH_RE = /^\/\d{4}(\/\d{2}(\/\d{2})?)?\/$/;
// WordPress taxonomy archives: listing pages that index posts by category,
// tag or author. Real URLs, but not pages anyone would count — and a
// /category/botox/ archive matches the service vocabulary, so it was counted
// as a Botox service page. Confirmed on culturemedspa.com: its
// category-sitemap.xml contributed 37 archives, 19 of them counted as
// "service" (half the site's service total) and 15 as "shop". Kept in the URL
// count but excluded from pages, like videos. WooCommerce's /product-category/
// is deliberately NOT matched: those are store categories, counted by the store.
const ARCHIVE_PATH_RE = /\/(category|tag|author)\/[^/]+/i;
// Sitemaps that only ever list taxonomy archives, whatever URL base the site
// configured (Yoast / Rank Math: category-, post_tag-, author-sitemap.xml).
const ARCHIVE_SOURCES = new Set(["category", "post_tag", "tag", "author", "product_tag"]);

/**
 * Canonical form of a URL path, used as the dedupe key everywhere a URL is
 * recorded: collapsed slashes, index pages (/index.php etc.) mapped to "/",
 * and a trailing slash — "/self-assessment" and "/self-assessment/" (both
 * seen live on havenpmu.com) are one page, and WordPress permalinks
 * canonically end in "/". Returns null for paths that are never pages.
 */
export function toPagePath(pathname: string): string | null {
  let path = pathname.replace(/\/{2,}/g, "/");
  path = path.replace(/\/index\.(php|html?|asp|aspx|cfm|jsp)$/i, "/");
  if (/\.(php|html?|asp|aspx|cfm|jsp)\/+$/i.test(path)) {
    path = path.replace(/\/+$/, "");
  } else if (path !== "/" && !path.endsWith("/") && !/\.(php|html?|asp|aspx|cfm|jsp)$/i.test(path)) {
    path += "/";
  }
  if (ASSET_RE.test(path) || NON_PAGE_PATH_RE.test(path) || DATE_ARCHIVE_PATH_RE.test(path)) return null;
  return path;
}

/** Hostname with a leading "www." removed: www.x.com and x.com are one site. */
const siteHost = (hostname: string): string => hostname.toLowerCase().replace(/^www\./, "");

// Hosts that are never a clinic's own storefront, even when the link text says
// "shop" or the path contains /store/ (play.google.com/store/apps/...).
const NOT_A_STOREFRONT_HOSTS = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com", "youtube.com", "youtu.be",
  "linkedin.com", "pinterest.com", "yelp.com", "google.com", "apple.com", "goo.gl", "g.page", "wa.me",
];
/** A WordPress taxonomy archive (category/tag/author listing), by path or by the sitemap it came from. */
export const isTaxonomyArchive = (path: string, sources: string[]): boolean =>
  ARCHIVE_PATH_RE.test(path) || sources.some((s) => ARCHIVE_SOURCES.has(s));

const isNotAStorefront = (hostname: string): boolean =>
  NOT_A_STOREFRONT_HOSTS.some((h) => hostname === h || hostname.endsWith("." + h));

// Which sitemap a URL came from is the single best signal WordPress gives us
// about what that URL IS. But a URL commonly appears in several sitemaps at once
// — on ruma.com 50 URLs are in BOTH the portfolio and the video sitemap. Those
// are service pages that happen to have a video on them, not media items, so the
// source that decides classification has to be the most specific one, not the
// one we happened to read first. Higher rank wins.
export const SOURCE_RANK: Record<string, number> = {
  page: 100, // an explicit CMS page — always authoritative
  portfolio: 90, // custom post type; on med-spa sites this is where services live
  product: 80,
  product_cat: 70,
  post: 60,
  local: 50,
  video: 10, // never the reason a URL exists; only ever a property of one
  attachment: 5,
  image: 5,
};
const rankOf = (s: string): number => (SOURCE_RANK[s] != null ? SOURCE_RANK[s] : 40);

// What counts as a "page" for the headline number. Products and product
// categories are catalogue entries (reported separately under the store), and
// videos/attachments are not pages at all.
export const NON_PAGE_SOURCES = new Set(["product", "product_cat", "video", "attachment", "image", "local", "archive"]);

export interface AnalyzedPage {
  path: string;
  url: string;
  source: string;
  sources: string[];
  isPage: boolean;
  title: string;
  navCategory?: string;
}

export interface ExternalStoreLink {
  url: string;        // The href from the anchor tag
  anchorText: string; // The visible link text (e.g. "shop", "store", "buy now")
}

export interface CrawlResult {
  origin: string;
  discoveredVia: string;
  sitemapIndex: string;
  sitemaps: string[];
  urlsSeen: number;
  total: number;
  pages: AnalyzedPage[];
  counts: Record<string, number>;
  warnings: string[];
  durationMs: number;
  /** External links from the homepage that look like shop/store links (different domain). */
  externalStoreLinks: ExternalStoreLink[];
  /** Homepage HTML ("" if it couldn't be fetched) — reused by later phases instead of refetching. */
  homeHtml: string;
}

import * as cheerio from "cheerio";
import { fetchWithFallback, WAF_BLOCKED_STATUSES, type FetchResult } from "./fetchWithFallback.js";
import { isPublicUrl } from "./urlSafety.js";

async function fetchPage(
  url: string,
  timeoutMs = 15000,
  onStatus?: (status: number, wasBlockedAndUnresolved?: boolean) => void
): Promise<FetchResult> {
  const res = await fetchWithFallback(url, { timeoutMs });
  if (onStatus) {
    const isUnresolvedBlock = !res.ok && WAF_BLOCKED_STATUSES.has(res.status);
    onStatus(res.status, isUnresolvedBlock);
  }
  if (!res.ok) console.error(`fetchText: Failed to fetch ${url} - Status: ${res.status} (${res.tier})`);
  return res;
}

async function fetchText(
  url: string,
  timeoutMs = 15000,
  onStatus?: (status: number, wasBlockedAndUnresolved?: boolean) => void
): Promise<string> {
  const res = await fetchPage(url, timeoutMs, onStatus);
  return res.ok ? res.html : "";
}

/**
 * Where the homepage request actually landed, when that should replace the
 * origin the user typed. Always for www/non-www and http→https (same site).
 * For a different domain only when the redirect lands on its homepage — a
 * whole-site move like lacosmeticspa.com → lacosmedic.com — never a redirect
 * to some deep page elsewhere (a booking portal, a parked-domain lander).
 */
function redirectTarget(origin: string, finalUrl: string): { origin: string; sameSite: boolean } | null {
  let final: URL;
  try {
    final = new URL(finalUrl);
  } catch {
    return null;
  }
  if (final.origin === origin || (final.protocol !== "https:" && final.protocol !== "http:")) return null;
  if (siteHost(final.hostname) === siteHost(new URL(origin).hostname)) return { origin: final.origin, sameSite: true };
  if (final.pathname === "/") return { origin: final.origin, sameSite: false };
  return null;
}

const locsOf = (xml: string): string[] =>
  (xml.match(/<loc>([^<]+)<\/loc>/g) || []).map((m) => m.replace(/<\/?loc>/g, "").trim());

// The child sitemap's own filename is the source label. Take the LAST
// hyphen-separated word before "-sitemap": names are often theme-prefixed
// ("astra-portfolio-sitemap.xml"), and reading the first word instead made 203
// portfolio items look like ordinary pages. Underscores are kept, because they're
// part of WordPress post-type names: "product_cat", "rank_math_locations".
const sourceOfSitemap = (url: string): string => {
  const wpMatch = url.match(/([a-z_]+)-sitemap/i);
  if (wpMatch) return wpMatch[1]!.toLowerCase();

  const shopifyMatch = url.match(/sitemap_([a-z_]+)_[0-9]+/i);
  if (shopifyMatch) {
    const s = shopifyMatch[1]!.toLowerCase();
    if (s === "products") return "product";
    if (s === "pages") return "page";
    if (s === "collections") return "product_cat";
    if (s === "blogs") return "post";
    return s;
  }
  
  return "page";
};

// For generic sitemaps (like a single sitemap.xml), we can infer the source from the URL path.
const refineSourceByUrl = (path: string, currentSource: string): string => {
  if (currentSource !== "page") return currentSource; // Only override the generic "page" source
  if (/^\/product(s)?\//i.test(path)) return "product";
  if (/^\/collection(s)?\//i.test(path) || /^\/product-category\//i.test(path)) return "product_cat";
  if (/^\/blog\//i.test(path) || /^\/post(s)?\//i.test(path)) return "post";
  if (/^\/portfolio\//i.test(path) || /^\/project(s)?\//i.test(path)) return "portfolio";
  if (/^\/service(s)?\//i.test(path)) return "portfolio"; // Often used for services in medspas
  return currentSource;
};

export const titleFromPath = (p: string): string =>
  p === "/"
    ? "Home"
    : decodeURIComponent(p)
        .replace(/^\/|\/$/g, "")
        .split("/")
        .pop()!
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Extracts navigation hierarchy context (e.g. links inside a "Services" or "Treatments"
 * dropdown menu) from the homepage HTML. This preserves the direct signal from the website
 * about what each page is, even when no sitemap exists.
 *
 * Parsed as a DOM, not with regexes: a regex capturing an <li> up to "</li>"
 * stops at the first NESTED item's closing tag, so every child link after
 * the first sub-item of a multi-level menu was silently dropped.
 */
export function extractNavCategories(html: string, origin: string): Map<string, string> {
  const result = new Map<string, string>(); // path -> "service" | "offers" | "forms" | "locations" | "about"
  if (!html) return result;

  const sectionPatterns = [
    { category: "service", re: /\b(services?|treatments?|procedures?|our[- ]services|what[- ]we[- ]do|aesthetic[- ]services)\b/i },
    { category: "offers", re: /\b(payment[- ]?plans?|financ\w*|specials?|offers?|memberships?|cherry)\b/i },
    { category: "forms", re: /\b(self[- ]?assessment|quiz|consult\w*|inquiry|booking|book[- ]?now|assessment)\b/i },
    { category: "locations", re: /\b(locations?|our[- ]clinics?|find[- ]us)\b/i },
    { category: "about", re: /\b(about(-us)?|our[- ]team|team|providers|staff)\b/i },
  ];

  const $ = cheerio.load(html);
  const originHost = siteHost(new URL(origin).hostname);

  // Same rule as the homepage link pass: an href carrying a fragment or query
  // is skipped (dropdown toggles are href="#").
  const usableHref = (href: string | undefined): href is string => !!href && !/[#?]/.test(href);

  function cleanPath(href: string | undefined): string | null {
    if (!usableHref(href)) return null;
    try {
      const u = new URL(href, origin);
      if (siteHost(u.hostname) !== originHost) return null;
      const p = toPagePath(u.pathname);
      return p && p !== "/" ? p : null;
    } catch {
      return null;
    }
  }

  // 1. WordPress / CMS custom post type classes on menu items (e.g. menu-item-object-*-portfolio, menu-item-object-service)
  $("li").each((_i, li) => {
    const cls = $(li).attr("class") || "";
    if (!/menu-item-object-/i.test(cls) || !/portfolio|service|treatment/i.test(cls)) return;
    const p = cleanPath($(li).find("a").first().attr("href"));
    if (p) result.set(p, "service");
  });

  // 2. Navigation dropdown menus (<li class="...has-children... | ...dropdown...">).
  // Walked innermost-first, so a nested "Financing" submenu inside "Services"
  // labels its own links "offers" before the outer menu claims them.
  const dropdowns: Array<{ li: Parameters<typeof $>[0]; category: string }> = [];
  $("li").each((_i, li) => {
    const cls = $(li).attr("class") || "";
    if (!/menu-item-has-children|dropdown|has-dropdown|menu-item--has-children/i.test(cls)) return;
    const top = $(li).find("a").first();
    if (!top.length) return;
    const topText = top.text().replace(/\s+/g, " ").trim();
    const topHref = top.attr("href");
    const match = sectionPatterns.find((sp) => sp.re.test(topText) || (usableHref(topHref) && sp.re.test(topHref)));
    if (match) dropdowns.push({ li, category: match.category });
  });
  for (const { li, category } of dropdowns.reverse()) {
    $(li).find("a").each((_i, a) => {
      const p = cleanPath($(a).attr("href"));
      if (p && !result.has(p)) result.set(p, category);
    });
  }

  // 3. Header CTA buttons or action links (e.g. "Self Assessment", "Cherry Financing")
  $("a").each((_i, a) => {
    const cls = $(a).attr("class") || "";
    if (!/button|btn|cta|elementor-button/i.test(cls)) return;
    const p = cleanPath($(a).attr("href"));
    if (!p) return;
    const btnText = $(a).text().replace(/\s+/g, " ").trim();
    if (/self[- ]?assessment|quiz|consult/i.test(btnText) || /self[- ]?assessment/i.test(p)) {
      if (!result.has(p)) result.set(p, "forms");
    } else if (/cherry|financing|payment/i.test(btnText) || /cherry|financing/i.test(p)) {
      if (!result.has(p)) result.set(p, "offers");
    }
  });

  return result;
}

/** Discover every URL a site publishes. */
export async function crawlSite(siteUrl: string): Promise<CrawlResult> {
  const started = Date.now();
  const warnings: string[] = [];
  console.log(`crawlSite: Starting crawl for ${siteUrl}`);

  // Tracks every fetch that came back with a blocking status (401/403/429/503)
  // across sitemap/homepage/shop-page requests, so a real WAF/bot-protection
  // block can be reported specifically instead of the generic "may be
  // JS-rendered or blocking us" catch-all. Confirmed live: ruma.com returned
  // 403 on every single request from Render's production IP.
  const blockedStatuses: number[] = [];
  let totalFetches = 0;
  const trackStatus = (status: number, wasBlockedAndUnresolved?: boolean) => {
    totalFetches++;
    if (wasBlockedAndUnresolved) blockedStatuses.push(status);
  };

  let origin: string;
  try {
    origin = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : "https://" + siteUrl).origin;
    console.log(`crawlSite: Resolved origin to ${origin}`);
  } catch {
    console.error(`crawlSite: Invalid URL: ${siteUrl}`);
    throw new Error(`Not a usable URL: ${siteUrl}`);
  }

  // ---- homepage first: its final URL is the site's real origin ----------
  // The origin typed by the user isn't necessarily where the site lives.
  // Confirmed live: theagelessclinic.com 301s to www.theagelessclinic.com, and
  // its sitemap lists www URLs — every one was rejected as "cross-origin", so
  // the crawl fell back to homepage links and found 2 pages. Its HTML is also
  // needed below (links, nav, WordPress check) and by later phases.
  console.log(`crawlSite: Fetching homepage for ${origin}...`);
  const home = await fetchPage(origin + "/", undefined, trackStatus);
  const homeHtml = home.ok ? home.html : "";
  const redirect = home.ok ? redirectTarget(origin, home.finalUrl) : null;
  if (redirect && (redirect.sameSite || (await isPublicUrl(redirect.origin)))) {
    if (!redirect.sameSite) {
      warnings.push(`${origin} redirects to ${redirect.origin} — analyzed ${redirect.origin} instead.`);
    }
    console.log(`crawlSite: Homepage redirected; using origin ${redirect.origin}`);
    origin = redirect.origin;
  }
  const originHost = siteHost(new URL(origin).hostname);
  // Same site = same host ignoring "www." and http/https. Sitemaps routinely
  // mix the two; those URLs are recorded under the resolved origin.
  const isSameSite = (u: URL): boolean =>
    (u.protocol === "https:" || u.protocol === "http:") && siteHost(u.hostname) === originHost;

  const found = new Map<string, { path: string; url: string; sources: Set<string> }>();
  const add = (rawUrl: string, source: string) => {
    let x: URL;
    try {
      x = new URL(rawUrl);
    } catch {
      return;
    }
    if (!isSameSite(x)) return;
    const path = toPagePath(x.pathname);
    if (!path) return;
    let row = found.get(path);
    if (!row) {
      row = { path, url: origin + path, sources: new Set() };
      found.set(path, row);
    }
    const refinedSource = refineSourceByUrl(path, source || "page");
    row.sources.add(refinedSource); // keep EVERY source
  };

  // ---- sitemap discovery -------------------------------------------------
  console.log(`crawlSite: Starting sitemap discovery for ${origin}`);
  let childSitemaps: string[] = [];
  let indexUsed = "";

  // Step 0: Always try robots.txt first — it explicitly declares the Sitemap
  // URL and is the most authoritative signal available. Many sites list their
  // sitemap in robots.txt even when the sitemap lives at a non-standard path.
  // Confirmed live: theagelessclinic.com's robots.txt contains
  // "Sitemap: https://www.theagelessclinic.com/sitemap.xml" — which we
  // would have found anyway — but on custom CMS / Squarespace sites the
  // path is often non-standard (e.g. /sitemap.xml?page=1 or /sitemap/).
  const robotsUrls: string[] = [];
  try {
    const robotsText = await fetchText(origin + "/robots.txt", 8000, trackStatus);
    if (robotsText) {
      const sitemapLines = robotsText.match(/^Sitemap:\s*(.+)$/gim) || [];
      for (const line of sitemapLines) {
        const sitemapUrl = line.replace(/^Sitemap:\s*/i, "").trim();
        if (sitemapUrl && /^https?:\/\//i.test(sitemapUrl)) {
          robotsUrls.push(sitemapUrl);
        }
      }
      if (robotsUrls.length > 0) {
        console.log(`crawlSite: Found ${robotsUrls.length} sitemap URL(s) in robots.txt`);
      }
    }
  } catch {
    /* robots.txt fetch failure is non-fatal */
  }

  // Build the final candidate list: robots.txt declarations first (most
  // authoritative), then the standard guesses as fallback.
  const candidatePaths = [
    ...robotsUrls,
    ...SITEMAP_CANDIDATES.map((c) => origin + c).filter((u) => !robotsUrls.includes(u)),
  ];

  for (const candUrl of candidatePaths) {
    const xml = await fetchText(candUrl, undefined, trackStatus);
    if (!xml) continue;
    const locs = locsOf(xml);
    const children = locs.filter((l) => /\.xml(\?|$)/i.test(l));
    if (children.length) {
      childSitemaps = children.slice(0, MAX_CHILD_SITEMAPS);
      if (children.length > MAX_CHILD_SITEMAPS) {
        warnings.push(`Site has ${children.length} child sitemaps; only the first ${MAX_CHILD_SITEMAPS} were read.`);
      }
    } else if (locs.length) {
      childSitemaps = [candUrl]; // flat sitemap, no index
    }
    if (childSitemaps.length) {
      // Record which path we used (strip origin for display)
      try { indexUsed = new URL(candUrl).pathname; } catch { indexUsed = candUrl; }
      console.log(`crawlSite: Found ${childSitemaps.length} sitemaps via ${candUrl}`);
      break;
    }
  }

  for (const sm of childSitemaps) {
    const source = sourceOfSitemap(sm);
    const xml = await fetchText(sm, undefined, trackStatus);
    if (!xml) {
      warnings.push(`Child sitemap could not be fetched: ${sm}`);
      continue;
    }
    for (const u of locsOf(xml)) add(u, source);
  }

  const sitemapOnlyCount = found.size;
  console.log(`crawlSite: Sitemap discovery completed. Found ${sitemapOnlyCount} URLs.`);
  let discoveredVia = childSitemaps.length ? "sitemap" : "homepage links";
  if (!sitemapOnlyCount) {
    discoveredVia = "homepage links";
  }

  // ---- supplement: homepage links, ALWAYS (not only when the sitemap failed) ----
  // Real-world sitemaps are frequently incomplete even when they "work": SEO
  // plugins (Yoast/RankMath) routinely exclude standalone landing pages that
  // were built outside the normal page flow, or leave a page out entirely for
  // reasons that have nothing to do with whether it's real, live content.
  // Confirmed live: lunamedspawi.com's /injectables/, /skincare/, /wellness/
  // are real 200-status pages linked directly from the homepage nav, in NO
  // sitemap at all — invisible to this crawler when the homepage-link pass
  // only ran as a last resort for a totally empty sitemap.
  //
  // addNewOnly guards against a precedence regression: if a page the sitemap
  // ALREADY found (e.g. a portfolio-sourced service page, very often also
  // linked from the homepage nav) got an extra "page" source added here,
  // SOURCE_RANK would let "page" (100) silently outrank "portfolio" (90) and
  // break the Gemini-adjudication routing in classify.ts, which specifically
  // checks `source === "portfolio"`. Only genuinely NEW paths are added.
  const addNewOnly = (rawUrl: string, source: string) => {
    let path: string | null;
    try {
      path = toPagePath(new URL(rawUrl).pathname);
    } catch {
      return;
    }
    if (path && !found.has(path)) add(rawUrl, source);
  };

  if (!homeHtml && !sitemapOnlyCount) warnings.push("Homepage could not be fetched either.");
  for (const m of homeHtml.matchAll(/href=["']([^"'#?]+)["']/gi)) {
    try {
      addNewOnly(new URL(m[1]!, origin).href, "page");
    } catch {
      /* skip */
    }
  }

  // ---- collect external shop/store links from homepage ----
  // Sites frequently link to an external storefront (a Shopify store on a
  // different domain, an external vendor portal, etc.) from their navbar.
  // These links are intentionally excluded from same-origin page counting,
  // but they ARE a real "store" signal that should be reported. We collect
  // them here so Phase 2 (platform detection) can fingerprint the external
  // store and report it as isThirdParty=true with the correct platform.
  //
  // We identify a link as a potential external store if:
  //   a) the anchor text matches shop/store/buy/cart/products keywords, OR
  //   b) the href itself contains shop/store/shopify/cart patterns
  // A deliberate conservative threshold: we don't want to flag every social
  // media link or partner referral as a "store".
  const externalStoreLinks: ExternalStoreLink[] = [];
  const anchorRe = /<a\s[^>]*href=["']([^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of homeHtml.matchAll(anchorRe)) {
    const href = m[1]!.trim();
    const rawText = m[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    try {
      const linked = new URL(href, origin);
      if (linked.protocol !== "https:" && linked.protocol !== "http:") continue; // mailto:, tel:
      if (isSameSite(linked)) continue; // same site — not an external store
      if (isNotAStorefront(linked.hostname.toLowerCase())) continue;
      if (externalStoreLinks.some((l) => l.url === linked.href)) continue; // nav + footer repeat the same link
      const isStoreAnchor = /\bshop\b|\bstore\b|\bbuy\b|\bcart\b|\bproducts\b/i.test(rawText);
      const isStoreHref = /shop\.|\.shop\b|shopify|\/shop|\/store|cart\.|\.cart/i.test(linked.href);
      if (isStoreAnchor || isStoreHref) {
        externalStoreLinks.push({ url: linked.href, anchorText: rawText });
      }
    } catch {
      /* skip unparseable hrefs */
    }
  }

  // Extract navigation menu hierarchy signals from homepage HTML
  const navCategories = extractNavCategories(homeHtml, origin);
  for (const [p, cat] of navCategories.entries()) {
    if (ASSET_RE.test(p) || NON_PAGE_PATH_RE.test(p)) continue;
    let row = found.get(p);
    if (!row) {
      row = { path: p, url: origin + p, sources: new Set() };
      found.set(p, row);
    }
    if (cat === "service") {
      row.sources.add("portfolio");
    } else {
      row.sources.add(`nav:${cat}`);
    }
  }

  // ---- supplement: product-category links from the store's own /shop/ page ----
  // WooCommerce product CATEGORY archive pages are commonly excluded from the
  // sitemap entirely (some sites publish no product_cat sitemap at all, even
  // though individual products ARE listed) — but the store's own /shop/ page
  // always links to every category. Confirmed live: lunamedspawi.com has no
  // product-category sitemap, but its (sitemap-discovered) /shop/ page links
  // to all 10 of its real product categories.
  const shopPage = [...found.values()].find((row) => /^\/(shop|store)\/?$/i.test(row.path));
  if (shopPage) {
    console.log(`crawlSite: Found shop page at ${shopPage.url}, fetching categories...`);
    const shopHtml = await fetchText(shopPage.url, undefined, trackStatus);
    for (const m of shopHtml.matchAll(/href=["']([^"'#?]+)["']/gi)) {
      try {
        const linked = new URL(m[1]!, origin);
        if (/\/product-category\//i.test(linked.pathname)) addNewOnly(linked.href, "product_cat");
      } catch {
        /* skip */
      }
    }
  }

  // ---- supplement: blog posts from blog archive page(s) and WordPress REST API ----
  // When sites lack an XML sitemap (e.g. thebellevous.com), blog posts are only linked
  // from the blog hub (/blog/, /blogs/, /news/, /articles/) or available via WP REST API.
  const blogHubs = [...found.values()].filter((row) =>
    /^\/(blogs?|news|articles?)\/?$/i.test(row.path)
  );

  // A URL confirmed as a blog post (listed in the blog hub, or returned by the
  // WP posts API) is a post even if the homepage-link pass recorded it as a
  // generic page first.
  const markAsPost = (rawUrl: string) => {
    let u: URL;
    try {
      u = new URL(rawUrl, origin);
    } catch {
      return;
    }
    if (!isSameSite(u)) return;
    const p = toPagePath(u.pathname);
    if (!p || p === "/" || blogHubs.some((hub) => hub.path === p)) return;
    add(u.href, "post");
    const r = found.get(p);
    if (r) {
      r.sources.delete("page");
      r.sources.add("post");
    }
  };

  for (const blogHub of blogHubs) {
    console.log(`crawlSite: Found blog hub at ${blogHub.url}, fetching blog posts...`);
    const blogHtml = await fetchText(blogHub.url, undefined, trackStatus);
    if (!blogHtml) continue;

    // 1. Extract links from <article> elements
    for (const block of blogHtml.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)) {
      for (const m of block[1]!.matchAll(/href=["']([^"'#?]+)["']/gi)) markAsPost(m[1]!);
    }

    // 2. Extract links from post-listing cards (.elementor-post, .post, .entry, .blog-card)
    const postCards = blogHtml.matchAll(/<(?:div|li)[^>]*class=["'][^"']*(?:elementor-post|post-|entry|blog-post|blog-card)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|li)>/gi);
    for (const card of postCards) {
      for (const m of card[1]!.matchAll(/href=["']([^"'#?]+)["']/gi)) markAsPost(m[1]!);
    }
  }

  // 3. Query WordPress REST API for posts if it's a WordPress site
  const isWordPress =
    homeHtml.includes("wp-content") ||
    homeHtml.includes("wp-includes") ||
    found.has("/wp-json/") ||
    [...found.keys()].some((p) => /wp-content/i.test(p));

  if (isWordPress) {
    try {
      const wpPostsJson = await fetchText(origin + "/wp-json/wp/v2/posts?per_page=100", 10000, trackStatus);
      if (wpPostsJson && wpPostsJson.trim().startsWith("[")) {
        const posts = JSON.parse(wpPostsJson);
        if (Array.isArray(posts)) {
          for (const item of posts) {
            if (typeof item.link === "string") markAsPost(item.link);
          }
        }
      }
    } catch {
      /* ignore REST error */
    }
  }

  // ---- resolve each URL to its single most authoritative source ----------
  const pages: AnalyzedPage[] = [...found.values()]
    .map((row) => {
      const sources = [...row.sources].sort((a, b) => rankOf(b) - rankOf(a));
      const source = isTaxonomyArchive(row.path, sources) ? "archive" : sources[0] || "page";
      const navCategory = navCategories.get(row.path);
      return {
        path: row.path,
        url: row.url,
        source,
        sources,
        isPage: !NON_PAGE_SOURCES.has(source),
        title: titleFromPath(row.path),
        navCategory,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const counts: Record<string, number> = {};
  for (const p of pages) counts[p.source] = (counts[p.source] || 0) + 1;

  // A specific, actionable warning when there's direct evidence of a block —
  // don't leave the employee guessing between "JS-rendered" and "blocking us"
  // when the response codes already say which one it is. This REPLACES the
  // warnings accumulated during discovery (e.g. "No sitemap found — page list
  // is from homepage links only") rather than appending to them: those are
  // misleading noise once we know EVERY fetch, including the homepage-link
  // pass, was blocked — there is no "homepage links" fallback data to caveat.
  const allFetchesBlocked = totalFetches > 0 && blockedStatuses.length === totalFetches;
  if (allFetchesBlocked) {
    const codes = [...new Set(blockedStatuses)].join(", ");
    warnings.length = 0;
    warnings.push(
      `This site returned HTTP ${codes} on every request — it appears to be actively blocking automated traffic (a WAF or bot-protection service, commonly one that blocks cloud/hosting-provider IP ranges). This site could not be analyzed from here; try checking it manually in a browser.`
    );
  } else if (!pages.length) {
    warnings.push("No pages discovered at all — the site may be JS-rendered or blocking us.");
  }

  const totalPages = pages.filter((p) => p.isPage).length;
  console.log(`crawlSite: Crawl completed in ${Date.now() - started}ms. Pages: ${totalPages}, Total URLs: ${found.size}`);

  // Stale sitemap warning: if the sitemap found significantly fewer URLs than
  // what the homepage-link pass discovered, the sitemap is probably outdated.
  // This is common on custom/PHP sites that use a third-party sitemap generator
  // run manually (e.g. www.xml-sitemaps.com) rather than an auto-regenerating plugin.
  // Only warn when the sitemap was actually used (not homepage-links-only discovery)
  // and when the gap is large enough to be actionable (>= 3x more from homepage).
  if (sitemapOnlyCount > 0 && found.size >= sitemapOnlyCount * 3 && found.size - sitemapOnlyCount > 20) {
    warnings.push(
      `Sitemap appears incomplete or stale: sitemap provided ${sitemapOnlyCount} URL(s), ` +
      `but homepage links discovered ${found.size - sitemapOnlyCount} additional URL(s). ` +
      `Page count includes all discovered URLs; consider regenerating the sitemap.`
    );
  }

  return {
    origin,
    discoveredVia,
    sitemapIndex: indexUsed,
    sitemaps: childSitemaps,
    urlsSeen: found.size, // every URL, including non-pages
    total: totalPages, // the headline "how many pages"
    pages,
    counts,
    warnings,
    durationMs: Date.now() - started,
    externalStoreLinks,
    homeHtml,
  };
}
