import { useEffect, useState } from "react";
import { analyze, type AnalyzeResult, type Detection } from "./api";
import { oneLineSummary, toClipboardText } from "./summarize";

// Approximate, honest phrasing — the backend runs platform/taxonomy/providers/
// locations CONCURRENTLY after the crawl, so this is not a literal step-by-step
// progress bar (that would misrepresent the concurrency). It's just enough
// feedback that a ~10-20s wait doesn't read as frozen.
const PROGRESS_STAGES: Array<{ afterSeconds: number; message: string }> = [
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

export default function App() {
  const [url, setUrl] = useState("https://ruma.com");
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
    <main className="mx-auto max-w-4xl px-5 pt-12 pb-20">
      <h1 className="text-2xl font-bold text-white">Website Analyzer</h1>
      <p className="mt-1 mb-6 text-muted">Give it one URL, get a structured profile of the site.</p>

      <form className="flex gap-2" onSubmit={onSubmit}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          autoComplete="off"
          spellCheck={false}
          className="flex-1 rounded-lg border border-border bg-panel px-3.5 py-2.5 text-[15px] text-white outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-accent px-5 py-2.5 font-semibold text-[#0b1020] disabled:cursor-default disabled:opacity-60"
        >
          {loading ? "Analyzing…" : "Analyze"}
        </button>
      </form>

      {loading && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-border bg-panel px-3.5 py-3 text-muted">
          <span className="h-4 w-4 flex-none animate-spin rounded-full border-2 border-border border-t-accent" />
          <span>
            {stage.message} <span className="text-xs">({elapsed}s)</span>
          </span>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/40 px-3.5 py-3 text-red-300">{error}</div>
      )}

      {result && <Report result={result} />}
    </main>
  );
}

