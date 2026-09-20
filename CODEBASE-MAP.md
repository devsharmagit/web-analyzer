# Codebase map — what we inherited, and what the analyzer can reuse

The repo is `g99-website-build-tool`: a **website *generation*** pipeline
(onboarding → Gemini/Stitch generate → WordPress theme → GitHub PR → feedback loop).
That is a different product from the analyzer. This file records which parts are
actually useful to us, and which are noise.

## Shape of the repo

| Path | Lines | What it is | Use to us |
|---|---|---|---|
| `server.js` | 20,178 | Monolithic `http.createServer` app: routes, jobs, AI calls, WP export, everything | **Mine it** — 3 specific regions |
| `lib/webgen/` | ~1,500 | Scrape a site → Gemini "BrandKit" → render a generated site | `scrape.js` yes, rest no |
| `lib/designgen/`, `lib/gitops/`, `lib/feedback/`, `lib/history/` | ~4,000 | Generation, PRs to WordPress, visual feedback loop, run history | **Not relevant** |
| `public/` | ~30 files | Vanilla-JS dashboard (no framework, no build step) | Pattern to copy for our UI |
| `test-*.js` | ~150KB | Bespoke `node test-x.js` scripts, no runner | Pattern to copy |
| `image-pool/`, `reference_sites/ruma-auto.html` | — | Scraped assets from med-spa sites, **ruma included** | Fixtures |

No framework, no TypeScript, no test runner, no linter. Deps are only
`cheerio`, `jimp`, `pg`, `playwright`, `sharp`. Deploy is Render (`render.yaml`).

## The three parts worth keeping

### 1. `crawlSiteInventory()` — server.js:3474 — **the backbone**

Already does exactly what the analyzer needs for page discovery:

- Tries `/sitemap.xml`, `/wp-sitemap.xml`, `/sitemap_index.xml`, follows child sitemaps
- Falls back to homepage `href` scraping when a site has no sitemap
- Keeps **which child sitemap each URL came from** (`post`, `page`, `product`,
  `portfolio`, `video`) — this is the single most valuable idea in the file.
  The source is what separates a blog post from a service page when both have
  "botox" in the URL
- Same-origin filter, asset-extension filter, path dedupe

Returns `{ origin, discoveredVia, sitemaps, total, pages: [{ path, source, section, scope, title }] }`.

### 2. `SECTIONS` + `classifyPage()` — server.js:3423–3466 — **~60% of our taxonomy**

A regex ruleset mapping a path to one of: `core`, `locations`, `forms`, `care`,
`treatments`, `proof`, `offers`, `shop`, `blog`, `legal`, `careers`, `other`.
The comments record real bugs already fixed (blog posts matching treatment
keywords; 200+ posts matching a state code; ruma's services living in a
`portfolio` post type). **Do not rewrite this from scratch — those comments are
paid-for knowledge.**

Gaps for us are listed in [ANALYZER-SCOPE.md](ANALYZER-SCOPE.md).

### 3. `scrapeLite()` / `scrape()` — lib/webgen/scrape.js

- `scrapeLite(url)`: plain `fetch` + regex, ~2–4s, no browser. Pulls images
  (largest `srcset`), alt text, title, lazy-load attrs.
- `scrape(url)`: full Playwright — palette, fonts, computed styles, auto-scroll
  for lazy images, screenshot. ~12s.
- **Playwright is lazily `require`d** and throws a catchable error when absent,
  so `scrapeLite` is the safe default. Keep that discipline.

### Supporting bits

- `geminiCall(parts, opts)` — server.js:282. Rotates across `GEMINI_KEYS` **and**
  a model fallback chain, with an abort timeout. This is a hardened helper; the
  comment above it documents four distinct failure modes it survives. Reuse as-is
  for any AI extraction (provider bios, page-type judgement calls).
- `GET /api/site-inventory` — server.js:18294. Existing route. **Its demo mode
  already defaults to `https://ruma.com`.**
- `public/coverage.{html,js}` — a working table UI over the inventory. Closest
  thing to an analyzer report that already exists.

## What to ignore

`buildCoverage()`, `buildPagePlan()`, `SECTION_BUILD`, `betaSlugFor()`, the
queue/`.g99/site.json` manifest, everything Stitch/PR/feedback related. Those
answer "what should we rebuild for this client" — a build-pipeline question.
We answer "what does this site *have*", which stops at the inventory.
