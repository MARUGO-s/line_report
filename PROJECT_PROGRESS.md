# LINE Report Project Progress

## Document information

- Current date: 2026-08-02
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
- 2026-07-31: Journal Report 全店舗ドロップダウン＋store_partition_key分離＋管理者横断サマリーを追加。店舗用ログインは自店固定。

## Continuation log

New records are appended below.

### 2026-08-02 - Journal AI conversational intent clarification

- Request: 質問が少しでも曖昧な場合、AIが質問の目的を聞き返し、知りたい内容を具体化してから分析する。
- Change: 保存データ検索前に、総売上・推移、フード／ドリンク／ワイン比率、客数／客単価、商品内訳、原因分析／改善策の5分類を判定。焦点が無い質問には選択肢を返し、番号回答を元の質問へ結合して検索・AIへ渡す。
- Behavior: 明確な指標・比較・期間質問は即時処理し、曖昧な質問だけ対話を1往復追加。質問内容は会話履歴から引き継ぐ。
- Scope: `public/jnm/jnl2txt.html` / `index.html` とフロント回帰テストのみ。DB・Edge Function変更なし。

### 2026-08-02 - Journal AI mobile keyboard-safe composer

- Request: スマートフォン／タブレットでソフトウェアキーボード表示時も、AIチャットの入力欄と入力中の文字を見える状態にする。
- Change: 固定`100vh`をVisual Viewport追従の高さ・上端へ変更。入力欄を縮小対象外にし、フォーカス時の表示位置・最下部スクロールを同期。モバイルは全幅、入力文字16px、44pxタップ領域、safe-area対応。
- Input: 日本語IME変換中のEnterでは送信しない。
- Scope: `public/jnm/jnl2txt.html` / `index.html` とフロント回帰テストのみ。DB・Edge Function変更なし。

### 2026-08-02 - Journal AI conversational saved-data query planner

- Request: 保存済みレポートがあるのに曖昧な質問で「データなし／0」と返さず、必要範囲を対話で確認し、AIトークン量も抑える。
- Change: 保存レポートの軽量月次索引を先に確認。「最新月」「直近3/12か月」「全期間」は必要月だけ集約し、期間が曖昧なら保存範囲を示して4択で聞き返す。取得・認証エラーはデータ不存在と区別。
- UI: Journal Reportのテーマ未設定時はライトモードで起動し、明示的に保存されたダーク設定は維持。
- Scope: `public/jnm/jnl2txt.html` / `index.html` とフロント回帰テストのみ。DB・Edge Function変更なし。

### 2026-08-01 - Journal AI Luna + Kimi K3 fallback

- Request: 既定 gpt-5.6-luna のフォールバックに Kimi K3 を指定。
- Change: `ai-analyze` で Luna 失敗時に `kimi-k3` へ自動退避。応答 note にフォールバック表示。

### 2026-08-01 - Journal AI default → gpt-5.6-luna

- Request: Journal Report AIの既定を Kimi K3 から GPT Luna へ変更。
- Change: `ai-analyze` を OpenAI `gpt-5.6-luna` 既定に切替。戦略系の外部ブリーフ統合先も Luna。

### 2026-07-31 - Receipt correction multi-field edits

- Request: 「この結果を修正」で複数箇所を直せるようにする。
- Change: `receipt_correction.ts` で変更済み項目の蓄積・可視化、「すべて保存して終了」、`5 140000` 形式の一括入力を追加。`line-webhook` デプロイ対象。

### 2026-07-31 - Remove Journal Report「クラウド連携」badge

- Request: ヘッダーの「クラウド連携」バッジを削除。
- Change: `public/jnm` ナビの `.pill-live` 要素とCSSを除去（`jnl2txt.html` / `index.html` 同期）。

### 2026-07-31 - Journal Report light-mode text contrast

