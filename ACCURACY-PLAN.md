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

## BASELINE (filled in at end of Phase 1)
_TBD_

## AFTER (filled in at end of Phase 5)
_TBD_
