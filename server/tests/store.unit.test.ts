import {
  canonicalizeProductSlug,
  collapseProductUrls,
  detectStore,
  deriveCategoriesFromProducts,
  type ApiProduct,
} from "../src/analyzer/platform.js";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${message}`);
}

console.log("--- Testing canonicalizeProductSlug base-slug grouping ---");

// 1. Confirm two DIFFERENT products with the SAME suffix DO NOT merge
const slugA = canonicalizeProductSlug("retinol-serum-50ml");
const slugB = canonicalizeProductSlug("hydrating-cleanser-50ml");
assert(slugA === "retinol-serum", `Expected "retinol-serum", got "${slugA}"`);
assert(slugB === "hydrating-cleanser", `Expected "hydrating-cleanser", got "${slugB}"`);
assert(slugA !== slugB, "Different products with same suffix (-50ml) MUST have distinct canonical slugs");

const collapsedDifferent = collapseProductUrls([
  "https://example.com/product/retinol-serum-50ml",
  "https://example.com/product/retinol-serum-100ml",
  "https://example.com/product/hydrating-cleanser-50ml",
]);
assert(collapsedDifferent.size === 2, `Expected 2 distinct products, got ${collapsedDifferent.size}`);
assert(collapsedDifferent.has("retinol-serum"), "Should have retinol-serum");
assert(collapsedDifferent.has("hydrating-cleanser"), "Should have hydrating-cleanser");

// 2. Size / volume / count variations collapse into the same base product
assert(canonicalizeProductSlug("daily-moisturizer-travel-size") === "daily-moisturizer", "travel-size variation");
assert(canonicalizeProductSlug("daily-moisturizer-full-size") === "daily-moisturizer", "full-size variation");
assert(canonicalizeProductSlug("collagen-peptides-30ct") === "collagen-peptides", "30ct count variation");
assert(canonicalizeProductSlug("collagen-peptides-60ct") === "collagen-peptides", "60ct count variation");
assert(canonicalizeProductSlug("face-cream-small") === "face-cream", "small size variation");
assert(canonicalizeProductSlug("face-cream-large") === "face-cream", "large size variation");

// 3. Gift cards collapse denominations into 1 product
assert(canonicalizeProductSlug("gift-card-50") === "gift-card", "gift-card-50 collapses");
assert(canonicalizeProductSlug("gift-card-100") === "gift-card", "gift-card-100 collapses");
assert(canonicalizeProductSlug("gift-card-500") === "gift-card", "gift-card-500 collapses");
assert(canonicalizeProductSlug("inspire-gift-card-50") === "inspire-gift-card", "inspire-gift-card-50 collapses");
assert(canonicalizeProductSlug("inspire-gift-card-100") === "inspire-gift-card", "inspire-gift-card-100 collapses");

const collapsedGiftCards = collapseProductUrls([
  "https://inspiremedicalspas.com/product/gift-card-50/",
  "https://inspiremedicalspas.com/product/gift-card-100/",
  "https://inspiremedicalspas.com/product/gift-card-500/",
  "https://inspiremedicalspas.com/product/gift-card-1000/",
]);
assert(collapsedGiftCards.size === 1, `Expected 1 gift card product, got ${collapsedGiftCards.size}`);

console.log("\n--- Testing deriveCategoriesFromProducts ---");

const testApiProducts: ApiProduct[] = [
  { slug: "gift-card-50", name: "Gift Card $50", categories: ["Gift Cards"] },
  { slug: "gift-card-100", name: "Gift Card $100", categories: ["Gift Cards"] },
  { slug: "gift-card-500", name: "Gift Card $500", categories: ["Gift Cards"] },
  { slug: "gift-card-1000", name: "Gift Card $1000", categories: ["Gift Cards"] },
  { slug: "keep-it-glassy", name: "Keep it Glassy", categories: ["Holiday Glow"] },
  { slug: "blemish-free", name: "Blemish Free", categories: ["Holiday Glow"] },
  { slug: "perfect-glow", name: "Perfect Glow", categories: ["Holiday Glow"] },
  { slug: "tox-alicious", name: "TOX-alicious", categories: ["Holiday Glow"] },
];

// Visible set: only gift cards
const visibleGiftCardUrls = [
  "https://inspiremedicalspas.com/product/gift-card-50/",
  "https://inspiremedicalspas.com/product/gift-card-100/",
  "https://inspiremedicalspas.com/product/gift-card-500/",
  "https://inspiremedicalspas.com/product/gift-card-1000/",
];
const derivedVisible = deriveCategoriesFromProducts(testApiProducts, visibleGiftCardUrls);
assert(derivedVisible.size === 1, `Expected 1 category for visible gift cards, got ${derivedVisible.size}`);
assert(derivedVisible.has("Gift Cards"), "Category must be Gift Cards");
assert(!derivedVisible.has("Holiday Glow"), "Holiday Glow must not be present in visible set");

// Multi-product store: 20 products across 4 categories
const multiCatalog: ApiProduct[] = [
  ...Array.from({ length: 5 }, (_, i) => ({ slug: `cleanser-${i}`, name: `Cleanser ${i}`, categories: ["Cleansers"] })),
  ...Array.from({ length: 5 }, (_, i) => ({ slug: `serum-${i}`, name: `Serum ${i}`, categories: ["Serums"] })),
  ...Array.from({ length: 5 }, (_, i) => ({ slug: `cream-${i}`, name: `Cream ${i}`, categories: ["Moisturizers"] })),
  ...Array.from({ length: 5 }, (_, i) => ({ slug: `sunscreen-${i}`, name: `Sunscreen ${i}`, categories: ["Sun Care"] })),
];
const derivedMulti = deriveCategoriesFromProducts(multiCatalog);
assert(derivedMulti.size === 4, `Expected 4 categories for 20 products across 4 categories, got ${derivedMulti.size}`);

// Fallback set: all 8 products
const derivedFallback = deriveCategoriesFromProducts(testApiProducts);
assert(derivedFallback.size === 2, `Expected 2 categories across full fallback catalog, got ${derivedFallback.size}`);
assert(derivedFallback.has("Gift Cards") && derivedFallback.has("Holiday Glow"), "Fallback should have both categories");

console.log("\n--- Testing detectStore behavior ---");

// 4. Single-page curated storefront (like inspiremedicalspas.com)
const singlePageHtml = `
  <html><body>
    <div class="elementor-widget">
      <a href="https://inspiremedicalspas.com/product/gift-card-50/">Gift Card $50</a>
      <a href="https://inspiremedicalspas.com/product/gift-card-100/">Gift Card $100</a>
      <a href="https://inspiremedicalspas.com/product/gift-card-500/">Gift Card $500</a>
      <a href="https://inspiremedicalspas.com/product/gift-card-1000/">Gift Card $1000</a>
    </div>
  </body></html>
