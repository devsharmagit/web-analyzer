// Provider extraction — Phase 4. Answers Q8: how many providers, and their info.
// JSON-LD first (free, exact), then AI extraction from stripped page text as a
// fallback (team pages are often multi-MB Elementor blobs).

import type { AnalyzedPage } from "./crawl.js";
import { fetchHtml, extractJsonLd, stripToText } from "./scrapeLite.js";
import { geminiAvailable, geminiCall } from "./gemini.js";

// Ordered by specificity — a dedicated team/staff page beats a general About
// page, which is more likely to have only the founder rather than the roster.
// Tier 2 is a keyword match rather than exact paths: clinics often brand their
// team page ("Meet the Glo Squad", "Our Injector Crew") in ways no fixed path
// list can anticipate, so any path containing team/staff/provider/squad/crew
// vocabulary — or the "meet-the-" prefix pattern — counts.
const TEAM_PATH_PATTERNS = [
  /^\/(team|our-team|staff|providers|meet-the-team)\/?$/i,
  /meet-the-|(^|-)(team|staff|squad|crew|providers?|injectors?|doctors?)(-|\/?$)/i,
  /^\/(about|about-us)\/?$/i,
];

const CREDENTIAL_RE = /\b(MD|DO|NP|PA-C|RN|BSN|DNP|FNP-C|LME|DMD)\b/;

export interface Provider {
  name: string;
  credentials: string;
  role: string;
  bio: string;
  photo: string;
}

export interface ProvidersResult {
  count: number | "unknown";
  source: string | null;
  list: Provider[];
}

function findTeamPage(pages: AnalyzedPage[]): AnalyzedPage | null {
  for (const re of TEAM_PATH_PATTERNS) {
    const hit = pages.find((p) => re.test(p.path));
    if (hit) return hit;
  }
  return null;
}

function fromJsonLd(blocks: any[]): Provider[] {
  const people = blocks.filter((b) => b["@type"] === "Person" || (Array.isArray(b["@type"]) && b["@type"].includes("Person")));
  return people.map((p) => ({
    name: p.name || "",
    credentials: (p.honorificSuffix || (p.name && (p.name.match(CREDENTIAL_RE) || [])[0]) || "") as string,
    role: p.jobTitle || "",
    bio: p.description || "",
    photo: typeof p.image === "string" ? p.image : p.image?.url || "",
  })).filter((p) => p.name);
}

async function fromAi(text: string): Promise<Provider[]> {
  if (!geminiAvailable() || !text.trim()) return [];
  const prompt = `Extract every staff/provider listed on this med-spa team page. For each person give name, credentials (e.g. MD, NP, PA-C — empty string if none), role/title, and a one-sentence bio (empty string if not present). Respond with ONLY a JSON array like:
[{"name":"","credentials":"","role":"","bio":""}]
No other text.

PAGE TEXT:
${text}`;
  try {
    const raw = await geminiCall([{ text: prompt }], { temperature: 0.2, maxOutputTokens: 3000 });
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && typeof p.name === "string" && p.name.trim())
      .map((p) => ({ name: p.name, credentials: p.credentials || "", role: p.role || "", bio: p.bio || "", photo: "" }));
  } catch {
    return [];
  }
}

/** Find and extract provider info from the site's team page, if one exists. */
export async function detectProviders(origin: string, pages: AnalyzedPage[]): Promise<ProvidersResult> {
  const teamPage = findTeamPage(pages);
  if (!teamPage) return { count: "unknown", source: null, list: [] };

  const html = await fetchHtml(teamPage.url);
  if (!html) return { count: "unknown", source: teamPage.path, list: [] };

  const jsonLdPeople = fromJsonLd(extractJsonLd(html));
  if (jsonLdPeople.length) {
    return { count: jsonLdPeople.length, source: teamPage.path, list: jsonLdPeople };
  }

  const aiPeople = await fromAi(stripToText(html));
  if (aiPeople.length) {
    return { count: aiPeople.length, source: teamPage.path, list: aiPeople };
  }

  return { count: "unknown", source: teamPage.path, list: [] };
}
