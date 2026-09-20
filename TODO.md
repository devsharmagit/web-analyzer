# Website Analyzer — build plan

Vertical: **med-spa only**. Scope in [ANALYZER-SCOPE.md](ANALYZER-SCOPE.md),
inherited code in [CODEBASE-MAP.md](CODEBASE-MAP.md).

New code lives in `lib/analyzer/`. The existing generation pipeline is left alone.

Test target throughout: `https://ruma.com` (WordPress + Elementor + WooCommerce,
203 portfolio service pages, 79 blog posts, 54 products, 1 location, ~7 providers).

---

## Phase 1 — Inventory  ·  answers Q2 (page count), Q7 (blog)

The backbone. Everything else reads from this. **Ship-worthy on its own.**

- [x] `lib/analyzer/crawl.js` — ported `crawlSiteInventory()` from [server.js:3474](server.js:3474)
- [x] Fixed the source-precedence bug via an explicit `SOURCE_RANK`
      (`page` > `portfolio` > `product` > `product_cat` > `post` > `video`)
- [x] Collect *all* sources per URL (`sources[]`), resolve one winner (`source`)
- [x] Split out `product` / `product_cat` / `video` via `NON_PAGE_SOURCES`
- [x] Report `total` (real pages) alongside `urlsSeen` (raw URLs)
- [x] Kept the homepage-link fallback for sites with no sitemap
- [x] `warnings[]` — no sitemap, sitemap fetch failed, 0 pages, >25 child sitemaps
- [x] `test-analyzer-crawl.js` — 17 checks, all passing
- [x] **Verified:** ruma → 413 urls seen, **341 pages** (203 portfolio + 79 post
      + 59 page), 53 products + 18 categories held out, no double-count

**Phase 1 result on ruma.com:** 5.2s, sitemap, 7 child sitemaps. All 78 video
URLs correctly resolved to their real type; `/shop/` correctly resolved
`page` over `product`.

## Phase 2 — Platform + store  ·  answers Q1, Q6

One homepage fetch plus two cheap probes. No crawling.

- [ ] `lib/analyzer/platform.js` — fingerprint table over homepage HTML
- [ ] CMS: WordPress (`wp-content`/`wp-json`/`wp-includes`), Squarespace, Wix,
      Webflow, Shopify, Duda, GoDaddy — the platforms that actually show up in
      this vertical
- [ ] Builder: Elementor, Divi, Beaver Builder, WPBakery, Gutenberg; plus theme
      name from the `themes/<name>` asset path
- [ ] E-commerce: WooCommerce, Shopify, BigCommerce, Ecwid
- [ ] Probes: `/wp-json/` status, `robots.txt`, `<meta name="generator">`
- [ ] Return `{ value, confidence, evidence[] }` — `wp-json` 200 is *certain*,
      a `wp-content` string match is only *likely*
- [ ] Store: `hasStore` + `productCount` + `categoryCount` from Phase 1 counts,
      cross-checked against the detected e-commerce platform
- [ ] **Verify:** ruma → WordPress / Elementor / WooCommerce, 54 products, 18 cats

## Phase 3 — Page taxonomy  ·  answers Q3, Q4, Q5

Where the med-spa tuning earns its keep.

- [ ] `lib/analyzer/classify.js` — port `SECTIONS` + `classifyPage()` from
      [server.js:3423](server.js:3423), **keeping the explanatory comments**
- [ ] Treat `portfolio` (and other service-ish custom post types) as a service
      signal, so ruma's 203 pages are found
- [ ] Split `beforeAfter` out of the `proof` bucket — it currently mixes
      before/after with reviews, testimonials and generic galleries
- [ ] New `condition` type + med-spa condition vocabulary (melasma, rosacea,
      acne scarring, hyperpigmentation, hair loss, sun damage, volume loss,
      hyperhidrosis, cellulite, stretch marks, …)
- [ ] Check for a `/conditions/` URL prefix — Phase 1 found exactly one on ruma
      (`/conditions/facial-volume-loss-treatment-test-157923/`, an orphan test
      page reachable only via the video sitemap). So the prefix convention exists
      in this vertical even where it is barely used; treat it as a strong signal
- [ ] Watch for condition words appearing *inside* service URLs
      (`/morpheus8-face-body-scar-near-draper-ut/` is a service page, not a scar
      condition page). Location-suffixed service pages must not be miscounted
- [ ] Heuristic pass first: condition pages skew to symptom/diagnosis nouns,
      service pages to procedure and brand names (Botox, Sculptra, Morpheus8)
- [ ] AI adjudication for the ambiguous remainder only — **batched**, via
      `geminiCall` ([server.js:282](server.js:282)). Never one call per URL
- [ ] Surface an `uncertain` bucket rather than forcing a guess
- [ ] Every count carries its URL list, so any number can be audited
- [ ] **Verify:** ruma's service/condition split is sane on manual spot-check

## Phase 4 — Providers + locations  ·  answers Q8, Q9

The fuzziest work. Expect this phase to be the longest.

- [ ] `lib/analyzer/providers.js`
- [ ] Find the team page: `/team/`, `/our-team/`, `/about/`, `/staff/`,
      `/providers/`, `/meet-the-team/` — plus anything Phase 1 tagged `core`
- [ ] JSON-LD first: `Person` and `LocalBusiness` blocks are free and exact
- [ ] Heading + portrait pairing as the structural fallback
- [ ] Credential regex: MD, DO, NP, PA-C, RN, BSN, DNP, FNP-C, LME, DMD
- [ ] AI fallback for bio/role extraction — ruma's `/team/` is a **2.6 MB**
      Elementor blob, so strip to text before sending anything to Gemini
- [ ] `lib/analyzer/locations.js` — JSON-LD `LocalBusiness`/`PostalAddress`,
      `/locations/` pages, `locations.kml` (ruma publishes one), footer NAP block
- [ ] Deduplicate locations by normalised address
- [ ] Return `unknown`, never `0`, when detection genuinely fails
- [ ] **Verify:** ruma → ~7 providers with names and credentials, 1 location

## Phase 5 — Surface

- [ ] `lib/analyzer/index.js` — `analyze(url)` orchestrating phases 1–4,
      returning the JSON shape in [ANALYZER-SCOPE.md](ANALYZER-SCOPE.md)
- [ ] Run independent phases concurrently; one failing phase must not fail the run
- [ ] Per-phase timeouts + partial results
- [ ] `GET /api/analyze?url=` route in `server.js`
- [ ] `public/analyze.{html,js}` — URL input, then a report: platform badge,
      count tiles, expandable URL lists per type, provider cards, locations.
      Follow the existing vanilla-JS pattern in `public/coverage.js`
- [ ] Show `warnings[]` and every confidence level in the UI — an analyzer that
      hides its uncertainty is worse than one that reports less
- [ ] **Verify:** paste ruma.com into the form, get the full report

---

## Suggested order of attack

Phase 1 → 2 first: together they're a working tool that already answers four of
the nine questions, on one afternoon's work. Phase 3 is the core value and
deserves real iteration. Phase 4 is where estimates go wrong — start it only
once 1–3 are solid, and be willing to ship `unknown` for hard sites.

Settled: **one URL at a time**, synchronous, no job queue. Still open before
Phase 4: whether Playwright is allowed for JS-rendered team pages.
