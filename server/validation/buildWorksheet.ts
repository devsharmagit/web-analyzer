// Builds a taxonomy labeling worksheet: samples a handful of URLs per site,
// stratified across the buckets the analyzer put them in, fetches each page's
// <title> (cheap — no full-page read), and writes a worksheet for a human (or
// an LLM doing a compact judgment pass) to fill in `humanLabel`.
//
// Run AFTER `npm run validate` has populated validation/out/*.analyzer.json.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AnalyzeResult } from "../src/analyzer/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");

const UA = "Mozilla/5.0 (compatible; G99-Validator/1.0)";
const PER_SITE_SAMPLE = 6;

async function fetchTitle(url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": UA } });
    if (!r.ok) return "";
    const html = await r.text();
    return html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

interface WorksheetEntry {
  site: string;
  url: string;
  title: string;
  analyzerBucket: string;
  humanLabel: string | null; // filled in by a human/LLM judgment pass
}

function stratifiedSample(byType: Record<string, { count: number; urls: string[] }>, n: number): Array<{ url: string; bucket: string }> {
  const buckets = Object.entries(byType).filter(([, b]) => b.count > 0);
  if (!buckets.length) return [];
  const out: Array<{ url: string; bucket: string }> = [];
  let i = 0;
  while (out.length < n && buckets.some(([, b]) => b.urls.length > 0)) {
    const [bucket, b] = buckets[i % buckets.length]!;
    if (b.urls.length) out.push({ url: b.urls.shift()!, bucket });
    i++;
  }
  return out;
}

(async () => {
  const files = readdirSync(OUT_DIR).filter((f) => f.endsWith(".analyzer.json"));
  const worksheet: WorksheetEntry[] = [];

  for (const file of files) {
    const host = file.replace(".analyzer.json", "");
    const result: AnalyzeResult = JSON.parse(readFileSync(join(OUT_DIR, file), "utf8"));
    const sample = stratifiedSample(result.pages.byType, PER_SITE_SAMPLE);

    console.log(`${host}: sampling ${sample.length} URLs...`);
    for (const { url, bucket } of sample) {
      const title = await fetchTitle(url);
      worksheet.push({ site: host, url, title, analyzerBucket: bucket, humanLabel: null });
    }
  }

  writeFileSync(join(OUT_DIR, "taxonomy-worksheet.json"), JSON.stringify(worksheet, null, 2));
  console.log(`\nWrote ${worksheet.length} entries to validation/out/taxonomy-worksheet.json`);
  console.log("Fill in `humanLabel` for each entry, then run `npm run score`.");
})();
