// Content acquisition — Phase 2 of ACCURACY-PLAN.md. Fetches real page content
// (not just the URL slug) for the specific pages the URL-based heuristics in
// classify.ts / providers.ts can't confidently place. Uses Crawlee's
// CheerioCrawler for bounded concurrency + automatic retries — no headless
// browser (see ANALYZER-SCOPE.md: this vertical is server-rendered WordPress,
// confirmed across 9 sites in ACCURACY-PLAN.md's recon).
//
// Deliberately narrow: this is not a general "fetch everything" crawler. It's
// called selectively, only on the small set of pages classification is
// unsure about (see classify.ts's use of it), to keep runtime and load on the
// target site bounded.

import "./crawleeBootstrap.js";
import { CheerioCrawler } from "crawlee";

export interface ContentSignals {
  title: string;
  h1: string;
  metaDescription: string;
  // Product-page signals: JSON-LD Product type, og:type=product, or a
  // WooCommerce add-to-cart button — any one of these means "this is a
  // product/store page" regardless of what its URL slug looks like (the
  // "/alastin/" case: a branded skincare-line product page with no "shop"
  // or "product" string anywhere in its path).
  looksLikeProduct: boolean;
  fetchFailed: boolean;
}

const EMPTY_SIGNALS: Omit<ContentSignals, "fetchFailed"> = {
  title: "",
  h1: "",
  metaDescription: "",
  looksLikeProduct: false,
};

/** Fetch content signals for a bounded list of URLs, concurrently, with retries. */
export async function fetchContentSignals(
  urls: string[],
  opts: { maxConcurrency?: number; timeoutSecs?: number } = {}
): Promise<Map<string, ContentSignals>> {
  const results = new Map<string, ContentSignals>();
  if (!urls.length) return results;

  const crawler = new CheerioCrawler({
    maxConcurrency: opts.maxConcurrency ?? 5,
    requestHandlerTimeoutSecs: opts.timeoutSecs ?? 12,
    maxRequestRetries: 1,
    async requestHandler({ request, $, body }) {
      const html = String(body);
      // Deliberately NOT using a bare `"@type":"Product"` JSON-LD check or a
      // generic "add-to-cart"+"woocommerce" text match — both looked reliable
      // in isolation but produced a confirmed false positive live: some SEO
      // plugins stamp a `Product` JSON-LD block on every page (describing the
      // business itself, for star-rating rich snippets), and "add to cart"
      // text appears in a header mini-cart widget site-wide. The signals below
      // were verified against a real product page (gloderma.com/alastin/,
      // true) and the false-positive case (ruma.com's before/after gallery
      // page, false) before being adopted.
      const looksLikeProduct =
        /property=["']og:type["']\s+content=["']product["']/i.test(html) ||
        /woocommerce-Price-amount/i.test(html) ||
        /name=["']add-to-cart["']/i.test(html);
      results.set(request.url, {
        title: $("title").first().text().trim(),
        h1: $("h1").first().text().trim(),
        metaDescription: $('meta[name="description"]').attr("content")?.trim() || "",
        looksLikeProduct,
        fetchFailed: false,
      });
    },
    failedRequestHandler({ request }) {
      results.set(request.url, { ...EMPTY_SIGNALS, fetchFailed: true });
    },
  });

  await crawler.run(urls);
  return results;
}
