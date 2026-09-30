import "../loadEnv.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { ProxyAgent, fetch as undiciFetch } from "undici";

// The one User-Agent the analyzer identifies itself with. Honest and
// identifiable (a name plus an info URL, the same shape as Googlebot's) —
// see the note at the top of crawl.ts.
export const ANALYZER_UA = "Mozilla/5.0 (compatible; G99WebAnalyzer/1.0; +https://github.com/devsharmagit/web-analyzer)";

export interface FetchResult {
  ok: boolean;
  status: number;
  html: string;
  /** URL of the final response after redirects (the requested URL if none). */
  finalUrl: string;
  tier: "direct" | "webshare_proxy" | "scraperapi_plain" | "scraperapi_rendered" | "failed";
  creditsUsed: number;
  error?: string;
}

// Paid-fallback usage. The session totals accumulate across every analysis
// since the server started (the /api/*/credits endpoints report them); the
// per-analysis counter lives in AsyncLocalStorage so concurrent analyses
// each report only their own usage — see trackProxyUsage().
export let sessionProxyRequestsUsed = 0;
export let sessionScraperApiCreditsUsed = 0;

export interface ProxyUsage {
  proxyRequests: number;
  scraperApiCredits: number;
}
const usageStore = new AsyncLocalStorage<ProxyUsage>();

/** Run `fn`, counting the proxy/ScraperAPI usage of every fetch made inside it. */
export async function trackProxyUsage<T>(fn: () => Promise<T>): Promise<{ result: T; usage: ProxyUsage }> {
  const usage: ProxyUsage = { proxyRequests: 0, scraperApiCredits: 0 };
  const result = await usageStore.run(usage, fn);
  return { result, usage };
}

function recordProxyRequest(): void {
  sessionProxyRequestsUsed += 1;
  const usage = usageStore.getStore();
  if (usage) usage.proxyRequests += 1;
}

function recordScraperApiCredits(cost: number): void {
  sessionScraperApiCreditsUsed += cost;
  const usage = usageStore.getStore();
  if (usage) usage.scraperApiCredits += cost;
}

export function getSessionUsage(): ProxyUsage {
  return { proxyRequests: sessionProxyRequestsUsed, scraperApiCredits: sessionScraperApiCreditsUsed };
}

/** Total paid-fallback usage this session: proxy requests plus ScraperAPI credits. */
export function getSessionCredits(): number {
  return sessionProxyRequestsUsed + sessionScraperApiCreditsUsed;
}

