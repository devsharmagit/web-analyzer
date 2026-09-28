# GEMINI / ANTIGRAVITY AGENT INSTRUCTIONS — WEB ANALYZER

## 🧠 Universal Multi-IDE Shared Memory Directive

> **CRITICAL RULE**: Do NOT store persistent knowledge, project decisions, or session summaries in native agent-local storage (`.gemini/`, brain logs, or hidden IDE scratchpads).
> 
> All persistent memory for `web-analyzer` lives in the dedicated Obsidian Vault at:
> **`/Users/devsharma/Documents/Obsidian Vault/ai-coding-mem/web-analyzer`**
>
> This vault is the shared source of truth across all coding environments (Antigravity/Gemini, Cursor, Windsurf, Claude Code, Cline, etc.).

---

## 1. Session Start: Context Retrieval Protocol

At the start of every session or complex task:
1. Access the Obsidian memory vault at `/Users/devsharma/Documents/Obsidian Vault/ai-coding-mem/web-analyzer/`.
2. Inspect the following core memory notes for current project context:
   - `INDEX.md` — Overview, tech stack, and documentation map.
   - `CURRENT-STATE.md` — Current progress, active phase status, and next tasks.
   - `TASK-LOG.md` — Most recent session entries and changes made across IDEs.
   - (As needed) `PIPELINE-AND-TAXONOMY.md` / `SYSTEM-ARCHITECTURE.md` / `DECISIONS-LOG.md` / `PATTERNS-AND-CONVENTIONS.md`.

---

## 2. Post-Task Protocol: Memory Persistence (MANDATORY)

**IMMEDIATELY after completing any task, feature, refactor, or bug fix**, you MUST persist important memories and updates directly to the Obsidian Vault (`/Users/devsharma/Documents/Obsidian Vault/ai-coding-mem/web-analyzer/`):

### A. Append to `TASK-LOG.md`
Add a new entry with this format:
```markdown
### [YYYY-MM-DD] — <Brief Task Title>
- **Agent / IDE**: Antigravity (Gemini)
- **Objective**: <What was requested and accomplished>
- **Files Modified / Created**:
  - `path/to/file1.ts`
  - `path/to/file2.tsx`
- **Key Changes & Rationale**: <Summary of implementation decisions and logic>
- **Verification**: <Tests run and outcomes, e.g., typecheck passed, pipeline tests passing>
- **Notes / Gotchas**: <Any edge case, warning, or detail useful for future sessions>
```

### B. Update `CURRENT-STATE.md`
- Check off completed items in the roadmap or phase tables (`- [x]`).
- Update the "Recent Major Milestones" section if a meaningful capability was unlocked.
- Add newly uncovered issues, blockers, or next steps to "Active Roadmap & Next Objectives".

### C. Update `DECISIONS-LOG.md` (When Applicable)
- If an architectural choice, new library, database change, or pipeline strategy was decided or altered, create a new ADR entry:
  - **ADR-XXX**: `<Title>`
  - **Context**: `<Why the change was needed>`
  - **Decision**: `<What was implemented>`
  - **Status**: `<Accepted / Implemented>`

### D. Update `PATTERNS-AND-CONVENTIONS.md` (When Applicable)
- If a new code convention, scraping edge case (e.g. CDN headers, stream limits), or testing requirement was introduced, document it immediately.

---

## 3. How to Access and Write to the Vault

The vault is located outside the workspace at:
`/Users/devsharma/Documents/Obsidian Vault/ai-coding-mem/web-analyzer`

Use bash/shell commands or lightweight scripts (e.g. Python) executed via `run_command` to read and update files in the vault:
- Ensure file encodings are UTF-8.
- Maintain Markdown and Obsidian compatibility: use standard Markdown links `[Title](./file.md)` or Obsidian wikilinks `[[Note-Name]]`.
- Always verify that written files retain clean structure and valid Markdown.

---

## 4. Codebase Core Rules & Verification

- **Node / TypeScript**: ES Modules (`"type": "module"`). Strict types, no unchecked `any`.
- **Classification Pipeline**: 4 tiers — Denylist -> Neon DB Exception Store -> `gemini-embedding-2` vector similarity -> Batched LLM adjudication.
- **LLM Calls**: Always batched, never executed in a loop per URL.
- **Resilience**: Never let errors in secondary phases (providers, locations, before/after) fail the primary crawl and inventory run.
- **Verification Commands**:
  - `cd server && npm run typecheck`
  - `cd server && npm test`
  - `cd server && npm run test:pipeline`
  - `cd client && npm run typecheck`
  - `cd client && npm run build`