`;
const storeResult = detectStore(
  { product: 8, product_cat: 0 },
  { value: "WooCommerce", confidence: "high", evidence: [] },
  singlePageHtml,
  [
    "https://inspiremedicalspas.com/product/gift-card-50/",
    "https://inspiremedicalspas.com/product/gift-card-100/",
    "https://inspiremedicalspas.com/product/gift-card-500/",
    "https://inspiremedicalspas.com/product/gift-card-1000/",
    "https://inspiremedicalspas.com/product/keep-it-glassy/",
    "https://inspiremedicalspas.com/product/blemish-free/",
    "https://inspiremedicalspas.com/product/perfect-glow/",
    "https://inspiremedicalspas.com/product/tox-alicious/",
  ],
  testApiProducts
);
assert(storeResult.productCount === 1, `Single-page curated store productCount should be 1, got ${storeResult.productCount}`);
assert(storeResult.categoryCount === 1, `Single-page curated store categoryCount should be 1 (genuinely derived "Gift Cards"), got ${storeResult.categoryCount}`);

// 5. Multi-page catalog with pagination (does NOT undercount to page 1)
const paginatedHtml = `
  <html><body>
    <div class="products">
      <a href="https://example.com/product/item-1/">Item 1</a>
      <a href="https://example.com/product/item-2/">Item 2</a>
    </div>
    <nav class="woocommerce-pagination">
      <ul class="page-numbers">
        <li><span class="current">1</span></li>
        <li><a class="page-numbers" href="https://example.com/shop/page/2/">2</a></li>
        <li><a class="page-numbers" href="https://example.com/shop/page/3/">3</a></li>
      </ul>
    </nav>
  </body></html>
`;
const allDiscoveredProducts = Array.from({ length: 30 }, (_, i) => `https://example.com/product/item-${i + 1}/`);
const multiPageStoreResult = detectStore(
  { product: 30, product_cat: 4 },
  { value: "WooCommerce", confidence: "high", evidence: [] },
  paginatedHtml,
  allDiscoveredProducts
);
assert(multiPageStoreResult.productCount === 30, `Multi-page store should NOT be clamped to page 1 (2 items), got ${multiPageStoreResult.productCount}`);
assert(multiPageStoreResult.categoryCount === 4, `Multi-page store categoryCount should be 4, got ${multiPageStoreResult.categoryCount}`);

console.log("\nAll store unit tests passed successfully!");
