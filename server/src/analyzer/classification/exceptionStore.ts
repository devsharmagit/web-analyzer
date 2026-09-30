import pg from 'pg';
const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  if (!pool && process.env.NEON_DB_URL) {
    pool = new Pool({
      connectionString: process.env.NEON_DB_URL,
      // pg's defaults are "wait forever". An unreachable database must not
      // stall classification — it runs inside the taxonomy phase's timeout,
      // and a hang here used to cost the entire page taxonomy.
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
    // An idle client erroring (e.g. Neon closing the connection) is emitted
    // on the pool; unhandled, it would crash the process.
    pool.on("error", (err) => console.warn("⚠️  [WARN] Neon DB pool error:", err.message));
  }
  return pool;
}

// The whole corrections table is small and read on every analysis, so it's
// cached in memory rather than re-queried each time. addException() clears
// the cache so a new correction applies to the very next analysis.
const CACHE_TTL_MS = 60_000;
interface CompiledCorrections {
  exact: Map<string, string>;
  wildcards: Array<{ re: RegExp; category: string }>;
}
let cache: { at: number; value: CompiledCorrections } | null = null;

async function loadCorrections(p: pg.Pool): Promise<CompiledCorrections> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const res = await p.query<{ url_pattern: string; correct_category: string }>(
    `SELECT url_pattern, correct_category FROM corrections ORDER BY created_at ASC`
  );
  const exact = new Map<string, string>();
  const wildcards: Array<{ re: RegExp; category: string }> = [];
  for (const row of res.rows) {
    if (row.url_pattern.includes("%")) {
      const regexStr = "^" + row.url_pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%/g, ".*")
        .replace(/_/g, ".") + "$";
      wildcards.push({ re: new RegExp(regexStr, "i"), category: row.correct_category });
    } else {
      exact.set(row.url_pattern, row.correct_category);
    }
  }
  cache = { at: Date.now(), value: { exact, wildcards } };
  return cache.value;
}

export async function initExceptionStore(): Promise<boolean> {
  const p = getPool();
  if (!p) {
    console.warn("⚠️  [WARN] Neon DB Exception Store: NEON_DB_URL is not set or empty. Exception store is inactive.");
    return false;
  }
  try {
    const res = await p.query("SELECT 1 AS alive");
    console.log("✅ [INFO] Neon DB Exception Store: Connected successfully to Neon DB.");
    await p.query(`
      CREATE TABLE IF NOT EXISTS corrections (
        id SERIAL PRIMARY KEY,
        url_pattern TEXT NOT NULL,
        matched_field TEXT NOT NULL,
        wrong_category TEXT NOT NULL,
        correct_category TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    return true;
  } catch (error) {
    console.warn(`⚠️  [WARN] Neon DB Exception Store: Failed to connect to Neon DB (${error instanceof Error ? error.message : String(error)}). Exception store is unreachable.`);
    return false;
  }
}

export async function batchCheckExceptions(
  urls: string[]
): Promise<Map<string, { category: string; confidence: number; method: "exception" }>> {
  const result = new Map<string, { category: string; confidence: number; method: "exception" }>();
  if (!urls.length) return result;

  const p = getPool();
  if (!p) return result;

  try {
    const { exact: exactMap, wildcards } = await loadCorrections(p);
    if (!exactMap.size && !wildcards.length) return result;

    for (const u of urls) {
      const exact = exactMap.get(u);
      if (exact) {
        result.set(u, { category: exact, confidence: 1.0, method: "exception" });
        continue;
      }
      for (const w of wildcards) {
        if (w.re.test(u)) {
          result.set(u, { category: w.category, confidence: 1.0, method: "exception" });
          break;
        }
      }
    }
  } catch (error) {
    console.warn("⚠️  [WARN] Neon DB Exception Store batch query failed:", error instanceof Error ? error.message : error);
  }

  return result;
}

export async function checkExceptions(url: string): Promise<{ category: string; confidence: number; method: "exception" } | null> {
  const map = await batchCheckExceptions([url]);
  return map.get(url) || null;
}

export async function addException(urlPattern: string, matchedField: string, wrongCategory: string, correctCategory: string): Promise<void> {
  const p = getPool();
  if (!p) {
    throw new Error("Neon DB is not configured (NEON_DB_URL is missing or empty)");
  }
  
  // ensure table exists
  await p.query(`
    CREATE TABLE IF NOT EXISTS corrections (
      id SERIAL PRIMARY KEY,
      url_pattern TEXT NOT NULL,
      matched_field TEXT NOT NULL,
      wrong_category TEXT NOT NULL,
      correct_category TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await p.query(
    `INSERT INTO corrections (url_pattern, matched_field, wrong_category, correct_category) 
     VALUES ($1, $2, $3, $4)`,
    [urlPattern, matchedField, wrongCategory, correctCategory]
  );
  cache = null;
}
