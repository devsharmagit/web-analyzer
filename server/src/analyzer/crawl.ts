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

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SITEMAP_CANDIDATES = ["/sitemap.xml", "/wp-sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"];
const MAX_CHILD_SITEMAPS = 25;
const ASSET_RE = /\.(xml|kml|jpe?g|png|webp|gif|svg|pdf|css|js|ico|zip|mp4|webm|json)$/i;
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
export const NON_PAGE_SOURCES = new Set(["product", "product_cat", "video", "attachment", "image", "local"]);

export interface AnalyzedPage {
  path: string;
  url: string;
  source: string;
  sources: string[];
  isPage: boolean;
  title: string;
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
}

async function fetchText(url: string, timeoutMs = 15000): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": UA } });
    return r.ok ? await r.text() : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

const locsOf = (xml: string): string[] =>
  (xml.match(/<loc>([^<]+)<\/loc>/g) || []).map((m) => m.replace(/<\/?loc>/g, "").trim());

// The child sitemap's own filename is the source label. Take the LAST word
// before "-sitemap": names are often theme-prefixed ("astra-portfolio-sitemap.xml"),
// and reading the first word instead made 203 portfolio items look like ordinary pages.
const sourceOfSitemap = (url: string): string => (url.match(/([a-z_]+)-sitemap/i) || [, "page"])[1]!.toLowerCase();

export const titleFromPath = (p: string): string =>
  p === "/"
    ? "Home"
    : decodeURIComponent(p)
        .replace(/^\/|\/$/g, "")
        .split("/")
        .pop()!
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());

/** Discover every URL a site publishes. */
export async function crawlSite(siteUrl: string): Promise<CrawlResult> {
  const started = Date.now();
  const warnings: string[] = [];

  let origin: string;
  try {
    origin = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : "https://" + siteUrl).origin;
  } catch {
    throw new Error(`Not a usable URL: ${siteUrl}`);
  }

  const found = new Map<string, { path: string; url: string; sources: Set<string> }>();
  const add = (rawUrl: string, source: string) => {
    let x: URL;
    try {
      x = new URL(rawUrl);
    } catch {
      return;
    }
    if (x.origin !== origin) return; // same-site only
    // Normalize a trailing slash so "/self-assessment" and "/self-assessment/"
    // — both real URLs seen live on havenpmu.com, one from a sitemap and one
    // from the homepage-link supplement — collapse to a single page instead
    // of double-counting. WordPress permalinks canonically end in "/".
    let path = x.pathname.replace(/\/{2,}/g, "/");
    if (path !== "/" && !path.endsWith("/") && !ASSET_RE.test(path)) path += "/";
    if (ASSET_RE.test(path) || NON_PAGE_PATH_RE.test(path)) return;
    let row = found.get(path);
    if (!row) {
      row = { path, url: origin + path, sources: new Set() };
      found.set(path, row);
    }
    row.sources.add(source || "page"); // keep EVERY source
  };

  // ---- sitemap discovery -------------------------------------------------
  let childSitemaps: string[] = [];
  let indexUsed = "";
  for (const cand of SITEMAP_CANDIDATES) {
    const xml = await fetchText(origin + cand);
    if (!xml) continue;
    const locs = locsOf(xml);
    const children = locs.filter((l) => /\.xml$/i.test(l));
    if (children.length) {
      childSitemaps = children.slice(0, MAX_CHILD_SITEMAPS);
      if (children.length > MAX_CHILD_SITEMAPS) {
        warnings.push(`Site has ${children.length} child sitemaps; only the first ${MAX_CHILD_SITEMAPS} were read.`);
      }
    } else if (locs.length) {
      childSitemaps = [origin + cand]; // flat sitemap, no index
    }
    if (childSitemaps.length) {
      indexUsed = cand;
      break;
    }
  }

  for (const sm of childSitemaps) {
    const source = sourceOfSitemap(sm);
    const xml = await fetchText(sm);
    if (!xml) {
      warnings.push(`Could not read sitemap: ${sm}`);
      continue;
    }
    for (const u of locsOf(xml)) add(u, source);
  }

  const sitemapOnlyCount = found.size;
  let discoveredVia = childSitemaps.length ? "sitemap" : "homepage links";
  if (!sitemapOnlyCount) {
    if (childSitemaps.length) warnings.push("Sitemaps were found but yielded no usable URLs — fell back to homepage links.");
    else warnings.push("No sitemap found — page list is from homepage links only and is probably incomplete.");
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
    let path: string;
    try {
      path = new URL(rawUrl).pathname.replace(/\/{2,}/g, "/");
    } catch {
      return;
    }
    if (!found.has(path)) add(rawUrl, source);
  };

  const homeHtml = await fetchText(origin + "/");
  if (!homeHtml && !sitemapOnlyCount) warnings.push("Homepage could not be fetched either.");
  for (const m of homeHtml.matchAll(/href=["']([^"'#?]+)["']/gi)) {
    try {
      addNewOnly(new URL(m[1]!, origin).href, "page");
    } catch {
      /* skip */
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
    const shopHtml = await fetchText(shopPage.url);
    for (const m of shopHtml.matchAll(/href=["']([^"'#?]+)["']/gi)) {
      try {
        const linked = new URL(m[1]!, origin);
        if (/\/product-category\//i.test(linked.pathname)) addNewOnly(linked.href, "product_cat");
      } catch {
        /* skip */
      }
    }
  }

  // ---- resolve each URL to its single most authoritative source ----------
  const pages: AnalyzedPage[] = [...found.values()]
    .map((row) => {
      const sources = [...row.sources].sort((a, b) => rankOf(b) - rankOf(a));
      const source = sources[0] || "page";
      return {
        path: row.path,
        url: row.url,
        source,
        sources,
        isPage: !NON_PAGE_SOURCES.has(source),
        title: titleFromPath(row.path),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const counts: Record<string, number> = {};
  for (const p of pages) counts[p.source] = (counts[p.source] || 0) + 1;

  if (!pages.length) warnings.push("No pages discovered at all — the site may be JS-rendered or blocking us.");

  return {
    origin,
    discoveredVia,
    sitemapIndex: indexUsed,
    sitemaps: childSitemaps,
    urlsSeen: found.size, // every URL, including non-pages
    total: pages.filter((p) => p.isPage).length, // the headline "how many pages"
    pages,
    counts,
    warnings,
    durationMs: Date.now() - started,
  };
}
