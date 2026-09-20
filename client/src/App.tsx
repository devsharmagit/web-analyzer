import { useState } from "react";
import { analyze, type AnalyzeResult } from "./api";

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

  const crawl = result?.crawl;

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

      {crawl && (
        <section className="report">
          <div className="tiles">
            <Tile label="Pages" value={crawl.total} />
            <Tile label="URLs seen" value={crawl.urlsSeen} />
            <Tile label="Sitemaps" value={crawl.sitemaps.length} />
            <Tile label="Time" value={`${(crawl.durationMs / 1000).toFixed(1)}s`} />
          </div>

          <p className="meta">
            <strong>{crawl.origin}</strong> · discovered via {crawl.discoveredVia}
          </p>

          <h2>By source</h2>
          <ul className="counts">
            {Object.entries(crawl.counts)
              .sort((a, b) => b[1] - a[1])
              .map(([source, n]) => (
                <li key={source}>
                  <span>{source}</span>
                  <b>{n}</b>
                </li>
              ))}
          </ul>

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

          <details className="pages">
            <summary>{crawl.pages.length} discovered URLs</summary>
            <table>
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Source</th>
                  <th>Page?</th>
                </tr>
              </thead>
              <tbody>
                {crawl.pages.map((p) => (
                  <tr key={p.path}>
                    <td>
                      <a href={p.url} target="_blank" rel="noreferrer">
                        {p.path}
                      </a>
                    </td>
                    <td>{p.source}</td>
                    <td>{p.isPage ? "✓" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}
    </main>
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
