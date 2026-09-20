// Types mirror the server's AnalyzeResult (server/src/analyzer). Kept in sync by
// hand for now; a shared package can replace this once the shape settles.

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

export interface AnalyzeResult {
  url: string;
  crawl: CrawlResult;
}

export async function analyze(url: string): Promise<AnalyzeResult> {
  const res = await fetch(`/api/analyze?url=${encodeURIComponent(url)}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body as AnalyzeResult;
}
