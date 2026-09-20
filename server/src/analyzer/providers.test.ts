process.loadEnvFile(new URL("../../.env", import.meta.url));
import { crawlSite } from "./crawl.js";
import { detectProviders } from "./providers.js";
import { detectLocations } from "./locations.js";

(async () => {
  const crawl = await crawlSite("https://ruma.com");
  const [providers, locations] = await Promise.all([
    detectProviders(crawl.origin, crawl.pages),
    detectLocations(crawl.origin, crawl.pages),
  ]);

  console.log("providers:", JSON.stringify(providers, null, 2).slice(0, 1500));
  console.log("locations:", JSON.stringify(locations, null, 2));

  let pass = 0, fail = 0;
  const ok = (name: string, cond: boolean, detail?: string) =>
    (cond ? pass++ : fail++, console.log(`  ${cond ? "✓" : "✗"} ${name}${detail && !cond ? " — " + detail : ""}`));

  ok("providers found something (count or unknown, never 0-as-failure)", providers.count !== 0);
  ok("providers source found (no dedicated /team/ on ruma; falls back)", providers.source != null, String(providers.source));
  ok("locations detected something", locations.count !== 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
