// The accuracy contract (ACCURACY-PLAN.md Phase 1): reads the ground-truth +
// analyzer JSON pairs already on disk (from `npm run validate`) and the
// hand-labeled taxonomy worksheet (from `npm run worksheet`, then filled in),
// and reports objective field accuracy + taxonomy accuracy, per-site and
// aggregate. Read-only — never re-fetches the network.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GroundTruth } from "./groundtruth.js";
import type { AnalyzeResult } from "../src/analyzer/index.js";
import { compareOne } from "./compare.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");

interface WorksheetEntry {
  site: string;
  url: string;
  title: string;
  analyzerBucket: string;
  humanLabel: string | null;
}

(async () => {
  const truthFiles = readdirSync(OUT_DIR).filter((f) => f.endsWith(".truth.json"));

  // ---- Objective field accuracy, aggregated across sites ----
  const fieldTally: Record<string, { pass: number; total: number }> = {};
  for (const file of truthFiles) {
    const host = file.replace(".truth.json", "");
    const analyzerFile = `${host}.analyzer.json`;
    if (!existsSync(join(OUT_DIR, analyzerFile))) continue;

    const truth: GroundTruth = JSON.parse(readFileSync(join(OUT_DIR, file), "utf8"));
    const result: AnalyzeResult = JSON.parse(readFileSync(join(OUT_DIR, analyzerFile), "utf8"));
    const { rows } = compareOne(truth, result);

    for (const row of rows) {
      // Only score the objective rows (they end without "(review)"); judgment
      // rows are scored separately via the taxonomy worksheet below.
      if (row.dimension.includes("(review)") || row.dimension === "Uncertain pages") continue;
      if (!fieldTally[row.dimension]) fieldTally[row.dimension] = { pass: 0, total: 0 };
      fieldTally[row.dimension]!.total++;
      if (row.status === "✓") fieldTally[row.dimension]!.pass++;
    }
  }

  console.log("=== Objective field accuracy (aggregate across sites) ===");
  let totalPass = 0, totalCount = 0;
  for (const [dim, t] of Object.entries(fieldTally)) {
    const pct = ((t.pass / t.total) * 100).toFixed(0);
    console.log(`  ${dim.padEnd(14)} ${t.pass}/${t.total}  (${pct}%)`);
    totalPass += t.pass;
    totalCount += t.total;
  }
  const objectiveAccuracy = totalCount ? ((totalPass / totalCount) * 100).toFixed(1) : "n/a";
  console.log(`  ---\n  OVERALL: ${totalPass}/${totalCount} (${objectiveAccuracy}%)`);

  // ---- Taxonomy accuracy, from the hand-labeled worksheet ----
  const worksheetPath = join(OUT_DIR, "taxonomy-worksheet.json");
  let taxonomyAccuracy = "n/a";
  let taxonomyPass = 0, taxonomyTotal = 0;
  if (existsSync(worksheetPath)) {
    const worksheet: WorksheetEntry[] = JSON.parse(readFileSync(worksheetPath, "utf8"));
    const labeled = worksheet.filter((e) => e.humanLabel !== null);
    taxonomyTotal = labeled.length;
    taxonomyPass = labeled.filter((e) => e.humanLabel === e.analyzerBucket).length;
    taxonomyAccuracy = taxonomyTotal ? ((taxonomyPass / taxonomyTotal) * 100).toFixed(1) : "n/a";

    console.log(`\n=== Taxonomy spot-check accuracy (hand-labeled sample) ===`);
    console.log(`  ${taxonomyPass}/${taxonomyTotal} (${taxonomyAccuracy}%)`);
    const mismatches = labeled.filter((e) => e.humanLabel !== e.analyzerBucket);
    if (mismatches.length) {
      console.log("  Mismatches:");
      for (const m of mismatches) {
        console.log(`    ${m.site}: ${m.url}\n      analyzer="${m.analyzerBucket}" human="${m.humanLabel}" title="${m.title}"`);
      }
    }
  } else {
    console.log("\n(no taxonomy-worksheet.json found — run `npm run worksheet` and fill in humanLabel first)");
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`  Objective field accuracy: ${objectiveAccuracy}% (${totalPass}/${totalCount})`);
  console.log(`  Taxonomy spot-check accuracy: ${taxonomyAccuracy}% (${taxonomyPass}/${taxonomyTotal})`);
})();
