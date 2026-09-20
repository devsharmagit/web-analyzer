// Compact discrepancy report between independent ground truth and the
// analyzer's own output. Report-only — never throws, never exits non-zero.

import type { GroundTruth } from "./groundtruth.js";
import type { AnalyzeResult } from "../src/analyzer/index.js";

interface Row {
  dimension: string;
  truth: string;
  analyzer: string;
  status: "✓" | "≈" | "✗";
}

function withinPct(a: number, b: number, pct: number): boolean {
  if (a === 0 && b === 0) return true;
  const base = Math.max(a, b, 1);
  return Math.abs(a - b) / base <= pct;
}

function dominantBuilder(truth: GroundTruth): string {
  const { elementorHits, diviHits } = truth.platform;
  if (elementorHits === 0 && diviHits === 0) return "unknown";
  return elementorHits >= diviHits ? "Elementor" : "Divi";
}

export function compareOne(truth: GroundTruth, result: AnalyzeResult): { rows: Row[]; discrepancies: string[] } {
  const rows: Row[] = [];
  const discrepancies: string[] = [];

  const pushObjective = (dimension: string, truthVal: string, analyzerVal: string, match: boolean, approx = false) => {
    const status: Row["status"] = match ? "✓" : approx ? "≈" : "✗";
    rows.push({ dimension, truth: truthVal, analyzer: analyzerVal, status });
    if (!match) discrepancies.push(`${truth.host}: ${dimension} — ground truth "${truthVal}" vs analyzer "${analyzerVal}"`);
  };

  // CMS
  const truthCms = truth.platform.wpJsonStatus === 200 || truth.platform.wpContentHits ? "WordPress" : "unknown";
  pushObjective("CMS", truthCms, result.platform.cms.value ?? "null", truthCms === (result.platform.cms.value ?? ""));

  // Builder — dominant of divi/elementor hit counts
  const truthBuilder = dominantBuilder(truth);
  pushObjective(
    "Builder",
    `${truthBuilder} (elementor=${truth.platform.elementorHits}, divi=${truth.platform.diviHits})`,
    result.platform.builder.value ?? "null",
    truthBuilder === (result.platform.builder.value ?? "")
  );

  // E-commerce
  const truthEcom = truth.platform.woocommerceHits ? "WooCommerce" : "none";
  const analyzerEcom = result.platform.ecommerce.value ?? "none";
  pushObjective("E-commerce", truthEcom, analyzerEcom, (truthEcom === "none") === (analyzerEcom === "none"));

  // Total pages — ±5% tolerance
  const pagesMatch = withinPct(truth.totalPages, result.pages.total, 0.05);
  pushObjective("Total pages", String(truth.totalPages), String(result.pages.total), pagesMatch, pagesMatch);

  // Products
  const truthProducts = truth.countsBySource.product || 0;
  pushObjective("Products", String(truthProducts), String(result.store.productCount), truthProducts === result.store.productCount);

  // Locations
  const truthLocations = truth.hasLocalSitemap ? String(truth.localCount || "≥1") : "0";
  const analyzerLocations = String(result.locations.count);
  const locMatch = truth.hasLocalSitemap ? result.locations.count !== 0 && result.locations.count !== "unknown" : true;
  pushObjective("Locations", truthLocations, analyzerLocations, locMatch);

  // ---- Judgment review rows (no hard match/fail, just surfaced side by side) ----
  const portfolioCount = truth.countsBySource.portfolio || truth.countsBySource.astra || 0;
  const serviceCount = result.pages.byType.service?.count || 0;
  rows.push({
    dimension: "Services (review)",
    truth: portfolioCount ? `~${portfolioCount} (portfolio sitemap)` : "no portfolio sitemap — manual check",
    analyzer: String(serviceCount),
    status: portfolioCount ? (withinPct(portfolioCount, serviceCount, 0.15) ? "✓" : "≈") : "≈",
  });

  rows.push({
    dimension: "Uncertain pages",
    truth: "—",
    analyzer: String(result.pages.uncertainCount),
    status: result.pages.uncertainCount === 0 ? "✓" : "≈",
  });

  const providerCount = typeof result.providers.count === "number" ? result.providers.count : 0;
  rows.push({
    dimension: "Providers (review)",
    truth: "manual check",
    analyzer: `${result.providers.count} — ${result.providers.list.map((p) => p.name).join(", ") || "none"}`,
    status: providerCount > 0 ? "✓" : "≈",
  });

  return { rows, discrepancies };
}

export function printTable(host: string, rows: Row[]) {
  console.log(`\n=== ${host} ===`);
  const w1 = Math.max(...rows.map((r) => r.dimension.length), 10);
  const w2 = Math.max(...rows.map((r) => r.truth.length), 12);
  for (const r of rows) {
    console.log(`  ${r.status} ${r.dimension.padEnd(w1)}  truth: ${r.truth.padEnd(w2)}  analyzer: ${r.analyzer}`);
  }
}
