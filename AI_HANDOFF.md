# LINE Report AI Handoff

## Project

- Production: `https://marugo-s.github.io/line_report/`
- Repository: `MARUGO-s/line_report`, branch `main`
- Working copy: `/Users/yoshito/Library/CloudStorage/Dropbox/web/line_report-main`
- Supabase production project: `hocbnifuactbvmyjraxy`
- Main surfaces: static GitHub Pages, `admin-api`, store-scoped `line-webhook`, cron Functions, Postgres/RLS, private `line-media` Storage.

## Knowledge environment

- AI rules: `AGENTS.md`
- Current state: `PROJECT_PROGRESS.md`
- Security source: `docs/SECURITY.md`
- Documentation index: `docs/DOCS-INDEX.md`
- Talk (chat.html) guide: `docs/CHAT-TALK-GUIDE.md`
- Repository layout: `docs/REPOSITORY_STRUCTURE.md`
- Architecture model: `knowledge/system-architecture.json`
- Public system page source: `public/system-map.html`
- Generated code/SQL graph: `public/system-map/graph.html`
- Generated environment diagrams: `public/system-map/environment.html`
- Obsidian app folder: `アプリ知識/10_アプリ別/LINE Report`
- AI entry note: `70_AI作業環境/00_AI_START_HERE.md`
- Repository docs mirror: `80_リポジトリ文書/`
- Graphify notes: `90_Graphify/`

## Commands

```bash
npm run knowledge:search -- "<task or symptom>"
npm run knowledge:check
graphify query "<question>"
graphify path "<A>" "<B>"
graphify explain "<node>"
npm run knowledge:update
```

## Required investigation order

1. Search Obsidian/manual repository docs.
2. Check Graphify freshness and SQL coverage.
3. Use Graphify to locate relevant code/migrations.
4. Read exact source sections and live service state.
5. Implement and verify.
6. Write durable knowledge back and regenerate.

## Important boundaries

- `public/pages-config.js` is the frontend URL/store catalog source.
- `public/auth-session.js` manages scoped `lrst_` sessions and one-time `lrlt_` exchange.
- Public Pages never read business tables directly; use protected Edge Functions.
- `docs/SECURITY.md` invariants remain mandatory.
- Own-store reviews (`store_review_*`) and competitor reviews remain separate.
- Talk cards (`chat_messages.kind='card'`) are service-role only; browser inserts are forced to `text`/`image` by trigger.
- Talk images live in the private `chat-images` bucket and are read through signed URLs, unlike the public `chat-icons`.
- `line_receipt__*` source rows and `line_room_receipt_search` index are separate.
- Graphify excludes vendor/node_modules/generated/secret paths but includes SQL migrations.
- GitHub Actions publishes `public/` to GitHub Pages at the existing `/line_report/*` URLs. Local DBs and backups belong under `.local/`.
