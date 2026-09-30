import { crawlSite, type CrawlResult } from "./crawl.js";
import { detectPlatform, detectStore, fetchStoreProducts, detectExternalStore, type PlatformResult, type StoreResult } from "./platform.js";
import { classifyPages, type TaxonomyResult } from "./classify.js";
import { detectProviders, type ProvidersResult } from "./providers.js";
import { detectLocations, type LocationsResult } from "./locations.js";
import { detectBeforeAfterGallery, type BeforeAfterResult } from "./beforeAfter.js";

import { fetchHtml } from "./scrapeLite.js";
import { trackProxyUsage } from "./fetchWithFallback.js";

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
    /** Paid-fallback usage by THIS analysis (not the server's running total). */
    scraperApiCreditsUsed: number;
    proxyRequestsUsed: number;
  };
}

// Tags an object fallback with a "timed out" reason only when the timeout
// branch actually wins the race — so a UI can distinguish "we checked, found
// nothing" (the phase's own reason) from "we never got an answer in time".
// A null fallback stays null: spreading it used to produce a truthy
// { reason } object, which the external-store check read as a detected store
// (hasStore: true, platform: undefined) whenever it timed out.
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(
      () => resolve(fallback !== null && typeof fallback === "object" ? ({ ...fallback, reason: `timed out after ${ms}ms` } as T) : fallback),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
  const { result, usage } = await trackProxyUsage(() => runAnalysis(url));
  result.crawl.proxyRequestsUsed = usage.proxyRequests;
  result.crawl.scraperApiCreditsUsed = usage.scraperApiCredits;
  return result;
}

async function runAnalysis(url: string): Promise<AnalyzeResult> {
  const crawl = await crawlSite(url);

  const platformPromise = withTimeout(detectPlatform(crawl.origin, crawl.homeHtml), 30000, {
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
  const locationsPromise = withTimeout(detectLocations(crawl.origin, crawl.pages, crawl.sitemaps, crawl.homeHtml), 45000, {
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
  let store = detectStore(crawl.counts, platform.ecommerce, shopHtml, productUrls, apiProducts);

  // If no native store was detected, check for a cross-domain external store
  // (e.g. a Shopify store on a different subdomain linked from the navbar).
  // This is the fix for theagelessclinic.com: their navbar links to
  // agelessxpress.com → ageless.shop (Shopify), which the same-origin crawl
  // silently ignored, producing a misleading "No store detected" result.
  if (!store.hasStore && crawl.externalStoreLinks.length > 0) {
    try {
      const externalStoreUrls = crawl.externalStoreLinks.map((l) => l.url);
      const externalStore = await withTimeout(
        detectExternalStore(externalStoreUrls),
        12000,
        null
      );
      if (externalStore) {
        store = {
          ...store,
          hasStore: true,
          isThirdParty: true,
          platform: externalStore.platform,
          thirdPartyIntegrations: [externalStore.platform],
          notes: `External ${externalStore.platform} store detected at ${externalStore.finalUrl} (linked from homepage navbar as "${crawl.externalStoreLinks[0]?.anchorText || "shop"}")`,
        };
      }
    } catch {
      /* external store detection failure is non-fatal */
    }
  }

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
      scraperApiCreditsUsed: 0, // filled in by analyze()
      proxyRequestsUsed: 0,
    },
  };
}
