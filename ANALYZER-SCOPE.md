# Website Analyzer — project scope

**Goal:** given one website URL, return a structured profile of that site.
Reference example throughout: `https://ruma.com`.

## The questions we answer

| # | Question | Output |
|---|---|---|
| 1 | What platform is the site built on? | CMS + page builder + e-commerce + theme, each with a confidence |
| 2 | How many pages? | Total, and split by type |
| 3 | How many service pages? | Count + list |
| 4 | How many condition pages? | Count + list |
| 5 | How many before/after pages? | Count + list |
| 6 | Do they have a store / sell anything? | Boolean + platform + product count |
| 7 | How many blog pages? | Count |
| 8 | How many providers, and their info? | Count + per-provider name, credentials, role, bio, photo |
| 9 | How many locations? | Count + per-location name, address, phone |

## Ground truth: what ruma.com actually is

Measured live on 2026-09-16 by hitting the sitemaps directly:

```
post-sitemap              79   → blog
page-sitemap              59   → core / misc pages
product-sitemap           54   → store products
astra-portfolio-sitemap  203   → SERVICE pages (custom post type!)
product_cat-sitemap       18   → store categories
video-sitemap             78   → NOT pages; 50 of these duplicate portfolio URLs
local-sitemap              1   → locations.kml
```

Platform, from the homepage HTML: **WordPress + Elementor + WooCommerce**
(`wp-json` returns 200; no `<meta name="generator">`). Providers are on `/team/`
under an "Aesthetic Injectors" heading — Shelby Miller, Chrissy Bushell, Tessa
Brown, Mikayla Hill, Lydia Fairbanks, Amanda DuBois, Stephanie… — but that page
is a **2.6 MB** Elementor blob, so naive HTML parsing is not the answer there.

Three lessons this one site teaches:

1. **Service pages are not under `/services/`.** Ruma's 203 real service pages
   live in an `astra-portfolio` custom post type. Any analyzer that counts by URL
   prefix will report ~0 service pages here. The sitemap source is the signal.
2. **Sitemaps double-count.** The video sitemap shares 50 URLs with portfolio.
   Dedupe by URL, and make source precedence explicit — a URL that is both
   `portfolio` and `video` is a service page with a video on it, not a media item.
   *(The inherited `crawlSiteInventory` dedupes first-source-wins, which makes the
   result depend on sitemap ordering. This is a real bug to fix, not to port.)*
3. **A total page count needs a definition.** 492 sitemap URLs, but products and
   product categories are catalogue entries and videos are not pages at all.
   We report a headline number **and** show the breakdown, so nobody has to guess
   which definition we used.

## Where the inherited code lands

Detail in [CODEBASE-MAP.md](CODEBASE-MAP.md). Summary:

| Need | Status |
|---|---|
| Page discovery (sitemap + fallback) | ✅ `crawlSiteInventory()` — port it |
| Blog count | ✅ works (`source === "post"`) |
| Store detection | 🟡 partial — `shop` section exists, but no platform ID, no product count |
| Service pages | 🟡 `treatments` regex is a med-spa keyword list; misses ruma's portfolio type |
| Locations | 🟡 `locations` regex is med-spa specific (`med-spa-near-x`) |
| Before/after | 🟡 folded into a `proof` bucket with reviews + testimonials + galleries |
| Platform detection | ❌ **new** |
| Condition pages | ❌ **new** — no concept of a condition vs. a treatment |
| Providers + their info | ❌ **new** for extraction; `scrapeLite` gives us the raw material |

## Design decisions

**Layered detection, cheapest first.** Every field is answered by the cheapest
method that works, and each answer carries `{ value, confidence, evidence }`:

1. **Sitemap / structured data** — free, authoritative. Covers counts and types.
2. **HTTP + regex fingerprints** — one homepage fetch. Covers platform, store.
3. **Targeted fetch** — `/team/`, `/locations/`, `robots.txt`, `/wp-json/`,
   JSON-LD blocks. Covers providers and locations.
4. **AI (Gemini) as last resort** — only for genuinely fuzzy judgements:
   is this page a *condition* or a *treatment*; parse a provider bio out of an
   Elementor blob. Reuse `geminiCall` (server.js:282) for its key/model rotation.

