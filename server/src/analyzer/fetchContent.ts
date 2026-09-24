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
import { CheerioCrawler, RequestQueue } from "crawlee";
import { randomUUID } from "node:crypto";

// Crawlee's default (unnamed) RequestQueue persists request-fingerprint dedup
// state on disk across separate crawler.run() calls within the same process
// — confirmed live: calling this twice in a row for the exact same URL, the
// SECOND call silently returned zero results (the queue considered the URL
// "already handled"). Since this server is long-running and the same site
// can genuinely be re-analyzed within one process's uptime, that would
// silently degrade accuracy on any repeat analysis, not just an edge case.
// Fix: every crawler run gets its own freshly-named, disposed-after-use
// queue, so no state can ever leak between calls.
async function runIsolatedCrawler(
  urls: string[],
  crawlerOptions: ConstructorParameters<typeof CheerioCrawler>[0]
): Promise<void> {
  const queue = await RequestQueue.open(randomUUID());
  try {
    const crawler = new CheerioCrawler({ ...crawlerOptions, requestQueue: queue });
    await crawler.run(urls);
  } finally {
    await queue.drop().catch(() => {});
  }
}

export interface ContentSignals {
  title: string;
  h1: string;
  metaDescription: string;
  looksLikeProduct: boolean;
  looksLikeService?: boolean;
  fetchFailed: boolean;
}

const EMPTY_SIGNALS: Omit<ContentSignals, "fetchFailed"> = {
  title: "",
  h1: "",
  metaDescription: "",
  looksLikeProduct: false,
  looksLikeService: false,
};

