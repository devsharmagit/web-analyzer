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
 * later phase reads its page list; phases 2-4 then run concurrently, each with
 * its own timeout and fallback so one slow/failing phase never fails the whole
 * analysis.
 */
export async function analyze(url: string): Promise<AnalyzeResult> {
  const crawl = await crawlSite(url);

  const [platform, taxonomy, providers, locations] = await Promise.all([
    withTimeout(detectPlatform(crawl.origin), 15000, {
      cms: { value: null, confidence: "unknown" as const, evidence: [] },
      builder: { value: null, confidence: "unknown" as const, evidence: [] },
      ecommerce: { value: null, confidence: "unknown" as const, evidence: [] },
    }),
    // Safety-net timeout only: classifyPages now internally time-boxes its own
    // slow steps (Gemini adjudication, Crawlee content fetch) at 20s each, so
    // this should rarely fire. It used to be the ONLY timeout, which meant a
    // slow content-fetch step silently discarded the entire, already-computed
    // taxonomy for all other pages — confirmed live on a 266-page Divi site.
    withTimeout(classifyPages(crawl.pages), 55000, { byType: {}, uncertainCount: 0, warnings: [] }),
    withTimeout(detectProviders(crawl.origin, crawl.pages), 30000, {
      count: "unknown" as const,
      source: null,
      list: [],
    }),
    withTimeout(detectLocations(crawl.origin, crawl.pages, crawl.sitemaps), 20000, {
      count: "unknown" as const,
      source: null,
      list: [],
    }),
  ]);

  const store = detectStore(crawl.counts, platform.ecommerce);

  // Depends on taxonomy.byType.beforeAfter, so it can't join the Promise.all
  // above — it has to run after taxonomy resolves. Own timeout/fallback, same
  // graceful-degradation contract as every other phase.
  const beforeAfterGallery = await withTimeout(
    detectBeforeAfterGallery(taxonomy.byType.beforeAfter?.urls || []),
    30000,
    { pageUrl: null, imageCount: 0, caseCount: "unknown" as const, confidence: "unknown" as const, evidence: [] }
  );

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
