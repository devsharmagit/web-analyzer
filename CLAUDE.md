# CLAUDE.md

Website analyzer for the med-spa vertical: given one URL, it returns the site's
platform, page counts by type, store, providers, locations and before/after
gallery. `server/` is the Express + TypeScript API (`GET /api/analyze?url=`),
`client/` is the React + Vite dashboard with PDF export. Architecture and
analysis strategy: [ARCHITECTURE.md](ARCHITECTURE.md).

## Shared memory vault

Project memory shared across coding tools (Claude Code, Antigravity/Gemini,
Cursor, Windsurf) lives outside the repo:

`/Users/devsharma/Documents/Obsidian Vault/ai-coding-mem/web-analyzer`

- At session start, read `CURRENT-STATE.md` and the latest entries in `TASK-LOG.md`.
- After completing a task, append an entry to `TASK-LOG.md` (format in
  [GEMINI.md](GEMINI.md) §2A, with "Claude Code" as the agent) and update
  `CURRENT-STATE.md`. Record architecture decisions in `DECISIONS-LOG.md` and new
  conventions in `PATTERNS-AND-CONVENTIONS.md`.
- The vault's descriptive notes (`SYSTEM-ARCHITECTURE.md`, `PIPELINE-AND-TAXONOMY.md`)
  have drifted from the code in places. When a note and the code disagree, the
  code is right; correct the note.

## Commands

```bash
cd server
npm run dev             # API on :3001 (tsx watch)
npm run typecheck
npm run test:unit       # offline unit tests — no network, no API keys
npm test                # crawl checks, hits ruma.com live
npm run test:pipeline   # classification tests, calls Gemini live

cd client
npm run dev             # UI on :5173; talks to VITE_API_URL from client/.env.local
npm run typecheck
npm run build
```

Everything except `test:unit` hits live sites and uses the Gemini keys and
proxy credentials in `server/.env`, so a failure there can be the network.

## Rules

- ESM TypeScript, strict mode. Relative imports end in `.js`.
- Secondary phases (platform, providers, locations, before/after, store) must
  never fail the crawl or the whole analysis. Each runs under `withTimeout` in
  `server/src/analyzer/index.ts` with a fallback value.
- Gemini: batch ambiguous items into one call; never one LLM call per URL.
- Route outbound page fetches through `fetchWithFallback.ts` and send
  `ANALYZER_UA` unless there's a specific reason not to.
- Report `"unknown"` rather than `0` when detection couldn't verify something:
  `0` means verified absence.
- `client/src/api.ts` mirrors the server's `AnalyzeResult` by hand. Change both.
- `server/validation/out/` holds names and bios scraped from real sites. Never commit it.
