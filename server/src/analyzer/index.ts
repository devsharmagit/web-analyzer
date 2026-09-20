import { crawlSite, type CrawlResult } from "./crawl.js";

export interface AnalyzeResult {
  url: string;
  crawl: CrawlResult;
  // Phases 2–5 (platform, taxonomy, providers, locations) land here as they ship.
}

/**
 * Analyze a single website. Synchronous request/response — one URL at a time,
 * no job queue (see ANALYZER-SCOPE.md). Currently runs Phase 1 (inventory) only.
 */
export async function analyze(url: string): Promise<AnalyzeResult> {
  const crawl = await crawlSite(url);
  return { url: crawl.origin, crawl };
}
