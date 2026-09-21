// Page taxonomy — Phase 3. Answers Q3 (service pages), Q4 (condition pages),
// Q5 (before/after pages). Ported from reference/server.js:3423 `SECTIONS` +
// `classifyPage()`, keeping the original comments (paid-for bug knowledge),
// extended with: portfolio-as-service, a split-out beforeAfter type, a new
// condition type + vocabulary, and an `uncertain` bucket for AI adjudication.

import { geminiAvailable, geminiCall } from "./gemini.js";
import type { AnalyzedPage } from "./crawl.js";

export type SectionKey =
  | "core" | "locations" | "forms" | "care" | "service" | "condition"
  | "beforeAfter" | "proof" | "offers" | "shop" | "blog" | "legal"
  | "careers" | "media" | "other" | "uncertain";

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
  { key: "core", label: "Core pages", scope: "required",
    test: (p) =>
      p === "/" ||
      /^\/home(-\d+)?\/?$/.test(p) ||
      /^\/(about|about-us|team|our-team|staff|providers|contacts?|contact-us|services|treatments|menu)\/?$/.test(p) },
  // Must be a real location landing page ("medical spa near X"), not merely a URL
  // that happens to end in a state code — that matched 200+ blog posts.
  { key: "locations", label: "Location / local SEO", scope: "recommended",
    test: (p) => /(medical|med)[- ]?spa[a-z-]*-(near|in)-[a-z-]+/.test(p) || /^\/our-[a-z-]+-location\/?$/.test(p) },
  // Forms and care sheets are tested BEFORE services: a "hormone health quiz" is
  // a lead form, not a service page, and must not be counted as one to rebuild.
  { key: "forms", label: "Forms & quizzes", scope: "optional",
    test: (p) => /(quiz|form|inquiry|consult|appointment|booking|book-)/.test(p) },
  { key: "care", label: "Pre / post care", scope: "optional",
    test: (p) => /(pre-and-post|pre-post|aftercare|post-care|instruction)/.test(p) },
  // Before/after split out of the old "proof" bucket — a gallery of results
  // photos is a distinct, countable page type (Q5), not folded into reviews.
  // Bare "gallery" / "results" are included (not just the compound phrases)
  // because in this vertical a standalone /gallery/ or /results/ page is
  // overwhelmingly a before/after gallery, not a generic photo gallery —
  // confirmed against real sites (conqraesthetics /gallery/, drippynursejess
  // /results/ were both misrouted to "proof" before this widened match).
  { key: "beforeAfter", label: "Before & after", scope: "recommended",
    test: (p) => /(before-and-after|before-after|b-a-gallery|results-gallery|\bgallery\b|\bresults\b)/.test(p) },
  // Condition vocabulary: what the patient HAS, not what the clinic DOES.
  // Checked before "service" below so condition words win when a URL is
  // otherwise ambiguous, but see the location-suffix guard in classifyPage —
  // "morpheus8-face-body-scar-near-draper-ut" must stay a service page.
  { key: "condition", label: "Condition pages", scope: "recommended",
    test: (p) =>
      /^\/conditions?\//.test(p) ||
      /(melasma|rosacea|acne-scar|hyperpigmentation|hair-loss|sun-damage|volume-loss|hyperhidrosis|cellulite|stretch-marks|dark-spots|fine-lines|wrinkles|double-chin|sagging-skin|uneven-skin-tone|enlarged-pores)/.test(p) },
  { key: "service", label: "Treatment / service pages", scope: "required",
    test: (p) => /(botox|dysport|filler|sculptra|microneedl|laser|peel|facial|inject|infusion|iv-|hormone|hrt|weight-loss|prp|prf|thread|skincare|hydrafacial|coolsculpt|kybella|bbl|moxi|morpheus|miradry|thermoclear|red-light|tox|lash|brow|wax|hair-removal|skin-tightening|body-contour)/.test(p) },
  // Offers is tested BEFORE proof: "affiliate-partner-discounts" is a discount
  // program, not a trust/affiliation page, but proof's bare "partner" keyword
  // used to win first — confirmed live on ruma.com.
  { key: "offers", label: "Offers, memberships & financing", scope: "recommended",
    test: (p) => /(special|offer|promo|vip|membership|payment-plan|financ|gift|package|bank|discount|affiliate)/.test(p) },
  { key: "proof", label: "Proof & trust", scope: "recommended",
    test: (p) => /(review|testimonial|gallery|results|partner)/.test(p) },
  { key: "shop", label: "Store & products", scope: "out-of-scope",
    test: (p, src) => src === "product" || /^\/(shop|store|product|cart|checkout|my-account)/.test(p) },
  { key: "blog", label: "Blog & articles", scope: "out-of-scope",
    test: (p, src) => src === "post" || /^\/(blog|blogs|news|article)/.test(p) },
  // "sitemap" used to be a bare keyword here and wrongly caught a marketing
  // "/html-sitemap/" page (a site-navigation index, not a legal document) —
  // confirmed live on conqraesthetics. Require "xml-sitemap" specifically.
  { key: "legal", label: "Legal & policy", scope: "out-of-scope",
    test: (p) => /(privacy|terms|policy|policies|accessibility|hipaa|disclaimer|xml-sitemap)/.test(p) },
  { key: "careers", label: "Careers", scope: "out-of-scope",
    test: (p) => /(career|job|employment|hiring)/.test(p) },
];

