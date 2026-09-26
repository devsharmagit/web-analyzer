// Page taxonomy — Phase 3. Answers Q3 (service pages), Q4 (condition pages),
// Q5 (before/after pages). Ported from reference/server.js:3423 `SECTIONS` +
// `classifyPage()`, keeping the original comments (paid-for bug knowledge),
// extended with: portfolio-as-service, a split-out beforeAfter type, a new
// condition type + vocabulary, and an `uncertain` bucket for AI adjudication.

import { geminiAvailable, geminiCall } from "./gemini.js";
import { fetchContentSignals } from "./fetchContent.js";
import type { AnalyzedPage } from "./crawl.js";

// Bound how many "other"-bucket pages get a real content fetch per analysis —
// keeps runtime and load on the target site predictable even on a large site.
const MAX_CONTENT_FETCH = 40;

export type SectionKey =
  | "core" | "locations" | "forms" | "care" | "service" | "condition"
  | "beforeAfter" | "proof" | "offers" | "shop" | "blog" | "legal"
  | "careers" | "media" | "other" | "uncertain" | "events" | "education";

interface Section {
  key: SectionKey;
  label: string;
  scope: "required" | "recommended" | "optional" | "out-of-scope" | "review";
  test?: (path: string, source: string) => boolean;
}

const SECTIONS: Section[] = [
  // "/home-2/", "/contacts/" (plural) etc. confirmed live: WordPress sites
  // routinely have a duplicate/staging homepage ("home-2") or a slug variant
  // of "contact" that a strict allowlist misses entirely.
  // "injectables"/"skincare"/"wellness" are common top-nav hub/category
  // landing pages in this vertical (confirmed live: lunamedspawi.com links
  // all three from its homepage nav) — the same structural role as the
  // already-listed "services"/"treatments", just different label words a
  // clinic chose. Exact single-segment match only (^...$), so this never
  // catches "wellness" appearing inside a blog post slug elsewhere.
  { key: "core", label: "Core pages", scope: "required",
    test: (p) =>
      p === "/" ||
      /^\/home(-\d+)?\/?$/.test(p) ||
      /^\/(about|about-us|team|our-team|staff|providers|contacts?|contact-us|services|treatments|menu|injectables|skincare|wellness)\/?$/.test(p) },
  // Must be a real location landing page ("medical spa near X"), not merely a URL
  // that happens to end in a state code — that matched 200+ blog posts.
  { key: "locations", label: "Location / local SEO", scope: "recommended",
    test: (p) => /(medical|med)[- ]?spa[a-z-]*-(near|in)-[a-z-]+/.test(p) || /^\/our-[a-z-]+-location\/?$/.test(p) },
  // Forms and care sheets are tested BEFORE services: a "hormone health quiz" is
  // a lead form, not a service page, and must not be counted as one to rebuild.
  { key: "forms", label: "Forms & quizzes", scope: "optional",
    test: (p) => /(quiz|form|inquiry|consult|appointment|booking|book-|assessment|self-assessment|treatment-finder)/i.test(p) },
  { key: "care", label: "Pre / post care", scope: "optional",
    test: (p) => /(pre-and-post|pre-post|aftercare|post-care|instruction)/i.test(p) },
  // Before/after split out of the old "proof" bucket — a gallery of results
  // photos is a distinct, countable page type (Q5), not folded into reviews.
  // Bare "gallery" / "results" are included (not just the compound phrases)
  // because in this vertical a standalone /gallery/ or /results/ page is
  // overwhelmingly a before/after gallery, not a generic photo gallery —
  // confirmed against real sites (conqraesthetics /gallery/, drippynursejess
  // /results/ were both misrouted to "proof" before this widened match).
  { key: "beforeAfter", label: "Before & after", scope: "recommended",
    test: (p) => /(before-and-after|before-after|b-a-gallery|results-gallery|\bgallery\b|\bresults\b|\bphotos?\b)/i.test(p) },
  // Condition vocabulary: what the patient HAS, not what the clinic DOES.
  // Checked before "service" below so condition words win when a URL is
  // otherwise ambiguous, but see the location-suffix guard in classifyPage —
  // "morpheus8-face-body-scar-near-draper-ut" must stay a service page.
  { key: "condition", label: "Condition pages", scope: "recommended",
    test: (p) =>
      /^\/conditions?\//i.test(p) ||
      /(melasma|rosacea|acne-scar|hyperpigmentation|hair-loss|sun-damage|volume-loss|hyperhidrosis|cellulite|stretch-marks|dark-spots|fine-lines|wrinkles|double-chin|sagging-skin|uneven-skin-tone|enlarged-pores)/i.test(p) },
  { key: "service", label: "Treatment / service pages", scope: "required",
    test: (p) => /(botox|dysport|filler|sculptra|biostimulat|radiesse|dermal-filler|neurotox|jeuveau|xeomin|daxxify|microneedl|skinpen|vivace|potenza|secret-rf|pixel8|opus|morpheus|laser|ipl|photofacial|photo-facial|bbl|moxi|halo|co2|resurfac|rejuvenat|tribella|venus[- ]?(versa|viva|bliss|legacy|freeze)?|versa-pro|peel|chemical-peel|facial|glowtox|hydrafacial|diamondglow|dermaplan|microderm|inject|infusion|iv-|hormone|hrt|weight-loss|semaglutide|tirzepatide|prp|prf|plasma|thread|skincare|coolsculpt|kybella|miradry|thermoclear|red-light|tox|lash|brow|wax|hair-removal|skin-tightening|body-contour|cellulite|contour|body-treatment|treatment(s)?-in-)/i.test(p) },
  // Offers is tested BEFORE proof: "affiliate-partner-discounts" is a discount
  // program, not a trust/affiliation page, but proof's bare "partner" keyword
  // used to win first — confirmed live on ruma.com.
  { key: "offers", label: "Offers, memberships & financing", scope: "recommended",
    test: (p) => /(special|offer|promo|vip|membership|payment-plan|payment|financ|cherry|carecredit|patientfi|alphaeon|gift|package|bank|discount|affiliate)/i.test(p) },
  { key: "proof", label: "Proof & trust", scope: "recommended",
    test: (p) => /(review|testimonial|gallery|results|partner)/i.test(p) },
  { key: "shop", label: "Store & products", scope: "out-of-scope",
    test: (p, src) => src === "product" || /^\/(shop|store|product|cart|checkout|my-account)/i.test(p) },
  { key: "blog", label: "Blog & articles", scope: "out-of-scope",
    test: (p, src) => src === "post" || /^\/(blog|blogs|news|article)/i.test(p) },
  // "sitemap" used to be a bare keyword here and wrongly caught a marketing
  // "/html-sitemap/" page (a site-navigation index, not a legal document) —
  // confirmed live on conqraesthetics. Require "xml-sitemap" specifically.
  { key: "legal", label: "Legal & policy", scope: "out-of-scope",
    test: (p) => /(privacy|terms|policy|policies|accessibility|hipaa|disclaimer|xml-sitemap)/i.test(p) },
  { key: "careers", label: "Careers", scope: "out-of-scope",
    test: (p) => /(career|job|employment|hiring)/i.test(p) },
];

