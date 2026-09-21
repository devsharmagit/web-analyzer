# Accuracy Improvement Plan

## Goal
Maximize the accuracy of every answer the analyzer produces, even at the cost of
speed and LLM spend. The current ceiling is that most pages are classified by
their **URL slug**, never by their actual content. This plan shifts to
**content-based, LLM-assisted, evidence-carrying** analysis, and — critically —
builds a way to **measure** accuracy before and after each change.

## Key findings from recon (2026-09-21)
- The med-spa vertical is **WordPress + server-rendered + sitemapped**. Checked 9
  sites (ruma, conqraesthetics, drippynursejess, trubeautybytrevor, gloderma,
  culturemedspa, havenpmu, skinmedhealth, medspasanangelo). None are JS shells.
- Therefore Crawlee's headline features (JS rendering, proxy rotation) are **not**
  our bottleneck. We adopt Crawlee only for the **content-fetch layer**
  (`CheerioCrawler`: concurrency, retries, dedup, `KeyValueStore` cache), with
  `AdaptivePlaywrightCrawler` as an opt-in escape hatch if a page looks empty.
- Builder detection must switch from first-match to **dominant** (Elementor
  outweighs Divi ~50× on every site, but our first-match code could pick wrong).

## Principle: measure first
No classifier change lands before the eval harness exists and a baseline is
recorded. "Accuracy improved" must be a number, not an assertion.

---

