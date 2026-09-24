// Before/after case counting. Answers "how many before/after results does
// this site show", counting distinct patient cases, not raw images — a
// single case is often shown as more than one photo (confirmed live on
// skinmedhealth.com: "BA-amy-a/b/c" is one patient, three angles).
//
// Recon across 4 real sites (see ACCURACY-PLAN.md-style evidence in the
// comments below) found no single reliable signal:
//   - ruma.com: Elementor lightbox groups (aria-label="N of 8") + filenames
//     like "Fillers-BeforeandAfter-Ruma-one.webp"
//   - gloderma.com: no lightbox metadata at all; alt text is the only signal
//     ("Before and after Photo for Facial Rejuvenation...")
//   - skinmedhealth.com: filenames only ("BA-amy-a", "BA-amy-b", "BA-amy-c")
//   - trubeautybytrevor.com: has lightbox groups, but one has 98 images and
//     another 32 — implausible for a single gallery to be pure before/after
//     content; likely mixes in unrelated gallery material
// So: deterministic filename-grouping first (cheap, works for the clear
// cases), AI adjudication only when the deterministic pass can't produce a
// plausible answer — same two-tier pattern as classify.ts's
// adjudicateUncertain, never a rigid regex assumed to generalize.

import { geminiAvailable, geminiCall } from "./gemini.js";
import { fetchImageCandidates, type ImageCandidate } from "./fetchContent.js";

const MAX_PAGES = 3; // most sites have exactly one dedicated before/after page
const MAX_AI_CANDIDATES = 60; // cap what gets sent to Gemini in one batch
const LARGE_UNGROUPED_THRESHOLD = 15; // triggers AI adjudication (see below)

export type Confidence = "high" | "likely" | "unknown";

export interface BeforeAfterResult {
  pageUrl: string | null;
  imageCount: number;
  caseCount: number | "unknown";
  confidence: Confidence;
  evidence: string[];
  images: string[];
  reason?: string;
}

const EMPTY: BeforeAfterResult = {
  pageUrl: null,
  imageCount: 0,
  caseCount: "unknown",
  confidence: "unknown",
  evidence: [],
  images: [],
};

function filenameOf(src: string): string {
  try {
    return decodeURIComponent(new URL(src).pathname.split("/").pop() || "");
  } catch {
    return src.split("/").pop() || src;
  }
}

// Strips a trailing ordinal/letter/number suffix before the extension —
// "BA-amy-a.webp" -> "BA-amy", "Fillers-BeforeandAfter-Ruma-one.webp" ->
// "Fillers-BeforeandAfter-Ruma". Confirmed live: this exact pattern is how
// skinmedhealth.com names multiple angles of the same patient.
function normalizeBase(filename: string): string {
  const noExt = filename.replace(/\.[a-z0-9]+$/i, "");
  return noExt.replace(/[-_](?:[a-z]|\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)$/i, "").toLowerCase();
}

interface GroupResult {
  caseCount: number;
  groups: Map<string, ImageCandidate[]>;
  largestGroupSize: number;
}

function groupByFilename(images: ImageCandidate[]): GroupResult {
  const groups = new Map<string, ImageCandidate[]>();
  for (const img of images) {
    const base = normalizeBase(filenameOf(img.src));
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base)!.push(img);
  }
  return {
    caseCount: groups.size,
    groups,
    largestGroupSize: Math.max(0, ...[...groups.values()].map((g) => g.length)),
  };
}

async function adjudicateWithAi(images: ImageCandidate[]): Promise<{ caseCount: number; evidence: string } | null> {
  if (!geminiAvailable() || !images.length) return null;

  const list = images
    .slice(0, MAX_AI_CANDIDATES)
    .map((img, i) => `${i + 1}. ${filenameOf(img.src)} :: alt="${img.alt}" title="${img.title}"`)
    .join("\n");
  const prompt = `This is a list of images found on a med-spa's "before & after" results page. Some may NOT actually be before/after result photos (they could be unrelated gallery images, staff photos, testimonials, promotional CTA banners, etc. that slipped through) — exclude those.
Among the genuine before/after photos, count the number of DISTINCT patient cases.
IMPORTANT RULES:
1. An image that shows a combined side-by-side Before & After comparison of one patient is ONE distinct case.
2. If images have distinct case numbers or number words like 'one', 'two', 'three', '1', '2', '3' (e.g. 'Lip-Filler-one', 'Lip-Filler-two', 'Lip-Filler-three', ...), each numbered entry is an independent, distinct patient case, NOT multiple angles of the same person.
3. Only group multiple photos together if they are explicitly different angles or separate before/after parts of the EXACT SAME patient case (for example: 'patient1-front' and 'patient1-side', or 'caseA_before' and 'caseA_after').
4. Be precise and count carefully. Do NOT underestimate or round down.

Respond with ONLY a JSON object like:
{"caseCount": 12, "evidence": "one short sentence explaining your reasoning"}
No other text.

IMAGES:
${list}`;

  try {
    const raw = await geminiCall([{ text: prompt }], { temperature: 0.1, maxOutputTokens: 500 });
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.caseCount !== "number") return null;
    return { caseCount: parsed.caseCount, evidence: String(parsed.evidence || "") };
  } catch {
    return null;
  }
}

