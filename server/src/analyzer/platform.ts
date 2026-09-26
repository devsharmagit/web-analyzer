// Platform + store fingerprinting — Phase 2. Answers Q1 (what platform) and
// Q6 (do they sell anything). One homepage fetch plus two cheap probes; no
// crawling here (Phase 1 already crawled).

const UA = "Mozilla/5.0 (compatible; G99-Analyzer/1.0)";

export type Confidence = "high" | "likely" | "unknown";

export interface Detection {
  value: string | null;
  confidence: Confidence;
  evidence: string[];
}

export interface PlatformResult {
  cms: Detection;
  builder: Detection;
  ecommerce: Detection;
}

export interface StoreResult {
  hasStore: boolean;
  platform: string | null;
  productCount: number;
  categoryCount: number;
  isThirdParty?: boolean;
  thirdPartyIntegrations?: string[];
  notes?: string;
}

import { fetchWithFallback } from "./fetchWithFallback.js";

async function fetchText(url: string, timeoutMs = 25000): Promise<string> {
  const res = await fetchWithFallback(url, { timeoutMs, headers: { "User-Agent": UA } });
  return res.ok ? res.html : "";
}

async function fetchStatus(url: string, timeoutMs = 8000): Promise<number> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": UA } });
    return r.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// CMS fingerprints, cheapest signal (string match in HTML) first.
const CMS_FINGERPRINTS: Array<{ name: string; re: RegExp }> = [
  { name: "WordPress", re: /wp-content|wp-includes|wp-json/i },
  { name: "Shopify", re: /cdn\.shopify\.com|Shopify\.theme/i },
  { name: "Squarespace", re: /squarespace\.com|static1\.squarespace/i },
  { name: "Wix", re: /wix\.com|wixstatic\.com/i },
  { name: "Webflow", re: /webflow\.com|website-files\.com/i },
  { name: "Next.js", re: /_next\/static|_next\/data|next-head-count/i },
  { name: "Duda", re: /irp\.cdn-website\.com|dudamobile/i },
  { name: "GoDaddy", re: /godaddy\.com\/websites|gdwebsite/i },
];

const BUILDER_FINGERPRINTS: Array<{ name: string; re: RegExp }> = [
  { name: "Elementor", re: /elementor/i },
  { name: "Divi", re: /divi-style|et_pb_/i },
  { name: "Beaver Builder", re: /fl-builder/i },
  { name: "WPBakery", re: /wpb_wrapper|js_composer/i },
  { name: "Gutenberg", re: /wp-block-/i },
  { name: "Webflow", re: /w-page|w-nav|w-embed/i },
];

const ECOMMERCE_FINGERPRINTS: Array<{ name: string; re: RegExp }> = [
  { name: "WooCommerce", re: /woocommerce/i },
  { name: "Shopify", re: /cdn\.shopify\.com|Shopify\.theme/i },
  { name: "BigCommerce", re: /bigcommerce\.com/i },
  { name: "Ecwid", re: /ecwid\.com|xproductbrowser/i },
  { name: "Wix Stores", re: /wix-stores|wixstores/i },
  { name: "Squarespace Commerce", re: /sqs-cart|sqs-add-to-cart/i },
];

// Sites commonly carry markers for more than one builder at once (an Elementor
// site can still have a handful of leftover Divi classes from a theme, or vice
// versa). Picking the FIRST regex that matches is arbitrary — it reflects table
// order, not which builder actually built the page. Count occurrences of each
// fingerprint instead and let the dominant one win.
function detectFromHtml(html: string, table: Array<{ name: string; re: RegExp }>): Detection {
  let best: { name: string; count: number; re: RegExp } | null = null;
  for (const fp of table) {
    const global = new RegExp(fp.re.source, fp.re.flags.includes("g") ? fp.re.flags : fp.re.flags + "g");
    const count = (html.match(global) || []).length;
    if (count > 0 && (!best || count > best.count)) best = { name: fp.name, count, re: fp.re };
  }
  if (!best) return { value: null, confidence: "unknown", evidence: [] };
  return {
    value: best.name,
    confidence: "likely",
    evidence: [`"${best.re.source}" matched ${best.count}× in homepage HTML (dominant fingerprint)`],
  };
}