export function classifyPage(pathname: string, source: string, navCategory?: string): Section {
  // The sitemap a URL came from is authoritative about WHAT it is, so content type
  // wins before any path guess. Without this, blog posts whose titles mention a
  // treatment or a town were being counted as treatment/location pages to build.
  if (source === "post") return SECTIONS.find((s) => s.key === "blog")!;
  if (source === "product" || source === "product_cat") return SECTIONS.find((s) => s.key === "shop")!;
  // Only genuinely-media sitemaps are skipped outright. NOT "portfolio": sites
  // commonly keep their real service pages in a portfolio custom post type
  // (ruma's /services/botox-in-lehi-ut/ lives there), so those must fall through
  // to path classification instead of being written off as media.
  if (source === "video" || source === "attachment" || source === "image") {
    return { key: "media", label: "Video & media items", scope: "out-of-scope" };
  }

  // Location-suffixed service pages must not be miscounted as conditions: a URL
  // like "morpheus8-face-body-scar-near-draper-ut" contains "scar" (condition
  // vocabulary) but is a location-targeted SERVICE page. If the path also
  // matches a known service/brand term, prefer service classification even
  // though condition is tested first below.
  const serviceSection = SECTIONS.find((s) => s.key === "service")!;
  const conditionSection = SECTIONS.find((s) => s.key === "condition")!;
  const looksLikeService = serviceSection.test!(pathname, source);
  const looksLikeCondition = conditionSection.test!(pathname, source);
  if (looksLikeService && looksLikeCondition) return serviceSection;

  for (const s of SECTIONS) {
    if (s.test && s.test(pathname, source)) return s;
  }

  // Direct navigation structure hint: if the URL was located inside a known
  // navigation dropdown or header section (e.g. under "Services" or "Payment Plans"),
  // honor the website's own explicit categorization!
  if (navCategory) {
    const navSection = SECTIONS.find((s) => s.key === navCategory);
    if (navSection) return navSection;
  }

  // If discovered via a portfolio custom post type or nav:service, default to service
  if (source === "portfolio" || source === "nav:service") {
    return serviceSection;
  }

  return { key: "other", label: "Other pages", scope: "review" };
}

