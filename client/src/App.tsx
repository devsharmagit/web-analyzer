import { useEffect, useState } from "react";
import { analyze, type AnalyzeResult, type Detection } from "./api";
import { oneLineSummary } from "./summarize";
import { generateReportHtml, ASSET_RE } from "./report";
import html2pdf from "html2pdf.js";
import { motion, AnimatePresence } from "motion/react";
import {
  MagnifyingGlass,
  WarningCircle,
  Globe,
  Storefront,
  Users,
  MapPin,
  Files,
  Sun,
  Moon,
  ChartBar,
  Warning,
  DownloadSimple
} from "@phosphor-icons/react";

const PROGRESS_STAGES = [
  { afterSeconds: 0, message: "Crawling the sitemap…" },
  { afterSeconds: 2, message: "Reading pages, providers & locations…" },
  { afterSeconds: 10, message: "Cross-checking ambiguous pages…" },
  { afterSeconds: 20, message: "Almost there…" },
];

function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 250);
    return () => clearInterval(id);
  }, [active]);
  return seconds;
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof localStorage !== "undefined" && localStorage.getItem("theme")) {
      return localStorage.getItem("theme") as "light" | "dark";
    }
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
    return "light";
  });

  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem("theme", theme);
  }, [theme]);

  return (
    <button
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] transition-colors active:scale-95"
      aria-label="Toggle theme"
    >
      {theme === "dark" ? <Sun weight="bold" className="h-5 w-5" /> : <Moon weight="bold" className="h-5 w-5" />}
    </button>
  );
}

export default function App() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const elapsed = useElapsedSeconds(loading);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await analyze(url.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const stage = [...PROGRESS_STAGES].reverse().find((s) => elapsed >= s.afterSeconds) ?? PROGRESS_STAGES[0]!;

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] selection:bg-[var(--color-accent)] selection:text-[var(--color-accent-fg)] font-sans flex flex-col transition-colors duration-300">
      
      {/* Header */}
      <header className="sticky top-0 z-40 w-full border-b border-[var(--color-border)]/50 bg-[var(--color-bg)]/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-2 font-semibold tracking-tight text-[var(--color-text)]">
            <Globe weight="bold" className="h-5 w-5 text-[var(--color-accent)]" />
            <span>WebAnalyzer</span>
          </div>
          
          <div className="flex items-center gap-4">
            {result && (
              <form onSubmit={onSubmit} className="hidden md:flex relative w-64 items-center">
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] py-1.5 pl-3 pr-8 text-sm outline-none transition-colors focus:border-[var(--color-accent)]"
                />
                <button type="submit" disabled={loading} className="absolute right-2 text-[var(--color-muted)] hover:text-[var(--color-text)]">
                  {loading ? <div className="h-3 w-3 animate-spin rounded-full border border-t-[var(--color-accent)]" /> : <MagnifyingGlass weight="bold" />}
                </button>
              </form>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-6xl px-6 py-10 md:py-16">
        {!result && !loading && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="flex flex-col items-center justify-center pt-20 text-center"
          >
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-[var(--color-panel)] shadow-sm">
              <ChartBar weight="duotone" className="h-10 w-10 text-[var(--color-accent)]" />
            </div>
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-[var(--color-text)]">
              Analyze any website
            </h1>
            <p className="mt-4 max-w-lg text-lg text-[var(--color-muted)]">
              Discover the underlying architecture, platform, and page structure of any site in seconds.
            </p>

            <form
              className="mt-10 flex w-full max-w-md flex-col sm:flex-row gap-3"
              onSubmit={onSubmit}
            >
              <div className="relative flex-1">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-[var(--color-muted)]">
                  <Globe weight="bold" />
                </div>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] py-3.5 pl-11 pr-4 text-[15px] shadow-sm outline-none transition-colors focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]/50"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="rounded-xl bg-[var(--color-accent)] px-8 py-3.5 font-medium text-[var(--color-accent-fg)] shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98]"
              >
                Analyze
              </button>
            </form>
          </motion.div>
        )}

        <AnimatePresence mode="wait">
          {loading && (
            <motion.div
              key="loading"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="mx-auto mt-12 max-w-md"
            >
              <div className="flex flex-col items-center gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-8 text-center shadow-sm">
                <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-bg)] shadow-sm">
                  <div className="absolute inset-0 rounded-full border-4 border-[var(--color-border)]" />
                  <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-[var(--color-accent)]" />
                  <MagnifyingGlass weight="duotone" className="h-6 w-6 text-[var(--color-accent)]" />
                </div>
                <div>
                  <h3 className="font-semibold text-[var(--color-text)]">{stage.message}</h3>
                  <p className="mt-1 text-sm text-[var(--color-muted)]">Elapsed: {elapsed}s</p>
                </div>
              </div>
            </motion.div>
          )}

          {error && (
            <motion.div
              key="error"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="mx-auto mt-12 max-w-md overflow-hidden"
            >
              <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-5 text-red-700 dark:text-red-400">
                <WarningCircle weight="fill" className="h-6 w-6 flex-none" />
                <span className="text-sm font-medium">{error}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {result && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            <Dashboard result={result} />
          </motion.div>
        )}
      </main>
    </div>
  );
}

