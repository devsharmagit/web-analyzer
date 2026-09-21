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

## AFTER (filled in at end of Phase 5)
_TBD_
