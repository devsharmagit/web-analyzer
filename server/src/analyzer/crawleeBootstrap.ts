// Must be imported BEFORE "crawlee" anywhere it's used — ESM evaluates a
// file's own imports in the order they're written, so importing this first
// (with zero imports of its own) guarantees these env vars are set before
// crawlee's module code runs and reads them.
process.env.CRAWLEE_STORAGE_DIR ??= new URL("../../.crawlee-storage", import.meta.url).pathname;
process.env.CRAWLEE_LOG_LEVEL ??= "ERROR"; // quiet by default — we print our own summaries
