// Independent ground-truth crawler. Deliberately does NOT import
// src/analyzer/crawl.ts — this must be a separate implementation, or a
// comparison against it would just be the analyzer checking itself.

const UA = "Mozilla/5.0 (compatible; G99-Validator/1.0)";
const NON_PAGE_SOURCES = new Set(["product", "product_cat", "video", "attachment", "image", "local"]);

export interface GroundTruth {
  host: string;
  origin: string;
  childSitemaps: string[];
  countsBySource: Record<string, number>;
  totalPages: number; // deduped, excludes NON_PAGE_SOURCES
  urlsSeen: number;
  hasLocalSitemap: boolean;
  localCount: number;
  platform: {
    wpJsonStatus: number;
    wpContentHits: boolean;
    elementorHits: number;
    diviHits: number;
    woocommerceHits: boolean;
    generatorMeta: string | null;
  };
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

async function fetchStatus(url: string, timeoutMs = 8000): Promise<number> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": UA } });
    return r.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

const locsOf = (xml: string): string[] =>
  (xml.match(/<loc>([^<]+)<\/loc>/g) || []).map((m) => m.replace(/<\/?loc>/g, "").trim());

// Same precedence idea as src/analyzer/crawl.ts SOURCE_RANK: a URL that appears
// in both the page sitemap and (e.g.) the video sitemap is a real page that
// happens to carry a video, not a media item. Independently re-derived here so
// the ground truth doesn't just inherit the analyzer's own logic.
const SOURCE_RANK: Record<string, number> = {
  page: 100, portfolio: 90, astra: 90, product: 80, product_cat: 70, post: 60, local: 50, video: 10, attachment: 5, image: 5,
};
const rankOf = (s: string) => SOURCE_RANK[s] ?? 40;

const sourceOfSitemap = (url: string): string => (url.match(/([a-z_]+)-sitemap/i) || [, "page"])[1]!.toLowerCase();

export async function crawlGroundTruth(siteUrl: string): Promise<GroundTruth> {
  const url = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : "https://" + siteUrl);
  const origin = url.origin;
  const host = url.hostname;

  const indexXml = await fetchText(origin + "/sitemap.xml");
  const childSitemaps = locsOf(indexXml).filter((l) => /\.xml$/i.test(l));

  // path -> best source seen (first occurrence wins is fine here; ground truth
  // just needs a page-vs-non-page split, not source-precedence subtlety)
  const pathSources = new Map<string, Set<string>>();
  let urlsSeen = 0;
  let localCount = 0;
  let hasLocalSitemap = false;

  for (const sm of childSitemaps) {
    const source = sourceOfSitemap(sm);
    if (source === "local") hasLocalSitemap = true;
    const xml = await fetchText(sm);
    const locs = locsOf(xml);
    if (source === "local") localCount += locs.length;
    for (const loc of locs) {
      let x: URL;
      try {
        x = new URL(loc);
      } catch {
        continue;
      }
      if (x.origin !== origin) continue;
      if (/\.(xml|kml|jpe?g|png|webp|gif|svg|pdf|css|js|ico|zip|mp4|webm)$/i.test(x.pathname)) continue;
      urlsSeen++;
      const path = x.pathname.replace(/\/{2,}/g, "/");
      if (!pathSources.has(path)) pathSources.set(path, new Set());
      pathSources.get(path)!.add(source);
    }
  }

  // Count each path once, under its highest-ranked source (mirrors the
  // analyzer's SOURCE_RANK precedence, computed independently here).
  const countsBySource: Record<string, number> = {};
  let totalPages = 0;
  for (const sources of pathSources.values()) {
    const winner = [...sources].sort((a, b) => rankOf(b) - rankOf(a))[0]!;
    countsBySource[winner] = (countsBySource[winner] || 0) + 1;
    if (!NON_PAGE_SOURCES.has(winner)) totalPages++;
  }

  // Platform signals — independent regex pass over the homepage.
  const html = await fetchText(origin + "/");
  const elementorHits = (html.match(/elementor/gi) || []).length;
  const diviHits = (html.match(/divi|et_pb_/gi) || []).length;
  const wpContentHits = /wp-content|wp-includes/i.test(html);
  const woocommerceHits = /woocommerce/i.test(html);
  const genMatch = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
  const wpJsonStatus = await fetchStatus(origin + "/wp-json/");

  return {
    host,
    origin,
    childSitemaps,
    countsBySource,
    totalPages,
    urlsSeen,
    hasLocalSitemap,
    localCount,
    platform: {
      wpJsonStatus,
      wpContentHits,
      elementorHits,
      diviHits,
      woocommerceHits,
      generatorMeta: genMatch ? genMatch[1]! : null,
    },
  };
}
