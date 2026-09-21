try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // Gemini-dependent phases degrade gracefully without it.
}

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { crawlGroundTruth } from "./groundtruth.js";
import { runAnalyzer } from "./runAnalyzer.js";
import { compareOne, printTable } from "./compare.js";
import { SITES } from "./sites.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");
mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const allDiscrepancies: string[] = [];

  for (const url of SITES) {
    const host = new URL(url).hostname;
    console.log(`\nRunning ${host} ...`);

    const [truth, result] = await Promise.all([crawlGroundTruth(url), runAnalyzer(url)]);

    writeFileSync(join(OUT_DIR, `${host}.truth.json`), JSON.stringify(truth, null, 2));
    writeFileSync(join(OUT_DIR, `${host}.analyzer.json`), JSON.stringify(result, null, 2));

    const { rows, discrepancies } = compareOne(truth, result);
    printTable(host, rows);
    allDiscrepancies.push(...discrepancies);
  }

  console.log("\n\n=== DISCREPANCIES (objective mismatches only) ===");
  if (!allDiscrepancies.length) {
    console.log("  none — all objective checks matched");
  } else {
    for (const d of allDiscrepancies) console.log(`  ✗ ${d}`);
  }
  console.log(`\nRaw output saved under ${OUT_DIR}\n`);
})();