/** Fetch content signals for a bounded list of URLs, concurrently, with retries. */
export async function fetchContentSignals(
  urls: string[],
  opts: { maxConcurrency?: number; timeoutSecs?: number } = {}
): Promise<Map<string, ContentSignals>> {
  const results = new Map<string, ContentSignals>();
  if (!urls.length) return results;

  await runIsolatedCrawler(urls, {
    maxConcurrency: opts.maxConcurrency ?? 5,
    requestHandlerTimeoutSecs: opts.timeoutSecs ?? 12,
    maxRequestRetries: 1,
    async requestHandler({ request, $, body }) {
      const html = String(body);
      const looksLikeProduct =
        /property=["']og:type["']\s+content=["']product["']/i.test(html) ||
        /woocommerce-Price-amount/i.test(html) ||
        /name=["']add-to-cart["']/i.test(html) ||
        /class=["'][^"']*sqs-add-to-cart-button[^"']*["']/i.test(html) || // Squarespace
        /name=["']add["'][^>]*>.*add to cart/i.test(html) || // Shopify
        /class=["'][^"']*ProductActionButtons[^"']*["']/i.test(html) || // Wix
        /class=["'][^"']*shopify-payment-button[^"']*["']/i.test(html); // Shopify

      const title = $("title").first().text().trim();
      const h1 = $("h1").first().text().trim();
      const metaDescription = $('meta[name="description"]').attr("content")?.trim() || "";
      const textSample = `${title} ${h1} ${metaDescription}`;
      const looksLikeService =
        !looksLikeProduct &&
        /(botox|dysport|filler|biostimulat|laser|peel|facial|treatment|procedure|inject|microneedl|contour|tightening|skincare|resurfac|rejuvenat|body-treatment)/i.test(textSample);

      results.set(request.url, {
        title,
        h1,
        metaDescription,
        looksLikeProduct,
        looksLikeService,
        fetchFailed: false,
      });
    },
    failedRequestHandler({ request }) {
      results.set(request.url, { ...EMPTY_SIGNALS, fetchFailed: true });
    },
  });

  return results;
}

export interface ImageCandidate {
  src: string;
  alt: string;
  title: string;
  // The Elementor lightbox gallery groups related images with a shared id
  // (confirmed live on ruma.com: aria-label="N of 8" + a shared
  // data-elementor-lightbox-slideshow id across one gallery's images) — a
  // useful case-boundary hint when present, but not universal (gloderma.com's
  // before/after page has none at all).
  lightboxGroup: string | null;
}

// Chrome a page's <header>/<nav>/<footer> commonly repeats site-wide (logos,
// nav icons, social icons) — never the actual gallery content a before/after
// page exists to show. Excluded at the DOM level, not just by filename, since
// a logo file doesn't reliably self-identify by name.
const CHROME_ANCESTOR_SELECTOR = "header, nav, footer";
// Filename/class patterns for chrome that CAN slip outside header/nav/footer
// (e.g. a mobile off-canvas menu duplicate, a floating widget).
const CHROME_NAME_RE = /logo|icon|avatar|sprite|placeholder|spinner|loader|cta|banner|promo/i;

/** Fetch every real content `<img>` on a bounded list of pages, for case-counting a gallery. */
export async function fetchImageCandidates(
  urls: string[],
  opts: { maxConcurrency?: number; timeoutSecs?: number } = {}
): Promise<Map<string, ImageCandidate[]>> {
  const results = new Map<string, ImageCandidate[]>();
  if (!urls.length) return results;

  await runIsolatedCrawler(urls, {
    maxConcurrency: opts.maxConcurrency ?? 5,
    requestHandlerTimeoutSecs: opts.timeoutSecs ?? 15,
    maxRequestRetries: 1,
    async requestHandler({ request, $ }) {
      const candidates: ImageCandidate[] = [];
      const seenSrc = new Set<string>();
      $("img").each((_i, el) => {
        const $el = $(el);
        if ($el.closest(CHROME_ANCESTOR_SELECTOR).length) return; // skip header/nav/footer chrome

        // Lazy-loaded images commonly carry the real URL in data-src rather
        // than src (a 1x1 placeholder sits in src until JS swaps it in).
        const src = $el.attr("src") || $el.attr("data-src") || $el.attr("data-lazy-src") || "";
        if (!src || src.startsWith("data:")) return;
        if (/\.svg(\?|$)/i.test(src)) return; // icons/decorative, never a photo
        if (CHROME_NAME_RE.test(src)) return;

        const alt = $el.attr("alt") || "";
        const title = $el.attr("title") || "";
        if (CHROME_NAME_RE.test(alt) || CHROME_NAME_RE.test(title)) return;

        // A tiny declared size is a tracking pixel or spacer, not a photo.
        const w = parseInt($el.attr("width") || "", 10);
        const h = parseInt($el.attr("height") || "", 10);
        if (w > 0 && w <= 10 && h > 0 && h <= 10) return;

        const lightboxGroup = $el.closest("[data-elementor-lightbox-slideshow]").attr("data-elementor-lightbox-slideshow") || null;
        seenSrc.add(src);
        candidates.push({ src, alt, title, lightboxGroup });
      });

      // Elementor's native Gallery widget (as opposed to the older
      // image-with-lightbox pattern above) renders each photo as an <a> with
      // a CSS background-image on a nested <div> — NOT an <img> tag at all.
      // Confirmed live: trubeautybytrevor.com's before/after gallery is built
      // this way entirely; the <img> pass above found only 2 unrelated
      // images (a logo, twice) and missed the actual gallery completely.
      $("a[data-elementor-lightbox-slideshow]").each((_i, el) => {
        const $el = $(el);
        if ($el.closest(CHROME_ANCESTOR_SELECTOR).length) return;

        const src = $el.attr("href") || "";
        if (!src || seenSrc.has(src)) return; // dedupe against the <img> pass
        if (/\.svg(\?|$)/i.test(src)) return;
        if (CHROME_NAME_RE.test(src)) return;

        const title = $el.attr("data-elementor-lightbox-title") || "";
        // The gallery widget's own aria-label (on the nested background-image
        // div) carries the closest thing to alt text this pattern has —
        // confirmed live: aria-label="women lip filler" on trubeautybytrevor.
        const alt = $el.find("[aria-label]").first().attr("aria-label") || "";
        if (CHROME_NAME_RE.test(alt) || CHROME_NAME_RE.test(title)) return;

        seenSrc.add(src);
        candidates.push({ src, alt, title, lightboxGroup: $el.attr("data-elementor-lightbox-slideshow") || null });
      });

      results.set(request.url, candidates);
    },
    failedRequestHandler({ request }) {
      results.set(request.url, []);
    },
  });

  return results;
}
