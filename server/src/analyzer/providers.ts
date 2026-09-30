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
// The tier-2 keyword must start a path segment or a hyphenated word:
// "(^|-)" alone never matched a segment start, because every path begins
// with "/" — so /injectors/, /doctors/ and /team-members/ were all missed.
const TEAM_PATH_PATTERNS = [
  /^\/(team|our-team|staff|providers|meet-the-team)\/?$/i,
  /meet-the-|(^|[-/])(team|staff|squad|crew|providers?|injectors?|doctors?)(-|\/?$)/i,
  /^\/(about|about-us)\/?$/i,
];
// Team pages tried, in priority order, until one yields people.
const MAX_TEAM_PAGES = 3;
// Individual bio pages under a team hub (/our-team/jane-doe/) read alongside it.
const MAX_BIO_PAGES = 8;
// Per-page text budget for the one batched AI extraction call.
const HUB_TEXT_CHARS = 12000;
const BIO_TEXT_CHARS = 2500;

const CREDENTIAL_RE = /\b(MD|DO|NP|PA-C|PA|RN|BSN|DNP|FNP-C|LME|DMD|APRN|CANS|CRNA|LE|CPPS|CLT)\b/;

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
  reason?: string; // set when count is "unknown", explains why detection stopped
}

/** Team-page candidates, most specific pattern first; each page appears once. */
export function findTeamPages(pages: AnalyzedPage[]): AnalyzedPage[] {
  const out: AnalyzedPage[] = [];
  for (const re of TEAM_PATH_PATTERNS) {
    for (const p of pages) {
      if (re.test(p.path) && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/** Pages one level below a team hub — /our-team/jane-doe/ under /our-team/. */
function bioPagesUnder(hub: AnalyzedPage, pages: AnalyzedPage[]): AnalyzedPage[] {
  if (hub.path === "/") return [];
  return pages
    .filter((p) => p.isPage && p.path.startsWith(hub.path) && /^[^/]+\/$/.test(p.path.slice(hub.path.length)))
    .slice(0, MAX_BIO_PAGES);
}

function fromJsonLd(blocks: any[]): Provider[] {
  const people = blocks.filter((b) => b["@type"] === "Person" || (Array.isArray(b["@type"]) && b["@type"].includes("Person")));
  return people
    .map((p) => ({
      name: p.name || "",
      credentials: (p.honorificSuffix || (p.name && (p.name.match(CREDENTIAL_RE) || [])[0]) || "") as string,
      role: p.jobTitle || "",
      bio: p.description || "",
      photo: typeof p.image === "string" ? p.image : p.image?.url || "",
    }))
    .filter((p) => p.name)
    .filter((p) => {
      // An SEO plugin (Yoast/Rank Math) auto-injects a Person block for the
      // page's WordPress AUTHOR on nearly every page/post — that's a CMS
      // account, not a team member. Confirmed live: ruma.com and havenpmu.com
      // both returned their dev/agency account ("Onboarding Growth99",
      // "InfraTeamAdmin") as the sole "provider." A genuine team-roster Person
      // entry always carries a role or bio; bare WP author schema never does
      // (just name + Gravatar image) — reject those.
      if (p.role || p.bio) return true;
      return false;
    });
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

// A carousel/slider widget (common on Elementor/Swiper team sections) often
// duplicates the same slide markup 2-4x in the raw DOM for seamless looping —
// confirmed live on culturemedspa.com, which returned "Anya Zerilla" 4 times
// with identical role. Dedupe by normalized name, keeping the first (richest
// so far, since entries are identical when this fires) occurrence.
function dedupeProviders(people: Provider[]): Provider[] {
  const seen = new Set<string>();
  const out: Provider[] = [];
  for (const p of people) {
    const key = p.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Read one team page plus its individual bio pages: JSON-LD Person entries
 * from all of them first, then — if none — one batched AI extraction over
 * their combined text. Multi-location clinics often list only names on the
 * hub and keep credentials/roles on each provider's own page.
 */
async function extractFromTeamPage(hub: AnalyzedPage, pages: AnalyzedPage[]): Promise<{ fetched: boolean; people: Provider[] }> {
  const bios = bioPagesUnder(hub, pages);
  const [hubHtml, ...bioHtml] = await Promise.all([fetchHtml(hub.url), ...bios.map((b) => fetchHtml(b.url))]);
  if (!hubHtml) return { fetched: false, people: [] };

  const allHtml = [hubHtml, ...bioHtml].filter(Boolean);
  const jsonLdPeople = dedupeProviders(allHtml.flatMap((h) => fromJsonLd(extractJsonLd(h))));
  if (jsonLdPeople.length) return { fetched: true, people: jsonLdPeople };

  const text = [
    stripToText(hubHtml, HUB_TEXT_CHARS),
    ...bioHtml.filter(Boolean).map((h, i) => `--- ${bios[i]!.path}\n${stripToText(h, BIO_TEXT_CHARS)}`),
  ].join("\n\n");
  return { fetched: true, people: dedupeProviders(await fromAi(text)) };
}

/** Find and extract provider info from the site's team page(s), if any exist. */
export async function detectProviders(origin: string, pages: AnalyzedPage[]): Promise<ProvidersResult> {
  const candidates = findTeamPages(pages).slice(0, MAX_TEAM_PAGES);
  if (!candidates.length) return { count: "unknown", source: null, list: [], reason: "no team/staff/about-shaped page found in the crawl" };

  // Most specific candidate first; fall through to the next when a page has
  // nobody on it (e.g. a /team/ page that's only a "join our team" pitch).
  let anyFetched = false;
  for (const page of candidates) {
    const { fetched, people } = await extractFromTeamPage(page, pages);
    anyFetched ||= fetched;
    if (people.length) return { count: people.length, source: page.path, list: people };
  }

  const tried = candidates.map((p) => p.path).join(", ");
  if (!anyFetched) return { count: "unknown", source: candidates[0]!.path, list: [], reason: `team page${candidates.length === 1 ? "" : "s"} found (${tried}) but could not be fetched` };
  const reason = geminiAvailable()
    ? `team page${candidates.length === 1 ? "" : "s"} fetched (${tried}) but neither JSON-LD nor AI extraction found any people`
    : `team page${candidates.length === 1 ? "" : "s"} fetched (${tried}) but no JSON-LD people, and AI extraction is unavailable (no GEMINI_KEYS configured)`;
  return { count: "unknown", source: candidates[0]!.path, list: [], reason };
}