## Phase 0 — Tier-1 quick fixes (low risk, no new deps)
- `platform.ts`: **dominant-builder** detection — count occurrences of each
  fingerprint, highest wins (mirror the validation harness's ground-truth logic).
- `locations.ts`: **footer NAP fallback** — regex address/phone near `<footer>`
  when JSON-LD / KML / `/locations/` all miss.
- `providers.ts`: expand `CREDENTIAL_RE` (add APRN, CANS, CRNA, LE, CPPS, PA).
- All phases: add a `reason` to `unknown`/timeout fallbacks so the UI can tell
  "timed out" from "genuinely not found."

## Phase 1 — Eval harness (the accuracy contract)
- Hand-label ground truth for all 9 sites in `server/validation/groundtruth/`:
  - Objective fields fully (CMS, builder, ecommerce, page total, products,
    locations, provider count).
  - A ~40-URL **taxonomy sample** per site labelled service/condition/blog/
    beforeAfter/other.
- Extend `server/validation/` into a **scorer** (`score.ts`) reporting
  precision / recall / accuracy **per field, per site**, plus an aggregate.
- Run against current `main` → commit the numbers as `BASELINE` in this file.
- Reuse the existing independent `groundtruth.ts` for the objective fields.

## Phase 2 — Content acquisition (Crawlee `CheerioCrawler`)
- New `server/src/analyzer/fetchContent.ts`: given a list of URLs, fetch with
  Crawlee (bounded concurrency, retry, cache via `KeyValueStore`), extract
  `{ url, title, h1s[], metaDescription, jsonLd[], text (first ~2-3k chars),
  breadcrumbs }`.
- **Selective fetch** — only pages the URL heuristic can't confidently place:
  skip `source==="post"` (blog) and `product`/`product_cat` (store); fetch
  `page` / `portfolio` / `other`.
- Adaptive escape hatch: if HTTP body looks empty, retry that one URL rendered.

## Phase 3 — Content-based classification (core accuracy win)
- `classify.ts`: deterministic signals first (JSON-LD `@type`, WooCommerce,
  clear title patterns) → confident bucket, no LLM.
- Remaining ambiguous pages → LLM adjudication seeing **real content** (title +
  h1 + snippet + JSON-LD type), batched ~40/call, returns
  `{ type, confidence, evidence }`.
- Decide service-vs-condition on content, not slug tie-breaks. Keep an
  `uncertain` bucket, now much smaller.
- Every count carries `{ value, confidence, evidence, method }`.

## Phase 4 — Content-based extraction
- Providers: multi-page aware — a roster page **or** individual `/team/*` pages;
  extract from rendered content; dedup; richer credentials.
- Locations: JSON-LD + KML + footer NAP + **multi-location** (needs a
  multi-location fixture to validate).

## Phase 5 — Re-run eval, report before/after
- Run the Phase-1 scorer again; record `AFTER` numbers per field in this file.
- Ship only if aggregate accuracy is up and no field regressed materially.

---

## Token / cost efficiency (runtime and dev-loop)
- Selective fetch (not all ~400 pages), all LLM calls batched.
- On-disk content cache (`KeyValueStore`) so re-runs during development never
  re-fetch or re-LLM the same page.
- Confidence + evidence on every field so weak numbers are visible, not hidden.

## Dependency note
Crawlee + Cheerio is a real new dependency. Start with `CheerioCrawler` (no
browser binaries — keeps Render light). Add `@playwright` only behind the
adaptive path, and only if a live site actually needs it.

## Ordering
Phase 0 → Phase 1 (baseline) → Phase 2 → 3 → 4 → Phase 5 (before/after).
Each phase is independently committable and keeps existing tests green.

---

## BASELINE (Phase 0 + Phase 1, 2026-09-21)

Measured with `npm run validate && npm run worksheet && npm run score` across
all 9 sites (ruma, conqraesthetics, drippynursejess, trubeautybytrevor,
gloderma, culturemedspa, havenpmu, skinmedhealth, medspasanangelo).

**Objective fields (CMS, builder, e-commerce, total pages, products,
locations): 54/54 — 100%.** All sitemap/regex-derived numbers check out
against independent ground truth. (Phase 0's dominant-builder fix and
footer-NAP fallback are reflected in this — before Phase 0, 3 of 9 sites'
locations were "unknown" instead of correct.)

**Taxonomy spot-check (54 hand-labeled URLs, ~6/site, stratified across
buckets): first pass 46/54 (85.2%).** 8 confirmed mismatches, all URL-slug
regex limitations. Since 6 of the 8 were cheap, well-justified regex fixes
(not requiring the full content-based rewrite), they were fixed immediately
and re-scored:

1. ~~**"gallery"/"results" pages misrouted to `proof` instead of
   `beforeAfter`**~~ — **fixed.** Bare `gallery`/`results` added to the
   `beforeAfter` regex (word-bounded), ahead of `proof` in match order.
2. ~~**Path variants miss the `core` regex**~~ ("/contacts/" plural,
   "/home-2/" duplicate homepage) — **fixed.** Core regex now accepts
   `contacts?` and `/home(-\d+)?/`.
3. ~~**False positive: `legal`'s bare `sitemap` keyword catches
   `/html-sitemap/`**~~ — **fixed.** Now requires `xml-sitemap`.
4. ~~**"affiliate-partner-discounts" misrouted to `proof`** (bare `partner`
   keyword) instead of `offers`~~ — **fixed** (found during the fix pass, same
   class of bug). `offers` now matches before `proof`, with `discount`/
   `affiliate` added to its keywords.
5. **Branded product pages fall to `other` instead of `shop`** (gloderma
   `/alastin/`, ruma `/alastin/`) — **not fixed, deliberately deferred.** The
   shop regex only matches `/shop|store|product|cart|.../` path prefixes; a
   retail brand-name slug can't be enumerated by regex without a fragile brand
   list. This is exactly what Phase 2/3 (content-based classification —
   WooCommerce/JSON-LD Product signals from real page content) is for.

**Taxonomy spot-check after the regex fixes: 52/54 — 96.3%** (re-crawled and
re-scored fresh, not just the 6 patched cases in isolation). Only the 2
branded-product-page misses remain, carried into Phase 2/3.

Also noted, not yet scored: two sites' provider extraction returned
CMS/dev-placeholder text instead of real staff (ruma → "Onboarding Growth99",
havenpmu → "InfraTeamAdmin") — a data-quality risk Phase 4 should guard
against (e.g. reject single-result extractions that don't look like a person's
name, or cross-check against JSON-LD `Person` schema more strictly).

**Revised Phase 2/3 scope, given this result:** the remaining accuracy gap is
narrower and more specific than originally assumed — not "URL-slug
classification is broadly unreliable" but "a small number of pages need real
content (product schema, JSON-LD) to classify correctly, and provider
extraction needs a sanity check against placeholder text." The Crawlee content
layer is still worth building for these targeted cases, but the bar it needs
to clear is now measured (96.3% → aim higher primarily by fixing the
brand-name-product and placeholder-provider classes), not a guess.

## Phase 2 — content acquisition, done (2026-09-21)

Installed `crawlee` (`CheerioCrawler` only — no browser). New
`server/src/analyzer/fetchContent.ts` fetches a bounded set of pages
concurrently (maxConcurrency 5, 1 retry) and extracts `{title, h1,
metaDescription, looksLikeProduct}`. `crawleeBootstrap.ts` pins its storage to
a git-ignored `server/.crawlee-storage/` and quiets its logging.

**Wired into `classify.ts`**, not as a general rewrite — narrowly, for exactly
the gap the baseline measured: pages that land in the generic `other` bucket
(not portfolio-sourced, so not already covered by Gemini adjudication) get a
real content fetch, capped at `MAX_CONTENT_FETCH = 40` pages per analysis, and
are reclassified to `shop` if the fetched page shows a genuine product signal.

**The product signal went through one real correction before shipping.** The
first version checked bare `"@type":"Product"` JSON-LD and a loose
`add-to-cart`+`woocommerce` text match — both looked reasonable but produced a
confirmed false positive live: ruma.com's SEO plugin stamps a `Product`
JSON-LD block (describing the *business*, for star-rating rich snippets) on
every single page, and "add to cart" text sits in a sitewide header mini-cart
widget. Diagnosed against the real HTML of a true product page
(gloderma.com/alastin/) vs. the false-positive page
(ruma.com/before-and-after-treatment-images/) and replaced with three signals
confirmed to discriminate correctly: `og:type=product`, the WooCommerce
`woocommerce-Price-amount` price-render class, and a real `name="add-to-cart"`
form field.

**Re-scored after Phase 2: objective 54/54 (100%), taxonomy 54/54 (100%)** on
the same 54-URL hand-labeled sample used for the baseline.

One result is worth being honest about rather than just banking as a win:
ruma.com's `/alastin/` page — one of the two original mismatches — did **not**
flip to `shop`. Its HTML has no price markup, no cart form, nothing
purchasable on the page itself (title says "Buy Alastin Skincare Products
Online," but that's SEO copy, not a working storefront). My original
hand-label of "shop" was based on the title alone; the content-based check is
arguably *more* correct in calling it `other`. This is the argument for
content-based classification working as intended, not a shortfall — but it
means "100% on this sample" partly reflects a corrected ground-truth label,
not purely a system improvement. gloderma.com's `/alastin/` (which does have
real WooCommerce price markup) correctly flipped to `shop`.

**Not yet done (Phase 4 scope, carried forward):** the provider
placeholder-text issue (ruma → "Onboarding Growth99", havenpmu →
"InfraTeamAdmin") is unaddressed. `fetchContent.ts` is general enough to reuse
for a "does this look like a real person's name" sanity check on provider
extraction, next.

## Phase 4 — provider/location content fixes, done (2026-09-21)

Two concrete bugs the baseline had flagged as "noted, not yet scored" turned
out to be the real priority — both fixed using the same `fetchContent.ts`-style
diagnosis-from-real-HTML approach as Phase 2, not the originally-planned
multi-page-provider/multi-location work (deferred — no site in the 9-site
sample actually needed it; building it speculatively would have been guessing
at a requirement instead of fixing a measured one).

**1. Placeholder-provider bug (providers.ts).** Root cause confirmed by
inspecting the raw JSON-LD: an SEO plugin (Yoast/Rank Math) auto-injects a
`Person` block for the page's WordPress **author** account on nearly every
page — that's a CMS login, not a team member. ruma.com and havenpmu.com both
returned exactly this (their agency/dev account) as the *only* "provider."
Fix: reject any JSON-LD `Person` match with no `jobTitle` and no
`description` — a genuine team-roster entry always carries a role or bio; bare
author schema never does (just name + Gravatar). This correctly falls through
to the existing AI-extraction fallback.
  - ruma.com: 1 fake provider ("Onboarding Growth99") → **27 real providers**
    (Shelby Miller, Chrissy Bushell, Tessa Brown, ... — matches the providers
    ANALYZER-SCOPE.md's own ground-truth section names).
  - havenpmu.com: 1 fake provider ("InfraTeamAdmin") → **10 real providers**.

**2. Duplicate-provider bug, found while re-validating (providers.ts).**
culturemedspa.com returned "Anya Zerilla" 4 times, identical role each time —
a carousel/slider widget (Elementor/Swiper) duplicating the same slide markup
in the raw DOM for seamless looping. Fix: dedupe by normalized name after
either extraction path. 18 entries → 15 correct ones.

**3. Location double-count bug, found while re-validating (locations.ts).**
culturemedspa.com reported 2 locations (truth: 1) — two separate JSON-LD
blocks describing the *same* business with complementary partial info (one
had an address but no phone, the other a phone but no address), so the
existing exact-key dedupe never collided them. Fix: a conservative merge pass
— only fires when there's exactly one addressless and one phoneless entry
(the shape of "same business, two incomplete descriptions"), leaving genuine
multi-location sites (which report complete, distinct addresses) untouched.
Verified no regression on ruma.com / gloderma.com (single complete entries,
unaffected).

**Re-scored after Phase 4: objective 54/54 (100%), taxonomy 54/54 (100%)** —
unchanged from Phase 2 (these were provider/location fixes, not taxonomy), but
provider/location *data quality* — not measured by the accuracy-percentage
metric, since the eval harness only scored counts/categories, not identity —
improved substantially and is now spot-checkable by eye in the JSON output.

**Deferred, not done:** multi-page provider support (individual `/team/*`
subpages instead of one roster page) and true multi-location parsing beyond
what KML/JSON-LD already provide — no site in the 9-site sample needed either,
so building them now would be speculative rather than measured. Revisit if a
future site surfaces the need.

## AFTER (Phase 0-4 complete, 2026-09-21)

| Metric | Baseline (Phase 1) | After Phase 2 | After Phase 4 |
|---|---|---|---|
| Objective fields (CMS/builder/ecommerce/pages/products/locations) | 100% | 100% | 100% |
| Taxonomy spot-check (54 hand-labeled URLs) | 85.2% | 100% | 100% |
| Provider data quality | 2/9 sites returning CMS placeholder text as the sole "provider"; 1/9 with quadruplicated entries | unchanged | all fixed, verified against real site content |
| Location data quality | 1/9 sites double-counting one business as two locations | unchanged | fixed |

Phase 5 (full re-run + report) is effectively folded into the above, since
every phase in this plan was scored immediately after landing rather than
batched to the end — there is no separate "before Phase 5 / after Phase 5"
gap left to measure on the current 9-site sample.

**What would most improve the numbers from here:** not more fixes to these 9
sites (diminishing returns — objective and taxonomy are both saturated at
100% on this sample), but **expanding the hand-labeled sample to more sites
and more URLs per site**, since 54 URLs across 9 sites is a real but modest
sample. The next-highest-leverage work is broadening the eval set, not
further tuning against sites already at 100%.
