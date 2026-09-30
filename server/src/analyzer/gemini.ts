// Gemini call helper — ported from reference/server.js:282 (`geminiCall`).
// Rotates across GEMINI_KEYS and a model fallback chain, with an abort timeout.
// Used sparingly: only for genuinely fuzzy judgements (service vs condition,
// provider bio extraction), and always batched — never one call per URL.

interface GeminiPart {
  text: string;
}

// Same key rotation as geminiCall(): a rate-limited (429) or unavailable (503)
// key moves on to the next one instead of failing every embedding. Each
// attempt has its own timeout; `signal` lets the caller abort the whole call
// (classify.ts uses it as a deadline for its embedding stage).
export async function embedText(text: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<number[]> {
  const GEMINI_KEYS = keys();
  if (!GEMINI_KEYS.length) throw new Error("No GEMINI_KEYS configured");

  const body = JSON.stringify({
    model: "models/gemini-embedding-2",
    content: { parts: [{ text }] },
  });

  let lastErr: Error | null = null;
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    if (opts.signal?.aborted) break;
    const key = GEMINI_KEYS[(gkIdx + i) % GEMINI_KEYS.length]!;
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15000);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent`, {
        method: "POST",
        signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body,
      });
      if (res.status === 429 || res.status === 503) {
        lastErr = new Error(`Embedding API error: ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Embedding API error: ${res.status} ${errorText.slice(0, 200)}`);
      }
      const data: any = await res.json();
      gkIdx = (gkIdx + i + 1) % GEMINI_KEYS.length;
      return data.embedding.values;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      // A non-retryable API error (bad request, auth) will fail the same way
      // on every key — stop instead of burning through all of them.
      if (/Embedding API error: (400|401|403)/.test(lastErr.message)) break;
    }
  }
  throw lastErr || new Error("Embedding call aborted");
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  // Vectors from different embedding models (e.g. prototypes computed with an
  // older model) aren't comparable at all — a partial dot product over the
  // shorter one would look like a real score.
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i]! * vecB[i]!;
    normA += vecA[i]! * vecA[i]!;
    normB += vecB[i]! * vecB[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface GeminiCallOpts {
  system?: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

let gkIdx = 0;

function keys(): string[] {
  return (process.env.GEMINI_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
}

function models(opts: GeminiCallOpts): string[] {
  if (opts.model) return [opts.model];
  const primary = process.env.GEMINI_MODEL || "";
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean);
  return [primary, ...fallbacks].filter((m, i, a) => m && a.indexOf(m) === i);
}

/** True when at least one API key is configured — callers use this to skip AI steps cleanly. */
export function geminiAvailable(): boolean {
  return keys().length > 0;
}

export async function geminiCall(parts: GeminiPart[], opts: GeminiCallOpts = {}): Promise<string> {
  const GEMINI_KEYS = keys();
  if (!GEMINI_KEYS.length) throw new Error("No GEMINI_KEYS configured");

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: opts.temperature ?? 0.5, maxOutputTokens: opts.maxOutputTokens ?? 8000 },
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

  const modelList = models(opts);
  let lastErr: Error | null = null;

  for (const model of modelList) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
      const key = GEMINI_KEYS[(gkIdx + i) % GEMINI_KEYS.length]!;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 30000);
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          signal: ctl.signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
        });
        if (r.status === 429 || r.status === 503 || r.status === 404) {
          lastErr = new Error(`${model} → ${r.status}`);
          continue;
        }
        const d: any = await r.json();
        if (!r.ok) throw new Error(`gemini ${r.status}: ${(d?.error?.message || "").slice(0, 140)}`);
        const text = d?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
        gkIdx = (gkIdx + i + 1) % GEMINI_KEYS.length;
        return text;
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw lastErr || new Error("Gemini call failed with no further detail");
}