/** Fingerprint the platform (CMS, page builder, e-commerce) from one homepage fetch + two probes. */
export async function detectPlatform(origin: string): Promise<PlatformResult> {
  const html = await fetchText(origin + "/");

  const cms = detectFromHtml(html, CMS_FINGERPRINTS);
  const builder = detectFromHtml(html, BUILDER_FINGERPRINTS);
  const ecommerce = detectFromHtml(html, ECOMMERCE_FINGERPRINTS);

  // <meta name="generator"> is a direct, authoritative signal when present.
  const genMatch = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
  if (genMatch) {
    const gen = genMatch[1]!;
    if (/wordpress/i.test(gen)) {
      cms.value = "WordPress";
      cms.confidence = "high";
      cms.evidence.push(`<meta name="generator"> = "${gen}"`);
    } else if (/wix/i.test(gen)) {
      cms.value = "Wix";
      cms.confidence = "high";
      cms.evidence.push(`<meta name="generator"> = "${gen}"`);
    } else if (/squarespace/i.test(gen)) {
      cms.value = "Squarespace";
      cms.confidence = "high";
      cms.evidence.push(`<meta name="generator"> = "${gen}"`);
    } else if (/webflow/i.test(gen)) {
      cms.value = "Webflow";
      cms.confidence = "high";
      cms.evidence.push(`<meta name="generator"> = "${gen}"`);
    } else if (cms.value && new RegExp(cms.value, "i").test(gen)) {
      cms.confidence = "high";
      cms.evidence.push(`<meta name="generator"> confirms "${gen}"`);
    }
  }

  // wp-json 200 is the strongest possible WordPress signal — certain, not likely.
  if (cms.value === "WordPress" || !cms.value) {
    const status = await fetchStatus(origin + "/wp-json/");
    if (status === 200) {
      cms.value = "WordPress";
      cms.confidence = "high";
      cms.evidence.push("GET /wp-json/ → 200");
    }
  }

  // Theme name, if we can see it, adds evidence to whichever builder we found
  // (or names the theme even when no known builder matched).
  const themeMatch = html.match(/\/themes\/([a-z0-9_-]+)\//i);
  if (themeMatch) {
    const theme = themeMatch[1]!;
    (builder.value ? builder : builder).evidence.push(`theme path: /themes/${theme}/`);
    if (!builder.value) {
      builder.value = theme;
      builder.confidence = "likely";
    }
  }

  return { cms, builder, ecommerce };
}

/**
 * Store presence + size, derived from Phase 1's source counts and cross-checked
 * against ecommerce detection.
 *
 * hasStore requires actual product evidence (a sitemap with real products/
 * categories), NOT just the e-commerce plugin being installed. Confirmed live
 * on tribecamedspa.com: WooCommerce fingerprints in the HTML (the plugin is
 * active) but zero products in any sitemap — "hasStore: true, 0 products" is
 * self-contradictory and would mislead an employee reading the report ("do
 * they have a store?" "yes... selling nothing?"). A dormant/unused plugin
 * install is common (installed for one gift-card flow, or left over from a
 * template) and isn't what "has a store" means to the person asking.
 * `platform` still reports which e-commerce plugin was detected even when
 * hasStore is false — that's a separate, still-useful fact.
 */
const THIRD_PARTY_STORE_PATTERNS = [
  { name: "SkinBetter Science", pattern: /skinbetter\.(?:pro|com)/i },
  { name: "Colorescience", pattern: /colorescience\.com/i },
  { name: "Alastin Skincare", pattern: /alastin\.com/i },
  { name: "Revision Skincare", pattern: /revisionskincare\.com/i },
  { name: "ZO Skin Health", pattern: /zoskinhealth\.com/i },
  { name: "SkinMedica", pattern: /skinmedica\.com|brilliantconnections\.com/i },
  { name: "DefenAge", pattern: /defenage\.com/i },
  { name: "Epionce", pattern: /epionce\.com/i },
  { name: "HydraFacial", pattern: /hydrafacial\.com/i },
  { name: "Cherry Financing", pattern: /withcherry\.com/i },
  { name: "RepeatMD", pattern: /repeatmd\.com/i },
  { name: "MyAestheticRecord", pattern: /myaestheticrecord\.com/i },
];

export function detectThirdPartyStore(html: string): string[] {
  if (!html) return [];
  const found: string[] = [];
  for (const item of THIRD_PARTY_STORE_PATTERNS) {
    if (item.pattern.test(html)) {
      found.push(item.name);
    }
  }
  return found;
}

export function detectStore(
  counts: Record<string, number>,
  ecommerce: Detection,
  shopHtml?: string
): StoreResult {
  const productCount = counts.product || 0;
  const categoryCount = counts.product_cat || 0;
  const hasNativeStore = productCount > 0 || categoryCount > 0;

  const thirdPartyIntegrations = shopHtml ? detectThirdPartyStore(shopHtml) : [];
  const isThirdParty = !hasNativeStore && thirdPartyIntegrations.length > 0;

  let platform = ecommerce.value;
  if (isThirdParty && !platform) {
    platform = "Third-party Integration";
  }

  let notes: string | undefined;
  if (isThirdParty) {
    notes = `Products on /shop are fulfilled via third-party partner portals (${thirdPartyIntegrations.join(", ")}). Not a native self-hosted e-commerce store.`;
  }

  return {
    hasStore: hasNativeStore || isThirdParty,
    platform,
    productCount,
    categoryCount,
    isThirdParty,
    thirdPartyIntegrations: thirdPartyIntegrations.length ? thirdPartyIntegrations : undefined,
    notes,
  };
}
