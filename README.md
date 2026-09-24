# Website Analyzer

Given one website URL, return a structured profile of the site — platform, page
counts by type, store size, providers and locations. Med-spa vertical.
Full architecture & analysis strategies in [ARCHITECTURE.md](ARCHITECTURE.md); scope in [ANALYZER-SCOPE.md](ANALYZER-SCOPE.md); build plan in [TODO.md](TODO.md).

## Structure

```
server/   Node + Express + TypeScript API   (GET /api/analyze?url=)
client/   React + Vite + TypeScript frontend
reference/  legacy website-build-tool code, kept locally to port from (git-ignored)
```

## Running it

Two terminals:

```bash
# terminal 1 — API on http://localhost:3001
cd server && npm install && npm run dev
```

```bash
# terminal 2 — UI on http://localhost:5173 (proxies /api to the server)
cd client && npm install && npm run dev
```

Then open http://localhost:5173 and paste a URL.

## Server scripts (`cd server`)

- `npm run dev` — watch mode (tsx)
- `npm test` — Phase 1 crawl checks (hits ruma.com live)
- `npm run build` / `npm start` — compile to `dist/` and run
- `npm run typecheck`

## Status

Phase 1 (page inventory) is ported and passing. Phases 2–5 (platform, taxonomy,
providers, locations, richer UI) are tracked in [TODO.md](TODO.md).
