// Offline regression tests for the fixes from BUG-AUDIT.md / API-TEST-RESULTS.md.
// No internet and no API keys: fixtures are served from a local HTTP server,
// so the real crawl / store-detection code paths run end to end.
// Run with: npm run test:unit
process.env.ALLOW_PRIVATE_TARGETS = "1"; // the fixture server is on 127.0.0.1
process.env.GEMINI_KEYS = ""; // keep AI steps off even if a .env is present
process.env.WEBSHARE_API_KEY = "";
process.env.WEBSHARE_PROXY_USERNAME = "";
process.env.SCRAPER_API_KEY = "";
process.env.NEON_DB_URL = "";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { crawlSite, extractNavCategories, isTaxonomyArchive, toPagePath, type AnalyzedPage } from "../src/analyzer/crawl.js";
import { classifyPage } from "../src/analyzer/classify.js";
import { detectExternalStore, detectPlatform } from "../src/analyzer/platform.js";
import { findTeamPages } from "../src/analyzer/providers.js";
import { dedupe, fromFooterHeuristic, fromJsonLd, locationKey, parseUsAddress } from "../src/analyzer/locations.js";
import { cosineSimilarity } from "../src/analyzer/gemini.js";
import { withTimeout } from "../src/analyzer/index.js";
import { assertPublicUrl, isPublicIp } from "../src/analyzer/urlSafety.js";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`);
  }
}
async function rejects(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

function serve(handler: (path: string, host: string, port: number) => { status?: number; body?: string; location?: string }): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const port = (server.address() as AddressInfo).port;
      const r = handler(req.url || "/", req.headers.host || "", port);
      if (r.location) res.writeHead(r.status ?? 301, { Location: r.location });
      else res.writeHead(r.status ?? (r.body === undefined ? 404 : 200), { "Content-Type": "text/html" });
      res.end(r.body ?? "");
    });
    server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

const sitemapIndex = (base: string, children: string[]) =>
  `<?xml version="1.0"?><sitemapindex>${children.map((c) => `<sitemap><loc>${base}${c}</loc></sitemap>`).join("")}</sitemapindex>`;
const urlset = (base: string, paths: string[]) =>
  `<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>${base}${p}</loc></url>`).join("")}</urlset>`;

// A small WordPress-like site: 3 real pages, 2 category archives in their own
// sitemap, and a tag archive hiding in the page sitemap.
function wpSite(base: string, path: string): { body?: string } {
  switch (path) {
    case "/":
      return { body: "<html><head><title>Home</title></head><body><a href='/botox/'>Botox</a></body></html>" };
    case "/sitemap.xml":
      return { body: sitemapIndex(base, ["/page-sitemap.xml", "/category-sitemap.xml"]) };
    case "/page-sitemap.xml":
      return { body: urlset(base, ["/", "/botox/", "/about/", "/blog/tag/lips/"]) };
    case "/category-sitemap.xml":
      return { body: urlset(base, ["/category/botox/", "/category/dermal-fillers/"]) };
    default:
      return {};
  }
}

const page = (path: string, source = "page"): AnalyzedPage => ({
  path,
  url: "https://example.com" + path,
  source,
  sources: [source],
  isPage: true,
  title: path,
});

