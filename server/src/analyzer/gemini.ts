// Gemini call helper — ported from reference/server.js:282 (`geminiCall`).
// Rotates across GEMINI_KEYS and a model fallback chain, with an abort timeout.
// Used sparingly: only for genuinely fuzzy judgements (service vs condition,
// provider bio extraction), and always batched — never one call per URL.

interface GeminiPart {
  text: string;
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
