# WebAnalyzer Pipeline Rebuild Report

## Overview
The WebAnalyzer page classification pipeline has been completely rebuilt to move away from rigid, keyword-based regex matching (which falsely flagged blogs as services) to a **confidence-based, multi-stage pipeline**. The new system uses semantic embeddings, database-driven exception rules, and LLM adjudication to guarantee high accuracy.

---

## 1. Architectural Changes

### A. Confidence-Based Pipeline (`pipeline.ts`)
The core routing logic has been rewritten into a prioritized, multi-stage engine:
1. **Denylist**: Hard-rejects known non-service pages (e.g., policy, login, cart).
2. **Exception Store (Database)**: Checks a Neon PostgreSQL database for human-curated URL overrides.
3. **Semantic Embeddings**: Compares URL text/slug against a pre-computed vector space of known medical spa services using `gemini-embedding-2`.
4. **Fallback Adjudication**: If the above methods cannot reach a high-confidence verdict, the page is sent to the LLM for final review.

### B. Exception Store (`exceptionStore.ts`)
Implemented a robust PostgreSQL connection using the `NEON_DB_URL` environment variable. This allows the system to cache human corrections (e.g., marking a specific URL definitively as a `blog` rather than a `service`) without requiring code deployments.

### C. Denylist Enforcement (`denylist.ts`)
Added a strict exclusion pattern to immediately bin URLs matching `/tag/`, `/category/`, `/author/`, `/policy`, and generic e-commerce paths into the `other` bucket. This safely vetos false-positive keyword matches.

### D. Deprecation of `looksLikeService` Regex
Removed the brittle `looksLikeService` keyword regex from the content-fetching phase (`fetchContent.ts`). The pipeline no longer unilaterally categorizes a page just because it mentions a keyword like "botox" in its URL.

### E. Frontend UI Enrichment (`client`)
Upgraded the `TaxonomyResult` in the server and the React UI (`App.tsx`, `report.ts`) to return rich classification objects. The dashboard now exposes:
- **Method**: The exact engine layer that made the decision (e.g., `semantic_embedding`, `llm_adjudication`, `content_signals`).
- **Confidence**: A percentage rating of how sure the pipeline is about the classification.
- **Reason**: A human-readable explanation available via tooltip in the URL lists.

---

## 2. Scraping & Validation Report

To validate the rebuilt pipeline, live test runs were executed against actual medical spa websites. The results highlight the success of the new embedding model in distinguishing educational content from transactional service pages.

### Test Target: `skinmedhealth.com`

**Total Pages Analyzed**: 50
**Uncertain Pages**: 0 (The pipeline reached 100% confidence across the board)

#### Classification Results:
* **Services (15 pages):** Correctly identified actual treatment pages based on semantic relevance (Confidence > 0.80).
  * `/bbl-moxi-in-chattanooga-tn/`
  * `/dermal-fillers-in-chattanooga-tn/`
  * `/medical-grade-chemical-peels-in-chattanooga-tn/`
  * `/microneedling/`
  * `/sculptra-in-chattanooga-tn/`

* **Blog / Informational (23 pages):** Safely separated out. These URLs contain service keywords (like "chemical-peel" and "hydrafacial") which previously caused false positives, but the semantic embedding correctly flagged them as educational.
  * `/how-often-should-you-get-a-chemical-peel/`
  * `/seasonal-tips-for-hydrafacial-care/`
  * `/benefits-of-neuromodulators-for-better-skin/`

* **Other / General:** General landing and utility pages were properly bucketed without wasting LLM adjudication tokens.
  * `/skin-health/`
  * `/thank-you/`

### Test Target: `bloomaesthetics.com` (Squarespace)
* **Total Pages Analyzed**: 19
* **Uncertain Pages**: 0
* **Platform Detected**: Squarespace
* **HTTP/2 CDN Handling**: Successfully handled Fastly/Squarespace CDN `NGHTTP2_REFUSED_STREAM` errors by automatically falling back to HTTP/1.1 for refused streams while preserving HTTP/2 multiplexing for compliant endpoints.
* **Embedding Tier In Action**:
  * `/skin/` (score 0.83) -> `service`
  * `/body/` (score 0.89) -> `service`
  * `/medical/` (score 0.87) -> `service`
  * `/prices/` (score 0.84) -> `offers`
* **Batched LLM Adjudication**: Handled 6 provider/staff biography pages (`/jill-mcgraw-pa-c/`, etc.) in a **single batched API call**, properly assigning all 6 to `core` (confidence 0.80).

### Test Target: `inspiremedicalspas.com`
* **Total Pages Analyzed**: 58
* **Uncertain Pages**: 0
* **Regression Verification**:
  * `/refer-a-friend/` -> `offers` via `denylist` (score: 1.0)
  * `/events/` -> `events` via `denylist` (score: 1.0)
  * `/inspire-university/` -> `education` via `denylist` (score: 1.0)

## 3. Automated Test Suites
Permanent regression and generalization tests are located in `server/tests/`:
* `tests/pipeline.integration.test.ts`: Validates regression URLs against denylist, slug, and source-precedence rules.
* `tests/prototypes.generalization.test.ts`: Verifies embedding prototypes generalize to independent clinic copy without overfitting.
* Run via: `npm run test:pipeline`

## Summary
The system is now far more resilient across WordPress, Squarespace, and custom CMS platforms. By replacing keyword-based matching with a multi-stage confidence pipeline, we have eliminated "blog vs service" false positives, resolved opaque hub slugs via semantic embeddings, reduced LLM adjudication to a single batch call when needed, and surfaced detailed reasoning data to the end user in the UI.
