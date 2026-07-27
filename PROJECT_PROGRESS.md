# LINE Report Project Progress

## Document information

- Current date: 2026-07-27
- Repository: `https://github.com/MARUGO-s/line_report`
- Branch: `main`
- Work-start HEAD: `e58715f0e8b4a62d9c0622b21ff730060e3e1c4c`
- Production: `https://marugo-s.github.io/line_report/`
- Supabase: `hocbnifuactbvmyjraxy`
- Do not record secret values, customer data, message bodies, receipt images, or uploaded media here.

## Current application boundary

- Static GitHub Pages management application for 22 stores.
- Protected management API and store-scoped sessions through Supabase `admin-api`.
- Store-specific LINE Webhooks, management Bot, media, conversation search, receipts, sales analytics, reservations/Gmail, reviews, petty cash, and AI-usage management.
- MARUGO S foodcourt forecasting, multi-agent analysis, daily reports, quality loops, and learning/fallback history.
- Supabase migrations, RLS, private Storage, pg_cron, and multiple cron Edge Functions.
- Auxiliary legacy/optional Cloudflare, Render OCR bridge, local Express/SQLite, and Google Apps Script components.

## Knowledge system

- Graphify is the code/SQL structural index. Final baseline includes third-party vendor exclusions and SQL parser coverage.
- Obsidian is durable external memory. Manual notes, mirrored repository docs, and generated Graphify notes are separate.
- AI workflow: Obsidian search → knowledge check → Graphify query/path/explain → targeted source reading → implementation/verification → knowledge writeback → regeneration.
- `knowledge/system-architecture.json` generates the production, business-AI, and development-knowledge diagrams from one model.
- `system-map.html` verifies the existing admin session before embedding the public code-only maps.

## Required closure checklist

1. Update this file and `docs/店舗運用修正記録.md`.
2. Update relevant manual Obsidian knowledge.
3. Run `npm run knowledge:update`, `npm run knowledge:check`, related tests, and `git diff --check`.
4. Commit/push and verify Pages plus any Supabase deployment.

## Open product work

- Actual provider/API and production-data work remains governed by existing feature docs and operations log.
- For this knowledge-system task, Supabase schema, Edge Functions, secrets, production data, and external providers are not changed.

## Continuation log

New records are appended below.

### 2026-07-27 11:48 JST - Graphify・Obsidian・AI開発知識環境を導入

- Request: Instatic TalksXと同様に、LINE ReportへObsidianとGraphifyを十分に連携した開発知識システムと、AIが活用できる環境図を構築する。
- Design:
  - Graphify = 現在のコード/SQL構造、関数・テーブル・migration・経路の索引。
  - Obsidian = 手書き知識、既存README/docsミラー、Graphify生成ノートの外部記憶。
  - AI = `knowledge:search` → `knowledge:check` → Graphify → 必要箇所精読 → 実装/検証 → 知識書き戻し → 再生成。
- Graphify:
  - 専用Python環境へ`tree-sitter-sql==0.3.11`を導入。
  - `.graphifyignore`でvendor、node_modules、生成物、backups、data、`.env*`、`.claude`、Supabase temp、`.clasp`を除外。
  - 古いSQLキャッシュ時はmigration coverage不足を検出し、`--force`で自動再抽出。
  - 最終結果: 2,982ノード、6,750関係、294コミュニティ、SQL 176ファイル/417ノード。Supabase migration 175/175件を全てグラフに収録。
- Environment diagrams:
  - `knowledge/system-architecture.json`を正本として3層図を生成。
  - 本番・配信・外部サービス: GitHub Pages/Actions、Supabase、LINE、Google、AI providers、補助/レガシー経路。
  - 業務データ・AI処理: レシート/OCR、売上、予約/Gmail、検索/メディア、口コミ、小口、フードコート予測/AI/品質ループ。
  - AI開発知識循環: AI入口、Obsidian検索、既存docsミラー、Graphify+SQL、精読、実装/テスト、本番確認、知識書き戻し。
- Management UI:
  - `index.html`ページメニューへ「システムマップ」を追加。
  - `system-map.html`を追加。`auth-session.js`の既存セッションを`POST /auth/verify`で検証し、全体管理者（storeScope/roomScope/scopeKindなし）だけ許可。
  - 未認証・店舗/ルーム限定セッションではiframeを読み込まず接続設定へ案内。
  - LINEアプリ経由は既存方針どおり`analytics.html?from=line`へリダイレクト。
  - コード/SQL構成、本番構成、業務AI構成、AI知識循環を切替表示。
