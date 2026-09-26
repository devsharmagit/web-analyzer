import { SectionKey } from "../classify.js";
import { AnalyzedPage } from "../crawl.js";
import { checkExceptions } from "./exceptionStore.js";
import { checkDenylist } from "./denylist.js";
import { PROTOTYPES } from "./prototypes.js";
import { embedText, cosineSimilarity, geminiAvailable, geminiCall } from "../gemini.js";

export interface ClassificationResult {
  category: SectionKey;
  confidence: number;
  method: "slug" | "exception" | "denylist" | "embedding" | "llm" | "unresolved";
  reason: string;
}

export async function runClassificationPipeline(
  page: AnalyzedPage,
  title: string,
  textSample: string,
  fastSlugMatch: { key: SectionKey; label: string },
  preloadedException?: { category: string; confidence: number; method: "exception" } | null
): Promise<ClassificationResult> {
  // 1. Exceptions
  const exceptionMatch = preloadedException !== undefined
    ? preloadedException
    : await checkExceptions(page.url);
  if (exceptionMatch) {
    return {
      category: exceptionMatch.category as SectionKey,
      confidence: exceptionMatch.confidence,
      method: "exception",
      reason: "Matched administrative override in exception store",
    };
  }

  // 2. Slug Match
  if (fastSlugMatch.key !== "other" && fastSlugMatch.key !== "uncertain") {
    return {
      category: fastSlugMatch.key,
      confidence: 1.0,
      method: "slug",
      reason: `Matched fast slug regex for ${fastSlugMatch.label}`,
    };
  }

  // 3. Denylist Match
  const denylistMatch = checkDenylist(page.url, title);
  if (denylistMatch) {
    return {
      category: denylistMatch.category as SectionKey,
      confidence: denylistMatch.confidence,
      method: "denylist",
      reason: "Matched known non-service structural patterns",
    };
  }

  // 4. Embedding Similarity
  if (textSample.length > 5 && geminiAvailable()) {
    try {
      const vector = await embedText(textSample);
      let bestMatch = null;
      let highestSimilarity = -1;

      for (const p of PROTOTYPES) {
        if (!p.vector) continue;
        const sim = cosineSimilarity(vector, p.vector);
        if (sim > highestSimilarity) {
          highestSimilarity = sim;
          bestMatch = p;
        }
      }

      if (highestSimilarity > 0.82 && bestMatch) {
        return {
          category: bestMatch.category,
          confidence: highestSimilarity,
          method: "embedding",
          reason: `High semantic similarity (${highestSimilarity.toFixed(2)}) to prototype: ${bestMatch.text.substring(0, 30)}...`,
        };
      }
    } catch (e) {
      console.warn("Embedding API failed for", page.url, e);
    }
  }

  // 5. LLM Fallback (Single page prompt for demonstration, but typically we batch in classify.ts. 
  // We'll leave it as uncertain for now and let the batched `adjudicateUncertain` handle it if needed.
  return {
    category: "uncertain",
    confidence: 0,
    method: "unresolved",
    reason: "Failed all positive matching paths",
  };
}
