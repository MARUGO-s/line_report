# LINE Report AI operating rules

These rules apply to every AI or automated coding agent working in this repository.

## Required startup

1. Read `PROJECT_PROGRESS.md`, `AI_HANDOFF.md`, `docs/SECURITY.md`, `docs/DOCS-INDEX.md`, `docs/REPOSITORY_STRUCTURE.md`, and `docs/AI_KNOWLEDGE_SYSTEM.md`.
2. Read Obsidian:
   `/Users/yoshito/Library/CloudStorage/Dropbox/web/アプリ知識/10_アプリ別/LINE Report/70_AI作業環境/00_AI_START_HERE.md`.
3. Check `git status --short`, branch, and HEAD. Never overwrite unrelated work.
4. Run `npm run knowledge:search -- "<task or symptom>"`.
5. Run `npm run knowledge:check`.

## Graphify-first investigation

- Start code and SQL investigation with `graphify query`, `graphify path`, or `graphify explain`.
- Graphify includes the repository's SQL migrations through `tree-sitter-sql`.
- After Graphify narrows the area, read only the relevant functions, migrations, static HTML sections, and existing docs.
- Large inline JavaScript inside `.html`, GitHub/Supabase/LINE settings, secrets, and external service state still require direct verification.
- Do not start with blind repository-wide `grep`/`read` loops.
- Keep GitHub Pages compatibility files under `public/` as defined in `docs/REPOSITORY_STRUCTURE.md`; the deployment workflow publishes that directory at the existing URLs. Put local DBs, backups, restore material, and temporary state under `.local/`; never commit them.

## Source-of-truth priority

1. Live GitHub Pages, Supabase hocbn, GitHub Actions, LINE, and AI-provider state.
2. Git working copy for HTML/JS, Edge Functions, migrations, and tests.
3. Graphify for current code/SQL structure.
4. Obsidian manual notes and `80_リポジトリ文書` for design rationale, security rules, operations, and incident history.
5. Conversation context only for the current request; write durable knowledge back.

## Security invariants

- Read `docs/SECURITY.md` before auth, RLS, migration, webhook, cron, Storage, or customer-data work.
- Public Pages must not access business tables directly.
- Preserve admin store/room scope and LINE signature verification.
- Never add env files, service-role keys, LINE tokens, AI keys, Gmail credentials, customer data, message bodies, receipt images, or uploaded media to Git, Graphify, Obsidian, screenshots, or chat.
- Schema changes require migration files. Run Supabase Advisors after relevant DB changes.

## Required closure

1. Run syntax/static checks and the relevant existing test groups.
2. Verify UI locally with `./scripts/local-line-report-pages.sh`; check desktop and mobile when UI changes.
3. Verify Pages/API/Edge Functions/DB as applicable. An unauthenticated `401` is a useful live auth check for protected APIs.
4. Update the relevant manual Obsidian note, `docs/店舗運用修正記録.md`, `PROJECT_PROGRESS.md`, and other affected source docs.
5. Run `npm run knowledge:update`, `npm run knowledge:check`, and `git diff --check`.
6. Commit/push and confirm GitHub Pages plus any Edge Function/migration deployment.

## Long task communication

During multi-layer DB/API/UI/deploy work, provide short concrete progress updates naming completed layers, the current layer, and the remaining verification.

## Cursor Cloud specific instructions

Environment prepared by a Cloud Agent. Dependencies are refreshed on startup by the update script (`npm install`); Deno and the Node-version fix below are baked into the VM image, not the update script.

### Runtimes (non-obvious)

- The default `node` on `PATH` is `/exec-daemon/node` (v22.14.0), which is **too old** to run this repo's `.ts` tests: the scripts call `node --test tests/*.test.ts` with no flag, and unflagged TypeScript type-stripping requires **Node ≥ 22.18**. nvm already ships **v22.22.2** as its default; `~/.bashrc` prepends that version's bin ahead of `/exec-daemon` so `node` resolves to v22.22.2. Confirm with `node --version`. If a shell ever shows v22.14.0, run `export PATH="$NVM_DIR/versions/node/$(nvm version default)/bin:$PATH"` before running tests.
- **Deno** (v2.1.x at `/usr/local/bin/deno`) is required by `test:journal-ai` and `test:pos-journal` (they call `deno test`).

### Lint / test

- Lint / static checks: `npm run check` (Node `--check` + `bash -n`; also runs the journal/ownership integration checks). Passes here.
- Tests: run **`npm run test:ci`** (structure + foodcourt + reservation + receipt + journal-ai + pos-journal ≈ 170 tests). This is the runnable suite in this environment.
- **Do not expect `npm test` to pass fully here.** It also runs `test:knowledge`, which reads `graphify-out/graph.json` produced by the external **Graphify** CLI. Graphify (and `npm run knowledge:*` / `npm run graphify:*` / `npm run knowledge:update`) needs the proprietary Graphify CLI plus `uv` + `tree-sitter-sql`, none of which are installed here. Skip those unless Graphify is available.

### Running the product

- Frontend (the actual LINE Report product): `./scripts/local-line-report-pages.sh` serves `public/` via `python3 -m http.server` at `http://127.0.0.1:8765/line_report/` (see README §10). There is no build step.
- The frontend calls **production Supabase (hocbn)**; login and all cloud/data/AI features need a real admin/session token (`ADMIN_DASHBOARD_TOKEN` / `lrst_...`), which is **not** present as a secret in this environment. Without it you can only exercise client-side features. The Journal Report converter (`jnm/jnl2txt.html` → "変換" tab) parses `.jnl`/`.lzh` POS journals **fully client-side** (no secrets needed); only save/AI need auth.
- Legacy Express/SQLite wine app (`src/server.js`): `npm run dev` (or `start`) runs it on port **3200**, DB at `.local/sqlite/wine_price.db`. It is what the root `dev`/`start` scripts launch but is **unrelated** to the LINE Report product; useful as a self-contained local backend for smoke tests (e.g. `GET /api/health`).
