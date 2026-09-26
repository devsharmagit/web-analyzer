import { oneLineSummary } from "./summarize";
import type { AnalyzeResult, StoreResult, BeforeAfterGalleryResult, ProvidersResult, ClassifiedUrl } from "./api";

function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const ASSET_RE = /\.(xml|kml|jpe?g|png|webp|gif|svg|pdf|css|js|ico|zip|mp4|webm|json|webmanifest|md|txt|csv|woff2?|ttf|otf|eot|fon|ttc|mp3|wav|ogg|m4a|avi|mov)(?:[?#/]|$)/i;
export const ASSET_URL_RE = ASSET_RE;
const SHOP_UTILITY_RE = /\/(cart|checkout|my-account|order-tracking|wishlist|account|basket)(\/|$)/i;

function formatLabel(str: string): string {
  if (!str) return "Clinical Gallery";
  if (str.toLowerCase() === "locations") return "Local SEO Pages";
  const words = str.replace(/[-_]+/g, " ").trim().split(" ");
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

function extractProcedureName(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts.pop() || "";
    const cleanLast = last.replace(/\.[a-z0-9]+$/i, "");
    
    // Look for procedure slug in pathname (ignoring CMS tech folders, years, months)
    for (const p of parts) {
      const low = p.toLowerCase();
      if (
        !["wp-content", "uploads", "photo", "photos", "gallery", "galleries", "before-after", "beforeafter", "ba", "cases", "case", "images", "image", "media"].includes(low) &&
        !/^\d{1,4}$/.test(low)
      ) {
        return formatLabel(p);
      }
    }
    
    const candidate = cleanLast
      .replace(/[-_]?(?:before|after|ba|case|\d{1,4}|front|side|three-quarter|angle).*$/i, "")
      .replace(/^[\d-_]+/, "");
    return formatLabel(candidate || cleanLast);
  } catch {
    return "Clinical Photo";
  }
}

// ---- Sales Angle Interpretive Helpers (Part 4) -----------------------------

function getECommerceInterpretiveLine(store: StoreResult): string | null {
  const hasThirdParty = Boolean(store.isThirdParty || (store.thirdPartyIntegrations && store.thirdPartyIntegrations.length > 0));
  const partners = store.thirdPartyIntegrations && store.thirdPartyIntegrations.length > 0
    ? store.thirdPartyIntegrations.join(", ")
    : "external partner portals";

  // Case 1: Both native store AND third-party partner fulfillment
  if (store.hasStore && hasThirdParty) {
    if (store.productCount > 0 && store.productCount <= 15) {
      return `Small in-house catalog (${store.productCount} products) paired with third-party fulfillment via ${partners} — hybrid e-commerce setup.`;
    }
    if (store.productCount > 15) {
      return `Active in-house catalog (${store.productCount} products) alongside third-party fulfillment via ${partners} — established hybrid sales channel.`;
    }
    return `Native store infrastructure alongside third-party fulfillment via ${partners} — external online purchase paths.`;
  }

  // Case 2: Native store only
  if (store.hasStore) {
    if (store.productCount > 0 && store.productCount <= 15) {
      return `Small in-house catalog (${store.productCount} products) — limited e-commerce footprint.`;
    }
    if (store.productCount > 15) {
      return `Active in-house catalog (${store.productCount} products) — established direct online storefront.`;
    }
    if (store.platform) {
      return `Installed storefront (${store.platform}) with no active products published.`;
    }
  }

  // Case 3: Third-party only
  if (hasThirdParty) {
    return `Products fulfilled via ${partners} rather than a native store — no direct online purchase path on-site.`;
  }

  return null;
}

function getGalleryInterpretiveLine(gallery: BeforeAfterGalleryResult): string {
  const hasGallery = gallery.imageCount > 0 || (gallery.images && gallery.images.length > 0) || (!!gallery.pageUrl && gallery.confidence !== "unknown");
  if (hasGallery) {
    if (typeof gallery.caseCount === "number" && gallery.caseCount > 0) {
      return `Active gallery with ${gallery.caseCount} patient cases — usable as visible social proof.`;
    }
    if (gallery.imageCount > 0) {
      return `Active gallery with ${gallery.imageCount} clinical photos — usable as visible social proof.`;
    }
    return "Active before-and-after gallery identified — usable as visible social proof.";
  }
  return "No before-and-after gallery found — a gap compared to clinics that lead with visual results.";
}

function getProvidersInterpretiveLine(providers: ProvidersResult): string | null {
  const total = providers.list.length;
  if (total === 0) return null;

  let physicianCount = 0;
  const physicianTypes: string[] = [];
  let npCount = 0;
  let paCount = 0;
  let rnCount = 0;
  let estheticianCount = 0;

  for (const p of providers.list) {
    const text = `${p.credentials || ""} ${p.role || ""}`.toUpperCase();
    if (/\b(MD|DO)\b/.test(text) || /\b(PHYSICIAN|SURGEON|DOCTOR|MEDICAL DIRECTOR)\b/.test(text)) {
      physicianCount++;
      if (/\bMD\b/.test(text) && !physicianTypes.includes("MD")) physicianTypes.push("MD");
      if (/\bDO\b/.test(text) && !physicianTypes.includes("DO")) physicianTypes.push("DO");
    } else if (/\b(FNP|NP|NURSE PRACTITIONER|APRN)\b/.test(text)) {
      npCount++;
    } else if (/\b(PA|PA-C|PHYSICIAN ASSISTANT)\b/.test(text)) {
      paCount++;
    } else if (/\b(RN|REGISTERED NURSE)\b/.test(text)) {
      rnCount++;
    } else if (/\b(LME|LE|ESTHETICIAN|AESTHETICIAN)\b/.test(text)) {
      estheticianCount++;
    }
  }

  if (physicianCount > 0) {
    const creds = physicianTypes.length > 0 ? ` (${physicianTypes.join("/")})` : "";
    return `${total} licensed providers on staff, including ${physicianCount} physician-level credential${physicianCount === 1 ? "" : "s"}${creds}.`;
  }

  const clinicalRoles: string[] = [];
  if (npCount > 0) clinicalRoles.push("nurse practitioner");
  if (paCount > 0) clinicalRoles.push("physician assistant");
  if (rnCount > 0) clinicalRoles.push("registered nurse");
  if (estheticianCount > 0) clinicalRoles.push("aesthetician");

  if (clinicalRoles.length > 0) {
    const roleList = clinicalRoles.length === 1
      ? clinicalRoles[0]
      : clinicalRoles.length === 2
        ? `${clinicalRoles[0]} and ${clinicalRoles[1]}`
        : `${clinicalRoles.slice(0, -1).join(", ")}, and ${clinicalRoles[clinicalRoles.length - 1]}`;
    return `${total} providers on staff, with clinical services delivered by ${roleList} roles.`;
  }

  return `${total} staff profiles listed across clinical and practice operations.`;
}

function getOffersInterpretiveLine(offersBucket: { count: number; urls: ClassifiedUrl[] } | undefined): string | null {
  if (!offersBucket || !offersBucket.urls || offersBucket.urls.length === 0) return null;
  const hasMembership = offersBucket.urls.some(u => /membership|vip|club/i.test(u.url));
  const hasFinancing = offersBucket.urls.some(u => /financ|cherry|payment[-_]?plan/i.test(u.url));
  const hasReferral = offersBucket.urls.some(u => /refer/i.test(u.url));

  const items: string[] = [];
  if (hasFinancing) items.push("financing");
  if (hasMembership) items.push("membership options");
  if (hasReferral) items.push("referral incentives");
  if (items.length === 0) items.push("special promotions");

  const leadIn = items.length === 1
    ? items[0]
    : items.length === 2
      ? `${items[0]} and ${items[1]}`
      : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;

  return `Offers ${leadIn} (${offersBucket.urls.length} page${offersBucket.urls.length === 1 ? "" : "s"}) — signals price-sensitive positioning.`;
}

/** @deprecated – kept for backwards compatibility; use generateStandaloneReport instead */
export const REPORT_CSS = ``;

export function generateReportHtml(result: AnalyzeResult, options?: { standalone?: boolean }): string {
  const standalone = options?.standalone ?? false;
  const { url, platform, pages, store, providers, locations, beforeAfterGallery, crawl } = result;
  const generatedAt = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  // Sanitize pages.byType so asset/font URLs never enter the taxonomy counts or display
  const sanitizedByType: Record<string, { count: number; urls: ClassifiedUrl[] }> = {};
  let totalUrls = 0;
  for (const [key, bucket] of Object.entries(pages.byType)) {
    const cleanUrls = (bucket.urls || []).filter(u => !ASSET_URL_RE.test(u.url));
    if (cleanUrls.length > 0) {
      sanitizedByType[key] = {
        count: cleanUrls.length,
        urls: cleanUrls,
      };
      totalUrls += cleanUrls.length;
    }
  }
  const categoriesCount = Object.keys(sanitizedByType).length;

  const cmsName = platform.cms.value || "Custom / Jamstack";
  const builderName = platform.builder.value;
  const storeStatus = store.isThirdParty
    ? `Third-Party Integration (${store.thirdPartyIntegrations?.join(", ") || "External"})`
    : store.hasStore 
      ? `Active (${store.platform || "Custom"}, ${store.productCount} products)` 
      : store.platform 
        ? `Installed (${store.platform})` 
        : "None detected";
  
  const providersCountText = providers.count === "unknown" 
    ? "Unknown" 
    : providers.count === 0 
      ? "None detected" 
      : `${providers.count} Provider${providers.count === 1 ? "" : "s"}`;

  // Gallery detection state (Part 1.2)
  const hasGallery = (beforeAfterGallery.imageCount > 0) || (beforeAfterGallery.images && beforeAfterGallery.images.length > 0) || (!!beforeAfterGallery.pageUrl && beforeAfterGallery.confidence !== "unknown");
  const baCasesText = hasGallery
    ? typeof beforeAfterGallery.caseCount === "number"
      ? `${beforeAfterGallery.caseCount} Cases`
      : beforeAfterGallery.imageCount > 0
        ? `${beforeAfterGallery.imageCount} Photos`
        : "Gallery Identified"
    : "None detected";

  // Interpretive lines (Part 4)
  const ecomInterpretiveLine = getECommerceInterpretiveLine(store);
  const galleryInterpretiveLine = getGalleryInterpretiveLine(beforeAfterGallery);
  const providersInterpretiveLine = getProvidersInterpretiveLine(providers);
  const offersInterpretiveLine = getOffersInterpretiveLine(sanitizedByType["offers"]);

  // Section: Platform & Technology Stack (Part 2: stripped technical signal evidence strings and crawl audit card)
  const platformHtml = `
    <div style="display: flex; flex-wrap: wrap; gap: 24px; margin-bottom: 32px;">
      <div class="pdf-card pdf-avoid-break" style="width: calc(50% - 12px); box-sizing: border-box; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.06em; color: #64748b; margin-bottom: 4px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;">Content Management System</div>
        <div style="font-size: 16px; font-weight: 700; color: #0f172a; margin: 8px 0 4px 0;">${escapeHtml(cmsName)}</div>
        <div style="font-size: 11px; color: #475569;">Confidence: <strong>${escapeHtml(platform.cms.confidence.toUpperCase())}</strong></div>
      </div>
      <div class="pdf-card pdf-avoid-break" style="width: calc(50% - 12px); box-sizing: border-box; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.06em; color: #64748b; margin-bottom: 4px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;">Page Builder / Framework</div>
        <div style="font-size: 16px; font-weight: 700; color: #0f172a; margin: 8px 0 4px 0;">${escapeHtml(builderName || "Native Theme / Standard")}</div>
        <div style="font-size: 11px; color: #475569;">Confidence: <strong>${escapeHtml(platform.builder.confidence.toUpperCase())}</strong></div>
      </div>
      <div class="pdf-card pdf-avoid-break" style="width: 100%; box-sizing: border-box; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.06em; color: #64748b; margin-bottom: 4px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;">E-Commerce Architecture</div>
        <div style="font-size: 16px; font-weight: 700; color: #0f172a; margin: 8px 0 4px 0;">${escapeHtml(storeStatus)}</div>
        ${store.isThirdParty 
          ? `<div style="font-size: 11px; color: #64748b; line-height: 1.5;">${escapeHtml(store.notes || "Products are fulfilled via external partner portals rather than a native self-hosted cart.")}</div>`
          : store.hasStore 
            ? `<div style="font-size: 11px; color: #64748b; line-height: 1.5;">Catalog: ${store.productCount} product${store.productCount === 1 ? "" : "s"} in native storefront${store.categoryCount > 0 ? ` across ${store.categoryCount} categor${store.categoryCount === 1 ? "y" : "ies"}` : ""}</div>` 
            : ""}
        ${store.thirdPartyIntegrations && store.thirdPartyIntegrations.length > 0
          ? `<div style="font-size: 11px; color: #64748b; line-height: 1.5; margin-top: 2px;">Partner Brands: ${escapeHtml(store.thirdPartyIntegrations.join(", "))} (external fulfillment links)</div>`
          : ""}
        ${ecomInterpretiveLine ? `<div style="font-size: 11.5px; color: #334155; font-weight: 500; margin-top: 8px; border-top: 1px solid #f1f5f9; padding-top: 6px; line-height: 1.4;">${escapeHtml(ecomInterpretiveLine)}</div>` : ""}
      </div>
    </div>`;

  // Section: Providers & Medical Staff
  let providersHtml = "";
  if (providers.list.length > 0) {
    providersHtml = `<div style="display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 24px;">` + providers.list.map(p => `
      <div class="pdf-card provider-card pdf-avoid-break" style="width: calc(50% - 8px); padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; box-sizing: border-box; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">
          ${escapeHtml(p.name)}${p.credentials ? `<span style="font-size: 11px; font-weight: 500; color: #475569; margin-left: 6px;">${escapeHtml(p.credentials)}</span>` : ""}
        </div>
        ${p.role ? `<div style="font-size: 12px; color: #475569;">${escapeHtml(p.role)}</div>` : ""}
      </div>`
    ).join("") + `</div>`;
  } else {
    providersHtml = `<div class="pdf-avoid-break" style="color: #64748b; font-size: 13px; font-style: italic; margin-bottom: 24px;">No provider profiles detected.${providers.reason ? ` ${escapeHtml(providers.reason)}` : ""}</div>`;
  }

  // Section: Locations & Contact Directory
  let locationsHtml = "";
  if (locations.list.length > 0) {
    locationsHtml = `<div style="display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 32px;">` + locations.list.map((l, i) => `
      <div class="pdf-card location-card pdf-avoid-break" style="width: calc(50% - 8px); padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 2px;">${escapeHtml(l.name || `Clinic Location #${i + 1}`)}</div>
        ${l.address ? `
          <div style="font-size: 12px; color: #475569; line-height: 1.5;">
            <strong style="color: #0f172a; font-weight: 600;">Address:</strong> ${escapeHtml(l.address)}
          </div>` : ""}
        ${l.phone ? `
          <div style="font-size: 12px; color: #475569; line-height: 1.5;">
            <strong style="color: #0f172a; font-weight: 600;">Telephone:</strong> ${escapeHtml(l.phone)}
          </div>` : ""}
      </div>
    `).join("") + `</div>`;
  } else {
    locationsHtml = `<div class="pdf-avoid-break" style="color: #64748b; font-size: 13px; font-style: italic; margin-bottom: 32px;">No physical locations were extracted from the site navigation.${locations.reason ? ` Note: ${escapeHtml(locations.reason)}` : ""}</div>`;
  }

  // Section: Before & After Clinical Results Gallery (Part 1.2: single clean state, no contradictory fields)
  let baHtml = "";
  if (hasGallery) {
    const photosCount = beforeAfterGallery.imageCount || beforeAfterGallery.images?.length || 0;
    const galleryHeadline = typeof beforeAfterGallery.caseCount === "number"
      ? `${beforeAfterGallery.caseCount} distinct patient case${beforeAfterGallery.caseCount === 1 ? "" : "s"}`
      : `${photosCount} clinical photograph${photosCount === 1 ? "" : "s"}`;

    baHtml += `
      <div class="pdf-ba-banner pdf-avoid-break" style="border: 1px solid #e2e8f0; border-left: 3px solid #94a3b8; padding: 18px 24px; margin-bottom: 16px; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 6px;">
          Gallery detected — ${galleryHeadline}
        </div>
        ${beforeAfterGallery.pageUrl ? `<div style="font-size: 12px; color: #475569;"><strong>Source Gallery Page:</strong> <a href="${escapeHtml(beforeAfterGallery.pageUrl)}" target="_blank" style="color: #2563eb; text-decoration: none;">${escapeHtml(beforeAfterGallery.pageUrl)}</a></div>` : ""}
      </div>
      <div class="pdf-avoid-break" style="font-size: 12px; color: #334155; font-weight: 500; margin-bottom: 24px; padding: 10px 14px; background: #f8fafc; border-left: 3px solid #94a3b8; line-height: 1.5; page-break-inside: avoid; break-inside: avoid;">
        ${escapeHtml(galleryInterpretiveLine)}
      </div>`;

    if (beforeAfterGallery.images && beforeAfterGallery.images.length > 0) {
      const grouped: Record<string, string[]> = {};
      beforeAfterGallery.images.forEach(imgUrl => {
        const proc = extractProcedureName(imgUrl);
        if (!grouped[proc]) grouped[proc] = [];
        grouped[proc].push(imgUrl);
      });

      baHtml += `
        <div style="margin-bottom: 32px;">
          <div style="font-size: 12px; font-weight: 600; color: #0f172a; margin-bottom: 16px;">Gallery images — grouped by procedure</div>` +
          Object.entries(grouped).map(([proc, urls]) => `
            <div class="pdf-avoid-break" style="margin-bottom: 16px; page-break-inside: avoid; break-inside: avoid;">
              <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; margin-bottom: 8px;">${escapeHtml(proc)} <span style="font-weight: 400; color: #94a3b8; margin-left: 8px;">${urls.length} image${urls.length > 1 ? "s" : ""}</span></div>
              <div style="display: flex; flex-direction: column; gap: 4px;">${
                urls.map((u, i) => `<div style="font-size: 11px; font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; color: #475569; word-break: break-all;">${i + 1}. <a href="${escapeHtml(u)}" target="_blank" style="color: #475569; text-decoration: none;">${escapeHtml(u)}</a></div>`).join("")
              }</div>
            </div>`
          ).join("") +
        `</div>`;
    }
  } else {
    baHtml += `
      <div class="pdf-avoid-break" style="color: #64748b; font-size: 13px; font-style: italic; margin-bottom: 12px;">No before-and-after gallery identified on this website.</div>
      <div class="pdf-avoid-break" style="font-size: 12px; color: #334155; font-weight: 500; margin-bottom: 28px; padding: 10px 14px; background: #f8fafc; border-left: 3px solid #94a3b8; line-height: 1.5; page-break-inside: avoid; break-inside: avoid;">
        ${escapeHtml(galleryInterpretiveLine)}
      </div>`;
  }

  // Section: Website Architecture & Full URL Sitemap (Part 1.3: "Local SEO Pages", Part 1.4: Shop storefront vs utility sub-labeling, Part 3: all URLs retained in full)
  const byType = Object.entries(sanitizedByType)
    .filter(([_, bucket]) => bucket.urls && bucket.urls.length > 0)
    .sort((a, b) => b[1].count - a[1].count);

  let sitemapHtml = `
    <div style="display: flex; flex-direction: column; gap: 32px; margin-bottom: 40px;">
      <div class="sitemap-intro pdf-avoid-break" style="font-size: 13px; color: #475569; line-height: 1.6; border-left: 3px solid #cbd5e1; padding: 12px 20px; page-break-inside: avoid; break-inside: avoid;">
        A total of <strong style="color: #0f172a;">${totalUrls} categorized pages</strong> were mapped across <strong style="color: #0f172a;">${byType.length} taxonomy categories</strong>. Every URL below is fully interactive and clickable.
      </div>`;

  byType.forEach(([typeKey, bucket]) => {
    const isShop = typeKey === "shop";
    const storefrontUrls = isShop ? bucket.urls.filter(u => !SHOP_UTILITY_RE.test(u.url)) : bucket.urls;
    const utilityUrls = isShop ? bucket.urls.filter(u => SHOP_UTILITY_RE.test(u.url)) : [];

    const countDisplay = isShop && utilityUrls.length > 0
      ? `${storefrontUrls.length} storefront page${storefrontUrls.length === 1 ? "" : "s"} (${bucket.count} total incl. account plumbing)`
      : `${bucket.count} page${bucket.count === 1 ? "" : "s"}`;

    sitemapHtml += `
      <div class="url-group pdf-avoid-break" style="page-break-inside: avoid; break-inside: avoid;">
        <div style="padding-bottom: 8px; margin-bottom: 12px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: baseline;">
          <span style="font-size: 14px; font-weight: 700; color: #0f172a;">${escapeHtml(formatLabel(typeKey))}</span>
          <span style="font-size: 11px; font-weight: 700; color: #64748b; letter-spacing: 0.05em; text-transform: uppercase;">${countDisplay}</span>
        </div>
        ${typeKey === "offers" && offersInterpretiveLine ? `
          <div style="font-size: 11.5px; color: #334155; font-weight: 500; margin-bottom: 12px; padding: 8px 12px; background: #f8fafc; border-left: 3px solid #94a3b8; line-height: 1.4;">
            ${escapeHtml(offersInterpretiveLine)}
          </div>` : ""}
        <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
          <tbody>` +
          bucket.urls.map((uObj) => {
            const u = uObj.url;
            let pathDisplay = u;
            try {
              const parsed = new URL(u);
              pathDisplay = parsed.pathname + parsed.search;
              if (pathDisplay.length > 55) pathDisplay = pathDisplay.slice(0, 52) + "...";
            } catch {
              pathDisplay = u;
            }

            let subTagHtml = "";
            if (isShop) {
              const isUtil = SHOP_UTILITY_RE.test(u);
              subTagHtml = isUtil
                ? `<span style="display: inline-block; font-size: 9px; font-weight: 600; text-transform: uppercase; color: #64748b; background: #f1f5f9; padding: 1px 6px; border-radius: 4px; margin-left: 6px; vertical-align: middle;">Utility</span>`
                : `<span style="display: inline-block; font-size: 9px; font-weight: 600; text-transform: uppercase; color: #0f766e; background: #ccfbf1; padding: 1px 6px; border-radius: 4px; margin-left: 6px; vertical-align: middle;">Storefront</span>`;
            }

            return `
            <tr style="border-bottom: 1px solid #f1f5f9; page-break-inside: avoid; break-inside: avoid;">
              <td style="padding: 10px 0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #0f172a; font-weight: 600; width: 40%; word-break: break-all;" title="${escapeHtml(u)}">
                ${escapeHtml(pathDisplay)}
                ${subTagHtml}
              </td>
              <td style="padding: 10px 0 10px 16px; width: 60%; word-break: break-all;">
                <a href="${escapeHtml(u)}" target="_blank" style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 10.5px; color: #475569; text-decoration: none;">${escapeHtml(u)}</a>
              </td>
            </tr>`;
          }).join("") + `
          </tbody>
        </table>
      </div>`;
  });
  sitemapHtml += `</div>`;

  // Warnings (filtered of technical sitemap noise)
  const visibleWarnings = crawl.warnings.filter(w => !/sitemap/i.test(w));
  const warningsHtml = visibleWarnings.length > 0
    ? `<div class="pdf-warning-box pdf-avoid-break" style="border: 1px solid #e2e8f0; border-left: 3px solid #94a3b8; padding: 20px 24px; margin-top: 32px; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 11px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 12px; letter-spacing: 0.05em;">Analysis Advisory & Notice</div>
        <ul style="margin: 0; padding-left: 18px; font-size: 13px; color: #1e293b; line-height: 1.6;">
          ${visibleWarnings.map(w => `<li style="margin-bottom: 6px;">${escapeHtml(w)}</li>`).join("")}
        </ul>
      </div>`
    : "";

  const bodyHtml = `
<div class="pdf-report-root" style="width: 100%; max-width: 700px; margin: 0 auto; background: #ffffff; color: #1e293b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 13px; line-height: 1.6; box-sizing: border-box; padding: 0;">
  
  <!-- Executive Cover Header -->
  <header class="report-header pdf-avoid-break" style="background: #ffffff; border: 1px solid #e2e8f0; border-top: 4px solid #0f172a; padding: 40px 48px; margin-bottom: 32px; page-break-inside: avoid; break-inside: avoid;">
    <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #64748b; margin-bottom: 12px;">Confidential Intelligence Audit</div>
    <h1 style="font-size: 28px; font-weight: 800; line-height: 1.25; margin: 0 0 12px 0; color: #0f172a; letter-spacing: -0.02em; word-break: break-all;">${escapeHtml(url)}</h1>
    <p style="font-size: 14px; color: #475569; margin: 0 0 24px 0; line-height: 1.6;">Deep architectural analysis, clinical taxonomy, and digital footprint audit</p>
    
    <div style="display: flex; flex-wrap: wrap; gap: 24px; margin-top: 24px; padding-top: 24px; border-top: 1px solid #f1f5f9; font-size: 12px; color: #475569;">
      <div><strong style="color: #0f172a;">Analyzed:</strong> ${escapeHtml(generatedAt)}</div>
      <div><strong style="color: #0f172a;">Total Pages:</strong> ${totalUrls}</div>
    </div>
  </header>

  <!-- Executive Summary Synopsis -->
  <div class="summary-callout pdf-avoid-break" style="background: #f8fafc; border-left: 3px solid #cbd5e1; padding: 20px 28px; margin-bottom: 36px; page-break-inside: avoid; break-inside: avoid;">
    <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; margin-bottom: 8px;">Executive Synopsis &amp; Key Findings</div>
    <div style="font-size: 14px; line-height: 1.7; color: #0f172a; font-weight: 500;">${escapeHtml(oneLineSummary(result))}</div>
  </div>

  <!-- Executive KPI Scorecards -->
  <div class="kpi-grid pdf-avoid-break" style="display: flex; gap: 16px; margin-bottom: 40px; page-break-inside: avoid; break-inside: avoid;">
    <div class="kpi-card" style="flex: 1 1 0; min-width: 0; padding: 0 16px; border-left: 1px solid #e2e8f0; box-sizing: border-box;">
      <div style="font-size: 10px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.06em; color: #64748b; margin-bottom: 8px;">Discovered Pages</div>
      <div style="font-size: 22px; font-weight: 700; color: #0f172a; line-height: 1.2; margin-bottom: 4px;">${totalUrls}</div>
      <div style="font-size: 12px; color: #475569;">${categoriesCount} taxonomy clusters</div>
    </div>
    <div class="kpi-card" style="flex: 1 1 0; min-width: 0; padding: 0 16px; border-left: 1px solid #e2e8f0; box-sizing: border-box;">
      <div style="font-size: 10px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.06em; color: #64748b; margin-bottom: 8px;">Core Platform</div>
      <div style="font-size: 18px; font-weight: 700; color: #0f172a; line-height: 1.2; margin-bottom: 4px;">${escapeHtml(cmsName)}</div>
      <div style="font-size: 12px; color: #475569;">${escapeHtml(builderName || "Native Builder")}</div>
    </div>
    <div class="kpi-card" style="flex: 1 1 0; min-width: 0; padding: 0 16px; border-left: 1px solid #e2e8f0; box-sizing: border-box;">
      <div style="font-size: 10px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.06em; color: #64748b; margin-bottom: 8px;">E-Commerce</div>
      <div style="font-size: 18px; font-weight: 700; color: #0f172a; line-height: 1.2; margin-bottom: 4px;">${store.isThirdParty ? "Third-Party" : store.hasStore ? "Active" : store.platform ? "Installed" : "None"}</div>
      <div style="font-size: 12px; color: #475569;">${store.isThirdParty ? (store.thirdPartyIntegrations?.join(", ") || "External Portal") : store.productCount > 0 ? `${store.productCount} product${store.productCount === 1 ? "" : "s"}` : "No products found"}</div>
    </div>
    <div class="kpi-card" style="flex: 1 1 0; min-width: 0; padding: 0 16px; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; box-sizing: border-box;">
      <div style="font-size: 10px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.06em; color: #64748b; margin-bottom: 8px;">Medical Staff</div>
      <div style="font-size: 18px; font-weight: 700; color: #0f172a; line-height: 1.2; margin-bottom: 4px;">${providersCountText}</div>
      <div style="font-size: 12px; color: #475569;">${providers.list.length > 0 ? "Profile data verified" : "No profiles found"}</div>
    </div>
  </div>

  <!-- Section 1: Platform & Technology Infrastructure -->
  <div class="section-container" style="margin-bottom: 48px;">
    <div class="section-header pdf-section-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; page-break-after: avoid; break-after: avoid;">
      <h2 style="font-size: 18px; font-weight: 700; color: #0f172a; margin: 0; letter-spacing: -0.01em;">Platform &amp; Technical Infrastructure</h2>
      <span style="font-size: 12px; color: #64748b;">Core Stack</span>
    </div>
    ${platformHtml}
  </div>

  <!-- Section 2: Providers & Medical Staff -->
  <div class="section-container" style="margin-bottom: 48px;">
    <div class="section-header pdf-section-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; page-break-after: avoid; break-after: avoid;">
      <h2 style="font-size: 18px; font-weight: 700; color: #0f172a; margin: 0; letter-spacing: -0.01em;">Medical &amp; Executive Providers</h2>
      <span style="font-size: 12px; color: #64748b;">${providers.list.length} profiles</span>
    </div>
    ${providersHtml}
    ${providersInterpretiveLine ? `<div class="pdf-avoid-break" style="font-size: 12px; color: #334155; font-weight: 500; margin-bottom: 32px; padding: 10px 14px; background: #f8fafc; border-left: 3px solid #94a3b8; line-height: 1.5; page-break-inside: avoid; break-inside: avoid;">${escapeHtml(providersInterpretiveLine)}</div>` : ""}
  </div>

  <!-- Section 3: Clinic Locations & Physical Footprint -->
  <div class="section-container" style="margin-bottom: 48px;">
    <div class="section-header pdf-section-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; page-break-after: avoid; break-after: avoid;">
      <h2 style="font-size: 18px; font-weight: 700; color: #0f172a; margin: 0; letter-spacing: -0.01em;">Clinic Locations &amp; Regional Footprint</h2>
      <span style="font-size: 12px; color: #64748b;">${locations.list.length} locations</span>
    </div>
    ${locationsHtml}
  </div>

  <!-- Section 4: Before & After Clinical Results Gallery -->
  <div class="section-container" style="margin-bottom: 48px;">
    <div class="section-header pdf-section-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; page-break-after: avoid; break-after: avoid;">
      <h2 style="font-size: 18px; font-weight: 700; color: #0f172a; margin: 0; letter-spacing: -0.01em;">Before &amp; After Clinical Photo Gallery</h2>
      <span style="font-size: 12px; color: #64748b;">${baCasesText}</span>
    </div>
    ${baHtml}
  </div>

  <!-- Section 5: Complete Website Taxonomy & Sitemap -->
  <div class="section-container" style="margin-bottom: 48px;">
    <div class="section-header pdf-section-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; page-break-after: avoid; break-after: avoid;">
      <h2 style="font-size: 18px; font-weight: 700; color: #0f172a; margin: 0; letter-spacing: -0.01em;">Comprehensive Website Architecture &amp; Sitemap</h2>
      <span style="font-size: 12px; color: #64748b;">${totalUrls} total pages</span>
    </div>
    ${sitemapHtml}
  </div>

  <!-- Warnings / Diagnostics -->
  ${warningsHtml}

  <!-- Provenance Footer -->
  <div class="report-footer pdf-avoid-break" style="margin-top: 36px; padding-top: 16px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 10.5px; color: #94a3b8; page-break-inside: avoid; break-inside: avoid;">
    <div>Generated by WebAnalyzer &bull; Confidential Research Audit</div>
    <div>All URLs are interactive and clickable</div>
  </div>

</div>`;

  if (!standalone) return bodyHtml;

  // Standalone: full HTML document with embedded print styles
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WebAnalyzer Report — ${escapeHtml(url)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      color-adjust: exact;
    }
    .pdf-report-root {
      background: #ffffff;
      padding: 32px 40px;
      margin: 24px auto;
      max-width: 860px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      border-radius: 16px;
    }
    a { color: #2563eb; text-decoration: none; }
    img { max-width: 100%; height: auto; }

    /* ---- PRINT STYLES ---- */
    @media print {
      @page { size: A4; margin: 14mm 16mm; }
      body { background: #ffffff !important; }
      .pdf-report-root {
        margin: 0 !important;
        padding: 0 !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        max-width: 100% !important;
      }
      .pdf-avoid-break, .pdf-card, tr, .kpi-card, .ba-image-card {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }
      .pdf-section-header, .section-header {
        page-break-after: avoid !important;
        break-after: avoid !important;
      }
      /* Force backgrounds to print */
      * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
        color-adjust: exact !important;
      }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;
}