- Request: ライトモードの文字視認性を上げ、濃くする。
- Change: `public/jnm` のライトテーマで `--text-2`/`--text-3`・本文色・アクセント・レポート内 opacity を濃く調整（ダークは変更なし）。
- Files: `jnl2txt.html` / `index.html`、運用記録。

### 2026-07-31 - Journal Report multi-store select and isolation

- Request: 店舗選択UI、店舗ごとの独立保存、非管理者の横断禁止、管理者の横断閲覧・分析。
- Isolation: 既存テーブルの `store_partition_key` + admin-api 強制（物理分割はしない）。
- UI: `public/jnm` に店舗セレクト、スコープバッジ、管理者横断サマリー。
- API: `GET /pos-journals/saved-reports/cross-store-summary`（フル管理者のみ）。保存時の他店舗ID衝突を409。
- Category overrides: ID を店舗別に変更。

### 2026-07-31 - AIチャットPDF履歴（質問＋回答）をDB保存
（質問＋回答）をDB保存

- Request: AIチャット表示結果を「PDFにする」押下時に Supabase の新テーブルへ自動保存し、質問起点の一覧ページを用意する。
- Database: migration `20260731070000_ai_chat_pdf_history.sql`（`ai_chat_pdf_history`、RLS、service_roleのみ）。
- API: `admin-api` の `/pos-journals/chat-pdf-history`（GET/POST）と `/item`（GET/DELETE）、店舗スコープ許可リスト追加。
- UI: `public/jnm/jnl2txt.html` / `index.html` で PDF ボタン時に保存、ツールボタンと専用ページ `ai-chat-pdf-history.html` で質問リスト表示。
- Docs: `docs/店舗運用修正記録.md`、`docs/REPOSITORY_STRUCTURE.md` を更新。

### 2026-07-28 - Bistro CAVACAVA POS電子ジャーナル保管・アップロード・削除

- Request: `/Volumes/KIOXIA/202606` のPOS電子ジャーナルをWebで確認するだけでなく、今後のLZHファイルを画面からアップロード・保管し、保管済み原本を削除できるようにする。削除は `delete` の確認入力を必須にする。
- Store mapping:
  - ファイル名先頭の店舗コード `1015` を既存店舗キー `bistrocavacava`、表示名 `Bistro CAVACAVA` に固定。
  - 未登録コード・選択店舗不一致・対象月不一致は保存前に拒否。
- Database and Storage:
  - migration `20260728092020_pos_journal_storage.sql` で `pos_journal_files` とprivate bucket `pos-journals`（8MB/件）を追加。
  - 公開Pagesからの直接参照を禁止し、RLS有効・anon/authenticated権限なし。admin-apiのservice_role経由のみ。
  - 同一店舗×営業日と同一店舗×SHA-256を重複防止。Storage削除後に削除スナップショットを記録してからテーブル行を削除。
- API:
  - `GET /pos-journals`: 店舗・月の原本一覧と保存済み解析データから月次集計を返す。
  - `POST /pos-journals/upload`: multipart複数LZH、LH5をEdge内で解凍、ESC/POS除去、CP932解析、Storage→DBの順で保存。DB失敗時はStorageをロールバック。
  - `GET /pos-journals/download`: private原本の期限付き署名URL。
  - `DELETE /pos-journals/file`: JSON `confirmation` が半角小文字の `delete` 完全一致の場合だけ、Storage APIで原本削除→削除スナップショット→テーブル削除。
- UI:
  - `pos-journal.html`へ管理セッション、対象月、複数選択/ドラッグ＆ドロップ、進捗・部分失敗、保管一覧、原本DL、delete確認モーダルを追加。
  - 2026年6月の静的互換データはDB未投入時の表示フォールバックとして維持し、ローカルパスを公開JSONから除去。
