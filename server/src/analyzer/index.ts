import { crawlSite, type CrawlResult } from "./crawl.js";
import { detectPlatform, detectStore, fetchStoreProducts, type PlatformResult, type StoreResult } from "./platform.js";
import { classifyPages, type TaxonomyResult } from "./classify.js";
import { detectProviders, type ProvidersResult } from "./providers.js";
import { detectLocations, type LocationsResult } from "./locations.js";
import { detectBeforeAfterGallery, type BeforeAfterResult } from "./beforeAfter.js";

import { fetchHtml } from "./scrapeLite.js";
import { getSessionCredits } from "./fetchWithFallback.js";

export interface AnalyzeResult {
  url: string;
  platform: PlatformResult;
  pages: {
    total: number;
    byType: TaxonomyResult["byType"];
    uncertainCount: number;
  };
  store: StoreResult;
  providers: ProvidersResult;
  locations: LocationsResult;
  beforeAfterGallery: BeforeAfterResult;
  crawl: Pick<CrawlResult, "discoveredVia" | "sitemaps" | "urlsSeen" | "durationMs" | "warnings"> & {
    scraperApiCreditsUsed?: number;
  };
}

// Tags the fallback with a "timed out" reason only when the timeout branch
// actually wins the race — so a UI can distinguish "we checked, found nothing"
// (the phase's own reason) from "we never got an answer in time".
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve({ ...fallback, reason: `timed out after ${ms}ms` } as T), ms)
    ),
  ]);
}

/**
 * Analyze a single website. Synchronous request/response — one URL at a time,
 * no job queue (see ANALYZER-SCOPE.md). Phase 1 (crawl) runs first since every
 * later phase reads its page list; taxonomy, platform, providers and
 * locations then run concurrently, and before/after gallery detection joins
 * in as soon as taxonomy resolves (it depends on taxonomy's output, but not
 * on providers/locations) — each phase has its own timeout and fallback so
 * one slow/failing phase never fails the whole analysis.
 */
export async function analyze(url: string): Promise<AnalyzeResult> {
  const crawl = await crawlSite(url);

  const platformPromise = withTimeout(detectPlatform(crawl.origin), 30000, {
    cms: { value: null, confidence: "unknown" as const, evidence: [] },
    builder: { value: null, confidence: "unknown" as const, evidence: [] },
    ecommerce: { value: null, confidence: "unknown" as const, evidence: [] },
  });
  const taxonomyPromise = withTimeout(classifyPages(crawl.pages), 90000, { byType: {}, uncertainCount: 0, warnings: [] });
  const providersPromise = withTimeout(detectProviders(crawl.origin, crawl.pages), 45000, {
    count: "unknown" as const,
    source: null,
    list: [],
  });
  const locationsPromise = withTimeout(detectLocations(crawl.origin, crawl.pages, crawl.sitemaps), 45000, {
    count: "unknown" as const,
    source: null,
    list: [],
  });

  const taxonomy = await taxonomyPromise;
  const beforeAfterPromise = withTimeout(detectBeforeAfterGallery((taxonomy.byType.beforeAfter?.urls || []).map(u => u.url)), 60000, {
    pageUrl: null,
    imageCount: 0,
    caseCount: "unknown" as const,
    confidence: "unknown" as const,
    evidence: [],
    images: [],
  });

  const shopPage = crawl.pages.find((p) => /^\/(shop|store)\/?$/i.test(p.path)) ||
    (crawl.pages.some((p) => /\/(shop|store)\//i.test(p.path)) ? { url: crawl.origin + "/shop/", path: "/shop/" } : null);

  const shopHtmlPromise = shopPage ? fetchHtml(shopPage.url, 25000).catch(() => "") : Promise.resolve("");
  const apiProductsPromise = fetchStoreProducts(crawl.origin).catch(() => []);

  const [platform, providers, locations, beforeAfterGallery, shopHtml, apiProducts] = await Promise.all([
    platformPromise,
    providersPromise,
    locationsPromise,
    beforeAfterPromise,
    shopHtmlPromise,
    apiProductsPromise,
  ]);

  const productUrls = crawl.pages.filter((p) => p.source === "product").map((p) => p.url);
  const store = detectStore(crawl.counts, platform.ecommerce, shopHtml, productUrls, apiProducts);

  // Surface taxonomy's own warnings (internal timeouts on its slow steps) and
  // the outer-safety-net "reason" (if THAT fired instead) alongside crawl's —
  // one place in the response for "here's what you should not fully trust."
  const allWarnings = [...crawl.warnings, ...taxonomy.warnings];
  const isTaxonomyTimedOut = "reason" in taxonomy && typeof (taxonomy as any).reason === "string";
  if (isTaxonomyTimedOut) {
    allWarnings.push(`Page classification: ${(taxonomy as any).reason}`);
  }

  // If taxonomy timed out or failed, report an honest error state:
  // All discovered pages that are real pages are marked as uncertain rather than 0.
  const pageCandidates = crawl.pages.filter((p) => p.isPage);
  let finalByType = taxonomy.byType;
  let finalUncertainCount = taxonomy.uncertainCount;

  if (isTaxonomyTimedOut && Object.keys(finalByType).length === 0 && pageCandidates.length > 0) {
    finalUncertainCount = pageCandidates.length;
    finalByType = {
      uncertain: {
        count: pageCandidates.length,
        urls: pageCandidates.map((p) => ({
          url: p.url,
          method: "unresolved",
          confidence: 0,
          reason: "Classification incomplete: taxonomy analysis timed out",
        })),
      },
    };
    allWarnings.push(
      `Classification incomplete: taxonomy analysis timed out before completing; ${pageCandidates.length} pages left unclassified.`
    );
  }

  return {
    url: crawl.origin,
    platform,
    pages: { total: crawl.total, byType: finalByType, uncertainCount: finalUncertainCount },
    store,
    providers,
    locations,
    beforeAfterGallery,
    crawl: {
      discoveredVia: crawl.discoveredVia,
      sitemaps: crawl.sitemaps,
      urlsSeen: crawl.urlsSeen,
      durationMs: crawl.durationMs,
      warnings: allWarnings,
      scraperApiCreditsUsed: getSessionCredits(),
    },
  };
}