export interface ClassifiedUrl {
  url: string;
  confidence?: number;
  method?: string;
  reason?: string;
}

export interface TaxonomyResult {
  byType: Record<string, { count: number; urls: ClassifiedUrl[] }>;
  uncertainCount: number;
  warnings: string[];
}

// Races a slow enhancement step (Gemini adjudication, Crawlee content fetch)
// against its own timeout so a hang there degrades to "skip this step" rather
// than discarding the whole, already-computed, fast regex classification —
// which is what the outer withTimeout() in index.ts used to do, confirmed
// live: a 266-page Divi site's content-fetch step ran long, the outer
// timeout fired, and the ENTIRE taxonomy silently came back empty ({}) with
// no warning, despite ~250 pages already having been classified correctly by
// regex before the slow step even started.
async function withInternalTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<{ value: T; timedOut: boolean }> {
  let timedOut = false;
  const value = await Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => { timedOut = true; resolve(fallback); }, ms)),
  ]);
  return { value, timedOut };
}

// Pages that landed in "other" AND are plausible custom-post-type service pages
// (source === "portfolio") but matched neither service nor condition vocabulary
// are genuinely ambiguous — batch them to Gemini in one call rather than
// guessing or one-call-per-URL.
type AdjudicatedCategory = "service" | "condition" | "blog" | "core" | "offers" | "forms" | "legal" | "proof" | "locations" | "care" | "other";

async function adjudicateUncertain(
  candidates: AnalyzedPage[],
  signals: Map<string, { title: string; h1: string; metaDescription: string }>
): Promise<Map<string, AdjudicatedCategory>> {
  const result = new Map<string, AdjudicatedCategory>();
  if (!candidates.length || !geminiAvailable()) return result;

  const list = candidates.slice(0, 200).map((p) => {
    // Prefer content-fetched signals over slug-derived title — the fetched
    // title/h1/metaDescription give the LLM enough context to classify accurately.
    const sig = signals.get(p.url);
    const label = sig
      ? `${sig.title}${sig.h1 ? ` | ${sig.h1}` : ""}${sig.metaDescription ? ` — ${sig.metaDescription.substring(0, 80)}` : ""}`
      : p.title || p.path;
    return `${p.path} :: ${label}`;
  }).join("\n");
  const prompt = `You classify med-spa website pages into one of these categories:
- "service": a specific treatment or procedure (Botox, laser hair removal, microneedling, facials, body contouring)
- "condition": a patient diagnosis or symptom (melasma, acne, rosacea, hair loss)
- "blog": editorial/informational content (guides, how-to, comparisons, tips)
- "core": homepage, about, team/provider bios, contact, general services/treatments hub pages
- "offers": pricing pages, memberships, specials, financing, payment plans
- "forms": booking, consultation forms, quizzes
- "legal": privacy policy, terms, HIPAA, accessibility
- "proof": reviews, testimonials, before-and-after galleries
- "other": anything that doesn't fit the above

IMPORTANT RULES:
- "How often...", "What is...", "X vs Y" and informational guides are ALWAYS "blog"
- Provider/staff bio pages (e.g. /jane-smith-np/ or /meet-dr-jones/) are "core"
- A page titled "Prices" or "Treatment Prices" is "offers"
- Single-word category hub pages like /skin/, /body/, /medical/ on a spa site are "service"

For each line below (path :: title), reply with ONLY the path followed by " => <category>", one per line.

Examples:
/laser-hair-removal/ :: Laser Hair Removal => service
/acne-scarring/ :: Treating Acne Scars => condition
/how-often-should-you-get-a-chemical-peel/ :: How Often Should You Get a Chemical Peel? => blog
/about-us/ :: About Our Team => core
/jill-mcgraw-pa-c/ :: Jill McGraw, PA-C | Confidence That Blooms => core
/prices/ :: Treatment Prices => offers
/body/ :: Body | Expert Body Treatments => service
/skin/ :: Skin | Expert Skin Treatments => service

${list}`;

  try {
    const text = await geminiCall([{ text: prompt }], { temperature: 0, maxOutputTokens: 4000 });
    for (const line of text.split("\n")) {
      const m = line.match(/(?:^|[-*]\s*)(\S+?)(?:\s*::.*?)?\s*=>\s*(service|condition|blog|core|offers|forms|legal|proof|locations|care|other)/i);
      if (m) result.set(m[1]!, m[2]!.toLowerCase() as AdjudicatedCategory);
    }
  } catch {
    // AI adjudication is best-effort; leftover candidates stay in "uncertain".
  }
  return result;
}