function Dashboard({ result }: { result: AnalyzeResult }) {
  const [activeTab, setActiveTab] = useState<"overview" | "pages" | "providers">("overview");

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
      <SummaryBanner result={result} />

      <div className="border-b border-[var(--color-border)]">
        <nav className="-mb-px flex space-x-8" aria-label="Tabs">
          <TabButton
            active={activeTab === "overview"}
            onClick={() => setActiveTab("overview")}
            icon={<ChartBar />}
            label="Overview"
          />
          <TabButton
            active={activeTab === "pages"}
            onClick={() => setActiveTab("pages")}
            icon={<Files />}
            label="Page Classification"
            count={result.pages.total}
          />
          <TabButton
            active={activeTab === "providers"}
            onClick={() => setActiveTab("providers")}
            icon={<Users />}
            label="Providers & Locations"
            count={(typeof result.providers.count === "number" ? result.providers.count : 0) + (typeof result.locations.count === "number" ? result.locations.count : 0)}
          />
        </nav>
      </div>

      <div className="min-h-[500px]">
        <AnimatePresence mode="wait">
          {activeTab === "overview" && (
            <motion.div
              key="overview"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              <TabOverview result={result} />
            </motion.div>
          )}
          {activeTab === "pages" && (
            <motion.div
              key="pages"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              <TabPages pages={result.pages} beforeAfterGallery={result.beforeAfterGallery} />
            </motion.div>
          )}
          {activeTab === "providers" && (
            <motion.div
              key="providers"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              <TabProviders locations={result.locations} providers={result.providers} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number }) {
  return (
    <button
      onClick={onClick}
      className={`group flex items-center gap-2 border-b-2 py-4 px-1 text-sm font-medium transition-colors ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
          : "border-transparent text-[var(--color-muted)] hover:border-[var(--color-border)] hover:text-[var(--color-text)]"
      }`}
    >
      <span className={active ? "" : "opacity-70 group-hover:opacity-100 transition-opacity"}>{icon}</span>
      <span>{label}</span>
      {count !== undefined && (
        <span className={`ml-1 rounded-full px-2 py-0.5 text-xs ${active ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]" : "bg-[var(--color-panel)] text-[var(--color-muted)]"}`}>
          {count}
        </span>
      )}
    </button>
  );
}

function TabOverview({ result }: { result: AnalyzeResult }) {
  const { platform, store, crawl } = result;
  
  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-12">
      <div className="md:col-span-12 lg:col-span-4 space-y-8">
        <section>
          <SectionHeading>Crawl Stats</SectionHeading>
          <div className="mt-4 grid grid-cols-1 gap-4">
            <Tile icon={<Files weight="duotone" />} label="Pages" value={result.pages.total} />
          </div>
        </section>

        {crawl.warnings.filter((w) => !/sitemap/i.test(w)).length > 0 && (
          <section>
            <SectionHeading>Warnings</SectionHeading>
            <div className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5">
              <ul className="list-inside list-disc space-y-2 text-sm text-[var(--color-text)]">
                {crawl.warnings
                  .filter((w) => !/sitemap/i.test(w))
                  .map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
              </ul>
            </div>
          </section>
        )}
      </div>

      <div className="md:col-span-12 lg:col-span-8 space-y-8">
        <section>
          <SectionHeading>Architecture</SectionHeading>
          <div className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6 md:p-8 shadow-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <Badge label="CMS" d={platform.cms} />
              <Badge label="Builder" d={platform.builder} />
            </div>
          </div>
        </section>

        <section>
          <SectionHeading>E-Commerce</SectionHeading>
          <div className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6 md:p-8 shadow-sm flex flex-col md:flex-row gap-8 items-start">
            <div className="flex-1 w-full">
              <Badge
                label="Platform"
                d={
                  store.isThirdParty && !platform.ecommerce.value
                    ? { value: store.platform || "Third-party Integration", confidence: "high", evidence: [store.notes || "Third-party store integration"] }
                    : platform.ecommerce
                }
              />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-muted)] mb-2">
                <Storefront weight="duotone" className="h-5 w-5" /> Store Status
              </div>
              <p className="text-sm leading-relaxed text-[var(--color-text)]">
                {store.isThirdParty
                  ? `Third-party store integration detected (${store.thirdPartyIntegrations?.join(", ") || "Partner Portal"}). Products found on /shop are fulfilled via external partner portals rather than a native self-hosted cart.`
                  : store.hasStore
                    ? `Active store detected (${store.platform ?? "unknown platform"}). Found ${store.productCount} product${store.productCount === 1 ? "" : "s"} across ${store.categoryCount} categor${store.categoryCount === 1 ? "y" : "ies"}.`
                    : store.platform
                      ? `${store.platform} is installed, but no products were found. Not an active store.`
                      : "No store detected on this site."}
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function TabPages({ pages, beforeAfterGallery }: { pages: AnalyzeResult["pages"]; beforeAfterGallery: AnalyzeResult["beforeAfterGallery"] }) {
  const uncertainBucket = pages.byType["uncertain"];
  const uncertainUrls = uncertainBucket ? uncertainBucket.urls : [];

  return (
    <div className="space-y-8">
      {pages.uncertainCount > 0 && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 md:p-6 shadow-sm">
          <div className="flex items-start md:items-center gap-3 text-[var(--color-text)] font-medium">
            <Warning weight="fill" className="h-5 w-5 mt-0.5 md:mt-0 flex-shrink-0 opacity-70" />
            <span>{pages.uncertainCount} pages could not be classified with confidence.</span>
          </div>
          {uncertainUrls.length > 0 && (
            <div className="mt-4 border-t border-[var(--color-border)] pt-4">
              <p className="text-sm font-medium text-[var(--color-muted)] mb-3">Unclassified URLs:</p>
              <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2 text-xs text-[var(--color-text)] max-h-48 overflow-y-auto custom-scrollbar pr-2">
                {uncertainUrls.map((u) => (
                  <li key={u.url} className="truncate" title={u.reason || u.method}>
                    <a href={u.url} target="_blank" rel="noreferrer" className="hover:underline hover:text-[var(--color-accent)]">{u.url}</a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(pages.byType)
          .filter(([type]) => type !== "uncertain")
          .map(([type, bucket]) => {
            const cleanUrls = bucket.urls.filter((u) => !ASSET_RE.test(u.url));
            return [type, { ...bucket, count: cleanUrls.length, urls: cleanUrls }] as const;
          })
          .filter(([_, bucket]) => bucket.count > 0)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([type, bucket]) => (
            <div key={type} className="flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-sm transition hover:border-[var(--color-border)]/80">
              <div className="flex items-center justify-between border-b border-[var(--color-border)]/50 bg-[var(--color-bg)]/30 px-5 py-4">
                <span className="font-semibold capitalize text-[var(--color-text)]">
                  {type === "locations" ? "Local SEO Pages" : type}
                </span>
                <span className="rounded-full bg-[var(--color-bg)] border border-[var(--color-border)] px-2.5 py-0.5 text-xs font-semibold">{bucket.count}</span>
              </div>
              {type === "shop" && bucket.urls.some((u) => /\/(cart|checkout|my-account|order-tracking|wishlist|account|basket)(\/|$)/i.test(u.url)) && (
                <div className="border-b border-[var(--color-border)]/50 bg-[var(--color-bg)]/30 px-5 py-2 text-xs text-[var(--color-muted)]">
                  {bucket.urls.filter((u) => !/\/(cart|checkout|my-account|order-tracking|wishlist|account|basket)(\/|$)/i.test(u.url)).length} storefront pages ({bucket.count} total incl. account plumbing)
                </div>
              )}
              {type === "beforeAfter" && typeof beforeAfterGallery.caseCount === "number" && (
                <div
                  className="border-b border-[var(--color-border)]/50 bg-[var(--color-bg)]/30 px-5 py-2.5 text-xs text-[var(--color-muted)]"
                  title={beforeAfterGallery.evidence.join(" ")}
                >
                  <b className="text-[var(--color-text)]">{beforeAfterGallery.caseCount}</b> distinct before/after case
                  {beforeAfterGallery.caseCount === 1 ? "" : "s"}
                  {beforeAfterGallery.confidence === "unknown" && " — estimated"}
                </div>
              )}
              <ul className="flex-1 overflow-y-auto px-5 py-4 text-xs max-h-56 custom-scrollbar">
                {bucket.urls.slice(0, 50).map((u) => (
                  <li key={u.url} className="py-1 border-b border-[var(--color-border)]/30 last:border-0" title={u.reason ? `${u.method}: ${u.reason} (${Math.round((u.confidence || 0) * 100)}%)` : u.method}>
                    <a href={u.url} target="_blank" rel="noreferrer" className="block truncate text-[var(--color-muted)] hover:text-[var(--color-accent)] transition-colors">
                      {u.url.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "").replace(/\/$/, "")}
                    </a>
                  </li>
                ))}
                {bucket.urls.length > 50 && (
                  <li className="pt-3 pb-1 text-center text-[var(--color-muted)] italic">…and {bucket.urls.length - 50} more</li>
                )}
              </ul>
            </div>
          ))}
      </div>
    </div>
  );
}

function TabProviders({ locations, providers }: { locations: AnalyzeResult["locations"]; providers: AnalyzeResult["providers"] }) {
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
      <section>
        <SectionHeading>
          Providers {typeof providers.count === "number" ? <span className="ml-2 rounded-full bg-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text)]">{providers.count}</span> : ""}
        </SectionHeading>
        {providers.list.length > 0 ? (
          <div className="mt-4 flex flex-col gap-4">
            {providers.list.map((p, i) => (
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6 shadow-sm" key={i}>
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold text-base">{p.name}</h4>
                    {p.role && <div className="mt-1 text-sm font-medium text-[var(--color-accent)]">{p.role}</div>}
                  </div>
                  {p.credentials && <span className="inline-flex rounded-lg bg-[var(--color-border)]/50 px-2.5 py-1 text-xs font-medium text-[var(--color-muted)] self-start">{p.credentials}</span>}
                </div>
                {p.bio && <p className="mt-4 text-sm leading-relaxed text-[var(--color-muted)]">{p.bio}</p>}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-panel)]/30 p-10 text-center text-[var(--color-muted)] flex flex-col items-center">
            <Users weight="duotone" className="h-10 w-10 opacity-30 mb-4" />
            <p className="text-sm font-medium">No providers detected.</p>
            {providers.reason && <p className="mt-2 text-xs opacity-70 max-w-sm">{providers.reason}</p>}
          </div>
        )}
      </section>

      <section>
        <SectionHeading>
          Locations {typeof locations.count === "number" ? <span className="ml-2 rounded-full bg-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text)]">{locations.count}</span> : ""}
        </SectionHeading>
        {locations.list.length > 0 ? (
          <div className="mt-4 flex flex-col gap-4">
            {locations.list.map((l, i) => (
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6 shadow-sm" key={i}>
                <h4 className="font-semibold text-base flex items-center gap-2">
                  <MapPin weight="fill" className="text-[var(--color-accent)] opacity-80" /> {l.name || "Location"}
                </h4>
                <div className="mt-4 space-y-2">
                  {l.address && <div className="text-sm text-[var(--color-muted)]">{l.address}</div>}
                  {l.phone && <div className="text-sm font-medium text-[var(--color-text)]">{l.phone}</div>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-[var(--color-border)] border-dashed bg-[var(--color-panel)]/30 p-10 text-center text-[var(--color-muted)] flex flex-col items-center">
            <MapPin weight="duotone" className="h-10 w-10 opacity-30 mb-4" />
            <p className="text-sm font-medium">No locations detected.</p>
            {locations.reason && <p className="mt-2 text-xs opacity-70 max-w-sm">{locations.reason}</p>}
          </div>
        )}
      </section>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center text-[11px] font-bold tracking-[0.15em] text-[var(--color-muted)] uppercase">
      {children}
    </h2>
  );
}

function SummaryBanner({ result }: { result: AnalyzeResult }) {
  const [downloading, setDownloading] = useState(false);

  async function onDownload() {
    if (downloading) return;
    setDownloading(true);
    let container: HTMLElement | null = null;
    try {
      const host = result.url.replace(/^https?:\/\//i, "").replace(/[^a-z0-9.-]/gi, "-");
      const date = new Date().toISOString().slice(0, 10);
      const filename = `website-analysis-${host}-${date}.pdf`;

      // Generate report HTML content
      const html = generateReportHtml(result, { standalone: false });

      // html2canvas REQUIRES the element to be in normal document flow
      // (position:relative) to render it — any off-screen trick like
      // position:fixed or position:absolute;left:-9999px produces a blank
      // canvas. The element is briefly appended and removed after capture.
      //
      // Width is set to 700px (A4 usable: 210mm - 2×12mm = 186mm ≈ 703px)
      // and the same value is passed to html2canvas via `windowWidth` so the
      // snapshot is locked to that width and the right side is never clipped.
      container = document.createElement("div");
      container.id = "pdf-report-export-container";
      container.style.position = "relative";
      container.style.width = "700px";
      container.style.margin = "0 auto";
      container.style.background = "#ffffff";
      container.style.color = "#1e293b";
      container.innerHTML = html;

      document.body.appendChild(container);

      const opt = {
        margin: [12, 12, 12, 12] as [number, number, number, number],
        filename,
        image: { type: "jpeg" as const, quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          logging: false,
          letterRendering: true,
          // windowWidth locks html2canvas to the container width so no
          // browser viewport bleed widens the canvas beyond the PDF page.
          windowWidth: 700,
        },
        jsPDF: {
          unit: "mm",
          format: "a4",
          orientation: "portrait" as const,
        },
        pagebreak: { mode: ["avoid-all", "css", "legacy"] },
      };

      // Download the PDF
      await html2pdf().set(opt).from(container).save();
    } catch (err) {
      console.error("PDF generation error:", err);
    } finally {
      // Remove the component
      if (container && container.parentNode) {
        container.parentNode.removeChild(container);
      }
      setDownloading(false);
    }
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6 shadow-sm">
      <div className="absolute -right-20 -top-20 h-48 w-48 rounded-full bg-[var(--color-accent)]/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-6">
        <p className="text-base font-medium leading-relaxed text-[var(--color-text)] flex-1">
          {oneLineSummary(result)}
        </p>
        <div className="flex flex-shrink-0">
          <button
            type="button"
            onClick={onDownload}
            disabled={downloading}
            className="flex items-center justify-center gap-2 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)] px-5 py-2.5 text-sm font-medium text-[var(--color-text)] shadow-sm transition hover:bg-[var(--color-border)]/50 active:scale-95 disabled:opacity-60"
          >
            {downloading ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-text)] border-t-transparent" />
                <span>Preparing report...</span>
              </>
            ) : (
              <>
                <DownloadSimple weight="bold" className="h-4 w-4" /> Download PDF Report
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, icon }: { label: string; value: string | number; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5 shadow-sm">
      <div className="flex items-center gap-2 text-[var(--color-muted)] mb-3">
        {icon && <span>{icon}</span>}
        <div className="text-[10px] font-bold uppercase tracking-wider">{label}</div>
      </div>
      <div className="text-2xl font-semibold tracking-tight text-[var(--color-text)]">{value}</div>
    </div>
  );
}

const CONFIDENCE_COLOR: Record<Detection["confidence"], string> = {
  high: "bg-[var(--color-bg)] border-[var(--color-border)] text-[var(--color-text)]",
  likely: "bg-[var(--color-bg)] border-[var(--color-border)] text-[var(--color-text)]",
  unknown: "bg-[var(--color-border)]/30 text-[var(--color-muted)] border-[var(--color-border)]",
};

function Badge({ label, d }: { label: string; d: Detection }) {
  return (
    <div
      className={`flex flex-col justify-between rounded-xl border p-4 ${CONFIDENCE_COLOR[d.confidence]}`}
      title={d.evidence.join("; ")}
    >
      <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-muted)]">{label}</span>
      <span className="mt-1.5 text-sm font-semibold">{d.value ?? "Unknown"}</span>
    </div>
  );
}
