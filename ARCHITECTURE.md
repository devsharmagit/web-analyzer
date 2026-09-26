# WebAnalyzer — System Architecture & Analysis Strategy

This document serves as the authoritative context and architectural blueprint for **WebAnalyzer**. It details the end-to-end strategies, algorithms, heuristics, and multi-layered fallbacks used to analyze websites (with specialized clinical optimizations for the medical spa / aesthetic clinic vertical).

---

## Table of Contents
1. [Overview & Objective](#overview--objective)
2. [System Architecture Overview](#system-architecture-overview)
3. [Phase 1: Multi-Source Crawling & Page Discovery](#phase-1-multi-source-crawling--page-discovery)
4. [Phase 2: Page Taxonomy & Classification Engine](#phase-2-page-taxonomy--classification-engine)
5. [Phase 3: Platform & E-Commerce Detection](#phase-3-platform--e-commerce-detection)
6. [Phase 4: Medical Staff & Physical Footprint Extraction](#phase-4-medical-staff--physical-footprint-extraction)
7. [Phase 5: Clinical Before & After Photo Gallery Analysis](#phase-5-clinical-before--after-photo-gallery-analysis)
8. [Phase 6: Performance, Timeouts & Fault Tolerance](#phase-6-performance-timeouts--fault-tolerance)
9. [Phase 7: Frontend Dashboard & PDF Report Generation](#phase-7-frontend-dashboard--pdf-report-generation)

---

## Overview & Objective

WebAnalyzer accepts any website URL and produces a comprehensive intelligence audit without requiring headless browser overhead. It answers critical sales and technical questions:
- What CMS and page builder power the site?
- How many total pages exist, categorized into clinical services, conditions, blogs, location pages, forms, and legal policy?
- Is there a native e-commerce store, or is product fulfillment outsourced to third-party partner portals (e.g. SkinBetter Science, Colorescience, MyAestheticRecord)?
- Who are the medical providers (doctors, nurses, aestheticians) and what are the physical clinic addresses?
- Does the clinic showcase before-and-after patient results?

---

## System Architecture Overview

```
                                 [ User Request: URL ]
                                           │
                                           ▼
                                ┌─────────────────────┐
                                │   Phase 1: Crawl    │
                                │  (Sitemaps, HTML,   │
                                │  Nav Menus, REST)   │
                                └──────────┬──────────┘
                                           │
         ┌─────────────────────────────────┼─────────────────────────────────┐
         ▼                                 ▼                                 ▼
┌──────────────────┐             ┌──────────────────┐             ┌──────────────────┐
│  Phase 2: Page   │             │ Phase 3: Platform│             │ Phase 4: Staff   │
│     Taxonomy     │             │    & E-Commerce  │             │   & Locations    │
└────────┬─────────┘             └────────┬─────────┘             └────────┬─────────┘
         │                                │                                │
         ▼                                │                                │
┌──────────────────┐                      │                                │
│ Phase 5: Before/ │                      │                                │
│   After Gallery  │                      │                                │
└────────┬─────────┘                      │                                │
         └────────────────────────────────┼────────────────────────────────┘
                                          │
                                          ▼
                               ┌──────────────────────┐
                               │  Phase 6: Synthesis  │
                               │   & Express API      │
                               └──────────┬───────────┘
                                          │
                                          ▼
                               ┌──────────────────────┐
                               │ Phase 7: UI & PDF    │
                               │   Report Generator   │
                               └──────────────────────┘
```

---

## Phase 1: Multi-Source Crawling & Page Discovery

Located in `server/src/analyzer/crawl.ts`.

### 1. Sitemap Discovery
- Tests candidates in order: `/sitemap.xml`, `/wp-sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`.
- Supports nested sitemaps (up to 25 child sitemaps).
- Extracts sitemap source hints (e.g., `portfolio-sitemap.xml` $\rightarrow$ `source: "portfolio"`, `post-sitemap.xml` $\rightarrow$ `source: "post"`).

### 2. Homepage HTML & DOM Navigation Hierarchy Parsing
- **Regex Extraction**: Collects all `<a href="...">` links from homepage HTML.
- **`extractNavCategories`**: Parses `<nav>`, `<header>`, and menu blocks (`menu-item-has-children`, `.dropdown`):
  - **Services / Treatments** (`Services`, `Treatments`, `Procedures`, `Solutions`) $\rightarrow$ tags nested URLs with `navCategory: "service"` and assigns `portfolio` source rank.
  - **Offers & Financing** (`Payment Plans`, `Financing`, `Specials`, `Cherry`) $\rightarrow$ tags nested URLs with `navCategory: "offers"`.
  - **Forms & Quizzes** (`Self Assessment`, `Quiz`, `Consultation`, `Booking`) $\rightarrow$ tags links/CTAs with `navCategory: "forms"`.
  - **Custom Post Type CSS Classes**: Detects WordPress classes like `menu-item-object-*-portfolio` or `menu-item-object-service` directly on `<li>` tags.

### 3. Store Category Supplement
- Identifies the `/shop/` or `/store/` page and extracts product categories (`/product-category/`).

### 4. Blog Hub & WordPress REST API Supplement
- Detects blog hubs (`/blogs/`, `/blog/`, `/news/`, `/articles/`).
- Extracts post URLs from `<article>` elements and post cards (`.elementor-post`, `.blog-card`).
- **WP REST API Fallback**: Queries `/wp-json/wp/v2/posts?per_page=100` for WordPress sites to ensure 100% post discovery even when sitemaps are missing.

### 5. Source Ranking & Deduplication
Every URL path is normalized (collapsing multiple slashes and canonicalizing trailing slashes) and assigned an authoritative winning source via `SOURCE_RANK`:
1. `page` (100) — explicit CMS page
2. `portfolio` (90) — custom post type (service pages)
3. `product` (80)
4. `product_cat` (70)
5. `post` (60) — blog post
6. `local` (50)
7. `video` / `attachment` / `image` (5–10) — excluded from headline page counts via `NON_PAGE_SOURCES`.

### 6. URL Exclusion Filters
URLs are dropped at ingestion time (inside the `add()` function) if they match any of the following patterns. This prevents infrastructure / archive URLs from inflating page counts:

| Filter | Pattern | Reason |
|---|---|---|
| `ASSET_RE` | `.jpg`, `.pdf`, `.js`, `.css`, etc. | Binary/static assets |
| `NON_PAGE_PATH_RE` | `/wp-json/`, `/wp-login.php`, `/feed/` | WordPress API/admin/RSS |
| `DATE_ARCHIVE_PATH_RE` | `/YYYY/`, `/YYYY/MM/`, `/YYYY/MM/DD/` | WordPress date archive pages that redirect to homepage |

> **Why date archives are filtered**: Paths like `ruma.com/2025/10/28/` are WordPress date-based archive/index pages — not real posts. Many sites redirect them to the homepage, bloating blog counts. Real posts with date-based WordPress permalinks (e.g. `/2025/10/28/my-post-slug/`) are **not** filtered because they have a 5th path segment.

---

## Phase 2: Page Taxonomy & Classification Engine

Located in `server/src/analyzer/classify.ts` and `server/src/analyzer/fetchContent.ts`.

### Taxonomy Buckets
- `core`: Homepage, About, Team, Contact, Services/Treatments hub pages, and provider bio pages.
- `service`: Specific clinical treatment pages (Botox, Sculptra, biostimulators, neurotoxins, dermal fillers, skin rejuvenation, Venus Versa, TriBella, microneedling, laser hair removal, body contouring, etc.).
- `condition`: Diagnosis / symptom pages (melasma, rosacea, acne scarring, hyperpigmentation, volume loss, wrinkles).
- `beforeAfter`: Clinical results galleries (`/gallery/`, `/results/`, `/before-and-after/`).
- `offers`: Financing, payment plans (Cherry, CareCredit, PatientFi), specials, memberships, pricing pages.
- `forms`: Self-assessment quizzes, virtual consults, booking forms.
- `care`: Pre & post care instructions.
- `locations`: Location landing pages ("med-spa in [City]").
- `proof`: Testimonials and reviews.
- `education`: Training academies, injector courses, masterclasses, provider university pages.
- `events`: Upcoming events, open houses, event calendars.
- `shop`: Store and product pages.
- `blog`: Individual editorial blog posts and articles.
- `legal`: Privacy policy, terms, HIPAA.
- `other` / `uncertain`: Ambiguous remainder.

### 5-Tier Classification Engine (`pipeline.ts`)
The legacy regex-only bucketing has been replaced with a prioritized, multi-stage confidence engine:

```
                    [ Discovered Page ]
                             │
                             ▼
              [ Tier 1: Exception Store ]
              (Database administrative overrides)
                             │ miss
                             ▼
            [ Tier 2: Slug / Source Precedence ]
            (Sitemap source tags & unambiguous slugs)
                             │ miss / "other"
                             ▼
                 [ Tier 3: Denylist ]
                 (Word-bounded veto patterns: events, edu, referrals)
                             │ miss
                             ▼
            [ Tier 4: Semantic Embeddings ]
            (Prototype vector cosine similarity > 0.82)
                             │ similarity <= 0.82
                             ▼
           [ Tier 5: Batched LLM Adjudication ]
           (Single-batch Gemini adjudication for ambiguous remainder)
```

1. **Tier 1: Exception Store (`exceptionStore.ts`)**: Checks a PostgreSQL database for human-curated URL overrides (e.g. forcing a specific URL to `blog` instead of `service`). Returns `method: "exception"`.
2. **Tier 2: Slug & Source Precedence (`classify.ts` `SECTIONS`)**: Evaluates authoritative CMS sitemap metadata (`source: "post"`, `source: "product"`) and unambiguous single-segment structural slugs (`/about/`, `/contact/`, `/cart/`). Returns `method: "slug"`.
3. **Tier 3: Word-Bounded Denylist (`denylist.ts`)**: Applies strict `\b...\b` word-bounded regex rules to catch non-service structural patterns (e.g. `/refer-a-friend/`, `/events/`, `/inspire-university/`) without falsely flagging legitimate clinical procedures (e.g. preventing wrinkles, expression lines, classic facials). Returns `method: "denylist"`.
4. **Tier 4: Semantic Embeddings (`pipeline.ts` + `prototypes.ts`)**: Content signals (`title`, `h1`, `h2` subheadings, `metaDescription`) fetched via CheerioCrawler (with automatic HTTP/1.1 fallback for HTTP/2 refused streams) are embedded via `gemini-embedding-2` and compared against a pre-computed vector space of prototype categories. Matches with cosine similarity $> 0.82$ resolve immediately. Returns `method: "embedding"`.
5. **Tier 5: Batched LLM Adjudication (`classify.ts` `adjudicateUncertain`)**: Ambiguous pages falling below the embedding threshold (e.g. staff bio pages) are batched into a single multi-line prompt to Gemini in **one single API call** up to 200 URLs. Returns `method: "llm_adjudication"`.

### Classification Result Schema
All classification decisions throughout the pipeline adhere to the standardized schema:
```ts
export interface ClassificationResult {
  category: SectionKey;
  confidence: number;
  method: "slug" | "exception" | "denylist" | "embedding" | "llm" | "unresolved";
  reason: string;
}
```
Exposed to the UI and reporting layers as:
```ts
export interface ClassifiedUrl {
  url: string;
  confidence?: number;
  method?: string;
  reason?: string;
}
```

---

## Phase 3: Platform & E-Commerce Detection

Located in `server/src/analyzer/platform.ts`.

### 1. CMS & Page Builder Detection
- **CMS**: WordPress, Elementor, Squarespace, Shopify, Wix, Webflow.
- **Builders**: Elementor, Divi, Astra, WPBakery, Beaver Builder, Gutenberg.
- Evaluates HTML generator tags, `wp-content/themes`, script signatures, and DOM wrappers with confidence scoring (`high`, `medium`, `low`).

### 2. E-Commerce Architecture & Third-Party Store Detection
- **Native E-Commerce**: WooCommerce, Shopify, BigCommerce.
- **Third-Party Partner Portals**: Detects outbound affiliate links and partner integrations on `/shop` or skincare pages via `THIRD_PARTY_STORE_PATTERNS`:
  - Skincare & Med-Spa Portals: *SkinBetter Science*, *Colorescience*, *Alastin Skincare*, *Revision Skincare*, *ZO Skin Health*, *SkinMedica*, *DefenAge*, *Epionce*, *MyAestheticRecord*, *RepeatMD*.
  - Patient Financing Portals: *Cherry Financing*, *CareCredit*, *PatientFi*, *Alphaeon*.
- Flags `isThirdParty: true`, lists detected partner portals, and generates an explanatory note when products are fulfilled externally rather than via a native cart.

#### Product & Category Derivation (`detectStore` & `fetchStoreProducts`)
- **Single-Page Curated Storefronts**:
  - `productCount`: Extracted from the customer-visible storefront HTML (`/shop/`) and canonicalized by base slug via `canonicalizeProductSlug`, stripping size, volume, weight, pack, count, and denomination suffixes (e.g. multiple gift card values collapse into 1 product).
  - `categoryCount`: Genuinely derived from the distinct set of real category names attached to the visible/collapsed product list using the WooCommerce Store API (`/wp-json/wc/store/v1/products`) or WP REST API (`/wp-json/wp/v2/product`). Orphaned products or unlinked categories in the CMS backend are excluded.
- **Multi-Page Catalogs & Pagination Fallback Tradeoff**:
  - When pagination (`/page/2/`, `woocommerce-pagination`) or category archives (`/product-category/`) are detected on `/shop/`, reading page 1 alone would undercount the catalog. In this case, `detectStore` falls back to the full discovered catalog across XML sitemaps (`product-sitemap.xml`) and raw API counts (`counts.product`, `apiProducts`).
  - **Known & Accepted Limitation**: For paginated stores, the fallback reverts to sitemap and raw API counts, which can re-include orphaned, unlinked, or legacy products that remain published in the WordPress database but are no longer surfaced in customer-facing storefront navigation. This is an intentional architectural trade-off to ensure large, genuine multi-page catalogs (e.g., 50+ items) are not artificially truncated to page 1's count.

---

## Phase 4: Medical Staff & Physical Footprint Extraction

Located in `server/src/analyzer/providers.ts` and `server/src/analyzer/locations.ts`.

### 1. Provider & Staff Extraction (`detectProviders`)
- Targets `/about`, `/team`, `/our-team`, `/staff`, `/providers`, `/meet-the-team`.
- Extracts provider names, medical credentials (MD, DO, NP, FNP-C, PA-C, RN, LE), and roles.

### 2. Location & Contact Directory (`detectLocations`)
- Targets `/contact`, `/contact-us`, `/locations`, and footer HTML.
- Extracts physical street addresses, city/state/zip, phone numbers, and location names.

---

## Phase 5: Clinical Before & After Photo Gallery Analysis

Located in `server/src/analyzer/beforeAfter.ts`.

- Inspects identified `beforeAfter` gallery pages.
- Filters out site-wide chrome (logos, icons, nav images).
- Identifies patient case pairs, computes photo counts, and groups URLs by procedure based on URL slug patterns.

---

## Phase 6: Performance, Timeouts & Fault Tolerance

Located in `server/src/index.ts` and `server/src/analyzer/index.ts`.

- **Socket Timeout**: Express HTTP server socket and keep-alive timeouts are set to **180,000 ms (180s)** to accommodate slow sites.
- **Phase Timeouts**: Each analyzer phase runs asynchronously wrapped in `withTimeout`:
  - Taxonomy: 90s
  - Before/After Gallery: 60s
  - Providers: 45s
  - Locations: 45s
  - Platform / Shop: 30s
- **Internal Safety Nets (`withInternalTimeout`)**: Slow steps inside taxonomy (AI adjudication, Crawlee content fetch) have internal 35s timeouts so a timeout in content fetch degrades gracefully to "skip enrichment" without wiping out the regex classification.
- **Multi-Tier Resilient Fetching & ScraperAPI Fallback (`fetchWithFallback.ts`)**:
  - **Tier 1 (Direct Fetch)**: Tried first for all requests (sitemaps, homepage, content signals, providers, locations). Fast, free, and consumes 0 API credits.
  - **Tier 2 (ScraperAPI Plain Fallback)**: Automatically triggered when direct fetch encounters a WAF/bot-protection block (HTTP 401, 403, 429, 503) or connection drop (timeouts, connection resets, refused HTTP/2 streams). Bypasses CDN bot challenges at **1 credit per request**.
  - **Non-Recoverable Error Bypasses**: Errors indicating non-existent domains or closed ports (`ENOTFOUND`, `ECONNREFUSED`, `ERR_INVALID_URL`) or standard 404 client errors explicitly bypass ScraperAPI to prevent wasting paid credits on dead endpoints.
  - **Credit Economics & Tradeoffs**: ScraperAPI free tier operates on a strict budget of 1,000 credits/month. Plain requests cost 1 credit, whereas JS rendering (`render=true`) carries a 10x penalty (10 credits/req). By reserving ScraperAPI strictly as a secondary fallback for blocked requests and defaulting to plain mode, credit consumption is minimized (0 credits for unprotected sites like `skinmedhealth.com` and `inspiremedicalspas.com`).
  - **WAF Warning Transparency**: If ScraperAPI resolves a blocked request, the crawl continues transparently without alarming the user. An actionable "site blocked by WAF" warning is surfaced only if all tiers fail.

---

## Phase 7: Frontend Dashboard & PDF Report Generation

Located in `client/src/App.tsx`, `client/src/summarize.ts`, and `client/src/report.ts`.

- **Dashboard UI**: Built with React, Vite, Tailwind CSS, and Phosphor Icons.
- **Executive Synopsis**: Concise one-line summary formatted via `oneLineSummary()`.
- **Single-Click PDF Export**: Uses `html2pdf.js` to convert `generateReportHtml()` into a downloadable `.pdf` document without triggering print dialogs or creating blank off-screen canvas issues.

---

## File Structure Reference

```
web-analyzer/
├── ARCHITECTURE.md            # This document (Architecture & Strategy)
├── README.md                  # Project overview & quickstart
├── server/
│   ├── src/
│   │   ├── index.ts           # Express server & socket timeout config
│   │   └── analyzer/
│   │       ├── index.ts       # Orchestrator (concurrent phases & timeouts)
│   │       ├── crawl.ts       # Phase 1: Sitemap, nav hierarchy, blog & shop crawl
│   │       ├── classify.ts    # Phase 2: Page taxonomy classification & AI adjudication
│   │       ├── classification/
│   │       │   ├── pipeline.ts       # 5-Tier classification pipeline orchestrator
│   │       │   ├── exceptionStore.ts # Tier 1: Neon DB human-curated overrides
│   │       │   ├── denylist.ts       # Tier 3: Word-bounded non-service pattern matcher
│   │       │   └── prototypes.ts     # Tier 4: Clinical semantic prototype vector definitions
│   │       ├── fetchWithFallback.ts # Multi-tier resilient fetch with ScraperAPI fallback
│   │       ├── fetchContent.ts# Content signal & image crawler (Crawlee with HTTP/1.1 fallback)
│   │       ├── gemini.ts      # Vector embeddings & Gemini LLM call wrapper
│   │       ├── platform.ts    # Phase 3: CMS, builder & third-party store detection
│   │       ├── providers.ts   # Phase 4: Provider & medical staff extraction
│   │       ├── locations.ts   # Phase 4: Physical location & contact extraction
│   │       └── beforeAfter.ts # Phase 5: Before & after gallery analysis
│   └── tests/
│       ├── pipeline.integration.test.ts      # Permanent regression integration tests
│       └── prototypes.generalization.test.ts # Prototype cross-clinic generalization tests
└── client/
    ├── src/
    │   ├── App.tsx            # Main dashboard UI
    │   ├── api.ts             # API client & TypeScript interfaces
    │   ├── summarize.ts       # Executive summary string formatter
    │   └── report.ts          # PDF report HTML generator
```