- Verification:
  - LHA/LH5 unit tests 4/4。CP932実ジャーナルサンプルで2026-06-02、総売上105,000円、会計2件を確認。
  - ローカルAPI E2E: upload 200、一覧/集計200、同一SHA重複スキップ、署名URL200、`DELETE`は400、`delete`は200、Storage/DB残0、削除後の再アップロード成功。
  - migration単体をローカルPostgresへ適用し、private bucket・RLS・anon/authenticated SELECT不可・partial unique indexを確認。
  - `npm run check`、既存`npm test` 90/90、`npm run knowledge:update`/`knowledge:check`、`git diff --check`成功。
  - Commit `4e6d70a`をmainへpush。Pages run `30351184119`、DB migration＋全Edge Functions run `30351184113`はいずれもsuccess。
  - 本番`pos-journal.html`/静的JSONはHTTP 200、新API未認証は401。本番DBで`pos_journal_files`、private bucket（8MB）、RLS有効、anon/authenticated SELECT不可を確認。

### 2026-07-28 - 電子ジャーナルへAI月次分析・自由質問を追加

- Request: 電子ジャーナルのデータも既存の売上分析と同様にAIで分析できるようにする。
- Analysis scope:
  - 月次総売上・営業日平均・客数・客単価・組単価。
  - 最高/最低営業日、前半/後半、中央値、標準偏差、異常日。
  - 曜日別・天候別、決済比率、商品売上構成と上位集中度。
  - 総評、売上推移、客数/客単価、曜日/天候、決済/商品、注目日、改善提案、注意点。
- API/UI:
  - `POST /pos-journals/ai-analysis`: 月次分析。保存済みデータがあればDB解析JSONを正本とし、未保管の2026年6月互換データは検証・再集計した画面データを使う。
  - `POST /pos-journals/ai-ask`: 最大500字の自由質問と直近8件の会話文脈。最高日、客単価、天候、商品、決済などに回答。
  - Groqの実測トークンは`ai_usage_events.surface='pos_journal'`へ記録し、AI使用料へ反映。
  - AIキーなし/API失敗/タイムアウト時は、画面を壊さず同じ事実データから基本分析・定型回答へフォールバック。
  - `pos-journal.html`へAI分析カード、進行状態、見出し別分析、質問候補、会話スレッドを追加。
- Safety:
  - クライアントの合計値・ランキングを信用せず日次/会計明細から再計算。DB保存済み月はクライアントJSONよりDBを優先。
  - 店舗/月を強制し、62日・1日200会計・1会計100品・リクエスト約900KBの上限、質問長・履歴数/文字数を検証。
  - 商品名などPOS文字列はプロンプト内で非信頼データとして扱い、命令に従わず、外部要因や利益を捏造しないよう制約。
- Verification:
  - 新規AI unit tests 5/5、既存LHA tests 4/4。
  - ローカルAPI E2E: 未認証401、AIキーなし基本分析200（総売上1,519,300円・最高日2026-06-12）、質問回答200、空データ200、501字質問400、未対応店舗400。
  - `npm run check`、既存`npm test` 90/90、UIインラインJS構文、実画面のAIカード/Q&A表示を確認。
  - Commit `1af2957`（機能）と`980c07a`（入力検証補強）をmainへpush。Pages run `30355275104`、Edge Functions run `30355274736`/`30355681784`はsuccess。
  - 本番`pos-journal.html`はHTTP 200でAI分析UIを確認、新AI API未認証は401。

### 2026-07-28 - 電子ジャーナルAI分析のPDF保存・DB履歴・削除

- Request: AI分析結果をPDFとして保存できるようにし、データベースへ蓄積、不要な履歴を削除できるようにする。
- Database/API:
  - migration `20260728115706_pos_journal_ai_analysis_history.sql`でprivate table `pos_journal_ai_analyses`を追加。
  - 分析本文、AI/基本分析区分、provider/model、警告、分析時点のfactsスナップショット、ファイル/日数、総売上、客数、客単価、生成日時を履歴ごとに保存。
  - 分析実行ごとに追加保存。同じ月の複数履歴を保持し、一覧は`created_at desc, id desc`。
  - `GET /pos-journals/ai-history`、`GET /pos-journals/ai-history/item`、`DELETE /pos-journals/ai-history/item`を追加。削除は店舗スコープと`confirmation === "delete"`完全一致を必須にする。
  - AI分析の表示はDB保存失敗で失わず、`history_saved=false`と警告を返すフェイルソフト設計。空データ/空本文は保存しない。