function Report({ result }: { result: AnalyzeResult }) {
  const { platform, pages, store, providers, locations, crawl } = result;

  return (
    <section className="mt-8">
      <SummaryBanner result={result} />

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Pages" value={pages.total} />
        <Tile label="URLs seen" value={crawl.urlsSeen} />
        <Tile label="Sitemaps" value={crawl.sitemaps.length} />
        <Tile label="Time" value={`${(crawl.durationMs / 1000).toFixed(1)}s`} />
      </div>

      <p className="mt-5 text-muted">
        <strong className="text-white">{result.url}</strong> · discovered via {crawl.discoveredVia}
      </p>

      <SectionHeading>Platform</SectionHeading>
      <div className="flex flex-wrap gap-2.5">
        <Badge label="CMS" d={platform.cms} />
        <Badge label="Builder" d={platform.builder} />
        <Badge label="E-commerce" d={platform.ecommerce} />
      </div>

      <SectionHeading>Store</SectionHeading>
      <p className="text-muted">
        {store.hasStore
          ? `Has a store (${store.platform ?? "unknown platform"}) — ${store.productCount} products, ${store.categoryCount} categories`
          : store.platform
            ? `${store.platform} is installed, but no products were found — not an active store`
            : "No store detected"}
      </p>

      <SectionHeading>Pages by type</SectionHeading>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {Object.entries(pages.byType)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([type, bucket]) => (
            <li key={type} className="rounded-lg border border-border bg-panel">
              <details>
                <summary className="flex cursor-pointer list-none justify-between px-3 py-2 [&::-webkit-details-marker]:hidden">
                  <span>{type}</span>
                  <b>{bucket.count}</b>
                </summary>
                <ul className="max-h-40 overflow-y-auto px-3 pt-1 pb-2.5 text-xs">
                  {bucket.urls.slice(0, 50).map((u) => (
                    <li key={u} className="py-0.5">
                      <a href={u} target="_blank" rel="noreferrer" className="text-muted break-all hover:text-accent">
                        {u}
                      </a>
                    </li>
                  ))}
                  {bucket.urls.length > 50 && (
                    <li className="italic text-muted">…and {bucket.urls.length - 50} more</li>
                  )}
                </ul>
              </details>
            </li>
          ))}
      </ul>
      {pages.uncertainCount > 0 && (
        <p className="mt-2 text-amber-300">{pages.uncertainCount} pages could not be classified with confidence.</p>
      )}

      <SectionHeading>Providers {typeof providers.count === "number" ? `(${providers.count})` : "(unknown)"}</SectionHeading>
      {providers.list.length > 0 ? (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {providers.list.map((p, i) => (
            <div className="rounded-lg border border-border bg-panel px-3.5 py-3" key={i}>
              <b>{p.name}</b>
              {p.credentials && <span className="ml-1 text-sm text-muted">{p.credentials}</span>}
              {p.role && <div className="mt-0.5 text-sm text-muted">{p.role}</div>}
              {p.bio && <p className="mt-1.5 text-sm">{p.bio}</p>}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-muted">
          No providers detected{providers.source ? ` (checked ${providers.source})` : ""}.
          {providers.reason && <span className="block text-xs italic">{providers.reason}</span>}
        </p>
      )}

      <SectionHeading>Locations {typeof locations.count === "number" ? `(${locations.count})` : "(unknown)"}</SectionHeading>
      {locations.list.length > 0 ? (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {locations.list.map((l, i) => (
            <div className="rounded-lg border border-border bg-panel px-3.5 py-3" key={i}>
              <b>{l.name || "Location"}</b>
              {l.address && <div className="mt-0.5 text-sm text-muted">{l.address}</div>}
              {l.phone && <div className="mt-0.5 text-sm text-muted">{l.phone}</div>}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-muted">
          No locations detected.
          {locations.reason && <span className="block text-xs italic">{locations.reason}</span>}
        </p>
      )}

      {crawl.warnings.length > 0 && (
        <>
          <SectionHeading>Warnings</SectionHeading>
          <ul className="list-disc pl-5 text-amber-300">
            {crawl.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-7 mb-2.5 text-sm font-semibold tracking-wide text-muted uppercase">{children}</h2>;
}

// The at-a-glance verdict for someone triaging a lead — one line, plus a copy
// button that puts a CRM/note-ready summary on the clipboard. This is meant
// to be readable without scrolling to the sections below it.
// Falls back to the legacy execCommand path when the async Clipboard API is
// blocked (denied permission, insecure context, some corporate browser
// policies) — confirmed live: the Clipboard API can throw NotAllowedError
// even though `navigator.clipboard` exists. Returns whether it worked, so the
// caller can show an honest failure state instead of doing nothing visibly.
function copyText(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

function SummaryBanner({ result }: { result: AnalyzeResult }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function onCopy() {
    const text = toClipboardText(result);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = copyText(text); // fallback path
    }
    setStatus(ok ? "copied" : "failed");
    setTimeout(() => setStatus("idle"), 2500);
  }

  return (
    <div className="rounded-xl border border-accent/40 bg-accent/10 px-4 py-3.5">
      <p className="text-[15px] font-medium text-white">{oneLineSummary(result)}</p>
      <button
        type="button"
        onClick={onCopy}
        className="mt-2.5 rounded-md border border-border bg-panel px-3 py-1.5 text-xs font-medium text-muted hover:text-white"
      >
        {status === "copied" ? "Copied ✓" : status === "failed" ? "Couldn't copy — select the text manually" : "Copy summary for CRM / notes"}
      </button>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border bg-panel p-4 text-center">
      <div className="text-2xl font-bold">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </div>
  );
}

const CONFIDENCE_BORDER: Record<Detection["confidence"], string> = {
  high: "border-emerald-800",
  likely: "border-amber-800",
  unknown: "border-border opacity-60",
};

function Badge({ label, d }: { label: string; d: Detection }) {
  return (
    <div
      className={`min-w-[120px] rounded-lg border bg-panel px-3.5 py-2.5 ${CONFIDENCE_BORDER[d.confidence]}`}
      title={d.evidence.join("; ")}
    >
      <span className="block text-[11px] text-muted uppercase">{label}</span>
      <span className="block font-semibold">{d.value ?? "unknown"}</span>
    </div>
  );
}
