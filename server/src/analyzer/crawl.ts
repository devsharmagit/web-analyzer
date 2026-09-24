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
// how a real block like this is now surfaced instead.
const UA = "Mozilla/5.0 (compatible; G99WebAnalyzer/1.0; +https://github.com/devsharmagit/web-analyzer)";
const SITEMAP_CANDIDATES = ["/sitemap.xml", "/wp-sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml"];
const MAX_CHILD_SITEMAPS = 25;
const ASSET_RE = /\.(xml|kml|jpe?g|png|webp|gif|svg|pdf|css|js|ico|zip|mp4|webm|json|webmanifest|md|txt|csv)(\?|#|$)/i;
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
  navCategory?: string;
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

// Status codes that specifically mean "a WAF/bot-protection service is
// blocking us" rather than "this URL doesn't exist" or "transient network
// error" — worth a distinct, actionable warning instead of the generic
// catch-all "may be JS-rendered or blocking us".
const BLOCKED_STATUSES = new Set([401, 403, 429, 503]);

async function fetchText(url: string, timeoutMs = 15000, onStatus?: (status: number) => void): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": UA } });
    onStatus?.(r.status);
    if (!r.ok) {
      console.error(`fetchText: Failed to fetch ${url} - Status: ${r.status}`);
      return "";
    }
    return await r.text();
  } catch (err) {
    console.error(`fetchText: Error fetching ${url}:`, err);
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

  function cleanPath(urlStr: string): string | null {
    try {
      const u = new URL(urlStr, origin);
      if (u.origin !== origin) return null;
      let p = u.pathname.replace(/\/+/g, "/");
      if (p !== "/" && !p.endsWith("/") && !ASSET_RE.test(p)) p += "/";
      if (ASSET_RE.test(p) || NON_PAGE_PATH_RE.test(p)) return null;
      return p;
    } catch {
      return null;
    }
  }

  // 1. WordPress / CMS custom post type classes on menu items (e.g. menu-item-object-*-portfolio, menu-item-object-service)
  const cptMatches = html.matchAll(/<li[^>]*class=["']([^"']*menu-item-object-[^"']*)["'][^>]*>([\s\S]*?)<\/li>/gi);
  for (const m of cptMatches) {
    const cls = m[1];
    const content = m[2];
    if (/portfolio|service|treatment/i.test(cls)) {
      const hrefMatch = content.match(/href=["']([^"'#?]+)["']/i);
      if (hrefMatch) {
        const p = cleanPath(hrefMatch[1]);
        if (p && p !== "/") result.set(p, "service");
      }
    }
  }

  // 2. Navigation dropdown menus (<li class="...has-children... | ...dropdown...">)
  const liBlocks = html.matchAll(/<li[^>]*class=["'][^"']*(?:menu-item-has-children|dropdown|has-dropdown|menu-item--has-children)[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi);
  for (const block of liBlocks) {
    const text = block[1];
    const topAnchorMatch = text.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    if (!topAnchorMatch) continue;
    const topText = topAnchorMatch[1].replace(/<[^>]+>/g, " ").trim();
    const topHref = topAnchorMatch[0].match(/href=["']([^"'#?]+)["']/i);

    let matchedCategory: string | null = null;
    for (const sp of sectionPatterns) {
      if (sp.re.test(topText) || (topHref && sp.re.test(topHref[1]))) {
        matchedCategory = sp.category;
        break;
      }
    }

    if (matchedCategory) {
      const childLinks = text.matchAll(/href=["']([^"'#?]+)["']/gi);
      for (const cl of childLinks) {
        const p = cleanPath(cl[1]);
        if (p && p !== "/") {
          if (!result.has(p)) result.set(p, matchedCategory);
        }
      }
    }
  }

  // 3. Header CTA buttons or action links (e.g. "Self Assessment", "Cherry Financing")
  const ctaMatches = html.matchAll(/<a[^>]*class=["'][^"']*(?:button|btn|cta|elementor-button)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi);
  for (const m of ctaMatches) {
    const btnText = m[1].replace(/<[^>]+>/g, " ").trim();
    const hrefMatch = m[0].match(/href=["']([^"'#?]+)["']/i);
    if (hrefMatch) {
      const p = cleanPath(hrefMatch[1]);
      if (p && p !== "/") {
        if (/self[- ]?assessment|quiz|consult/i.test(btnText) || /self[- ]?assessment/i.test(p)) {
          if (!result.has(p)) result.set(p, "forms");
        } else if (/cherry|financing|payment/i.test(btnText) || /cherry|financing/i.test(p)) {
          if (!result.has(p)) result.set(p, "offers");
        }
      }
    }
  }

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
  const trackStatus = (status: number) => {
    totalFetches++;
    if (BLOCKED_STATUSES.has(status)) blockedStatuses.push(status);
  };

  let origin: string;
  try {
    origin = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : "https://" + siteUrl).origin;
    console.log(`crawlSite: Resolved origin to ${origin}`);
  } catch {
    console.error(`crawlSite: Invalid URL: ${siteUrl}`);
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
    if (ASSET_RE.test(path) || NON_PAGE_PATH_RE.test(path) || DATE_ARCHIVE_PATH_RE.test(path)) return;
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
  for (const cand of SITEMAP_CANDIDATES) {
    const xml = await fetchText(origin + cand, undefined, trackStatus);
    if (!xml) continue;
    const locs = locsOf(xml);
    const children = locs.filter((l) => /\.xml(\?|$)/i.test(l));
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
      console.log(`crawlSite: Found ${childSitemaps.length} sitemaps via ${cand}`);
      break;
    }
  }

  for (const sm of childSitemaps) {
    const source = sourceOfSitemap(sm);
    const xml = await fetchText(sm, undefined, trackStatus);
    if (!xml) {
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
    let path: string;
    try {
      path = new URL(rawUrl).pathname.replace(/\/{2,}/g, "/");
    } catch {
      return;
    }
    if (!found.has(path)) add(rawUrl, source);
  };

  console.log(`crawlSite: Fetching homepage links for ${origin}...`);
  const homeHtml = await fetchText(origin + "/", undefined, trackStatus);
  if (!homeHtml && !sitemapOnlyCount) warnings.push("Homepage could not be fetched either.");
  for (const m of homeHtml.matchAll(/href=["']([^"'#?]+)["']/gi)) {
    try {
      addNewOnly(new URL(m[1]!, origin).href, "page");
    } catch {
      /* skip */
    }
  }

  // Extract navigation menu hierarchy signals from homepage HTML
  const navCategories = extractNavCategories(homeHtml, origin);
  for (const [p, cat] of navCategories.entries()) {
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

  for (const blogHub of blogHubs) {
    console.log(`crawlSite: Found blog hub at ${blogHub.url}, fetching blog posts...`);
    const blogHtml = await fetchText(blogHub.url, undefined, trackStatus);
    if (!blogHtml) continue;

    // 1. Extract links from <article> elements
    const articleBlocks = blogHtml.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi);
    for (const block of articleBlocks) {
      for (const m of block[1].matchAll(/href=["']([^"'#?]+)["']/gi)) {
        try {
          const u = new URL(m[1]!, origin);
          if (u.origin === origin) {
            let p = u.pathname.replace(/\/+/g, "/");
            if (p !== "/" && !p.endsWith("/") && !ASSET_RE.test(p)) p += "/";
            if (p !== "/" && p !== blogHub.path && !ASSET_RE.test(p) && !NON_PAGE_PATH_RE.test(p)) {
              add(u.href, "post");
              const r = found.get(p);
              if (r) {
                r.sources.delete("page");
                r.sources.add("post");
              }
            }
          }
        } catch {
          /* skip */
        }
      }
    }

    // 2. Extract links from post-listing cards (.elementor-post, .post, .entry, .blog-card)
    const postCards = blogHtml.matchAll(/<(?:div|li)[^>]*class=["'][^"']*(?:elementor-post|post-|entry|blog-post|blog-card)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|li)>/gi);
    for (const card of postCards) {
      for (const m of card[1].matchAll(/href=["']([^"'#?]+)["']/gi)) {
        try {
          const u = new URL(m[1]!, origin);
          if (u.origin === origin) {
            let p = u.pathname.replace(/\/+/g, "/");
            if (p !== "/" && !p.endsWith("/") && !ASSET_RE.test(p)) p += "/";
            if (p !== "/" && p !== blogHub.path && !ASSET_RE.test(p) && !NON_PAGE_PATH_RE.test(p)) {
              add(u.href, "post");
              const r = found.get(p);
              if (r) {
                r.sources.delete("page");
                r.sources.add("post");
              }
            }
          }
        } catch {
          /* skip */
        }
      }
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
            if (typeof item.link === "string") {
              add(item.link, "post");
              try {
                const u = new URL(item.link);
                let p = u.pathname.replace(/\/+/g, "/");
                if (p !== "/" && !p.endsWith("/")) p += "/";
                const r = found.get(p);
                if (r) {
                  r.sources.delete("page");
                  r.sources.add("post");
                }
              } catch {
                /* skip */
              }
            }
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
      const source = sources[0] || "page";
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
  };
}
