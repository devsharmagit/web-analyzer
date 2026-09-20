import { crawlSite } from "./crawl.js";
import { detectPlatform, detectStore } from "./platform.js";

(async () => {
  const crawl = await crawlSite("https://ruma.com");
  const platform = await detectPlatform(crawl.origin);
  const store = detectStore(crawl.counts, platform.ecommerce);

  console.log("platform:", JSON.stringify(platform, null, 2));
  console.log("store:", JSON.stringify(store, null, 2));

  let pass = 0, fail = 0;
  const ok = (name: string, cond: boolean) => (cond ? pass++ : fail++, console.log(`  ${cond ? "✓" : "✗"} ${name}`));

  ok("cms = WordPress", platform.cms.value === "WordPress");
  ok("cms confidence high", platform.cms.confidence === "high");
  ok("builder = Elementor", platform.builder.value === "Elementor");
  ok("ecommerce = WooCommerce", platform.ecommerce.value === "WooCommerce");
  ok("store detected", store.hasStore === true);
  ok("product count ~53", store.productCount > 45);
  ok("category count ~18", store.categoryCount > 10);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
