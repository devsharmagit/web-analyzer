import { useState } from "react";
import { analyze, type AnalyzeResult, type Detection } from "./api";

export default function App() {
  const [url, setUrl] = useState("https://ruma.com");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);

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

  return (
    <main className="wrap">
      <h1>Website Analyzer</h1>
      <p className="sub">Give it one URL, get a structured profile of the site.</p>

      <form className="bar" onSubmit={onSubmit}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={loading}>
          {loading ? "Analyzing…" : "Analyze"}
        </button>
      </form>

      {error && <div className="error">{error}</div>}

      {result && <Report result={result} />}
    </main>
  );
}

function Report({ result }: { result: AnalyzeResult }) {
  const { platform, pages, store, providers, locations, crawl } = result;

  return (
    <section className="report">
      <div className="tiles">
        <Tile label="Pages" value={pages.total} />
        <Tile label="URLs seen" value={crawl.urlsSeen} />
        <Tile label="Sitemaps" value={crawl.sitemaps.length} />
        <Tile label="Time" value={`${(crawl.durationMs / 1000).toFixed(1)}s`} />
      </div>

      <p className="meta">
        <strong>{result.url}</strong> · discovered via {crawl.discoveredVia}
      </p>

      <h2>Platform</h2>
      <div className="badges">
        <Badge label="CMS" d={platform.cms} />
        <Badge label="Builder" d={platform.builder} />
        <Badge label="E-commerce" d={platform.ecommerce} />
      </div>

      <h2>Store</h2>
      <p className="meta">
        {store.hasStore
          ? `Has a store (${store.platform ?? "unknown platform"}) — ${store.productCount} products, ${store.categoryCount} categories`
          : "No store detected"}
      </p>

      <h2>Pages by type</h2>
      <ul className="counts">
        {Object.entries(pages.byType)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([type, bucket]) => (
            <li key={type}>
              <details>
                <summary>
                  <span>{type}</span>
                  <b>{bucket.count}</b>
                </summary>
                <ul className="url-list">
                  {bucket.urls.slice(0, 50).map((u) => (
                    <li key={u}>
                      <a href={u} target="_blank" rel="noreferrer">
                        {u}
                      </a>
                    </li>
                  ))}
                  {bucket.urls.length > 50 && <li className="more">…and {bucket.urls.length - 50} more</li>}
                </ul>
              </details>
            </li>
          ))}
      </ul>
      {pages.uncertainCount > 0 && (
        <p className="meta warn">{pages.uncertainCount} pages could not be classified with confidence.</p>
      )}

      <h2>Providers {typeof providers.count === "number" ? `(${providers.count})` : "(unknown)"}</h2>
      {providers.list.length > 0 ? (
        <div className="cards">
          {providers.list.map((p, i) => (
            <div className="card" key={i}>
              <b>{p.name}</b>
              {p.credentials && <span className="cred"> {p.credentials}</span>}
              {p.role && <div className="role">{p.role}</div>}
              {p.bio && <p className="bio">{p.bio}</p>}
            </div>
          ))}
        </div>
      ) : (
        <p className="meta">No providers detected{providers.source ? ` (checked ${providers.source})` : ""}.</p>
      )}

      <h2>Locations {typeof locations.count === "number" ? `(${locations.count})` : "(unknown)"}</h2>
      {locations.list.length > 0 ? (
        <div className="cards">
          {locations.list.map((l, i) => (
            <div className="card" key={i}>
              <b>{l.name || "Location"}</b>
              {l.address && <div className="role">{l.address}</div>}
              {l.phone && <div className="role">{l.phone}</div>}
            </div>
          ))}
        </div>
      ) : (
        <p className="meta">No locations detected.</p>
      )}

      {crawl.warnings.length > 0 && (
        <div className="warnings">
          <h2>Warnings</h2>
          <ul>
            {crawl.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="tile">
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

function Badge({ label, d }: { label: string; d: Detection }) {
  return (
    <div className={`badge conf-${d.confidence}`} title={d.evidence.join("; ")}>
      <span className="badge-label">{label}</span>
      <span className="badge-value">{d.value ?? "unknown"}</span>
    </div>
  );
}