- UI/PDF:
  - AI分析カードに「PDFで保存」と「AI分析履歴」を追加。履歴から再表示、PDF、削除が可能。
  - PDFはブラウザ印刷の「PDFとして保存」を使用し、A4専用レイアウトで店舗、対象月、生成日時、AI種別/モデル、主要KPI、分析全文、注意を含める。
  - PDFは保存時点のfactsスナップショットを使うため、後日POSデータが変わっても履歴の主要数値が変化しない。
- Verification:
  - migration単体をローカルDBへ適用し、RLS有効、anon/authenticated直接SELECT不可を確認。
  - API E2E: 自動保存200、一覧200、詳細200、`DELETE`確認文字は400、`delete`は200、削除後詳細404。
  - 新規履歴テスト3/3、AI/LHAテスト10/10、既存`npm test` 90/90、`npm run check`成功。
  - 実画面のPDF保存処理からA4 PDFを生成。1ページ、日本語、店舗、総売上1,519,300円、改善提案を確認し、全ページをPNGへレンダリングして文字切れ・重なりなしを確認。
  - Commit `580915d`をmainへpush。Pages run `30364591130`、DB migration＋全Edge Functions run `30364585947`はsuccess。
  - 本番`pos-journal.html`はHTTP 200でPDF/履歴/削除UIを確認。履歴API未認証401。本番DBで`pos_journal_ai_analyses`、RLS有効、anon/authenticated SELECT不可、service_role insert/delete可を確認。

### 2026-07-27 - リポジトリ構成を整理

- Request: `line_report-main`直下に公開ページ、ローカルDB、復旧用バックアップ、生成物が混在していたため、既存URLを壊さずに整理する。
- Public site:
  - GitHub Pagesの公開HTML/JS、icons、vendor、system-mapを`public/`へ集約。
  - `.github/workflows/deploy-pages.yml`を追加し、`public/`だけをPages artifactとして配信する構成へ変更。
  - 公開URLは従来どおり`https://marugo-s.github.io/line_report/*.html`を維持。
- Local state:
  - SQLite DB/WAL/SHMを`.local/sqlite/`へ移動。
  - 復旧作業用SQL・スクリプトを`.local/backups/restore-work/`へ移動。
  - ローカル`deno.lock`を`.local/`へ移動し、不要な`.DS_Store`と自己参照`line_report` symlinkを除去。
  - 壊れたClaude worktree登録と約35MBの残骸を清掃。未統合の`wip-local-fix`ブランチは保護して変更していない。
- Compatibility:
  - 旧Express/SQLiteは旧配置が残る場合に優先し、整理後は`.local/sqlite/wine_price.db`と`.local/backups/runtime`を既定にする互換フォールバックを追加。
  - ローカルPagesサーバーは`.local/pages-preview/line_report -> public/`を使い、本番同様の`/line_report/` URLを維持。
- Guardrails:
  - `docs/REPOSITORY_STRUCTURE.md`を追加し、配置ルールを正本化。
  - `AGENTS.md`、`AI_HANDOFF.md`、README、DOCS-INDEX、SECURITYへ新構成を反映。
  - `tests/repository_structure.test.mjs`を追加し、公開ファイル、Pages workflow、ローカル状態、既存docsリンクを検査。
  - Graphify/Obsidian生成先と検査を`public/system-map/`へ更新し、`.local/`と公開system-map生成物をGraphify入力から除外。
