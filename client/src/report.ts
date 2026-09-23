import { oneLineSummary } from "./summarize";
import type { AnalyzeResult } from "./api";

function escapeHtml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}



function formatLabel(str: string): string {
  if (!str) return "Clinical Gallery";
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



/** @deprecated – kept for backwards compatibility; use generateStandaloneReport instead */
export const REPORT_CSS = ``;

export function generateReportHtml(result: AnalyzeResult, options?: { standalone?: boolean }): string {
  const standalone = options?.standalone ?? false;
  const { url, platform, pages, store, providers, locations, beforeAfterGallery, crawl } = result;
  const generatedAt = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  // Pre-calculate summary stats
  const totalUrls = pages.total || 0;
  const categoriesCount = Object.keys(pages.byType).filter(k => pages.byType[k]?.urls?.length > 0).length;
  const cmsName = platform.cms.value || "Custom / Jamstack";
  const builderName = platform.builder.value;
  const storeStatus = store.hasStore 
    ? `Active (${store.platform || "Custom"}, ${store.productCount} products)` 
    : store.platform 
      ? `Installed (${store.platform})` 
      : "None detected";
  
  const providersCountText = providers.count === "unknown" 
    ? "Unknown" 
    : providers.count === 0 
      ? "None detected" 
      : `${providers.count} Provider${providers.count === 1 ? "" : "s"}`;

  const baCasesText = typeof beforeAfterGallery.caseCount === "number"
    ? `${beforeAfterGallery.caseCount} Cases`
    : beforeAfterGallery.imageCount > 0
      ? `${beforeAfterGallery.imageCount} Photos`
      : "None detected";

  // Section: Platform & Technology Stack
  const platformHtml = `
    <div style="display: flex; flex-wrap: wrap; gap: 24px; margin-bottom: 32px;">
      <div class="pdf-card pdf-avoid-break" style="width: calc(50% - 12px); box-sizing: border-box; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.06em; color: #64748b; margin-bottom: 4px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;">Content Management System</div>
        <div style="font-size: 16px; font-weight: 700; color: #0f172a; margin: 8px 0 4px 0;">${escapeHtml(cmsName)}</div>
        <div style="font-size: 11px; color: #475569; margin-bottom: 4px;">Confidence: <strong>${escapeHtml(platform.cms.confidence.toUpperCase())}</strong></div>
        ${platform.cms.evidence.length ? `<div style="font-size: 11px; color: #64748b; line-height: 1.5;">Signal: ${escapeHtml(platform.cms.evidence[0])}</div>` : ""}
      </div>
      <div class="pdf-card pdf-avoid-break" style="width: calc(50% - 12px); box-sizing: border-box; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.06em; color: #64748b; margin-bottom: 4px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;">Page Builder / Framework</div>
        <div style="font-size: 16px; font-weight: 700; color: #0f172a; margin: 8px 0 4px 0;">${escapeHtml(builderName || "Native Theme / Standard")}</div>
        <div style="font-size: 11px; color: #475569; margin-bottom: 4px;">Confidence: <strong>${escapeHtml(platform.builder.confidence.toUpperCase())}</strong></div>
        ${platform.builder.evidence.length ? `<div style="font-size: 11px; color: #64748b; line-height: 1.5;">Signal: ${escapeHtml(platform.builder.evidence[0])}</div>` : ""}
      </div>
      <div class="pdf-card pdf-avoid-break" style="width: calc(50% - 12px); box-sizing: border-box; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.06em; color: #64748b; margin-bottom: 4px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;">E-Commerce Architecture</div>
        <div style="font-size: 16px; font-weight: 700; color: #0f172a; margin: 8px 0 4px 0;">${escapeHtml(storeStatus)}</div>
        ${store.hasStore ? `<div style="font-size: 11px; color: #64748b; line-height: 1.5;">Catalog: ${store.productCount} products across ${store.categoryCount} categories</div>` : ""}
      </div>
      <div class="pdf-card pdf-avoid-break" style="width: calc(50% - 12px); box-sizing: border-box; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.06em; color: #64748b; margin-bottom: 4px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;">Crawl & Sitemap Audit</div>
        <div style="font-size: 16px; font-weight: 700; color: #0f172a; margin: 8px 0 4px 0;">${escapeHtml(crawl.discoveredVia || "Sitemap discovery")}</div>
        <div style="font-size: 11px; color: #64748b; line-height: 1.5;">${crawl.urlsSeen} URLs analyzed in ${(crawl.durationMs / 1000).toFixed(1)}s (${crawl.sitemaps.length} sitemaps found)</div>
      </div>
    </div>`;

  // Section: Providers & Medical Staff
  let providersHtml = "";
  if (providers.list.length > 0) {
    providersHtml = `<div style="display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 32px;">` + providers.list.map(p => `
      <div class="pdf-card provider-card pdf-avoid-break" style="width: calc(50% - 8px); padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; box-sizing: border-box; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 14px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">
          ${escapeHtml(p.name)}${p.credentials ? `<span style="font-size: 11px; font-weight: 500; color: #475569; margin-left: 6px;">${escapeHtml(p.credentials)}</span>` : ""}
        </div>
        ${p.role ? `<div style="font-size: 12px; color: #475569;">${escapeHtml(p.role)}</div>` : ""}
      </div>`
    ).join("") + `</div>`;
  } else {
    providersHtml = `<div class="pdf-avoid-break" style="color: #64748b; font-size: 13px; font-style: italic; margin-bottom: 32px;">No provider profiles detected.${providers.reason ? ` ${escapeHtml(providers.reason)}` : ""}</div>`;
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

  // Section: Before & After Clinical Results Gallery
  let baHtml = "";
  const baEvidenceText = beforeAfterGallery.evidence.length > 0 
    ? beforeAfterGallery.evidence.slice(0, 3).map(escapeHtml).join(" • ") 
    : "Gallery structure identified";

  baHtml += `
    <div class="pdf-ba-banner pdf-avoid-break" style="border: 1px solid #e2e8f0; border-left: 3px solid #94a3b8; padding: 20px 24px; margin-bottom: 24px; page-break-inside: avoid; break-inside: avoid;">
      <div style="display: flex; gap: 32px; margin-bottom: 16px;">
        <div style="display: flex; flex-direction: column;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 4px; letter-spacing: 0.05em;">Distinct Patient Cases</div>
          <div style="font-size: 20px; font-weight: 700; color: #0f172a; line-height: 1.2;">${typeof beforeAfterGallery.caseCount === "number" ? beforeAfterGallery.caseCount : "Detected"}</div>
        </div>
        <div style="display: flex; flex-direction: column;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 4px; letter-spacing: 0.05em;">Clinical Photographs</div>
          <div style="font-size: 20px; font-weight: 700; color: #0f172a; line-height: 1.2;">${beforeAfterGallery.imageCount || 0}</div>
        </div>
        <div style="display: flex; flex-direction: column;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 4px; letter-spacing: 0.05em;">Detection Confidence</div>
          <div style="font-size: 20px; font-weight: 700; color: #0f172a; line-height: 1.2;">${escapeHtml(beforeAfterGallery.confidence.toUpperCase())}</div>
        </div>
      </div>
      ${beforeAfterGallery.pageUrl ? `<div style="font-size: 12px; color: #475569; margin-bottom: 8px;"><strong>Source Gallery Page:</strong> ${escapeHtml(beforeAfterGallery.pageUrl)}</div>` : ""}
      <div style="font-size: 12px; color: #64748b; line-height: 1.5;">${baEvidenceText}</div>
    </div>`;

  if (beforeAfterGallery.images && beforeAfterGallery.images.length > 0) {
    // Group by procedure
    const grouped: Record<string, string[]> = {};
    beforeAfterGallery.images.forEach(imgUrl => {
      const proc = extractProcedureName(imgUrl);
      if (!grouped[proc]) grouped[proc] = [];
      grouped[proc].push(imgUrl);
    });

    baHtml += `
      <div style="margin-bottom: 32px;">
        <div style="font-size: 12px; font-weight: 600; color: #0f172a; margin-bottom: 16px;">${beforeAfterGallery.images.length} image URLs found — grouped by procedure</div>` +
        Object.entries(grouped).map(([proc, urls]) => `
          <div class="pdf-avoid-break" style="margin-bottom: 16px; page-break-inside: avoid; break-inside: avoid;">
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; margin-bottom: 8px;">${escapeHtml(proc)} <span style="font-weight: 400; color: #94a3b8; margin-left: 8px;">${urls.length} image${urls.length > 1 ? "s" : ""}</span></div>
            <div style="display: flex; flex-direction: column; gap: 4px;">${
              urls.map((u, i) => `<div style="font-size: 11px; font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; color: #475569; word-break: break-all;">${i + 1}. <a href="${escapeHtml(u)}" target="_blank" style="color: #475569; text-decoration: none;">${escapeHtml(u)}</a></div>`).join("")
            }</div>
          </div>`
        ).join("") +
      `</div>`;
  } else if (beforeAfterGallery.imageCount === 0 && !beforeAfterGallery.pageUrl) {
    baHtml += `<div class="pdf-avoid-break" style="color: #64748b; font-size: 13px; font-style: italic; margin-bottom: 32px;">No before-and-after galleries identified.</div>`;
  }

  // Section: Website Architecture & Full URL Sitemap
  const byType = Object.entries(pages.byType)
    .filter(([_, bucket]) => bucket.urls && bucket.urls.length > 0)
    .sort((a, b) => b[1].count - a[1].count);

  let sitemapHtml = `
    <div style="display: flex; flex-direction: column; gap: 32px; margin-bottom: 40px;">
      <div class="sitemap-intro pdf-avoid-break" style="font-size: 13px; color: #475569; line-height: 1.6; border-left: 3px solid #cbd5e1; padding: 12px 20px; page-break-inside: avoid; break-inside: avoid;">
        A total of <strong style="color: #0f172a;">${totalUrls} categorized pages</strong> were mapped across <strong style="color: #0f172a;">${byType.length} taxonomy categories</strong>. Every URL below is fully interactive and clickable.
      </div>`;

  byType.forEach(([typeKey, bucket]) => {
    sitemapHtml += `
      <div class="url-group pdf-avoid-break" style="page-break-inside: avoid; break-inside: avoid;">
        <div style="padding-bottom: 8px; margin-bottom: 12px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: baseline;">
          <span style="font-size: 14px; font-weight: 700; color: #0f172a;">${escapeHtml(formatLabel(typeKey))}</span>
          <span style="font-size: 11px; font-weight: 700; color: #64748b; letter-spacing: 0.05em; text-transform: uppercase;">${bucket.count} page${bucket.count === 1 ? "" : "s"}</span>
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
          <tbody>` +
          bucket.urls.map((u) => {
            let pathDisplay = u;
            try {
              const parsed = new URL(u);
              pathDisplay = parsed.pathname + parsed.search;
              if (pathDisplay.length > 55) pathDisplay = pathDisplay.slice(0, 52) + "...";
            } catch {
              pathDisplay = u;
            }
            return `
            <tr style="border-bottom: 1px solid #f1f5f9; page-break-inside: avoid; break-inside: avoid;">
              <td style="padding: 10px 0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #0f172a; font-weight: 600; width: 40%; word-break: break-all;" title="${escapeHtml(u)}">${escapeHtml(pathDisplay)}</td>
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

  // Warnings
  const warningsHtml = crawl.warnings.length > 0
    ? `<div class="pdf-warning-box pdf-avoid-break" style="border: 1px solid #e2e8f0; border-left: 3px solid #94a3b8; padding: 20px 24px; margin-top: 32px; page-break-inside: avoid; break-inside: avoid;">
        <div style="font-size: 11px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 12px; letter-spacing: 0.05em;">Analysis Advisory & Notice</div>
        <ul style="margin: 0; padding-left: 18px; font-size: 13px; color: #1e293b; line-height: 1.6;">
          ${crawl.warnings.map(w => `<li style="margin-bottom: 6px;">${escapeHtml(w)}</li>`).join("")}
        </ul>
      </div>`
    : "";

  const bodyHtml = `
<div class="pdf-report-root" style="width: 100%; max-width: 820px; margin: 0 auto; background: #ffffff; color: #1e293b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 13px; line-height: 1.6; box-sizing: border-box; padding: 0;">
  
  <!-- Executive Cover Header -->
  <header class="report-header pdf-avoid-break" style="background: #ffffff; border: 1px solid #e2e8f0; border-top: 4px solid #0f172a; padding: 40px 48px; margin-bottom: 32px; page-break-inside: avoid; break-inside: avoid;">
    <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #64748b; margin-bottom: 12px;">Confidential Intelligence Audit</div>
    <h1 style="font-size: 28px; font-weight: 800; line-height: 1.25; margin: 0 0 12px 0; color: #0f172a; letter-spacing: -0.02em; word-break: break-all;">${escapeHtml(url)}</h1>
    <p style="font-size: 14px; color: #475569; margin: 0 0 24px 0; line-height: 1.6;">Deep architectural analysis, clinical taxonomy, and digital footprint audit</p>
    
    <div style="display: flex; flex-wrap: wrap; gap: 16px; margin-top: 24px; padding-top: 24px; border-top: 1px solid #f1f5f9; font-size: 12px; color: #475569;">
      <div><strong style="color: #0f172a;">Analyzed:</strong> ${escapeHtml(generatedAt)}</div>
      <div><strong style="color: #0f172a;">Sitemap Status:</strong> ${escapeHtml(crawl.discoveredVia || "Verified")}</div>
      <div><strong style="color: #0f172a;">URLs Discovered:</strong> ${crawl.urlsSeen}</div>
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
      <div style="font-size: 18px; font-weight: 700; color: #0f172a; line-height: 1.2; margin-bottom: 4px;">${store.hasStore ? "Active" : store.platform ? "Installed" : "None"}</div>
      <div style="font-size: 12px; color: #475569;">${store.productCount > 0 ? `${store.productCount} products` : "No products found"}</div>
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
    <div>Generated by WebAnalyzer Enterprise &bull; Discovered via ${escapeHtml(crawl.discoveredVia || "sitemaps")}</div>
    <div>Confidential Research Report &bull; All URLs are interactive and clickable</div>
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
  <div class="no-print" style="background: #1e293b; color: #e2e8f0; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; font-family: sans-serif; font-size: 13px; position: sticky; top: 0; z-index: 100;">
    <span>📄 <strong>WebAnalyzer Report</strong> — ${escapeHtml(url)}</span>
    <button onclick="window.print()" style="background: #2563eb; color: #ffffff; border: none; border-radius: 8px; padding: 8px 18px; font-size: 13px; font-weight: 700; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#1d4ed8'" onmouseout="this.style.background='#2563eb'">
      ⬇ Save as PDF (Ctrl+P)
    </button>
  </div>
  ${bodyHtml}
  <script>
    // Auto-trigger print dialog after a short delay to allow images to load
    window.addEventListener('load', function() {
      setTimeout(function() { window.print(); }, 800);
    });
  </script>
</body>
</html>`;
}