import { runClassificationPipeline } from "./classification/pipeline.js";
import { batchCheckExceptions } from "./classification/exceptionStore.js";

/** Classify every discovered page into the taxonomy, with AI adjudication for the ambiguous remainder. */
export async function classifyPages(pages: AnalyzedPage[]): Promise<TaxonomyResult> {
  const byType: Record<string, { count: number; urls: ClassifiedUrl[] }> = {};
  const push = (key: string, classifiedUrl: ClassifiedUrl) => {
    if (!byType[key]) byType[key] = { count: 0, urls: [] };
    byType[key].count++;
    byType[key].urls.push(classifiedUrl);
  };

  const uncertainPages: AnalyzedPage[] = [];
  const otherPages: AnalyzedPage[] = [];
  const fastMatches = new Map<string, Section>();

  for (const p of pages) {
    if (!p.isPage) continue; 
    const section = classifyPage(p.path, p.source, p.navCategory);
    fastMatches.set(p.url, section);
    
    if (section.key === "other" || section.key === "uncertain") {
      if (p.source === "portfolio" || p.navCategory === "service") {
        uncertainPages.push(p);
      } else {
        otherPages.push(p);
      }
    }
  }

  const warnings: string[] = [];
  
  // 1. Fetch content for ambiguous pages (up to limit)
  const pagesToFetch = [...uncertainPages, ...otherPages].slice(0, MAX_CONTENT_FETCH);
  const { value: signals, timedOut: contentFetchTimedOut } = await withInternalTimeout(
    fetchContentSignals(pagesToFetch.map((p) => p.url)).catch(() => new Map<string, any>()),
    35000,
    new Map<string, any>()
  );
  
  if (contentFetchTimedOut && pagesToFetch.length) {
    warnings.push(`Content fetch for ${pagesToFetch.length} ambiguous pages timed out.`);
  }

  // 2. Pre-load exception store overrides in ONE batch query across all pages
  const exceptionsMap = await batchCheckExceptions(pages.map((p) => p.url));

  // 3. Run pipeline for ALL pages
  const llmAdjudicationQueue: AnalyzedPage[] = [];

  for (const p of pages) {
    if (!p.isPage) continue;
    const fastMatch = fastMatches.get(p.url)!;
    const sig = signals.get(p.url);
    
    // Check shop/product via fetch signals first if available
    if (sig?.looksLikeProduct) {
       push("shop", { url: p.url, method: "content_signals", confidence: 0.9, reason: "Product JSON-LD or meta tags detected" });
       continue;
    }
    
    const textSample = sig ? `${sig.title} ${sig.h1} ${sig.metaDescription}` : "";
    const title = sig?.title || "";

    const result = await runClassificationPipeline(
      p,
      title,
      textSample,
      fastMatch,
      exceptionsMap.get(p.url) || null
    );
    
    if (result.method === "unresolved" && result.category === "uncertain") {
       // Portfolio/nav:service pages are always worth LLM adjudication.
       // Non-portfolio pages (e.g. Squarespace source:"page") are also worth
       // LLM adjudication IF the content fetcher got real text for the LLM to
       // use. An empty textSample means the LLM has nothing to work with.
       const hasRealContent = textSample.trim().length > 20;
       if (uncertainPages.includes(p) || hasRealContent) {
         llmAdjudicationQueue.push(p);
       } else {
         push("other", { url: p.url, method: "fallback", confidence: 0, reason: "Passed through pipeline unrecognized" });
       }
    } else {
       push(result.category, { url: p.url, method: result.method, confidence: result.confidence, reason: result.reason });
    }
  }

  // 3. Batch LLM Adjudication for the leftovers
  let uncertainCount = 0;
  if (llmAdjudicationQueue.length > 0) {
    const { value: resolved, timedOut: adjudicationTimedOut } = await withInternalTimeout(
      adjudicateUncertain(llmAdjudicationQueue, signals).catch(() => new Map<string, AdjudicatedCategory>()),
      35000,
      new Map<string, AdjudicatedCategory>()
    );
    if (adjudicationTimedOut) {
      warnings.push(`AI adjudication of ${llmAdjudicationQueue.length} ambiguous pages timed out.`);
    }
    
    for (const p of llmAdjudicationQueue) {
      const verdict = resolved.get(p.path);
      if (verdict) {
        push(verdict, { url: p.url, method: "llm_adjudication", confidence: 0.8, reason: `LLM selected ${verdict}` });
      } else {
        push("uncertain", { url: p.url, method: "llm_adjudication", confidence: 0.5, reason: "LLM was unable to classify definitively" });
        uncertainCount++;
      }
    }
  }

  return { byType, uncertainCount, warnings };
}