- Verification:
  - `npm run check` success。
  - `npm test`はknowledge 7、structure 7、foodcourt 44、reservation 4、receipt 28、合計90/90 success。
  - `npm run knowledge:update` / `npm run knowledge:check` success。最終Graphify 3,708ノード、8,874関係、305コミュニティ、SQL 176ファイル、migration 175/175。
  - ローカル`/line_report/index.html`、`system-map.html`、`pages-config.js`がHTTP 200。静的href/srcの欠落なし。
  - Commit `8f6e779`を`main`へpush。GitHub Pagesをlegacy branch-root配信からActions workflow配信へ切替。
  - Pages run `30277607753` success。本番`index.html`、`analytics.html`、`system-map.html`、`pages-config.js`、環境図、graph statsは全てHTTP 200。

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

### 2026-07-31 - AI分析を店舗住所基準に（新宿三丁目固定廃止）

- Request: 系列23店舗。四谷・丸の内・地方店もあり、ジャーナル店舗の住所で分析したい。
- Fix: `STORE_LOCATION_PROFILES` + AIプロンプトへ店舗立地ブロック。全店新宿三丁目前提を禁止。
- Deploy: Pages + `ai-analyze`（ユーザー端末からも deploy 可）。

### 2026-07-31 - Journal AI 意図ルーティング＋Perplexity/Grok

- Request: 数値は Kimi、戦略・対策は Perplexity/Grok を自動オーケストレーション。
- Changes: `journal_ai_orchestrate.ts` + `ai-analyze` chat 分岐、クライアント `orchestrationMode: auto`、モード注記表示。
- Secrets: `PERPLEXITY_API_KEY`（任意）、既存 Moonshot / xAI。
- Verify: `npm run test:journal-ai`。
- Deploy: `ai-analyze` + Pages。

### 2026-07-31 - AI参照を保存済み月間レポート優先に

- Request: ジャーナル検索より、カテゴリ分け済みの保存済みレポート（2023-07〜）を正本にしたい。
- Cause: `saved-reports` が created_at 降順+limit のため日別が月間を押し出していた。
- Fix: API `kind=monthly|daily`、クライアントは月間優先＋欠月だけ日別補完。
- Deploy: Pages + `admin-api`。

### 2026-07-31 - AIチャット年クエリに月次推移を付与

- Request: 「今年の売り上げの推移」で月次が無いと返る問題を直す。
- Cause: 年指定が年合計のみに集約され、AIへ月次系列が渡っていなかった。
- Fix: `summarizeMatched` の `monthlyBreakdown` を確定データ／ローカル回答に含め、推移説明を許可。
- Deploy: Pages（`public/jnm`）。Edge Function 変更なし。

### 2026-07-31 - AI分析ベースをマルゴグループ（ワイン推し）特化へ

- Request: Journal／売上AI分析・チャットを、一般飲食ではなくマルゴグループ専用（ワイン推し・ワイン充実）の前提で行う。会社情報は https://05-marugo-group.com 。
- Changes:
  - `supabase/functions/ai-analyze/index.ts` に `MARUGO_COMPANY_CONTEXT` を追加し、analyze/chat 既定プロンプトを更新。
  - `public/jnm/jnl2txt.html` / `index.html` のチャット厳格指示と分析 `systemInstruction` を同前提へ。
  - `pos_journal_ai.ts` の月次分析・Q&A system もマルゴ／ワイン軸へ更新。
  - `docs/店舗運用修正記録.md` に追記。
- Verification:
  - 埋め込みJS定数を Node で実行し会社URL含有を確認。
  - `npm run check`、`npm run test:structure` success。
  - Graphify／Obsidian はこのクラウド環境に未配置のため `knowledge:check` は未実施。
- Deploy notes:
  - Pages（`public/jnm`）と Edge Function `ai-analyze`（および `pos_journal_ai` を使う `admin-api`）の反映が必要。
