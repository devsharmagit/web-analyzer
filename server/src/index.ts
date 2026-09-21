try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // .env is optional locally; Gemini-dependent phases degrade to "uncertain"/"unknown".
}

import express from "express";
import cors from "cors";
import { analyze } from "./analyzer/index.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
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

app.listen(PORT, () => {
  console.log(`Analyzer API listening on http://localhost:${PORT}`);
});
