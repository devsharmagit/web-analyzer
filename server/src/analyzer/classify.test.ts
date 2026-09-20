process.loadEnvFile(new URL("../../.env", import.meta.url));
import { crawlSite } from "./crawl.js";
import { classifyPages } from "./classify.js";

(async () => {
  const crawl = await crawlSite("https://ruma.com");
  const taxonomy = await classifyPages(crawl.pages);

  console.log("byType counts:", Object.fromEntries(Object.entries(taxonomy.byType).map(([k, v]) => [k, v.count])));
  console.log("uncertain (unresolved):", taxonomy.uncertainCount);

  let pass = 0, fail = 0;
  const ok = (name: string, cond: boolean, detail?: string) =>
    (cond ? pass++ : fail++, console.log(`  ${cond ? "✓" : "✗"} ${name}${detail && !cond ? " — " + detail : ""}`));

  const serviceCount = taxonomy.byType.service?.count || 0;
  ok("most portfolio pages resolve to service", serviceCount > 150, String(serviceCount));
  ok("blog count matches ~79", (taxonomy.byType.blog?.count || 0) > 70);
  ok("no crash on uncertain bucket", typeof taxonomy.uncertainCount === "number");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