export function resetSessionCredits(): void {
  sessionProxyRequestsUsed = 0;
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

// Cached Webshare Proxy Agent
let cachedWebshareAgent: ProxyAgent | null = null;
let webshareInitPromise: Promise<ProxyAgent | null> | null = null;

export function resetWebshareProxyAgent(): void {
  cachedWebshareAgent = null;
  webshareInitPromise = null;
}

/**
 * Retrieves or initializes the Webshare rotating backbone proxy agent.
 * Credentials are read from env (WEBSHARE_PROXY_USERNAME / WEBSHARE_PROXY_PASSWORD)
 * or retrieved dynamically from Webshare API (https://proxy.webshare.io/api/v2/proxy/config/)
 * using WEBSHARE_API_KEY.
 */
export async function getWebshareProxyAgent(): Promise<ProxyAgent | null> {
  if (cachedWebshareAgent) {
    return cachedWebshareAgent;
  }
  if (webshareInitPromise) {
    return webshareInitPromise;
  }

  webshareInitPromise = (async () => {
    // 1. Direct credentials override if provided in env
    const directUser = process.env.WEBSHARE_PROXY_USERNAME;
    const directPass = process.env.WEBSHARE_PROXY_PASSWORD;
    if (directUser && directPass) {
      const proxyUrl = `http://${directUser}-rotate:${directPass}@p.webshare.io:80`;
      cachedWebshareAgent = new ProxyAgent(proxyUrl);
      return cachedWebshareAgent;
    }

    const apiKey = process.env.WEBSHARE_API_KEY;
    if (!apiKey) {
      return null;
    }

    try {
      console.log("[WEBSHARE] Fetching proxy configuration from Webshare API...");
      const resp = await undiciFetch("https://proxy.webshare.io/api/v2/proxy/config/", {
        headers: { Authorization: `Token ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        console.error(`[WEBSHARE] Failed to fetch proxy config: HTTP ${resp.status}`);
        return null;
      }

      const data = (await resp.json()) as any;
      if (!data?.username || !data?.password) {
        console.error("[WEBSHARE] Invalid config returned from Webshare API (missing credentials)");
        return null;
      }

      // Configure rotating backbone proxy (p.webshare.io:80 with -rotate param for new IP per request)
      const proxyUrl = `http://${data.username}-rotate:${data.password}@p.webshare.io:80`;
      console.log(`[WEBSHARE] Successfully initialized backbone proxy agent for user: ${data.username}`);
      cachedWebshareAgent = new ProxyAgent(proxyUrl);
      return cachedWebshareAgent;
    } catch (err: any) {
      console.error("[WEBSHARE] Error initializing proxy agent:", err?.message || err);
      return null;
    } finally {
      webshareInitPromise = null;
    }
  })();

  return webshareInitPromise;
}

/**
 * Executes a resilient multi-tier fetch:
 * 1. Direct fetch (Default, free, tried first)
 * 2. Webshare rotating proxy fallback (Triggered on WAF block or connection drop)
 * 3. ScraperAPI plain fallback (Secondary fallback if SCRAPER_API_KEY is configured)
 */
export async function fetchWithFallback(
  url: string,
  options?: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    forceFallback?: boolean;
  }
): Promise<FetchResult> {
  const timeoutMs = options?.timeoutMs ?? 15000;
  const webshareKey = process.env.WEBSHARE_API_KEY || process.env.WEBSHARE_PROXY_USERNAME;
  const scraperKey = process.env.SCRAPER_API_KEY;

  // ----------------------------------------------------
  // Tier 1: Direct Fetch (Default, free, primary path)
  // ----------------------------------------------------
  let directStatus = 0;
  let directError: any = null;

  if (!options?.forceFallback) {
    try {
      // The signal stays armed until the body has been read — clearing it
      // right after the headers arrived let a server that stalls mid-body
      // hang the request indefinitely.
      const resp = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "User-Agent": ANALYZER_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...options?.headers,
        },
      });
      directStatus = resp.status;

      if (resp.ok) {
        const html = await resp.text();
        return {
          ok: true,
          status: resp.status,
          html,
          finalUrl: resp.url || url,
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
          finalUrl: url,
          tier: "direct",
          creditsUsed: 0,
          error: `HTTP ${resp.status}`,
        };
      }

      console.warn(`[FETCH] Direct fetch blocked (HTTP ${resp.status}) for ${url}. Attempting proxy fallback...`);
    } catch (err: any) {
      directError = err;
      if (!isRetryableWafOrNetworkError(0, err)) {
        console.warn(`[FETCH] Direct fetch failed non-recoverably for ${url} (${err?.code || err?.message || err}). Skipping fallback.`);
        return {
          ok: false,
          status: 0,
          html: "",
          finalUrl: url,
          tier: "direct",
          creditsUsed: 0,
          error: `Non-recoverable error: ${err?.code || err?.message || err}`,
        };
      }

      console.warn(`[FETCH] Direct fetch connection error for ${url} (${err?.code || err?.message || err}). Attempting proxy fallback...`);
    }
  }

  // ----------------------------------------------------
  // Tier 2: Webshare Rotating Proxy Fallback (Primary fallback)
  // ----------------------------------------------------
  if (webshareKey) {
    const agent = await getWebshareProxyAgent();
    if (!agent) {
      console.warn(`[FETCH] Webshare proxy initialization failed for ${url}.`);
      return {
        ok: false,
        status: directStatus || 0,
        html: "",
        finalUrl: url,
        tier: "failed",
        creditsUsed: 0,
        error: `Direct fetch failed (${directStatus || directError?.code || "network error"}) and Webshare proxy initialization failed`,
      };
    }

    try {
      console.log(`[WEBSHARE] Calling proxy fallback (rotating backbone) for: ${url}`);
      const resp = await undiciFetch(url, {
        dispatcher: agent,
        signal: AbortSignal.timeout(30000),
        headers: {
          "User-Agent": ANALYZER_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...options?.headers,
        },
      });

      recordProxyRequest();

      console.log(`[WEBSHARE] Proxy fallback returned HTTP ${resp.status} for ${url} (Total proxy requests: ${sessionProxyRequestsUsed})`);

      if (resp.ok) {
        const html = await resp.text();
        return {
          ok: true,
          status: resp.status,
          html,
          finalUrl: resp.url || url,
          tier: "webshare_proxy",
          creditsUsed: 1,
        };
      }

      return {
        ok: false,
        status: resp.status,
        html: "",
        finalUrl: url,
        tier: "failed",
        creditsUsed: 1,
        error: `Webshare proxy returned HTTP ${resp.status}`,
      };
    } catch (err: any) {
      console.error(`[WEBSHARE] Proxy fallback request failed for ${url}:`, err?.message || err);
      return {
        ok: false,
        status: 0,
        html: "",
        finalUrl: url,
        tier: "failed",
        creditsUsed: 0,
        error: `Webshare proxy network error: ${err?.message || err}`,
      };
    }
  }

  // ----------------------------------------------------
  // Tier 3: ScraperAPI Fallback (Secondary fallback)
  // ----------------------------------------------------
  if (scraperKey) {
    try {
      const scraperUrl = `https://api.scraperapi.com?api_key=${scraperKey}&url=${encodeURIComponent(url)}`;
      console.log(`[SCRAPERAPI] Calling plain fallback (render=false) for: ${url}`);

      const resp = await fetch(scraperUrl, { signal: AbortSignal.timeout(30000) });
      const costHeader = resp.headers.get("sa-credit-cost");
      const cost = costHeader ? parseInt(costHeader, 10) : 1;
      recordScraperApiCredits(cost);

      console.log(`[SCRAPERAPI] Plain fallback returned HTTP ${resp.status} for ${url} (Credits consumed: ${cost}, Session total: ${sessionScraperApiCreditsUsed})`);

      if (resp.ok) {
        const html = await resp.text();
        return {
          ok: true,
          status: resp.status,
          html,
          finalUrl: url, // ScraperAPI's own URL is resp.url; the site's final URL isn't exposed
          tier: "scraperapi_plain",
          creditsUsed: cost,
        };
      }

      return {
        ok: false,
        status: resp.status,
        html: "",
        finalUrl: url,
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
        finalUrl: url,
        tier: "failed",
        creditsUsed: 0,
        error: `ScraperAPI network error: ${err?.message || err}`,
      };
    }
  }

  console.warn(`[FETCH] Neither WEBSHARE_API_KEY nor SCRAPER_API_KEY configured. Cannot execute fallback for ${url}.`);
  return {
    ok: false,
    status: directStatus || 0,
    html: "",
    finalUrl: url,
    tier: "failed",
    creditsUsed: 0,
    error: `Direct fetch failed (${directStatus || directError?.code || "network error"}) and no proxy service configured`,
  };
}