(async () => {
  // ---------------------------------------------------------------------------
  console.log("\nWordPress taxonomy archives (category/tag/author)");
  ok("path: /category/botox/ is an archive", isTaxonomyArchive("/category/botox/", ["page"]));
  ok("path: /blog/tag/lips/ is an archive", isTaxonomyArchive("/blog/tag/lips/", ["post"]));
  ok("path: /author/jane/ is an archive", isTaxonomyArchive("/author/jane/", ["page"]));
  ok("source: a category-sitemap URL is an archive whatever its path", isTaxonomyArchive("/topics/botox/", ["category"]));
  ok("WooCommerce /product-category/ is NOT an archive", !isTaxonomyArchive("/product-category/serums/", ["product_cat"]));
  ok("/botox/ is not an archive", !isTaxonomyArchive("/botox/", ["page"]));

  const a = await serve((path, _host, port) => wpSite(`http://127.0.0.1:${port}`, path));
  const crawl = await crawlSite(`http://127.0.0.1:${a.port}`);
  const byPath = new Map(crawl.pages.map((p) => [p.path, p]));
  ok("crawl: only the 3 real pages are counted", crawl.total === 3, { total: crawl.total, pages: crawl.pages.filter((p) => p.isPage).map((p) => p.path) });
  ok("crawl: archives are still seen as URLs", crawl.urlsSeen === 6, crawl.urlsSeen);
  ok("crawl: /category/botox/ is marked archive, not a page", byPath.get("/category/botox/")?.source === "archive" && byPath.get("/category/botox/")?.isPage === false);
  ok("crawl: /blog/tag/lips/ from the page sitemap is marked archive", byPath.get("/blog/tag/lips/")?.isPage === false);
  ok("crawl: homepage HTML is handed on to later phases", crawl.homeHtml.includes("<title>Home</title>"));
  a.server.close();

  // ---------------------------------------------------------------------------
  console.log("\nOrigin follows the homepage redirect (BUG-24)");
  const b = await serve((path, host, port) => {
    if (host.startsWith("127.0.0.1") && path === "/") return { location: `http://localhost:${port}/` };
    return wpSite(`http://localhost:${port}`, path);
  });
  const moved = await crawlSite(`http://127.0.0.1:${b.port}`);
  ok("adopts the redirect target as the origin", moved.origin === `http://localhost:${b.port}`, moved.origin);
  ok("then reads that site's sitemap", moved.discoveredVia === "sitemap" && moved.total === 3, { via: moved.discoveredVia, total: moved.total });
  ok("says it analyzed the other domain", moved.warnings.some((w) => /redirects to/.test(w)), moved.warnings);
  b.server.close();

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  console.log("\nPath normalization (BUG-14)");
  ok("/index.php → /", toPagePath("/index.php") === "/");
  ok("double slashes collapse, trailing slash added", toPagePath("/a//b") === "/a/b/");
  ok("file pages (.php/.html) keep extension without trailing slash", toPagePath("/contact-us.php") === "/contact-us.php");
  ok("trailing slash on file page (.php/) is normalized", toPagePath("/contact-us.php/") === "/contact-us.php");
  ok("date archive without trailing slash is dropped", toPagePath("/2025/10") === null);
  ok("real dated post is kept", toPagePath("/2025/10/28/my-post") === "/2025/10/28/my-post/");
  ok("assets are dropped", toPagePath("/uploads/menu.pdf") === null);

  // ---------------------------------------------------------------------------
  console.log("\nNested nav menus (BUG-17)");
  const navHtml = `<nav><ul>
    <li class="menu-item menu-item-has-children"><a href="#">Services</a>
      <ul>
        <li class="menu-item menu-item-has-children"><a href="/face/">Face</a>
          <ul><li class="menu-item"><a href="/botox/">Botox</a></li></ul>
        </li>
        <li class="menu-item"><a href="/laser-hair-removal/">Laser Hair Removal</a></li>
        <li class="menu-item menu-item-has-children"><a href="#">Financing</a>
          <ul><li class="menu-item"><a href="/cherry/">Cherry</a></li></ul>
        </li>
      </ul>
    </li>
    <li class="menu-item menu-item-has-children"><a href="/about/">About</a>
      <ul><li class="menu-item"><a href="/meet-dr-jones/">Dr. Jones</a></li></ul>
    </li>
  </ul></nav>`;
  const nav = extractNavCategories(navHtml, "https://example.com");
  ok("link after a nested sub-menu is still found", nav.get("/laser-hair-removal/") === "service", Object.fromEntries(nav));
  ok("links inside the nested sub-menu are found", nav.get("/botox/") === "service");
  ok("a nested Financing menu labels its own links offers", nav.get("/cherry/") === "offers");
  ok("About dropdown children are labelled about", nav.get("/meet-dr-jones/") === "about");

  // ---------------------------------------------------------------------------
  console.log("\nTaxonomy (BUG-06, BUG-07, PHP/flat site & med-spa expansion)");
  ok("nav 'about' hint resolves to core", classifyPage("/meet-dr-jones/", "page", "about").key === "core");
  ok("bare /gallery/ is still before & after", classifyPage("/gallery/", "page").key === "beforeAfter");
  ok("/results/ is still before & after", classifyPage("/results/", "page").key === "beforeAfter");
  ok("/search-results/ is not before & after", classifyPage("/search-results/", "page").key !== "beforeAfter");
  ok("/office-gallery/ is not before & after or testimonial", !["beforeAfter", "testimonial"].includes(classifyPage("/office-gallery/", "page").key));
  ok("/before-and-after/ is before & after", classifyPage("/before-and-after/", "page").key === "beforeAfter");
  ok(".php core page resolves to core", classifyPage("/contact-us.php", "page").key === "core");
  ok("branded about slug resolves to core", classifyPage("/about-us-the-ageless-clinic-best-skin-doctor-mumbai.php", "page").key === "core");
  ok("profhilo resolves to service", classifyPage("/profhilo.php", "page").key === "service");
  ok("thermage resolves to service", classifyPage("/thermage-flx.php", "page").key === "service");
  ok("hifu resolves to service", classifyPage("/hifu.php", "page").key === "service");
  ok("mesotherapy resolves to service", classifyPage("/mesotherapy.php", "page").key === "service");
  ok("mediapage resolves to media", classifyPage("/mediapage.php", "page").key === "media");
  ok("pcod/pcos resolves to condition", classifyPage("/pcod-and-pcos-polycystic-ovarian-disorder-treatment.php", "page").key === "condition");

  // ---------------------------------------------------------------------------
  console.log("\nPlatform fingerprints (BUG-03, BUG-15, BUG-23)");
  const unreachable = "http://127.0.0.1:9"; // only the /wp-json/ probe would hit it
  const godaddy = await detectPlatform(unreachable, `<meta name="generator" content="Starfield Technologies; Go Daddy Website Builder 8.0.0000"/><img src="//img1.wsimg.com/isteam/ip/1.jpg">`);
  ok("GoDaddy Website Builder via generator tag", godaddy.cms.value === "GoDaddy Website Builder" && godaddy.cms.confidence === "high", godaddy.cms);
  const wsimgOnly = await detectPlatform(unreachable, `<img src="//img1.wsimg.com/isteam/ip/1.jpg"><img src="//img1.wsimg.com/isteam/ip/2.jpg">`);
  ok("GoDaddy Website Builder via wsimg.com CDN", wsimgOnly.cms.value === "GoDaddy Website Builder", wsimgOnly.cms.value);
  const hubspotTracking = await detectPlatform(unreachable, `<script src="//js.hs-analytics.net/analytics/1.js"></script><div class="custom"></div>`);
  ok("HubSpot tracking script alone is not HubSpot CMS", hubspotTracking.cms.value !== "HubSpot CMS", hubspotTracking.cms.value);
  const hubspotHosted = await detectPlatform(unreachable, `<div class="hs_cos_wrapper hs_cos_wrapper_widget"></div><div class="hs_cos_wrapper"></div>`);
  ok("HubSpot-hosted page is HubSpot CMS", hubspotHosted.cms.value === "HubSpot CMS", hubspotHosted.cms.value);
  const sqsCartIcon = await detectPlatform(unreachable, `<link href="https://static1.squarespace.com/x.css"><span class="sqs-cart-quantity">0</span>`);
  ok("Squarespace cart icon alone is not Squarespace Commerce", sqsCartIcon.ecommerce.value === null, sqsCartIcon.ecommerce.value);
  const sqsProducts = await detectPlatform(unreachable, `<link href="https://static1.squarespace.com/x.css"><div class="sqs-add-to-cart-button">Add</div>`);
  ok("Squarespace add-to-cart is Squarespace Commerce", sqsProducts.ecommerce.value === "Squarespace Commerce", sqsProducts.ecommerce.value);

  // ---------------------------------------------------------------------------
  console.log("\nExternal store detection (BUG-04)");
  const c = await serve((path) => {
    if (path === "/images") return { body: `<html><link rel="icon" type="image/png" href="/i.png"><img src="/media/image/1.jpg"></html>` };
    if (path === "/ecwid") return { body: `<html><head><meta name="generator" content="ec-instant-site" /></head></html>` };
    if (path === "/magento") return { body: `<html><script type="text/x-magento-init">{}</script></html>` };
    return {};
  });
  const base = `http://127.0.0.1:${c.port}`;
  ok("a page that merely contains image/ is not Magento", (await detectExternalStore([`${base}/images`])) === null);
  ok("Ecwid Instant Site is Ecwid", (await detectExternalStore([`${base}/ecwid`]))?.platform === "Ecwid");
  ok("a real Magento page is still Magento", (await detectExternalStore([`${base}/magento`]))?.platform === "Magento");
  ok("first matching link in order wins", (await detectExternalStore([`${base}/images`, `${base}/ecwid`, `${base}/magento`]))?.platform === "Ecwid");
  c.server.close();

  // ---------------------------------------------------------------------------
  console.log("\nwithTimeout with a null fallback");
  const never = new Promise<{ platform: string } | null>(() => {});
  ok("a timed-out null fallback stays null (was a truthy { reason })", (await withTimeout(never, 20, null)) === null);
  const objFallback = await withTimeout(new Promise<{ count: number; reason?: string }>(() => {}), 20, { count: 0 });
  ok("an object fallback is tagged with the timeout reason", objFallback.reason === "timed out after 20ms", objFallback);
  ok("a fast promise wins", (await withTimeout(Promise.resolve(5), 1000, 0)) === 5);

  // ---------------------------------------------------------------------------
  console.log("\nProvider team pages (BUG-16)");
  const teamPaths = (paths: string[]) => findTeamPages(paths.map((p) => page(p))).map((p) => p.path);
  ok("/injectors/ is a team page", teamPaths(["/injectors/"]).includes("/injectors/"));
  ok("/doctors/ is a team page", teamPaths(["/doctors/"]).includes("/doctors/"));
  ok("/team-members/ is a team page", teamPaths(["/team-members/"]).includes("/team-members/"));
  ok("/teamwork-tips/ is not", teamPaths(["/teamwork-tips/"]).length === 0);
  ok("candidates are ordered most-specific first", JSON.stringify(teamPaths(["/about/", "/meet-the-injectors/", "/team/"])) === JSON.stringify(["/team/", "/meet-the-injectors/", "/about/"]), teamPaths(["/about/", "/meet-the-injectors/", "/team/"]));

  // ---------------------------------------------------------------------------
  console.log("\nLocations (BUG-01/02, BUG-05, BUG-21)");
  const inspire = fromJsonLd([
    { "@type": ["HealthAndBeautyBusiness", "Organization"], name: "Inspire", address: { streetAddress: "10420 Rubicon Rd B104", addressLocality: "South Jordan", addressRegion: "UT", postalCode: "84009" } },
    { "@type": "LocalBusiness", name: "Inspire Medical Spa", telephone: "(801) 555-0100", address: { streetAddress: "10420 S. Rubicon Road Suite B104", addressLocality: "South Jordan", addressRegion: "UT", postalCode: "84009" } },
  ]);
  ok("@type arrays are read", inspire.length === 2, inspire.length);
  ok("structured city/state/zip come straight from JSON-LD", inspire[0]?.city === "South Jordan" && inspire[0]?.state === "UT" && inspire[0]?.zip === "84009");
  const merged = dedupe(inspire);
  ok("two spellings of one address are one location", merged.length === 1, merged.map((l) => l.address));
  ok("the merged location keeps the phone from the other block", merged[0]?.phone === "(801) 555-0100");
  ok("genuinely different addresses stay separate", dedupe([{ name: "", phone: "", address: "12 Main St, Provo, UT 84601" }, { name: "", phone: "", address: "12 Center St, Provo, UT 84601" }]).length === 2);
  ok("key ignores Rd/Road and directionals", locationKey({ name: "", phone: "", address: "10420 S. Rubicon Road" }) === locationKey({ name: "", phone: "", address: "10420 Rubicon Rd B104" }));

  const trailing = fromJsonLd([{ "@type": "LocalBusiness", address: { streetAddress: "116 Concord Road Suite #100,", addressLocality: "Knoxville", addressRegion: "TN", postalCode: "37934" } }]);
  ok("a trailing comma in streetAddress doesn't double up", trailing[0]?.address === "116 Concord Road Suite #100, Knoxville, TN, 37934", trailing[0]?.address);

  const multi = fromJsonLd([{ "@type": "MedicalBusiness", name: "Two sites", address: [{ streetAddress: "1 A St", addressLocality: "X", addressRegion: "TX" }, { streetAddress: "2 B St", addressLocality: "Y", addressRegion: "TX" }] }]);
  ok("an address array yields one location per address", multi.length === 2, multi.length);

  const p1 = parseUsAddress("2701 N Causeway Blvd, Metairie, LA, 70002");
  ok("parses comma-separated address", p1.city === "Metairie" && p1.state === "LA" && p1.zip === "70002" && p1.street === "2701 N Causeway Blvd", p1);
  const p2 = parseUsAddress("2110 W. Main St. Norman, OK 73069");
  ok("parses city after the street type with no comma", p2.city === "Norman" && p2.state === "OK" && p2.zip === "73069", p2);
  const p3 = parseUsAddress("6106 Shallowford Road Ste 104 Chattanooga, TN 37421");
  ok("parses city after a suite number", p3.city === "Chattanooga" && p3.street === "6106 Shallowford Road Ste 104", p3);
  ok("non-US address yields no parts", Object.keys(parseUsAddress("Linking Rd, Santacruz (West), Mumbai, 400054")).length === 0);

  const footer = fromFooterHeuristic(`<footer><p>Call (423) 894-0098</p>\n\t\t\t\t\t\t \n\t\t\t\t\t    <p>6106 Shallowford Road Ste 104  Chattanooga, TN 37421</p></footer>`);
  ok("footer address doesn't start inside the phone number or keep tabs/newlines", footer[0]?.address === "6106 Shallowford Road Ste 104 Chattanooga, TN 37421", footer[0]?.address);

  // ---------------------------------------------------------------------------
  console.log("\nEmbeddings (BUG-12)");
  ok("vectors of different lengths score 0", cosineSimilarity([1, 0, 0], [1, 0]) === 0);
  ok("identical vectors score 1", Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);

  // ---------------------------------------------------------------------------
  console.log("\nURL safety / SSRF (BUG-20)");
  ok("public IPv4", isPublicIp("8.8.8.8"));
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    ok(`${ip} is not public`, !isPublicIp(ip));
  }
  ok("public IPv6", isPublicIp("2606:4700:4700::1111"));
  delete process.env.ALLOW_PRIVATE_TARGETS;
  ok("rejects the cloud metadata endpoint", await rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data/")));
  ok("rejects localhost", await rejects(assertPublicUrl("http://localhost:3001/")));
  ok("rejects private IPs", await rejects(assertPublicUrl("10.0.0.5")));
  ok("rejects non-http schemes", await rejects(assertPublicUrl("file:///etc/passwd")));
  ok("rejects embedded credentials", await rejects(assertPublicUrl("https://user:pw@example.com/")));
  ok("rejects non-web ports", await rejects(assertPublicUrl("https://example.com:6379/")));
  ok("accepts a public IP literal", !(await rejects(assertPublicUrl("https://8.8.8.8/"))));
  ok("lets an unresolvable domain through (reported later as dead)", !(await rejects(assertPublicUrl("https://this-domain-should-not-exist-g99.invalid"))));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
