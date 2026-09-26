try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // .env is optional locally; Gemini-dependent phases degrade to "uncertain"/"unknown".
}

import express from "express";
import cors from "cors";
import { analyze } from "./analyzer/index.js";

import { addException, initExceptionStore } from "./analyzer/classification/exceptionStore.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

import { getSessionCredits, resetSessionCredits } from "./analyzer/fetchWithFallback.js";

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/scraperapi/credits", (_req, res) => {
  res.json({ sessionCreditsUsed: getSessionCredits() });
});

app.post("/api/scraperapi/reset-credits", (_req, res) => {
  resetSessionCredits();
  res.json({ ok: true, sessionCreditsUsed: 0 });
});

// Admin endpoint to log a misclassification
app.post("/api/corrections", async (req, res) => {
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

// One URL at a time, synchronous. GET /api/analyze?url=https://ruma.com
app.get("/api/analyze", async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
  if (!url) {
    res.status(400).json({ error: "Missing ?url= query parameter" });
    return;
  }
  try {
    const result = await analyze(url);
    res.json(result);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error analyzing ${url}:`, err);
    res.status(400).json({ error: err instanceof Error ? err.message : "Analysis failed" });
  }
});

const server = app.listen(PORT, async () => {
  console.log(`Analyzer API listening on http://localhost:${PORT}`);
  await initExceptionStore();
});
server.timeout = 180000;
server.keepAliveTimeout = 180000;
