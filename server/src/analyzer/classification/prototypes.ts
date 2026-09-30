import type { SectionKey } from "../classify.js";

export interface Prototype {
  category: SectionKey;
  text: string;
  vector?: number[];
}

// Reference page descriptions with pre-computed gemini-embedding-2 vectors
// (3072 dims), compared against each ambiguous page's embedding in
// pipeline.ts. The vectors live in prototypes.json and are loaded on first
// use: only the embedding stage needs them, and ~1.2MB of numbers as a
// TypeScript array literal made every typecheck and cold start parse it.
let cached: Promise<Prototype[]> | null = null;

export function loadPrototypes(): Promise<Prototype[]> {
  cached ??= import("./prototypes.json", { with: { type: "json" } }).then((m) => m.default as Prototype[]);
  return cached;
}
