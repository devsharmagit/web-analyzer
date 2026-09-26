export interface FetchResult {
  ok: boolean;
  status: number;
  html: string;
  tier: "direct" | "scraperapi_plain" | "scraperapi_rendered" | "failed";
  creditsUsed: number;
  error?: string;
}

// Running session credit counter
export let sessionScraperApiCreditsUsed = 0;

export function getSessionCredits(): number {
  return sessionScraperApiCreditsUsed;
}

export function resetSessionCredits(): void {
  sessionScraperApiCreditsUsed = 0;
}

export const WAF_BLOCKED_STATUSES = new Set([401, 403, 429, 503]);

/**
 * Checks whether an HTTP response status or connection-level error plausibly
 * indicates a WAF/bot-protection block (or network drop) rather than a non-recoverable
 * DNS or connection refusal (ENOTFOUND, ECONNREFUSED).
 */
export function isRetryableWafOrNetworkError(status: number, err?: any): boolean {
  if (WAF_BLOCKED_STATUSES.has(status)) {
    return true;
  }
  if (!err) {
    return false;
  }

  const code = String(err?.code || "");
  const msg = String(err?.message || "").toLowerCase();

  // Exclude non-recoverable domain/connection errors:
  // Domain does not resolve or port is closed/not listening
  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ERR_INVALID_URL" ||
    msg.includes("enotfound") ||
    msg.includes("econnrefused") ||
    msg.includes("getaddrinfo")
  ) {
    return false;
  }

  // Allow plausible WAF/bot-block connection drops, timeouts, and protocol errors
  const isWafOrDrop =
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code.startsWith("ERR_HTTP2") ||
    err?.name === "TimeoutError" ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("reset") ||
    msg.includes("refused_stream") ||
    msg.includes("nghttp2") ||
    msg.includes("protocol_error");

  return isWafOrDrop;
}

/**
 * Executes a resilient multi-tier fetch:
 * 1. Direct fetch (Default, free, tried first)
 * 2. ScraperAPI plain fallback (Triggered only on WAF block or connection drop, costs 1 credit)
 */
export async function fetchWithFallback(
  url: string,
  options?: {
    timeoutMs?: number;
    headers?: Record<string, string>;
  }
): Promise<FetchResult> {
  const timeoutMs = options?.timeoutMs ?? 15000;
  const apiKey = process.env.SCRAPER_API_KEY;

  // ----------------------------------------------------
  // Tier 1: Direct Fetch (Default, free, primary path)
  // ----------------------------------------------------
  let directStatus = 0;
  let directError: any = null;

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const resp = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...options?.headers,
      },
    });
    clearTimeout(timer);
    directStatus = resp.status;

    if (resp.ok) {
      const html = await resp.text();
      return {
        ok: true,
        status: resp.status,
        html,
        tier: "direct",
        creditsUsed: 0,
      };
    }

    // Check if status is a WAF block
    if (!isRetryableWafOrNetworkError(resp.status)) {
      return {
        ok: false,
        status: resp.status,
        html: "",
        tier: "direct",
        creditsUsed: 0,
        error: `HTTP ${resp.status}`,
      };
    }

    console.warn(`[FETCH] Direct fetch blocked (HTTP ${resp.status}) for ${url}. Attempting ScraperAPI fallback...`);
  } catch (err: any) {
    directError = err;
    if (!isRetryableWafOrNetworkError(0, err)) {
      console.warn(`[FETCH] Direct fetch failed non-recoverably for ${url} (${err?.code || err?.message || err}). Skipping paid fallback.`);
      return {
        ok: false,
        status: 0,
        html: "",
        tier: "direct",
        creditsUsed: 0,
        error: `Non-recoverable error: ${err?.code || err?.message || err}`,
      };
    }

    console.warn(`[FETCH] Direct fetch connection error for ${url} (${err?.code || err?.message || err}). Attempting ScraperAPI fallback...`);
  }

  // ----------------------------------------------------
  // Tier 2: ScraperAPI Plain Fallback (1 credit)
  // ----------------------------------------------------
  if (!apiKey) {
    console.warn(`[FETCH] ScraperAPI key missing from environment (SCRAPER_API_KEY). Cannot execute fallback for ${url}.`);
    return {
      ok: false,
      status: directStatus || 0,
      html: "",
      tier: "failed",
      creditsUsed: 0,
      error: `Direct fetch failed (${directStatus || directError?.code || "network error"}) and SCRAPER_API_KEY is not configured`,
    };
  }

  try {
    const scraperUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(url)}`;
    console.log(`[SCRAPERAPI] Calling plain fallback (render=false) for: ${url}`);

    const resp = await fetch(scraperUrl, { signal: AbortSignal.timeout(30000) });
    const costHeader = resp.headers.get("sa-credit-cost");
    const cost = costHeader ? parseInt(costHeader, 10) : 1;
    sessionScraperApiCreditsUsed += cost;

    console.log(`[SCRAPERAPI] Plain fallback returned HTTP ${resp.status} for ${url} (Credits consumed: ${cost}, Session total: ${sessionScraperApiCreditsUsed})`);

    if (resp.ok) {
      const html = await resp.text();
      return {
        ok: true,
        status: resp.status,
        html,
        tier: "scraperapi_plain",
        creditsUsed: cost,
      };
    }

    return {
      ok: false,
      status: resp.status,
      html: "",
      tier: "failed",
      creditsUsed: cost,
      error: `ScraperAPI returned HTTP ${resp.status}`,
    };
  } catch (err: any) {
    console.error(`[SCRAPERAPI] Plain fallback request failed for ${url}:`, err?.message || err);
    return {
      ok: false,
      status: 0,
      html: "",
      tier: "failed",
      creditsUsed: 0,
      error: `ScraperAPI network error: ${err?.message || err}`,
    };
  }
}