export function classifyPage(pathname: string, source: string): Section {
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
  return { key: "other", label: "Other pages", scope: "review" };
}

export interface TaxonomyResult {
  byType: Record<string, { count: number; urls: string[] }>;
  uncertainCount: number;
}

// Pages that landed in "other" AND are plausible custom-post-type service pages
// (source === "portfolio") but matched neither service nor condition vocabulary
// are genuinely ambiguous — batch them to Gemini in one call rather than
// guessing or one-call-per-URL.
async function adjudicateUncertain(
  candidates: AnalyzedPage[]
): Promise<Map<string, "service" | "condition">> {
  const result = new Map<string, "service" | "condition">();
  if (!candidates.length || !geminiAvailable()) return result;

  const list = candidates.slice(0, 200).map((p) => `${p.path} :: ${p.title}`).join("\n");
  const prompt = `You classify med-spa website pages as either "service" (a treatment/procedure the clinic performs — e.g. Botox, laser hair removal, microneedling) or "condition" (a patient complaint/diagnosis — e.g. melasma, acne scarring, hair loss).
For each line below (format: path :: title), reply with ONLY the path followed by " => service" or " => condition", one per line, no other text.

${list}`;

  try {
    const text = await geminiCall([{ text: prompt }], { temperature: 0, maxOutputTokens: 4000 });
    for (const line of text.split("\n")) {
      const m = line.match(/^(\S+)\s*=>\s*(service|condition)/i);
      if (m) result.set(m[1]!, m[2]!.toLowerCase() as "service" | "condition");
    }
  } catch {
    // AI adjudication is best-effort; leftover candidates stay in "uncertain".
  }
  return result;
}

/** Classify every discovered page into the taxonomy, with AI adjudication for the ambiguous remainder. */
export async function classifyPages(pages: AnalyzedPage[]): Promise<TaxonomyResult> {
  const byType: Record<string, { count: number; urls: string[] }> = {};
  const push = (key: string, url: string) => {
    if (!byType[key]) byType[key] = { count: 0, urls: [] };
    byType[key].count++;
    byType[key].urls.push(url);
  };

  const uncertainPages: AnalyzedPage[] = [];

  for (const p of pages) {
    if (!p.isPage) continue; // products/videos/etc. handled by store/crawl counts
    const section = classifyPage(p.path, p.source);
    // "portfolio" pages that fell through to "other" are ambiguous custom-post-type
    // items — hold them for batched AI adjudication instead of mis-bucketing.
    if (section.key === "other" && p.source === "portfolio") {
      uncertainPages.push(p);
      continue;
    }
    push(section.key, p.url);
  }

  const resolved = await adjudicateUncertain(uncertainPages);
  let uncertainCount = 0;
  for (const p of uncertainPages) {
    const verdict = resolved.get(p.path);
    if (verdict) push(verdict, p.url);
    else {
      push("uncertain", p.url);
      uncertainCount++;
    }
  }

  return { byType, uncertainCount };
}