- Obsidian:
  - `アプリ知識/10_アプリ別/LINE Report/`を作成し、総合アプリ一覧へ追加。
  - 手書き: 概要、アーキテクチャ/セキュリティ、運用、意思決定、障害、レシート、売上/口コミ、予約、フードコートAI。
  - `70_AI作業環境`: AI START HERE、3図、情報源、チェックリスト、Graphify/Obsidianブリッジ、Canvas 3件。
  - `80_リポジトリ文書`: README、AGENTS、HANDOFF、PROGRESS、docs 31件を自動ミラー。正本はGit側。
  - `90_Graphify`: 自動生成ノート3,276件と`graph.canvas`。nested `.obsidian`は削除。
  - LINE Report配下はMarkdown合計3,330件、AI workspace 10ファイル。
- Security:
  - `docs/SECURITY.md`へ公開システムマップの不変条件と更新チェックを追加。
  - Graphify/Obsidian/Gitへ秘密値、顧客データ、メッセージ本文、レシート画像、添付メディアを入れない。
  - 公開manifestにローカル`/Users/`パスなし。高リスク秘密値スキャン成功。
  - 本番`admin-api POST /auth/verify`は未認証で401を確認。
- Automation:
  - `knowledge:update`, `knowledge:check`, `knowledge:search`, `knowledge:generate`, `graphify:system-map`, `test:knowledge`, `check`, aggregate `test`を追加。
  - `docs/AI_CONTEXT.md`, `docs/AI_KNOWLEDGE_SYSTEM.md`, `system-map/`生成物を追加。
  - `npm run knowledge:search`で既存の`店舗運用修正記録`, `LINE-RECEIPT-ANALYSIS`, `SECURITY`, フードコート完全設計書等を検索できることを確認。
- Tests:
  - `npm run check`: success.
  - `npm test`: knowledge 7/7、foodcourt 44/44、reservation 4/4、receipt 28/28。合計83/83 success.
  - `npm run knowledge:check`: Graphify freshness、SQL coverage、構成hash、Web生成物、Obsidianミラー一致、Canvas、秘密値検査すべてsuccess.
  - Auth gate unit scenarios: tokenなし、store scope、future scopeKind拒否、全体管理者成功、stats失敗時のmap継続を確認。
- UI verification:
  - ローカル`system-map.html`未認証ゲートを1280×900で確認。マップは未読込、接続設定リンクを表示。
  - 3層環境図を1440×1000で確認。
  - 業務AI図を390×844で確認。統計を折返し表示、タブと大型図は横スクロール。
  - `?from=line&store_key=marugoS`は売上分析へリダイレクトし`<title>売上分析`を確認。
  - ObsidianアプリでLINE Reportの`00_AI_START_HERE`を開き、2,982ノード/6,750関係/SQL 176、3図/Canvas導線を確認。
- Documentation:
  - README、DOCS-INDEX、README-PAGES、SECURITY、店舗運用修正記録、ローカルサーバー案内を更新。
  - `AGENTS.md`, `AI_HANDOFF.md`, `PROJECT_PROGRESS.md`を追加。
- Deployment scope:
  - Supabase DB migration、Edge Functions、Secrets、LINE/Google/AI providers、本番データの変更なし。
  - Integration commit `1aecf7ef806b4573630b714dab55a1c3b4a6552e`とGraphify生成物整合commit `2c8eaf0956cab5f34da37437d19765e6d6bdc87c`を`main`へpush。
  - GitHub Pages workflow run `30233350201`（HEAD `2c8eaf0956cab5f34da37437d19765e6d6bdc87c`）はsuccess。
  - 公開`index.html`、`system-map.html`、`environment.html`、`graph.html`、`graph-stats.json`、`knowledge-system-manifest.json`は全てHTTP 200。
  - 公開環境図に2,982ノード、6,750関係、SQL 176ファイル/417ノード、3層図を確認。公開manifestにローカル`/Users/`パスなし。
  - 今回HEADの`Deploy Edge Functions` workflowは起動していない。Supabase DB/Functions/Secretsは変更なし。
- Remaining:
  - 認証済み本番全体管理者で4表示を切り替える最終操作確認。
