import "./loadEnv.js"; // first: every module below may read process.env

import express from "express";
import cors from "cors";
import { analyze } from "./analyzer/index.js";
import { addException, initExceptionStore } from "./analyzer/classification/exceptionStore.js";
import { getSessionUsage, resetSessionCredits } from "./analyzer/fetchWithFallback.js";
import { assertPublicUrl, UnsafeUrlError } from "./analyzer/urlSafety.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Behind Render's proxy, req.ip is the proxy's address unless Express trusts
// one hop of X-Forwarded-For — and the rate limiter below keys on req.ip.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));

// CORS_ORIGINS: comma-separated origins allowed to call the API from a
// browser, e.g. "https://analyzer.example.com,http://localhost:5173".
// Unset keeps the API open to every origin (the previous behaviour) —
// set it in production.
const corsOrigins = (process.env.CORS_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : undefined));
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ---- rate limiting -----------------------------------------------------------
// Every analysis fans out into dozens of outbound requests, some through the
// paid proxy, so an unthrottled client could drain the proxy quota. In-memory
// fixed window per client IP; defaults allow a team sharing one office IP to
// work normally. RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS override.
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 20;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000;
const hits = new Map<string, { count: number; windowStart: number }>();

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const now = Date.now();
  const key = req.ip || "unknown";
  let entry = hits.get(key);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    hits.set(key, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: `Too many requests — try again in ${Math.ceil(retryAfter / 60)} minute(s).` });
    return;
  }
  next();
}

// Expired windows are dropped so the map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) hits.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

// ---- concurrency -------------------------------------------------------------
// Each analysis runs a full crawl + classification. Only a few run at once;
// the rest wait in a short queue, and beyond that the server says it's busy
// instead of piling work up until every request times out.
const MAX_CONCURRENT_ANALYSES = Number(process.env.MAX_CONCURRENT_ANALYSES) || 2;
const MAX_QUEUED_ANALYSES = Number(process.env.MAX_QUEUED_ANALYSES) || 10;
let runningAnalyses = 0;
const waiting: Array<() => void> = [];

async function withAnalysisSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (runningAnalyses >= MAX_CONCURRENT_ANALYSES) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  runningAnalyses++;
  try {
    return await fn();
  } finally {
    runningAnalyses--;
    waiting.shift()?.();
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Session totals since the server started — each analysis's own usage is in
// its response (crawl.proxyRequestsUsed / crawl.scraperApiCreditsUsed).
app.get("/api/scraperapi/credits", (_req, res) => {
  res.json({ sessionCreditsUsed: getSessionUsage().scraperApiCredits });
});

app.post("/api/scraperapi/reset-credits", (_req, res) => {
  resetSessionCredits();
  res.json({ ok: true, sessionCreditsUsed: 0 });
});

app.get("/api/webshare/credits", (_req, res) => {
  const { proxyRequests } = getSessionUsage();
  res.json({ sessionRequestsUsed: proxyRequests, sessionCreditsUsed: proxyRequests });
});

app.post("/api/webshare/reset-credits", (_req, res) => {
  resetSessionCredits();
  res.json({ ok: true, sessionRequestsUsed: 0, sessionCreditsUsed: 0 });
});

// Admin endpoint to log a misclassification
app.post("/api/corrections", rateLimit, async (req, res) => {
  const { urlPattern, matchedField, wrongCategory, correctCategory } = req.body;
  if (!urlPattern || !wrongCategory || !correctCategory) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  try {
    await addException(urlPattern, matchedField || "", wrongCategory, correctCategory);
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to add exception:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// One URL per request, synchronous. GET /api/analyze?url=https://ruma.com
app.get("/api/analyze", rateLimit, async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
  if (!url) {
    res.status(400).json({ error: "Missing ?url= query parameter" });
    return;
  }
  try {
    // Refuse private/internal targets before any request is made (SSRF).
    await assertPublicUrl(url);
  } catch (err) {
    res.status(400).json({ error: err instanceof UnsafeUrlError ? err.message : "Invalid URL" });
    return;
  }
  if (runningAnalyses >= MAX_CONCURRENT_ANALYSES && waiting.length >= MAX_QUEUED_ANALYSES) {
    res.setHeader("Retry-After", "60");
    res.status(503).json({ error: "The analyzer is busy with other sites right now — try again in a minute." });
    return;
  }
  try {
    const result = await withAnalysisSlot(() => analyze(url));
    res.json(result);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error analyzing ${url}:`, err);
    res.status(400).json({ error: err instanceof Error ? err.message : "Analysis failed" });
  }
});

const server = app.listen(PORT, async () => {
  console.log(`Analyzer API listening on http://localhost:${PORT}`);
  if (!corsOrigins.length) {
    console.warn("⚠️  [WARN] CORS_ORIGINS is not set — the API accepts browser requests from any origin.");
  }
  await initExceptionStore();
});
server.timeout = 180000;
server.keepAliveTimeout = 180000;
