// Minimal page fetch + strip-to-text helper for Phases 3-4. No Playwright —
// plain fetch + regex only (targets are WordPress-heavy sites where this is
// enough; see ANALYZER-SCOPE.md decision to skip a headless browser budget).

import { fetchWithFallback } from "./fetchWithFallback.js";

const UA = "Mozilla/5.0 (compatible; G99-Analyzer/1.0)";

export async function fetchHtml(url: string, timeoutMs = 15000): Promise<string> {
  const res = await fetchWithFallback(url, { timeoutMs, headers: { "User-Agent": UA } });
  return res.ok ? res.html : "";
}

/** Extract every JSON-LD <script type="application/ld+json"> block as parsed JSON. */
export function extractJsonLd(html: string): any[] {
  const blocks: any[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1]!.trim());
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else if (parsed["@graph"]) blocks.push(...parsed["@graph"]);
      else blocks.push(parsed);
    } catch {
      // malformed JSON-LD — skip, don't crash the whole extraction
    }
  }
  return blocks;
}

/** Strip HTML to plain text — a 2.6MB Elementor blob shouldn't be sent to an LLM as-is. */
export function stripToText(html: string, maxChars = 20000): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxChars);
}