/** Count distinct before/after cases shown on the site's before/after page(s), if any. */
export async function detectBeforeAfterGallery(beforeAfterPageUrls: string[]): Promise<BeforeAfterResult> {
  if (!beforeAfterPageUrls.length) return EMPTY;

  const targetUrls = beforeAfterPageUrls.slice(0, MAX_PAGES);
  const imagesByPage = await fetchImageCandidates(targetUrls);

  // Combine across the (usually one) page(s) — most sites have exactly one.
  const allImages: ImageCandidate[] = [];
  for (const url of targetUrls) allImages.push(...(imagesByPage.get(url) || []));

  const pageUrl = targetUrls[0] || null;
  if (!allImages.length) {
    return { ...EMPTY, pageUrl, reason: "before/after page found but no real content images could be extracted" };
  }

  const byFilename = groupByFilename(allImages);
  const imageCount = allImages.length;
  const imageUrls = allImages.map(img => img.src);

  // Two conditions call for AI adjudication instead of trusting the
  // deterministic filename grouping:
  //   1. No grouping signal at all (every filename is unique) on a large
  //      gallery — plausible either way, but worth a second opinion since a
  //      naive 1-image-per-case guess is exactly where we'd be wrong.
  //   2. A single filename-group is implausibly large — confirmed live on
  //      trubeautybytrevor.com, where a lightbox gallery held 98 images;
  //      that's far more likely to mix in unrelated content than to be 98
  //      genuine distinct patient cases.
  const noGroupingSignal = byFilename.caseCount === imageCount && imageCount > LARGE_UNGROUPED_THRESHOLD;
  const implausiblyLargeGroup = byFilename.largestGroupSize > LARGE_UNGROUPED_THRESHOLD;

  if (noGroupingSignal || implausiblyLargeGroup) {
    const ai = await adjudicateWithAi(allImages);
    if (ai) {
      return {
        pageUrl,
        imageCount,
        caseCount: ai.caseCount,
        confidence: "unknown", // AI-derived — never claim "high" for a judgment call
        evidence: [ai.evidence, `${imageCount} candidate images considered (filename grouping alone was inconclusive)`],
        images: imageUrls,
      };
    }
    // AI unavailable/failed — fall through to the deterministic guess below,
    // but flag it as low-confidence since we know it's likely imprecise here.
    return {
      pageUrl,
      imageCount,
      caseCount: byFilename.caseCount,
      confidence: "unknown",
      evidence: [`Filename grouping alone found ${byFilename.caseCount} cases across ${imageCount} images, but AI adjudication was unavailable to double-check — treat this as a rough estimate.`],
      images: imageUrls,
      reason: geminiAvailable() ? "AI adjudication failed" : "AI adjudication unavailable (no GEMINI_KEYS configured)",
    };
  }

  // A clean, plausible filename grouping: e.g. skinmedhealth's
  // "BA-amy-a/b/c" -> 1 case, or ruma's mostly-unique filenames -> largely
  // 1 image per case. "high" only when grouping actually collapsed several
  // images into cases (a real, matched multi-photo-per-case pattern); a
  // trivial 1:1 mapping (every image its own case) is "likely", since we
  // can't rule out an undetectable same-patient grouping.
  const collapsedSomeImages = byFilename.caseCount < imageCount;
  return {
    pageUrl,
    imageCount,
    caseCount: byFilename.caseCount,
    confidence: collapsedSomeImages ? "high" : "likely",
    evidence: collapsedSomeImages
      ? [`Grouped ${imageCount} images into ${byFilename.caseCount} cases by matching filename patterns (e.g. shared base name with a trailing "-a"/"-b"/"-1" suffix).`]
      : [`${imageCount} images found, each with a distinct filename — no same-case grouping signal detected, so each is counted as its own case.`],
    images: imageUrls,
  };
}
