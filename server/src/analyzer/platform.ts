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
  { name: "Ghost", re: /ghost\.io|content\/themes\/ghost/i },
  { name: "Drupal", re: /Drupal\.settings|drupal\.js|sites\/default\/files/i },
  { name: "Joomla", re: /joomla|com_content|mosConfig/i },
  { name: "HubSpot CMS", re: /hubspot\.com|hs-sites\.com|hs-analytics/i },
  { name: "Craft CMS", re: /craft-cms|craftcms/i },
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

// Custom platform fingerprints — used when no known CMS matches. These identify
// WHAT the site was built with (framework/stack) so we can say "Custom (Bootstrap + PHP)"
// instead of the unhelpful "Unknown".
//
// Ordered by how reliably the signal identifies the technology. Higher = more distinct.
const CUSTOM_PLATFORM_CHECKS: Array<{ name: string; re: RegExp; weight: number }> = [
  // JS Frameworks (high confidence — very distinctive signals)
  { name: "React", re: /ReactDOM|react-dom|__reactFiber|data-reactroot|data-reactid/i, weight: 10 },
  { name: "Vue", re: /vue\.global\.js|__vue_app__|data-v-[a-f0-9]{6,}|v-cloak|v-bind/i, weight: 10 },
  { name: "Angular", re: /ng-version|angular\.js|ng-app|angular\/core|zone\.js/i, weight: 10 },
  { name: "Svelte", re: /svelte|__svelte/i, weight: 10 },
  // CSS Frameworks
  { name: "Bootstrap", re: /bootstrap\.min\.css|bootstrap\.css|vendor\/bootstrap|cdn\.jsdelivr\.net\/npm\/bootstrap|stackpath\.bootstrapcdn\.com/i, weight: 7 },
  { name: "Tailwind CSS", re: /tailwindcss|cdn\.tailwindcss\.com|@tailwind/i, weight: 7 },
  { name: "Foundation", re: /foundation\.min\.css|\/foundation\//i, weight: 7 },
  { name: "Bulma", re: /bulma\.min\.css|\/bulma\//i, weight: 6 },
  // JS Libraries
  { name: "jQuery", re: /jquery\.min\.js|jquery-[0-9]|jquery\/jquery|code\.jquery\.com/i, weight: 4 },
  // Backend signals (inferred from URL patterns in the HTML)
  { name: "PHP", re: /\.php["'?\s>]|action=["'][^"']+\.php/i, weight: 5 },
  { name: "ASP.NET", re: /\.aspx["'?\s>]|__VIEWSTATE|WebResource\.axd/i, weight: 8 },
  { name: "Ruby on Rails", re: /rails|turbolinks|data-remote=["']true/i, weight: 7 },
  { name: "Laravel", re: /laravel|csrf-token.*content=["'][a-zA-Z0-9+\/]{40}/i, weight: 8 },
];

/**
 * Identify what a custom/unknown site is built with (Bootstrap, PHP, React, etc.)
 * so the UI can show "Custom (Bootstrap + PHP)" rather than just "Unknown".
 * Called ONLY when no known CMS was detected.
 */
function detectCustomPlatform(html: string): Detection {
  if (!html) return { value: "Custom", confidence: "unknown", evidence: ["No CMS fingerprint detected"] };

  // Run all checks, collect those that match, sort by weight (most specific first)
  const found: Array<{ name: string; weight: number; evidence: string }> = [];
  for (const check of CUSTOM_PLATFORM_CHECKS) {
    if (check.re.test(html)) {
      found.push({ name: check.name, weight: check.weight, evidence: `"${check.re.source}" matched in page HTML` });
    }
  }

  if (found.length === 0) {
    return {
      value: "Custom",
      confidence: "unknown",
      evidence: ["No known CMS, framework, or library fingerprints detected; likely a custom-built static site"],
    };
  }

  // Sort descending by weight, keep top 3 for the label (avoid noisy labels like "Bootstrap + jQuery + PHP + React")
  found.sort((a, b) => b.weight - a.weight);
  const top = found.slice(0, 3);
  const label = "Custom (" + top.map((f) => f.name).join(" + ") + ")";

  return {
    value: label,
    confidence: "likely",
    evidence: found.map((f) => f.evidence),
  };
}

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

  // If no CMS was identified, run custom platform detection to determine WHAT
  // the site is built with (Bootstrap, PHP, React, etc.) so the UI can show
  // "Custom (Bootstrap + PHP)" instead of the unhelpful "Unknown".
  if (!cms.value) {
    const custom = detectCustomPlatform(html);
    cms.value = custom.value;
    cms.confidence = custom.confidence;
    cms.evidence = custom.evidence;
  }

  return { cms, builder, ecommerce };
}

export interface ExternalStoreResult {
  platform: string;
  finalUrl: string;
  confidence: Confidence;
  evidence: string[];
}

/**
 * Detect a cross-domain store by fingerprinting the target URL of a shop/store
 * link found in the homepage navbar. Follows redirects (up to 3 hops) and
 * fingerprints the final destination.
 *
 * Example: theagelessclinic.com navbar → agelessxpress.com → ageless.shop
 * (Shopify). Without this, the analyzer reports "No store detected" even though
 * the site has a fully active external shop.
 */
export async function detectExternalStore(externalLinks: string[]): Promise<ExternalStoreResult | null> {
  if (!externalLinks.length) return null;

  const EXTERNAL_ECOMMERCE_FINGERPRINTS: Array<{ name: string; re: RegExp }> = [
    { name: "Shopify", re: /cdn\.shopify\.com|myshopify\.com|Shopify\.shop|shopify-features/i },
    { name: "WooCommerce", re: /woocommerce/i },
    { name: "BigCommerce", re: /bigcommerce\.com/i },
    { name: "Magento", re: /mage\/|Magento_/i },
    { name: "PrestaShop", re: /prestashop/i },
  ];

  for (const link of externalLinks.slice(0, 5)) { // limit to 5 to avoid long tail
    try {
      // Follow redirects to get the final landing URL and HTML
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      let finalUrl = link;
      let html = "";
      try {
        const res = await fetch(link, {
          redirect: "follow",
          signal: ctl.signal,
          headers: { "User-Agent": UA },
        });
        finalUrl = res.url || link;
        if (res.ok) html = await res.text();
      } finally {
        clearTimeout(timer);
      }

      if (!html) continue;

      // Check the final URL itself for common store domain patterns
      const urlLower = finalUrl.toLowerCase();
      if (/shopify\.com|myshopify\.com|\.shop\b/.test(urlLower)) {
        // High-confidence Shopify domain
        const shopifyHtml = EXTERNAL_ECOMMERCE_FINGERPRINTS.find((f) => f.name === "Shopify");
        return {
          platform: "Shopify",
          finalUrl,
          confidence: "high",
          evidence: [`External store URL (${finalUrl}) matches Shopify domain pattern`],
        };
      }

      // Fingerprint HTML for e-commerce markers
      for (const fp of EXTERNAL_ECOMMERCE_FINGERPRINTS) {
        if (fp.re.test(html)) {
          return {
            platform: fp.name,
            finalUrl,
            confidence: "likely",
            evidence: [`"${fp.re.source}" matched in external store HTML (${finalUrl})`],
          };
        }
      }
    } catch {
      // Individual link failure is non-fatal — try the next one
    }
  }

  return null;
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

export function canonicalizeProductSlug(slug: string): string {
  const s = slug.toLowerCase().replace(/\/+$/, "");
  // Collapse gift card variations: gift-card-100, inspire-gift-card-500, etc.
  // Preserves brand/prefix (e.g. "inspire-gift-card" vs "medspa-gift-card"), collapsing only the denomination suffix.
  const giftCardMatch = s.match(/^((?:[a-z0-9]+[-_])*(?:gift[-_]?(?:card|certificate)s?))([-_]\d+)?$/i);
  if (giftCardMatch) {
    return giftCardMatch[1];
  }
  // Collapse size/volume/pack variations: -50ml, -100ml, -small, -large, -30ct, -travel-size
  // Extracts capturing group 1 (the product base slug) before the variation delimiter.
  const variationMatch = s.match(/^(.+?)[-_](?:\d+(?:\.\d+)?(?:oz|fl[-_]?oz|ml|g|mg|kg|lb|lbs|ct|count|pk|pack|capsules|tablets|gummies)|small|medium|large|xl|xxl|travel[-_]?size|full[-_]?size|mini|sample)$/i);
  if (variationMatch) return variationMatch[1];
  return s;
}

export function collapseProductUrls(urls: string[]): Set<string> {
  const unique = new Set<string>();
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      const slug = parsed.pathname.split("/").filter(Boolean).pop() || "";
      unique.add(canonicalizeProductSlug(slug));
    } catch {
      const slug = u.split("/").filter(Boolean).pop() || "";
      unique.add(canonicalizeProductSlug(slug));
    }
  }
  return unique;
}

export interface ApiProduct {
  id?: number;
  slug: string;
  name: string;
  permalink?: string;
  categories: string[];
}

export function extractSlugFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean).pop() || "";
  } catch {
    return url.split("/").filter(Boolean).pop() || "";
  }
}

/**
 * Genuinely derive the set of distinct category names attached to a set of products.
 * If filterUrls is provided, only category names of matching products are included.
 */
export function deriveCategoriesFromProducts(
  products: ApiProduct[],
  filterUrls?: string[]
): Set<string> {
  let targetProducts = products;
  if (filterUrls && filterUrls.length > 0) {
    const targetSlugs = new Set(filterUrls.map((u) => extractSlugFromUrl(u).toLowerCase()));
    targetProducts = products.filter(
      (p) =>
        targetSlugs.has(p.slug.toLowerCase()) ||
        (p.permalink && filterUrls.some((u) => u.replace(/\/+$/, "") === p.permalink?.replace(/\/+$/, "")))
    );
  }
  const categories = new Set<string>();
  for (const p of targetProducts) {
    for (const cat of p.categories) {
      if (cat && typeof cat === "string") {
        categories.add(cat.trim());
      }
    }
  }
  return categories;
}

/**
 * Fetch products and their real categories from WooCommerce Store API or WP REST API.
 */
export async function fetchStoreProducts(origin: string): Promise<ApiProduct[]> {
  try {
    // 1. Try WooCommerce Store API (standard in modern WooCommerce)
    const res = await fetchWithFallback(`${origin}/wp-json/wc/store/v1/products?per_page=100`, {
      timeoutMs: 10000,
      headers: { "User-Agent": UA },
    });
    if (res.ok && res.html) {
      const data = JSON.parse(res.html);
      if (Array.isArray(data) && data.length > 0) {
        return data.map((item: any) => ({
          id: item.id,
          slug: (item.slug || "").toLowerCase(),
          name: item.name || "",
          permalink: item.permalink || "",
          categories: Array.isArray(item.categories)
            ? item.categories.map((c: any) => (c.name || c.slug || "").trim()).filter(Boolean)
            : [],
        }));
      }
    }
  } catch {
    /* fallback to wp/v2 */
  }

  try {
    // 2. Fall back to WP REST API /wp/v2/product + /wp/v2/product_cat
    const [prodRes, catRes] = await Promise.all([
      fetchWithFallback(`${origin}/wp-json/wp/v2/product?per_page=100`, {
        timeoutMs: 10000,
        headers: { "User-Agent": UA },
      }),
      fetchWithFallback(`${origin}/wp-json/wp/v2/product_cat?per_page=100`, {
        timeoutMs: 10000,
        headers: { "User-Agent": UA },
      }),
    ]);

    if (prodRes.ok && prodRes.html) {
      const prods = JSON.parse(prodRes.html);
      const catMap = new Map<number, string>();
      if (catRes.ok && catRes.html) {
        const cats = JSON.parse(catRes.html);
        if (Array.isArray(cats)) {
          for (const c of cats) {
            if (c.id && c.name) catMap.set(c.id, c.name.trim());
          }
        }
      }

      if (Array.isArray(prods) && prods.length > 0) {
        return prods.map((item: any) => ({
          id: item.id,
          slug: (item.slug || "").toLowerCase(),
          name: item.title?.rendered || item.name || "",
          permalink: item.link || "",
          categories: Array.isArray(item.product_cat)
            ? item.product_cat.map((id: number) => catMap.get(id) || "").filter(Boolean)
            : [],
        }));
      }
    }
  } catch {
    /* no api products available */
  }

  return [];
}

export function detectStore(
  counts: Record<string, number>,
  ecommerce: Detection,
  shopHtml?: string,
  productUrls?: string[],
  apiProducts: ApiProduct[] = []
): StoreResult {
  const rawCategoryCount = counts.product_cat || 0;

  // Extract products and categories directly from the customer-visible shop storefront if available
  let storefrontProductUrls: string[] = [];
  let shopCategoryUrls: string[] = [];
  let hasPaginationOrCategories = false;

  if (shopHtml) {
    const shopMatches = [...shopHtml.matchAll(/href=["'](https?:\/\/[^"']*\/product\/[^"'?#]+)\/?["']/gi)];
    storefrontProductUrls = [...new Set(shopMatches.map((m) => m[1].replace(/\/+$/, "")))];

    const catMatches = [...shopHtml.matchAll(/href=["'](https?:\/\/[^"']*\/product-category\/[^"'?#]+)\/?["']/gi)];
    shopCategoryUrls = [...new Set(catMatches.map((m) => m[1].replace(/\/+$/, "")))];

    hasPaginationOrCategories =
      /page\/\d+|next page-numbers|woocommerce-pagination/i.test(shopHtml) ||
      shopCategoryUrls.length > 0;
  }

  let productCount = 0;
  let categoryCount = 0;

  if (storefrontProductUrls.length > 0 && !hasPaginationOrCategories) {
    // Single landing storefront (e.g. Elementor gift cards page) — exact customer-visible catalog
    const collapsed = collapseProductUrls(storefrontProductUrls);
    productCount = collapsed.size;

    // Derive categoryCount from the distinct set of real category names
    // attached to the SAME visible/collapsed product list used for productCount.
    if (apiProducts.length > 0) {
      categoryCount = deriveCategoriesFromProducts(apiProducts, storefrontProductUrls).size;
    } else if (shopCategoryUrls.length > 0) {
      categoryCount = shopCategoryUrls.length;
    } else {
      categoryCount = rawCategoryCount;
    }
  } else if (hasPaginationOrCategories) {
    // Multi-page store with pagination or category archive links:
    // Storefront page 1 does NOT contain the full catalog. Fall back to all discovered products
    // from sitemaps/crawling, or the raw product count from sitemap/API.
    if (productUrls && productUrls.length > 0) {
      productCount = collapseProductUrls(productUrls).size;
    }
    if (counts.product && counts.product > productCount) {
      productCount = counts.product;
    }

    // Derive categoryCount from real category data across the fallback product set
    if (apiProducts.length > 0) {
      categoryCount = deriveCategoriesFromProducts(apiProducts).size;
    } else if (shopCategoryUrls.length > 0) {
      categoryCount = shopCategoryUrls.length;
    } else {
      categoryCount = rawCategoryCount;
    }
  } else if (productUrls && productUrls.length > 0) {
    productCount = collapseProductUrls(productUrls).size;
    if (apiProducts.length > 0) {
      categoryCount = deriveCategoriesFromProducts(apiProducts, productUrls).size;
    } else {
      categoryCount = rawCategoryCount || shopCategoryUrls.length;
    }
  } else if (storefrontProductUrls.length > 0) {
    productCount = collapseProductUrls(storefrontProductUrls).size;
    if (apiProducts.length > 0) {
      categoryCount = deriveCategoriesFromProducts(apiProducts, storefrontProductUrls).size;
    } else {
      categoryCount = shopCategoryUrls.length || rawCategoryCount;
    }
  } else {
    productCount = counts.product || 0;
    if (apiProducts.length > 0) {
      categoryCount = deriveCategoriesFromProducts(apiProducts).size;
    } else {
      categoryCount = rawCategoryCount;
    }
  }

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
