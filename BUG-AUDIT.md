# Web Analyzer — Comprehensive Bug & Issue Audit

**Date:** 2026-09-30  
**Scope:** Full server codebase (`server/src/`) — every module audited line-by-line  
**Total Issues Found:** 34

---

## 🔴 Critical Bugs (Data Correctness)

### BUG-01 · Location city/state never populated
**File:** [`locations.ts`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/locations.ts#L9-L13) | **Severity:** Critical  
**Symptom:** `locations.list[].city` and `.state` are always blank across every test site. The API returns `[", "]` instead of `["Salt Lake City, UT"]`.  
**Root Cause:** The `Location` interface only has `name`, `address`, `phone` — there are **no `city` or `state` fields at all**. The address is stored as a single unparsed string, but the client/consumer apparently expects structured `city`/`state` fields that don't exist in the schema.  
**Fix:** Parse the `address` string into structured `{ street, city, state, zip }` fields, or add a post-processing step that extracts city/state from the combined address string using regex or the structured JSON-LD fields (`addressLocality`, `addressRegion`). The `addressToString()` function at L22-27 **has access to `addressLocality` and `addressRegion` individually** but throws them away by joining them into a single string.

---

### BUG-02 · JSON-LD addressLocality/addressRegion discarded
**File:** [`locations.ts:22-27`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/locations.ts#L22-L27) | **Severity:** Critical  
**Symptom:** Even when JSON-LD provides perfectly structured `addressLocality: "Nashville"`, `addressRegion: "TN"`, these are merged into the flat `address` string and lost.  
**Root Cause:** `addressToString()` joins all address parts into one string. The individual fields are never preserved on the `Location` object.
```typescript
// Current: loses structured data
const parts = [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean);
return parts.join(", ");
```
**Fix:** Store individual fields: `street`, `city`, `state`, `zip` alongside or instead of the flat `address` string.

---

### BUG-03 · GoDaddy Website Builder not in CMS fingerprint library
**File:** [`platform.ts:52-66`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/platform.ts#L52-L66) | **Severity:** High  
**Symptom:** `lacosmeticspa.com` (GoDaddy builder) returned `"Custom (PHP)"` instead of `"GoDaddy Website Builder"`.  
**Root Cause:** The `CMS_FINGERPRINTS` array has a GoDaddy entry at L60, but it looks for `godaddy.com/websites` or `gdwebsite` — neither of which is present on GoDaddy Website Builder pages. The actual fingerprint is **`wsimg.com`** (GoDaddy's image CDN, `img1.wsimg.com`). The regex misses it entirely.  
**Fix:** Change the GoDaddy regex to: `{ name: "GoDaddy Website Builder", re: /wsimg\.com|godaddy\.com\/websites|gdwebsite|godaddysites/i }`

---

### BUG-04 · Magento false positive on non-store sites
**File:** [`platform.ts:259`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/platform.ts#L259) | **Severity:** High  
**Symptom:** `lacosmeticspa.com` (no store) returned `hasStore: true, platform: "Magento"`.  
**Root Cause:** The `EXTERNAL_ECOMMERCE_FINGERPRINTS` Magento regex `/mage\/|Magento_/i` is overly broad. The word "image/" (common in image CDN paths like `https://img1.wsimg.com/isteam/ip/.../image/...`) contains the substring `mage/`, triggering a false positive match.  
**Fix:** Tighten the regex to require word boundaries or more specific patterns: `/\/mage\b|Magento_|\/Magento\//i` or better yet, require the Magento-specific markers only in the e-commerce detection context (not external store detection where the HTML is unknown territory).

---

### BUG-05 · Multi-location under-count despite dedicated location pages
**File:** [`locations.ts:163-229`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/locations.ts#L163-L229) | **Severity:** High  
**Symptom:** `inspiremedicalspas.com` has 6 location URLs in its `local-sitemap.xml` but only 1 location returned.  
**Root Cause:** `detectLocations()` checks for JSON-LD on the homepage first (L168-169). If it finds **any** JSON-LD LocalBusiness (even just 1), it returns immediately without checking the individual `/riverton/`, `/salt-lake-city/` etc. sub-pages. Multi-location sites typically only put their **primary** location in the homepage JSON-LD.  
**Fix:** When the crawl found `local`-sourced pages (from `local-sitemap.xml`), fetch JSON-LD from **each** of those individual location pages rather than relying solely on the homepage. The `pages` array with `source === "local"` already contains the location URLs — they're just never iterated.

---

### BUG-06 · `events` and `education` categories not in the `SectionKey` SECTIONS array
**File:** [`classify.ts:27-89`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/classify.ts#L27-L89) | **Severity:** Medium  
**Symptom:** The denylist returns `"events"` and `"education"` categories, but these are not defined as `Section` entries in the `SECTIONS` array. When `navCategory` is checked (L123-126), `SECTIONS.find(s => s.key === "events")` returns `undefined`.  
**Root Cause:** `events` and `education` are defined in `SectionKey` union type (L18) and used in `denylist.ts`, but there's no corresponding `Section` entry in the `SECTIONS` array. The `classifyPage` function falls through correctly because the denylist runs inside `pipeline.ts` (not inside `classifyPage`), but this inconsistency means `navCategory === "events"` would fail silently.

---

### BUG-07 · `beforeAfter` regex catches generic `/results/` and `/gallery/` pages
**File:** [`classify.ts:59-60`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/classify.ts#L59-L60) | **Severity:** Medium  
**Symptom:** A generic `/results/` page (e.g., search results) or a staff photo `/gallery/` would be misclassified as a before/after page.  
**Root Cause:** The regex `/(before-and-after|...|\bgallery\b|\bresults\b|\bphotos?\b)/i` is too permissive. Bare `\bresults\b` and `\bgallery\b` match paths like `/search-results/`, `/photo-gallery/`, `/image-gallery/` — not just B/A galleries.  
**Fix:** Require compound forms or a path prefix: `/results-gallery/`, `/our-results/`, or `/before-and-after/` etc. At minimum, exclude paths containing `/search-results/`.

---

## 🟠 Logic Errors & Edge Cases

### BUG-08 · `sourceOfSitemap` takes FIRST word before `-sitemap`, not LAST
**File:** [`crawl.ts:138-140`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/crawl.ts#L138-L140) | **Severity:** Medium  
**Symptom:** The comment on L137 says "Take the LAST word before `-sitemap`", but the regex `(/([a-z_]+)-sitemap/i)` actually captures `([a-z_]+)` which is **greedy** — it captures the entire prefix, not just the last word. For `astra-portfolio-sitemap.xml`, it captures `astra-portfolio`, not `portfolio`.  
**Root Cause:** The regex `([a-z_]+)` doesn't match hyphens, so for `astra-portfolio-sitemap`, it actually matches `portfolio-sitemap` and captures `portfolio`. The code happens to work for this specific case because hyphens aren't in the character class — but the comment is misleading and for names like `theme_portfolio-sitemap.xml` (underscore variant), it would capture `theme_portfolio` which IS the wrong result because underscores are in the char class.  
**Fix:** Make the regex explicitly capture only the last word: `/(?:^|[-/])([a-z_]+)-sitemap/i`.

---

### BUG-09 · Dead code / no-op expression in `platform.ts`
**File:** [`platform.ts:216`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/platform.ts#L216) | **Severity:** Low  
**Symptom:** Code does `(builder.value ? builder : builder).evidence.push(...)` — this is a no-op ternary. Both branches evaluate to `builder`. Clearly intended to be `(builder.value ? builder : cms)` or similar.
```typescript
(builder.value ? builder : builder).evidence.push(`theme path: /themes/${theme}/`);
```
**Fix:** Determine the intended logic — likely `(builder.value ? builder : cms).evidence.push(...)`.

---

### BUG-10 · `embedText` doesn't rotate API keys
**File:** [`gemini.ts:10-33`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/gemini.ts#L10-L33) | **Severity:** Medium  
**Symptom:** `embedText()` always uses `GEMINI_KEYS[gkIdx % GEMINI_KEYS.length]` without incrementing `gkIdx`. If the first key is rate-limited, every embedding call fails instead of rotating.  
**Root Cause:** Unlike `geminiCall()` which loops through keys and increments `gkIdx` on success, `embedText()` uses a single key, has no retry loop, no timeout, and no key rotation.  
**Fix:** Add the same retry-with-key-rotation pattern used in `geminiCall()`.

---

### BUG-11 · `embedText` has no abort/timeout
**File:** [`gemini.ts:21-26`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/gemini.ts#L21-L33) | **Severity:** Medium  
**Symptom:** If the Gemini embedding API hangs, the entire classification pipeline hangs with it. There's no `AbortController` or timeout for the `fetch` call in `embedText()`, unlike `geminiCall()` which uses `opts.timeoutMs || 30000`.  
**Fix:** Add `signal: AbortSignal.timeout(15000)` to the fetch call.

---

### BUG-12 · `cosineSimilarity` doesn't validate vector lengths
**File:** [`gemini.ts:35-46`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/gemini.ts#L35-L46) | **Severity:** Low  
**Symptom:** If `vecA` and `vecB` have different lengths (e.g., model version mismatch between pre-computed prototypes and a live embedding), the function silently computes a partial/incorrect similarity without warning.  
**Fix:** Add a length check: `if (vecA.length !== vecB.length) return 0;`

---

### BUG-13 · Duplicate `fetchText()` functions with inconsistent User-Agents
**File:** [`crawl.ts:112`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/crawl.ts#L112) vs [`platform.ts:33`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/platform.ts#L33) vs [`scrapeLite.ts:9`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/scrapeLite.ts#L9) | **Severity:** Medium  
**Symptom:** Three separate `fetchText()` functions across three files, each with a different User-Agent string:
- `crawl.ts`: `"Mozilla/5.0 (compatible; G99WebAnalyzer/1.0; +https://...)"` (honest bot UA)
- `platform.ts`: `"Mozilla/5.0 (compatible; G99-Analyzer/1.0)"` (different bot UA)
- `scrapeLite.ts`: Same as platform.ts

Meanwhile, `fetchWithFallback.ts` overrides ALL of these with a Chrome spoofed UA (`"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36..."`) at L188-189 for Tier 1 direct fetch. The honest bot UA specified in `crawl.ts` is **silently overwritten** by `fetchWithFallback` and never actually sent. This is inconsistent with the extensive comment at L12-22 about using an honest bot UA.

---

### BUG-14 · `addNewOnly` path normalization doesn't match `add()`
**File:** [`crawl.ts:417-426`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/crawl.ts#L417-L426) | **Severity:** Medium  
**Symptom:** `addNewOnly` checks both `found.has(path)` and `found.has(path + "/")`, but the `add()` function normalizes paths to always end in `/` (L315). So `addNewOnly` could miss a URL that `add()` would normalize differently. For example, a path `/about` would check `found.has("/about")` and `found.has("/about/")`, but `add()` would have stored it as `/about/`. The `found.has(path)` check (without trailing slash) is technically dead code — the Map only ever has slash-terminated keys.  
**Fix:** Normalize `path` in `addNewOnly` the same way `add()` does before the lookup, then just check `found.has(normalizedPath)`.

---

### BUG-15 · `HubSpot CMS` fingerprint false positive on analytics snippet
**File:** [`platform.ts:64`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/platform.ts#L64) | **Severity:** Medium  
**Symptom:** The regex `hs-analytics` matches ANY site that uses HubSpot's free analytics tracking JavaScript (very common — many WordPress sites embed HubSpot for CRM/analytics). This causes a non-HubSpot site to be identified as `HubSpot CMS`.  
**Root Cause:** `hs-analytics` (the HubSpot tracking script) is present on sites that use HubSpot's marketing tools, not necessarily HubSpot CMS. It's as common as Google Analytics.  
**Fix:** Remove `hs-analytics` from the CMS regex and only match `hs-sites.com` and `hubspot.com` which are specific to sites actually hosted on HubSpot CMS.

---

### BUG-16 · Provider extraction only checks ONE team page
**File:** [`providers.ts:38-44`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/providers.ts#L38-L44) | **Severity:** Medium  
**Symptom:** `findTeamPage()` returns the first match from `TEAM_PATH_PATTERNS`, then `detectProviders()` only fetches that one page. Multi-location medspas often have provider info spread across `/our-team/`, `/meet-the-team/`, AND individual provider pages like `/dr-jane-smith/`.  
**Root Cause:** Only the highest-priority team page pattern is used; individual provider sub-pages (e.g., `/providers/dr-smith/`) are never crawled.

---

### BUG-17 · `navCategory` extraction's `<li>` regex is non-greedy with nested `<li>`s
**File:** [`crawl.ts:221`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/crawl.ts#L221) | **Severity:** Medium  
**Symptom:** The regex `<li[^>]*class="[^"]*...has-children...*"[^>]*>([\s\S]*?)<\/li>` uses lazy `[\s\S]*?` which will match the **first** `</li>` it encounters — which in nested dropdown menus is the **inner** list item, not the parent. This truncates the captured content and misses child links.  
**Root Cause:** HTML regexes can't handle nested elements of the same type. A nested `<li>` inside the dropdown `<li>` will prematurely close the match.

---

## 🟡 Missing Features / Gaps

### BUG-18 · No request concurrency limit — concurrent analyses can overwhelm the proxy
**File:** [`index.ts:66-78`](file:///Users/devsharma/Developer/web-analyzer/server/src/index.ts#L66-L78) | **Severity:** High  
**Symptom:** The `/api/analyze` endpoint is unbounded — multiple simultaneous requests each spawn their own full crawl + classify + providers pipeline. With proxy usage, this can exhaust the Webshare proxy quota or trigger rate limits on target sites.  
**Root Cause:** No queue, semaphore, or concurrency guard on the analyze endpoint.  
**Fix:** Add a request queue or semaphore that limits concurrent analyses to 1 (or 2).

---

### BUG-19 · Session proxy credits are global — not per-analysis
**File:** [`fetchWithFallback.ts:24-33`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/fetchWithFallback.ts#L24-L33) | **Severity:** Medium  
**Symptom:** `sessionProxyRequestsUsed` is a module-level counter that accumulates across ALL analyses since server start. The response `crawl.proxyRequestsUsed` reports the cumulative total, not the cost of THIS specific analysis.  
**Root Cause:** No per-request scoping of the counter. Each analysis just reads the running total.  
**Fix:** Reset or snapshot the counter before each `analyze()` call and report the delta.

---

### BUG-20 · No URL validation or sanitization
**File:** [`index.ts:67`](file:///Users/devsharma/Developer/web-analyzer/server/src/index.ts#L67) | **Severity:** Medium  
**Symptom:** The API accepts any string as `?url=`. An attacker could pass internal network URLs (`http://localhost:3001`, `http://169.254.169.254/latest/meta-data/`) to trigger Server-Side Request Forgery (SSRF).  
**Root Cause:** No validation that the URL is a public, external website. `crawl.ts` only checks `new URL().origin` for format, not whether it resolves to a public IP.  
**Fix:** Validate the URL is `https://`, resolve the hostname, check it's not a private/loopback IP, and reject internal addresses.

---

### BUG-21 · `extractJsonLd` doesn't handle `@type` arrays for location detection
**File:** [`locations.ts:30-32`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/locations.ts#L30-L32) | **Severity:** Medium  
**Symptom:** The JSON-LD filter checks `typeof b["@type"] === "string"` but many sites use `@type` as an array: `"@type": ["LocalBusiness", "MedicalBusiness"]`. The filter skips these entirely.  
**Root Cause:** Only string `@type` is checked; array `@type` is rejected. Compare with `providers.ts:47` which correctly handles both: `b["@type"] === "Person" || (Array.isArray(b["@type"]) && ...)`.

---

### BUG-22 · Homepage fetched redundantly across 3+ phases
**File:** Multiple | **Severity:** Medium  
**Symptom:** The homepage HTML is fetched separately in:
1. `crawl.ts` (L429) — for link discovery
2. `platform.ts:169` — for CMS fingerprinting
3. `locations.ts:168` — for JSON-LD location extraction
4. `providers.ts` — if team page is "/"

Each is a separate HTTP request (potentially through the paid proxy), wasting bandwidth and credits.  
**Fix:** Fetch the homepage once, pass the HTML to all downstream phases.

---

### BUG-23 · `Squarespace Commerce` ecommerce fingerprint too broad
**File:** [`platform.ts:83`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/platform.ts#L83) | **Severity:** Medium  
**Symptom:** `sqs-cart|sqs-add-to-cart` detects Squarespace Commerce even when the site is on a basic plan with no active products (bloomaesthetics returned `ecommerce: "Squarespace Commerce"`). This is not necessarily wrong — the ecommerce system IS present — but is semantically misleading. It causes the store report to show a platform that has zero products.  
**Root Cause:** Plugin/infrastructure detection conflated with active store detection.

---

### BUG-24 · `theagelessclinic.com` has a sitemap but crawled via "homepage links"
**File:** [`crawl.ts:363-382`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/crawl.ts#L363-L382) | **Severity:** Medium  
**Symptom:** The site has a valid sitemap at `https://www.theagelessclinic.com/sitemap.xml` (confirmed reachable at HTTP 200), but the crawl returned `discoveredVia: "homepage links"` and only found 2 pages.  
**Root Cause:** The site redirects `theagelessclinic.com` → `www.theagelessclinic.com`. The crawl resolves `origin` to `https://theagelessclinic.com` (without www), and robots.txt doesn't declare a sitemap for the non-www origin. The sitemap probe goes to `https://theagelessclinic.com/sitemap.xml` which 301-redirects to `https://www.theagelessclinic.com/sitemap.xml`. But `fetchText` inside `fetchWithFallback` follows redirects — so it SHOULD have gotten the XML. The real issue may be that the sitemap contains URLs for `www.theagelessclinic.com` which don't match the resolved `origin` (`https://theagelessclinic.com`), causing `add()` to reject them as cross-origin at L303.  
**Fix:** After fetching the homepage, resolve the origin to the final redirect destination (canonical URL). If `https://theagelessclinic.com/` redirects to `https://www.theagelessclinic.com/`, use `www.theagelessclinic.com` as the origin.

---

### BUG-25 · Prototypes file is 1.6MB — loaded synchronously into memory
**File:** [`classification/prototypes.ts`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/classification/prototypes.ts) | **Severity:** Medium  
**Symptom:** A 1.6MB TypeScript file with 55,460 lines of pre-computed embeddings is imported at module load time. This bloats the server's memory footprint and slows cold starts.  
**Root Cause:** Embedding vectors are stored inline in a `.ts` file rather than in a separate data file (e.g., JSON or a binary format) loaded on demand.  
**Fix:** Move prototypes to a JSON file, load lazily on first classification run.

---

## 🔵 Performance Issues

### BUG-26 · Embedding API called per-page in a serial loop
**File:** [`classification/pipeline.ts:57-83`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/classification/pipeline.ts#L57-L83) | **Severity:** High  
**Symptom:** `runClassificationPipeline` is called inside a `for` loop in `classify.ts:284`. Each call makes a separate `embedText()` API call. For a site with 50 pages where 20 fall through to embedding, that's 20 sequential API calls (~200ms each = 4 seconds of serial latency).  
**Root Cause:** No batching of embedding requests. The embedding API supports batch requests, but this code calls it one-at-a-time.  
**Fix:** Batch all unresolved pages into a single embedding call, then compute similarities in-memory.

---

### BUG-27 · `batchCheckExceptions` fetches ALL corrections every time
**File:** [`exceptionStore.ts:51-53`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/classification/exceptionStore.ts#L51-L53) | **Severity:** Medium  
**Symptom:** `SELECT url_pattern, correct_category FROM corrections ORDER BY created_at ASC` is a full table scan — every correction ever logged is fetched and processed in JavaScript for every analysis.  
**Root Cause:** No WHERE clause, no caching, no pagination.  
**Fix:** Cache the corrections table in memory with a TTL, or use SQL `LIKE` / `SIMILAR TO` operators to filter server-side.

---

### BUG-28 · CSS `ASSET_RE` may filter too aggressively
**File:** [`crawl.ts:37`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/crawl.ts#L37) | **Severity:** Low  
**Symptom:** The asset filter regex includes `.json` — this would incorrectly filter out URLs like `/services/dermal-filler.json` if any CMS used `.json` page URLs (Next.js data routes use `.json`). Also filters out `.md` files, though Markdown-based CMSes (Docusaurus, Hugo) serve pages at `.md` URLs.

---

## 🟣 Security & Reliability

### BUG-29 · No rate limiting on the API
**File:** [`index.ts`](file:///Users/devsharma/Developer/web-analyzer/server/src/index.ts) | **Severity:** High  
**Symptom:** Any client can send unlimited `/api/analyze` requests. Each analysis triggers dozens of outbound HTTP requests (proxy-backed). An attacker could drain the Webshare proxy quota in minutes.  
**Fix:** Add `express-rate-limit` middleware, at minimum 1 req/min per IP.

---

### BUG-30 · CORS is fully open (`app.use(cors())`)
**File:** [`index.ts:16`](file:///Users/devsharma/Developer/web-analyzer/server/src/index.ts#L16) | **Severity:** Medium  
**Symptom:** Any domain can call the API. Combined with the SSRF risk (BUG-20), this means a malicious third-party site could trigger internal network probes from this server.  
**Fix:** Restrict CORS to the known client origin (e.g., `http://localhost:5173` in dev, specific domain in production).

---

### BUG-31 · API key exposed in ScraperAPI URL
**File:** [`fetchWithFallback.ts:311`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/fetchWithFallback.ts#L311) | **Severity:** Low  
**Symptom:** `const scraperUrl = "http://api.scraperapi.com?api_key=${scraperKey}&url=..."` — the API key is sent over plain HTTP (not HTTPS). This leaks the key to any network intermediary.  
**Fix:** Use `https://api.scraperapi.com` instead of `http://`.

---

### BUG-32 · `process.loadEnvFile()` is a Node.js experimental API
**File:** [`index.ts:2`](file:///Users/devsharma/Developer/web-analyzer/server/src/index.ts#L2), [`fetchWithFallback.ts:6`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/fetchWithFallback.ts#L6) | **Severity:** Low  
**Symptom:** `process.loadEnvFile()` was added in Node.js 20.12+ as experimental. It may be removed or changed in future versions. Also, two separate files independently try to load the `.env` — both with different relative paths, creating a fragile startup.  
**Fix:** Use `dotenv` or consolidate env loading in a single entry point.

---

## ⚪ Code Quality & Maintainability

### BUG-33 · `looksLikeProduct` detection duplicated across two code paths
**File:** [`fetchContent.ts:75-82`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/fetchContent.ts#L75-L82) vs [`fetchContent.ts:130-137`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/fetchContent.ts#L130-L137) | **Severity:** Low  
**Symptom:** The identical `looksLikeProduct` regex set is duplicated verbatim in the Crawlee request handler AND the fallback handler. If one is updated, the other is easy to forget.  
**Fix:** Extract to a shared function `detectProductSignals(html: string): boolean`.

---

### BUG-34 · `unused variable` in `detectExternalStore`
**File:** [`platform.ts:288`](file:///Users/devsharma/Developer/web-analyzer/server/src/analyzer/platform.ts#L288) | **Severity:** Low  
**Symptom:** `const shopifyHtml = EXTERNAL_ECOMMERCE_FINGERPRINTS.find(...)` is assigned but never used. The early return on L289-294 doesn't use `shopifyHtml`.

---

## Summary by Severity

| Severity | Count | Key Items |
|----------|-------|-----------|
| 🔴 Critical | 7 | Location city/state missing, addressLocality discarded, GoDaddy not detected, Magento false positive, multi-location under-count, www/non-www origin mismatch |
| 🟠 Logic Error | 9 | sourceOfSitemap comment mismatch, dead code ternary, embedText no rotation/timeout, cosine no length check, UA inconsistency, HTML regex nesting |
| 🟡 Missing | 6 | No concurrency limit, global credit counter, no URL validation, JSON-LD @type array, redundant homepage fetches, Squarespace Commerce false positive |
| 🔵 Performance | 3 | Serial embedding calls, full table scan, over-aggressive asset filter |
| 🟣 Security | 4 | No rate limiting, open CORS, HTTP API key leak, experimental Node API |
| ⚪ Quality | 2 | Code duplication, unused variable |
| **Total** | **34** | |

---

## Resolution — 2026-09-30 (Claude Code)

Each item was checked against the code, and where possible against the live site, before being changed. Offline regression tests for these fixes are in `server/tests/fixes.unit.test.ts` (`npm run test:unit`).

| Item | Status | What changed / why not |
|---|---|---|
| BUG-01 | Not a bug as described | `address` was always populated; the client reads `address`, never city/state. The `[", "]` in API-TEST-RESULTS came from the test script printing fields that don't exist. Structured `street`/`city`/`state`/`zip` were added anyway: from JSON-LD directly, otherwise parsed from US-format addresses. |
| BUG-02 | Done | JSON-LD `PostalAddress` parts are now kept on each location. |
| BUG-03 | Fixed | GoDaddy detected via `wsimg.com` and the "Go Daddy Website Builder" generator tag. |
| BUG-04 | Fixed | Magento now needs Magento-specific tokens (`image/` contained `mage/`). The lacosmeticspa store link is real: geauxstore.com is an **Ecwid** store, now reported as Ecwid. |
| BUG-05 | Fixed (mechanism); premise wrong | Homepage JSON-LD, locations.kml and per-location pages are now merged and deduplicated. Inspire was not under-counted: its six "location" pages are local-SEO landing pages ("med-spa-near-riverton-utah"), and it has one physical address. |
| BUG-06 | Fixed | `events`/`education` have Section entries. The hint actually being lost was nav "About" (`about` isn't a section key); it now maps to `core`. |
| BUG-07 | Fixed, narrowly | Search/office/team/staff/facility/event/tour galleries and results are no longer before/after. Bare `/gallery/` and `/results/` still are (validated on real sites, per the code comments). |
| BUG-08 | Not a bug | `[a-z_]+` excludes hyphens, so the last hyphenated word is captured. Underscores must be kept: `product_cat`, `rank_math_locations`. Comment clarified. |
| BUG-09, BUG-34 | Fixed | No-op ternary and unused variable removed. |
| BUG-10, BUG-11 | Fixed | `embedText` rotates keys on 429/503, with a 15s per-attempt timeout and a caller deadline. |
| BUG-12 | Fixed | Mismatched vector lengths score 0. |
| BUG-13 | Claim reversed; consolidated | Caller headers override the Chrome default, so the bot UA *was* sent. All modules now use one `ANALYZER_UA`. The content-fetch fallback still deliberately sends a Chrome UA — an open posture decision (see crawl.ts header comment). |
| BUG-14 | Fixed | One `toPagePath()` normalizer used everywhere. |
| BUG-15 | Fixed | HubSpot CMS only on HubSpot-hosted markers (`hs_cos_wrapper`, `hs-sites.com`, `hubspotusercontent`, generator). |
| BUG-16 | Fixed | Up to 3 team-page candidates tried in order; up to 8 bio pages under a team hub read in the same batch. Also fixed: the tier-2 pattern `(^|-)` never matched `/injectors/`, `/doctors/`, `/team-members/`. |
| BUG-17 | Fixed | Nav menus parsed with cheerio, innermost submenu first. |
| BUG-18 | Fixed | 2 concurrent analyses, up to 10 queued, 503 beyond (`MAX_CONCURRENT_ANALYSES`, `MAX_QUEUED_ANALYSES`). |
| BUG-19 | Fixed | Per-analysis usage via AsyncLocalStorage; the credits endpoints still report session totals. |
| BUG-20 | Fixed at entry | Target hostname resolved; private/loopback/link-local/reserved addresses, non-http schemes, credentials and non-web ports rejected. Also applied to external store links and cross-domain homepage redirects. Not covered: re-checking every redirect hop, DNS rebinding. `ALLOW_PRIVATE_TARGETS=1` for local dev. |
| BUG-21 | Fixed | Every `@type` in an array is checked; LocalBusiness subtypes (HealthAndBeautyBusiness, DaySpa, …) included. Dedupe now keys on house number + street name so one address spelled two ways stays one location. |
| BUG-22 | Fixed | The crawl fetches the homepage once; platform and locations reuse it. |
| BUG-23 | Fixed | Squarespace Commerce needs product-level markers; the header cart icon alone doesn't count (bloomaesthetics.com's /shop is a 404). |
| BUG-24 | Fixed | The origin follows the homepage redirect (www/non-www, http→https, or a whole-site domain move with a warning). Sitemap URLs on the other www variant are accepted. |
| BUG-25 | Done | Vectors moved to `prototypes.json`, loaded on first use. (The memory claim was overstated: 31 × 3072 numbers is under 1MB.) |
| BUG-26 | Fixed | Embedding calls run 6 at a time under a shared deadline. The batch endpoint wasn't used: not verified for `gemini-embedding-2`. |
| BUG-27 | Fixed | Corrections cached 60s, cleared on insert. Also: pg connect/query timeouts (5s) — pg's default is to wait forever. |
| BUG-28 | Not changed | `.json`/`.md` URLs are data/source files, not pages, on the platforms this vertical uses. |
| BUG-29 | Fixed | 20 requests / 10 min per IP (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`), with `trust proxy` for Render. |
| BUG-30 | Configurable — action needed | `CORS_ORIGINS` allowlist. Unset keeps the API open (the production frontend URL isn't in the repo); set it on Render. |
| BUG-31 | Fixed | ScraperAPI over HTTPS. |
| BUG-32 | Fixed | One loader, `server/src/loadEnv.ts`. `process.loadEnvFile` kept (Node 26 in use). |
| BUG-33 | Fixed | One `extractContentSignals()` helper. |

### Also fixed (not in this audit)

- **WordPress category/tag/author archives counted as pages.** `/category/botox/` matched the service vocabulary: on culturemedspa.com, 19 of its 39 "service" pages were category archives. Archives are now excluded from page counts and classification (still counted in `urlsSeen`).
- **External-store timeout reported a store.** `withTimeout(…, null)` resolved to a truthy `{ reason }` → `hasStore: true, platform: undefined`.
- **External-store links:** `\\.shop` regex typo; social/app-store links (play.google.com/store/…) no longer qualify; a `.shop` domain alone no longer means Shopify; links checked in parallel within the 12s budget.
- **Footer address regex** started inside the preceding phone number and kept tabs/newlines (skinmedhealth.com returned `"0098\t\t…6106 Shallowford Road…"`).
- **Taxonomy phase budget:** every internal step now fits an 85s budget inside the 90s outer timeout, so a slow step degrades on its own instead of the outer timeout discarding every classified page.
- **Direct fetch timeout** now covers reading the body, not just the headers.