Never send 492 URLs to an LLM one at a time. Batch, and only for the fuzzy ones.

**Every number is auditable.** A count is useless if the user can't see which
URLs produced it. Every count links to its list.

**Confidence is first-class.** "WordPress (certain, `wp-json` 200)" and
"WordPress (likely, `wp-content` in HTML)" are different answers. Say which.

**Honest unknowns.** A site with no sitemap, no team page, and a JS-rendered nav
should return `providers: unknown`, not `providers: 0`.

### Condition vs. service — the hard one

The distinction is real in this vertical but has no structural marker:

- **Service / treatment** = what the clinic *does*. Botox, microneedling, PRP.
- **Condition** = what the patient *has*. Melasma, acne scarring, hair loss.

Both live in the same post type, under the same URL prefix, using the same
template. Plan: keyword/title heuristics first (conditions skew toward symptom
and diagnosis nouns), AI adjudication for the ambiguous remainder, and a
`serviceOrCondition: uncertain` bucket we surface rather than hide.

## Proposed output shape

```json
{
  "url": "https://ruma.com",
  "platform": { "cms": "WordPress", "builder": "Elementor",
                "ecommerce": "WooCommerce", "confidence": "high",
                "evidence": ["wp-json 200", "elementor in html"] },
  "pages":   { "total": 341, "counted": "excludes videos + product categories",
               "byType": { "service": 203, "condition": 0, "blog": 79,
                           "beforeAfter": 2, "core": 12, "location": 1,
                           "product": 54, "other": 45 } },
  "store":   { "hasStore": true, "platform": "WooCommerce", "productCount": 54,
               "categoryCount": 18 },
  "providers": { "count": 7, "source": "/team/",
                 "list": [{ "name": "", "credentials": "", "role": "",
                            "bio": "", "photo": "" }] },
  "locations": { "count": 1, "list": [{ "name": "", "address": "", "phone": "" }] },
  "crawl":   { "discoveredVia": "sitemap", "sitemaps": 7, "urlsSeen": 492,
               "durationMs": 0, "warnings": [] }
}
```

## Build phases

- **Phase 1 — Inventory.** Port `crawlSiteInventory`, fix the dedupe/source
  precedence bug, add the product/category/video split. Answers Q2, Q7, and the
  raw material for the rest. *Ship this alone and it is already useful.*
- **Phase 2 — Platform + store.** Fingerprint table over one homepage fetch plus
  `robots.txt`/`wp-json` probes. Answers Q1, Q6.
- **Phase 3 — Page taxonomy.** Generalise the med-spa regexes; split before/after
  out of `proof`; add the condition-vs-service pass. Answers Q3, Q4, Q5.
- **Phase 4 — Providers + locations.** Team-page extraction and JSON-LD
  `LocalBusiness` / `Person` parsing, AI fallback. Answers Q8, Q9.
- **Phase 5 — Surface.** `GET /api/analyze?url=` + a report page, following the
  existing `public/` vanilla-JS pattern.

## Decisions

1. **Vertical: med-spa only.** Settled. Keyword lists, the condition taxonomy and
   the provider/credential vocabulary are all tuned for aesthetics clinics and
   stay hardcoded. No per-vertical config layer. This is what makes Q3/Q4
   (service vs. condition) tractable at all — a general-purpose analyzer could
   not draw that line.
2. **Extend this repo in place.** It is already named `web-analyzer`. New code
   lands in `lib/analyzer/` as self-contained modules; the generation pipeline is
   left untouched rather than deleted, so nothing breaks while we build. A later
   cleanup can drop the unused 20k lines once the analyzer stands on its own.

## Open questions

1. **Headless budget.** Playwright is ~12s/page and some sites render nav in JS.
   Do we allow it, and with what page cap? *Defaulting to no browser in Phase 1–3;
   revisit at Phase 4 where the team page may need it.*
2. **Where does this run?** Same Render service, or standalone?
3. ~~**Volume.**~~ **Settled: one URL at a time**, submitted from a form. No job
   queue, no batch runner, no result persistence — `analyze(url)` runs
   synchronously and returns. Keep each phase fast enough to answer inside a
   single HTTP request.
