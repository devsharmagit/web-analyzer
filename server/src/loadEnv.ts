// Loads server/.env into process.env — the one place config is read from disk.
// Imported first by the entry point (ESM evaluates imports in order, so it
// runs before any module that reads config), and by fetchWithFallback.ts so
// tests and scripts that import the analyzer directly get the same config.
// Variables already set in the environment are not overridden.
//
// .env is optional: without it, Gemini-dependent phases degrade to
// "uncertain"/"unknown" and the proxy fallback is disabled.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no .env — fine
}
