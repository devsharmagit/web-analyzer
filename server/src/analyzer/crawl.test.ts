// Phase 1 checks — run with: npm test (from server/)
// Hits ruma.com live (no fixtures yet), so a failure here may be the network.
import { crawlSite } from "./crawl.js";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail?: string) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
};

(async () => {
  console.log("\ncrawlSite(ruma.com)");
  const r = await crawlSite("https://ruma.com");
  console.log(`  ${r.urlsSeen} urls seen · ${r.total} pages · via ${r.discoveredVia} · ${r.durationMs}ms`);
  console.log("  by source:", r.counts);

  ok("resolves the origin", r.origin === "https://ruma.com", r.origin);
  ok("used the sitemap, not the fallback", r.discoveredVia === "sitemap", r.discoveredVia);
  ok("found the 7 child sitemaps", r.sitemaps.length === 7, String(r.sitemaps.length));

  ok("finds ~203 portfolio (service) pages", (r.counts.portfolio ?? 0) > 190, String(r.counts.portfolio));
  ok("finds ~79 blog posts", (r.counts.post ?? 0) > 70 && (r.counts.post ?? 0) < 90, String(r.counts.post));
  ok("finds ~54 products", (r.counts.product ?? 0) > 45, String(r.counts.product));

  const dual = r.pages.filter((p) => p.sources.includes("video") && p.sources.length > 1);
  ok("50 urls carry a video source alongside another", dual.length > 40, String(dual.length));
  ok("video never wins over a real source", dual.every((p) => p.source !== "video"), dual.find((p) => p.source === "video")?.path);

  ok("products excluded from the page count", r.pages.filter((p) => p.isPage && p.source === "product").length === 0);
  ok("page count is below the raw url count", r.total < r.urlsSeen, `${r.total} vs ${r.urlsSeen}`);

  const paths = r.pages.map((p) => p.path);
  ok("no duplicate paths", new Set(paths).size === paths.length);
  ok("every url is same-origin", r.pages.every((p) => p.url.startsWith(r.origin)));
  ok("no asset urls leaked in", !paths.some((p) => /\.(xml|kml|jpg|png|css|js)$/i.test(p)));
  ok("homepage is present", paths.includes("/"));

  console.log("\nbad input");
  try {
    await crawlSite("not a url");
    ok("rejects garbage input", false, "did not throw");
  } catch {
    ok("rejects garbage input", true);
  }

  const dead = await crawlSite("https://this-domain-should-not-exist-g99.com");
  ok("dead domain returns empty rather than throwing", dead.total === 0);
  ok("dead domain explains itself in warnings", dead.warnings.length > 0, JSON.stringify(dead.warnings));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
