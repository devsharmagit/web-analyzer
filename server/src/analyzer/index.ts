import { crawlSite, type CrawlResult } from "./crawl.js";
import { detectPlatform, detectStore, type PlatformResult, type StoreResult } from "./platform.js";
import { classifyPages, type TaxonomyResult } from "./classify.js";
import { detectProviders, type ProvidersResult } from "./providers.js";
import { detectLocations, type LocationsResult } from "./locations.js";
import { detectBeforeAfterGallery, type BeforeAfterResult } from "./beforeAfter.js";

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
  crawl: Pick<CrawlResult, "discoveredVia" | "sitemaps" | "urlsSeen" | "durationMs" | "warnings">;
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

  const platformPromise = withTimeout(detectPlatform(crawl.origin), 15000, {
    cms: { value: null, confidence: "unknown" as const, evidence: [] },
    builder: { value: null, confidence: "unknown" as const, evidence: [] },
    ecommerce: { value: null, confidence: "unknown" as const, evidence: [] },
  });
  // Safety-net timeout only: classifyPages now internally time-boxes its own
  // slow steps (Gemini adjudication, Crawlee content fetch) at 20s each, so
  // this should rarely fire. It used to be the ONLY timeout, which meant a
  // slow content-fetch step silently discarded the entire, already-computed
  // taxonomy for all other pages — confirmed live on a 266-page Divi site.
  const taxonomyPromise = withTimeout(classifyPages(crawl.pages), 55000, { byType: {}, uncertainCount: 0, warnings: [] });
  const providersPromise = withTimeout(detectProviders(crawl.origin, crawl.pages), 30000, {
    count: "unknown" as const,
    source: null,
    list: [],
  });
  const locationsPromise = withTimeout(detectLocations(crawl.origin, crawl.pages, crawl.sitemaps), 20000, {
    count: "unknown" as const,
    source: null,
    list: [],
  });

  // beforeAfterGallery depends on taxonomy.byType.beforeAfter, so it can't
  // start until taxonomy resolves — but it does NOT depend on
  // providers/locations, so it's kicked off as soon as taxonomy is ready
  // rather than waiting for the whole batch first. Confirmed live this
  // mattered: awaiting the full batch before starting it pushed a cold-start
  // request past a 30s timeout that a concurrent start would have avoided.
  const taxonomy = await taxonomyPromise;
  const beforeAfterPromise = withTimeout(detectBeforeAfterGallery(taxonomy.byType.beforeAfter?.urls || []), 35000, {
    pageUrl: null,
    imageCount: 0,
    caseCount: "unknown" as const,
    confidence: "unknown" as const,
    evidence: [],
    images: [],
  });

  const [platform, providers, locations, beforeAfterGallery] = await Promise.all([
    platformPromise,
    providersPromise,
    locationsPromise,
    beforeAfterPromise,
  ]);

  const store = detectStore(crawl.counts, platform.ecommerce);

  // Surface taxonomy's own warnings (internal timeouts on its slow steps) and
  // the outer-safety-net "reason" (if THAT fired instead) alongside crawl's —
  // one place in the response for "here's what you should not fully trust."
  const allWarnings = [...crawl.warnings, ...taxonomy.warnings];
  if ("reason" in taxonomy && typeof (taxonomy as any).reason === "string") {
    allWarnings.push(`Page classification: ${(taxonomy as any).reason}`);
  }

  return {
    url: crawl.origin,
    platform,
    pages: { total: crawl.total, byType: taxonomy.byType, uncertainCount: taxonomy.uncertainCount },
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
    },
  };
}
