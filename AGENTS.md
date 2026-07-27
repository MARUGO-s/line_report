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
