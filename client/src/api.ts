// Types mirror the server's AnalyzeResult (server/src/analyzer). Kept in sync by
// hand for now; a shared package can replace this once the shape settles.

export type Confidence = "high" | "likely" | "unknown";

export interface Detection {
  value: string | null;
  confidence: Confidence;
  evidence: string[];
}

export interface PlatformResult {
  cms: Detection;
  builder: Detection;
  ecommerce: Detection;
}

export interface StoreResult {
  hasStore: boolean;
  platform: string | null;
  productCount: number;
  categoryCount: number;
  isThirdParty?: boolean;
  thirdPartyIntegrations?: string[];
  notes?: string;
}

export interface ClassifiedUrl {
  url: string;
  confidence?: number;
  method?: string;
  reason?: string;
}

export interface TypeBucket {
  count: number;
  urls: ClassifiedUrl[];
}

export interface Provider {
  name: string;
  credentials: string;
  role: string;
  bio: string;
  photo: string;
}

export interface ProvidersResult {
  count: number | "unknown";
  source: string | null;
  list: Provider[];
  reason?: string;
}

export interface Location {
  name: string;
  address: string;
  phone: string;
}

export interface LocationsResult {
  count: number | "unknown";
  source: string | null;
  list: Location[];
  reason?: string;
}

export interface BeforeAfterGalleryResult {
  pageUrl: string | null;
  imageCount: number;
  caseCount: number | "unknown";
  confidence: Confidence;
  evidence: string[];
  images: string[];
  reason?: string;
}

export interface AnalyzeResult {
  url: string;
  platform: PlatformResult;
  pages: {
    total: number;
    byType: Record<string, TypeBucket>;
    uncertainCount: number;
  };
  store: StoreResult;
  providers: ProvidersResult;
  locations: LocationsResult;
  beforeAfterGallery: BeforeAfterGalleryResult;
  crawl: {
    discoveredVia: string;
    sitemaps: string[];
    urlsSeen: number;
    durationMs: number;
    warnings: string[];
  };
}

export async function analyze(url: string): Promise<AnalyzeResult> {
  const API_BASE = import.meta.env.VITE_API_URL || "https://web-analyzer-ztnw.onrender.com";
  const res = await fetch(`${API_BASE}/api/analyze?url=${encodeURIComponent(url)}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body as AnalyzeResult;
}
