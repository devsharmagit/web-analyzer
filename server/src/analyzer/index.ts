import { crawlSite, type CrawlResult } from "./crawl.js";
import { detectPlatform, detectStore, type PlatformResult, type StoreResult } from "./platform.js";
import { classifyPages, type TaxonomyResult } from "./classify.js";
import { detectProviders, type ProvidersResult } from "./providers.js";
import { detectLocations, type LocationsResult } from "./locations.js";

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
    // Higher timeout: classifyPages now does a bounded Crawlee content fetch
    // (up to MAX_CONTENT_FETCH pages) for the ambiguous "other" bucket.
    withTimeout(classifyPages(crawl.pages), 45000, { byType: {}, uncertainCount: 0 }),
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

  return {
    url: crawl.origin,
    platform,
    pages: { total: crawl.total, byType: taxonomy.byType, uncertainCount: taxonomy.uncertainCount },
    store,
    providers,
    locations,
    crawl: {
      discoveredVia: crawl.discoveredVia,
      sitemaps: crawl.sitemaps,
      urlsSeen: crawl.urlsSeen,
      durationMs: crawl.durationMs,
      warnings: crawl.warnings,
    },
  };
}
