# LINE Report Project Progress

## Document information

- Current date: 2026-08-10
- Repository: `https://github.com/MARUGO-s/line_report`
- Branch: `main`
- Work-start HEAD: `74b44e6876ceaa226578426ab323e31b5d3dd356`
- Production: `https://marugo-s.github.io/line_report/`
- Supabase: `hocbnifuactbvmyjraxy`
- Do not record secret values, customer data, message bodies, receipt images, or uploaded media here.

### 2026-08-10 - 店舗資料A+B複合案の全経路監査・信頼境界・LINE失敗通知

- Request: A案（詳細候補拡張）＋B案（全資料目次）の実装、LINE連絡経路、AI判断経路を再監査し、バグと改善点を修正して再デプロイする。
- A+B: 詳細は最大20資料・全体12000字、目次は最大4000字。証拠を先、目次を後に分離し、目次は存在確認専用で因果・引用の根拠にしない。RAG上限8件に入らない資料は資料別本文へフォールバック。
- Accuracy: 離れた比較期間を別区間のまま照合。無効資料は期間付きの過去明示分析だけ参照。日本語期間も解析。取得失敗・未接続・stale・上限到達・詳細部分失敗と、正常な0件を区別。
- Performance: 一覧をページングし本文を取得しない。選定最大20件は一括詳細APIで取得し、更新日時が同じ詳細をキャッシュ。AI実行時は一覧を再検証して直前のLINEメモを反映。
- AI safety: サーバー固定規約をOpenAI developer/system・Claude systemへ置き、ブラウザ文脈、店舗資料、集計、外部知見を非信頼userデータへ分離。埋め込み命令・区切り偽装を無視し、目次と証拠、確定数値と背景資料を分離。
- Prompt: 39000字超過時は実資料マーカー内だけを縮め、前方の確定集計・店舗情報と後方の統合指示を保持。全店一律のクリスマス実施断定を廃止し、確定商品または選定資料がある場合だけ事実、無ければ仮説とする。
- Backend/LINE: 編集時の添付・由来保持、店舗キー正規化、Storageパス店舗境界、引用添付のStorage失敗時ロールバック、テキスト`#メモ`失敗返信を追加。
- Verification: `npm run check` / `test:ci` / `journal:integration:check`（21 OK / 0 NG）すべて exit 0。`deno check` ai-analyze 0エラー。`git diff --check` clean。`public/jnm/index.html` と `jnl2txt.html` は byte一致。
- Deploy: commit `d7d18bb` を `main` へ push。GitHub Actions の `Deploy GitHub Pages` / `Deploy Edge Functions` が両方 success（push 時に全 Edge Function を自動デプロイするため手動 deploy 不要）。
- Production check: Pages 2入口とも HTTP 200・824,895 bytes・ローカルと byte一致。`AI_KNOWLEDGE_MAX_ITEMS = 20` / `MAX_CHARS = 12000` / `CATALOG_MAX_CHARS = 4000` を公開HTMLで確認。未認証の `admin-api/pos-journals/knowledge`・`.../knowledge/items`・`ai-analyze` はいずれも HTTP 401。
- Known gap: `npm run knowledge:check` は `graphify` CLI 不在で fail。生成ミラーは同期済み、Graphify抽出のみ stale。製品影響なし。

### 2026-08-07 - LINE `#メモ` 送信日時を分析時間軸へ

- Request: `#メモ` を分析の糧にするとき送信日時も読み、時間軸をずらさない。
- Change: webhook が `line_timestamp` を転送。`created_at`＝送信時刻、`period`＝JST送信日。AIブロックに送信ラベル。他月 LINE投稿は類似度補完から除外。
- Deploy: `line-webhook` / `admin-api` + Pages `public/jnm/*`。

### 2026-08-07 - ドキュメント: Qwen/Kimi を現行AI構成から除外して記載更新

- Request: 情報流出対策で構成外にした Qwen／Kimi が MD に残っているので書き直す。
- Change: アーキテクチャ／機能仕様／AIループ設計／運用記録の「現行」記述を OpenAI・Claude・Groq GPT-OSS・Gemini・Grok に合わせる。履歴項目は当時の記録として残し、冒頭に現行表を追加。

### 2026-08-07 - Journal Report 機能仕様MDを整備

- Request: `#メモ` を含む Journal Report の機能を詳細に正確な MD へまとめる。
- Change: `docs/JOURNAL-REPORT-FEATURES.md` を新設。DOCS-INDEX・アーキテクチャ・資料仕様・使い方タブを同期。
- Deploy: Pages `public/jnm/*`（使い方文言）＋ docs。

### 2026-08-07 - AIチャットのワイン量 点数/ml 確認経路

- Request: 年比較などでワイン量を聞かれたとき、点数／総ml／両方をユーザーに確認し、mlは店舗換算で計算。
- Change: `wineMetric` clarifier + choice buttons + `formatWineVolumeFactsForAi` を verifiedData に注入。
- Deploy: Pages `public/jnm/*`。

### 2026-08-07 - ワイン提供量(ml)換算を店舗情報＋AI分析へ

- Request: 店舗情報でグラスワインmlを店舗別に設定（ボトル750固定）。分析の1項目にする。
- Change: `profile.wineMl` + UI。`wineVolumeAnalysis` を salesData／店舗営業情報ブロックへ。AI指示に必須節を追加。
- Deploy: `admin-api` + Pages `public/jnm/*`。

### 2026-08-07 - 店舗情報カレンダー（施策・イベント）

- Request: 店舗情報入力時にカレンダーでイベント／施策を開始日〜終了日登録し、AIとプレビューへ自動反映。
- Change: `profile.calendarEvents` + 月次カレンダーUI。`formatStoreOpsBlockForAi` / `#opsPreview` に反映。API はキー省略時に既存イベントを維持。
- Deploy: `admin-api` + Pages `public/jnm/*`。

### 2026-08-07 - 過去売上同期トグルの本番動作テスト

- Result: PASS (Actions run 31146495132)
- Covered: Pages wiring, DB ON store = bistrocavacava only, admin-api ON/OFF/omit-key preserve on sauvage (restored), CAVACAVA stayed ON
- Script kept: `scripts/verify-journal-sales-sync-toggle.sh`

### 2026-08-07 - 過去売上同期 ON/OFF を店舗情報へ

- Request: おすすめの場所に journalSalesSync の on/off スイッチを作る。
- Place: Journal Report「店舗情報」タブ、営業カレンダーカードの下に独立カード。
- Change: UI トグル＋`normalizeStoreOperationProfile` で boolean 保持。キー未送信時は既存 ON を維持。初期値リセットでも同期フラグは維持。
- Deploy: `admin-api` + Pages（`public/jnm/*`）。

### 2026-08-07 - 誤登録2027-08予算の削除

- Store: Sauvage (`sauvage`)
- Deleted: month budget ¥2,300,000 and 4 closed days for `2027-08`
- Verified empty afterward. One-shot workflow removed after run.

### 2026-08-07 - migration 履歴ズレ修復で Edge デプロイを緑に

- Request: Deploy Edge Functions の ×（db push 履歴ズレ）を消し、git push デプロイを成功扱いにする。
- Cause: 本番だけに残る orphan migration `20260806185129`（local git にファイル無し）。
- Change: `scripts/supabase-db-push-reconcile.sh` で remote-only を `migration repair --status reverted` 後に再 `db push`。workflow から呼び出す。
- Expected: 未適用の `20260806133001` / `20260807030000` もこの成功時に適用される。

### 2026-08-06 - git push デプロイの単一ジョブ化

- Request: `main` への git push / マージで Edge Functions と GitHub Pages が確実にデプロイされるようにする。
- Cause: validate と deploy が別ジョブのため、hosted runner 枯渇時に二段目だけ取得失敗して未デプロイが残った。加えて Actions/Pages major outage。
- Change: 両 workflow を単一 `deploy` ジョブへ統合。Edge は db push 失敗後も関数デプロイを続行し、最後に DB 失敗を通知。緊急用 `skip_tests` / `skip_db_push` を追加。
- Note: GitHub Actions 自体が outage の間はキューイングされない。復旧後、この workflow 変更の push が未反映分の再デプロイを起動する。

### 2026-08-06 - POSジャーナル修復の周辺不具合

- Request: 複数修復に続き、最新ファイル表示・原本整合・不完全行可視化・売上同期営業日・Luna退避記録も直す。
- Change: 修復で `uploaded_at` 更新、ハッシュ変更時は Storage 差し替え、Storage 無し行の削除許容、POS一覧に要修復表示、月次営業日は総売上>0、月次 source は mixed、Luna は auth/rate/quota で縮小再試行せず、clarifier も fallback 記録。
- Deploy: `admin-api` / `ai-analyze` / Pages。GitHub Actions・Pages は 2026-08-06 時点で major outage。

### 2026-08-06 - POSジャーナル upload のプレースホルダ複数修復

- Request: 不完全な電子ジャーナル行（会計0件／売上未設定）へ同じ営業日の LZH を再アップロードしたとき、削除せずに解析結果を上書き修復できるようにする。
- Change: `admin-api` の `/pos-journals/upload` でプレースホルダ判定後に `parsed_data` と集計を UPDATE。既存 `storage_path` は維持し、未保管時のみ Storage 保存。応答に `repaired_count` / `repaired` を追加。Journal Report / POS Journal UI に「うち修復 M件」を表示。
- Merged: `main` `be5dfcd`（#61）。
- Deploy: `admin-api` 再デプロイと Pages（`public/jnm/*`, `pos-journal.html`）が必要。GitHub Actions/Pages major outage のため未デプロイの場合あり。
- Post-deploy check: KIOXIA 202502 / 202511 の再アップロードで修復件数と月次合計を確認。

### 2026-08-05 - Journal Report 原本ジャーナル全件ページ分割

- Request: Supabase/PostgRESTの1レスポンス行数上限で、長期保存した原本ジャーナルの古い月が落ちる構造的弱点を解消。
- Change: `scanRowsByAscendingId`を追加し、IDカーソルで空ページまで取得。商品初出・コース全期間・商品利用比較・汎用コホート比較を共通スキャナへ移行。短いページをEOFにせず、重複を除外し、進捗停止・不正ID・100,000行超・途中失敗は部分成功にしない。
- Tests: 2,505行、短縮ページ、境界重複、順不同、空ページ、進捗停止、安全上限、取得/処理失敗と、`admin-api`の配線回帰テストを追加。
- Deploy: `admin-api` Edge Functionの再デプロイが必要。DB migrationとPages変更は不要。

### 2026-08-05 - Journal Report 全期間コース導入前後分析の根本修正

- Request: SPコース初出を起点に全期間を分析すると、初回だけ2026年1月以前の既存コースが落ち、指摘後には読める問題を再発防止。
- Root cause: 「全ての月」が全期間語彙に無く、2回目の期間確認上限で最新月へ強制縮小。加えて商品初出の「SP導入前0点」とコース全体を区別する保存全期間月次表がAIへ無かった。
- Change: 全期間表現を共通判定し、明示範囲を確認上限でも保持。`q=コース`のジャーナル全件`by_month`を導入前を含め全件プロンプト化し、固有商品0点と既存コース全体を分離。
- Tests: 実会話型の期間解決、全期間選択、導入前後コース月次・集計の回帰テストを追加。

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

### 2026-08-04 - Journal AI multiple continuous range comparison fix

- Symptom: 「2025年3月〜7月と2026年3月〜7月」の比較で、2025年側だけ回答し2026年側を「表示されていません」とした。
- Cause: `extractRangeRef`が質問中の最初の連続期間だけを返し、`searchSavedReportsByQuery`が単一範囲として早期returnしていた。DBには2026年3〜7月の月間データが存在。
- Change: `extractAllRangeRefs`で複数の連続期間を抽出し、単一範囲分岐より先に各期間を個別集計して`multiPeriod`へ渡す。合算レポートは従来どおり除外。
- Accuracy: `monthCount`と`monthlyAvgCustomers`をローカル確定集計で計算し、AIへ明示する。
- Verified facts (Bistro CAVACAVA): 2025年3〜7月=580名/5か月→116名/月、客単価¥11,532。2026年3〜7月=640名/5か月→128名/月、客単価¥10,218。

### 2026-08-04 - Reservation AI chronology, monitoring, paging, direct queries, and compact cache

- Accuracy: 新規/リピートを「その予約時点・店舗別・食べログ/一休/manual横断」で再計算。キャンセル/非表示を除外し、`last_visit_at`は対象予約より前の同店舗直前予約へ変更。
- Paging: 予約イベント取得の月2,000件固定上限を廃止し、1,000件ページング＋安全上限100,000件へ変更。上限超過は途中集計せずエラーにする。
- Monitoring: `reservation_ai_cache_runs`へ実行開始/終了・成功失敗・店舗数・更新日数・予約件数・所要時間・エラーを保存。最終成功から36時間超の場合はキャッシュを使わずDB直接参照へ退避。
- Direct queries: 「明日/来週の予約」「特定日の予約」「売上レポート未保存月の予約」へ予約DBだけで回答可能。単日・日付範囲は売上があれば予約と統合する。
- Compact cache: `reservation_ai_cache_coverage`で生成済み期間を管理し、予約0件の日次行を削除。coverage内の行なしを0件と解釈する。
- Cron: pg_net待機時間を5分へ延長し、長い全再生成をHTTPタイムアウトに見せない。

### 2026-08-04 - Reservation AI daily cache and live-future split

- Request: 予約日が過ぎた確定データをAIチャットのたびに予約イベント表から再読せず、店舗別のRAG風確定データとして毎朝作成し、未来予約だけ最新DBを読む。
- Data: `reservation_ai_store_cache`を追加。店舗×予約日で`facts`（集計＋氏名入り明細）と`rag_text`を保持。RLS有効、anon/authenticated revoke、service_roleのみ。
- Change tracking: `reservation_ai_cache_dirty_dates`と3予約イベント表のtriggerを追加。過去予約の後日編集・削除があった日を記録し、翌cronで安全に再作成する。
- Cron: `reservation-ai-cache-cron`を追加。既存の日次処理（04:10、04:20、05:00 JST）と重ならない**毎朝05:37 JST**に実行。初回は過去24か月、通常は昨日分＋dirty日以降を再計算。
- API: `/reservations/ai-facts`は過去日を日次キャッシュから取得し、本日以降を予約イベントDBから直接取得して結合。キャッシュ欠損日はライブDBへフォールバックし、既存API応答形を維持。
- Token/latency: 日次キャッシュを`summary_facts`（集計のみ）と`facts.items`（氏名入り明細）に分離。通常分析は集計だけを取得し、予約者名・予約一覧・前回来店・顧客等の質問時だけ明細を取得する。
- Security: キャッシュ再構築 `/reservations/ai-cache/rebuild` はcron認証専用。公開Pagesから予約テーブル/キャッシュを直接読まない。
- Verification: 予約キャッシュ新規テスト4件を含む予約テスト8件、Journal AIテスト36件、`npm run check`、共有helper/cronのDeno check、`git diff --check`成功。

### 2026-08-03 - Journal Report AI data-flow verification

- Request: 月次・日別・ジャーナル原本・店舗施策／LINE投稿等がAI分析へ統合されているか、コードから全経路を再検証する。
- Added: `scripts/verify-journal-ai-data-flow.mjs` と `npm run journal:integration:check`。中核経路が切れると失敗し、条件付き接続と通常AI未統合系統を明示する。
- Verified core: 月次優先＋月次欠損の日別補完、単日検索、原本保存・必要時再読、Web資料、LINEテキスト／引用添付、RAG、店舗営業情報、商品分類ルール、店舗立地、会話履歴、AI分析レポート、AIチャット。
- Conditional: 原本再読は質問に応じて実行、外部知見は戦略系のみ、資料は最大5件／8チャンク／3500字、詳細明細は通常12か月・商品質問36か月・昼夜F/D補完18か月。
- Gaps: 通常Journal AIへ天候・気温を明示投入していない、過去予測/MAPEと過去AI文章は通常AIの入力外、`generate-insight`はAPIのみで自動呼び出しなし。

### 2026-08-03 - Journal Report security, recoverability, CI, and ownership hardening

- `ai-analyze`: 公開anonキーだけでは実行できないよう、`lrst_`管理セッション検証、店舗スコープ照合、DB共有レート制限を追加。Journalの分析・確認質問・チャットは共通`journal-ai-client.js`から管理セッションを送る。
- Frontend security: ドロップしたファイル名・解凍エラーを`innerHTML`ではなく`textContent`で描画し、`public/jnm`本体とPDF履歴ページへCSP/referrer policyを追加。
- Accuracy: `コース６品`のNFKC＋長音正規化後もコース商品として認識し、ボトル＋コースの複合質問からコースが脱落しないよう修正。
- Recoverability: `saved_reports` / `sales_forecasts` / `ai_analysis_history` / `ai_chat_pdf_history`へ`deleted_at`を追加。DELETEはゴミ箱移動、通常一覧・AI検索から除外。復元PATCH APIと「ゴミ箱・復元」UIを追加し、レポートHTML Storageも復元用に保持。
- CI: Pages/Edge Functionsデプロイ前にNode/Deno、静的チェック、全CIテストを必須化。DB migration失敗時はFunctionだけを先行公開せず停止する。
- Supabase ownership: `knowledge/supabase-ownership.json`を正本に、LINE Report所有15 Functionsを検査・デプロイ対象化。共有プロジェクト内の別アプリFunctionは触らない。
- Legacy native: 非Git作業コピーの旧macOS/Windows資産を非破壊で隔離し、通常ビルドを停止。現行正本は`line_report-main/public/jnm/`。
- Knowledge: Graphify/SQL coverageと公開システムマップを更新。Journal回帰テスト、POS Journal Denoテスト、知識検査を拡充。

### 2026-08-02 - Journal Report store knowledge folder (phase 1)

- Request: 店舗がやってきた施策やメニュー資料を登録するフォルダを作り、そこに蓄積した資料をもとにAIが分析する循環にする。
- Scope decision: フェーズ1は「登録 → 実施期間で売上と紐付け → AIプロンプトへ注入」までを通し、自動テキスト抽出・チャンク分割・埋め込み検索・効果測定はフェーズ2以降へ分離。フェーズ2/3をテーブル変更なしで載せられる形にした。
- Data: `store_knowledge_documents`（RLS有効・anon/authenticated revoke・service_roleのみ）と非公開Storage `store-knowledge`（20MB・許可MIMEのみ）。`period_start`/`period_end` は null を「常時有効」とし、`is_active` による論理削除を既定にする（終了した施策も過去期間の回答に必要なため）。`source_type='ai_insight'` をフェーズ3用に予約。
- API: `admin-api` に `/pos-journals/knowledge`（一覧・登録更新）、`/knowledge/item`（単体・削除）、`/knowledge/upload`（multipart＋SHA-256）、`/knowledge/download`（署名URL）を追加。すべて店舗スコープ許可リストへ登録し、他店キーは403。一覧は本文を200字の抜粋に切り詰める。
- UI: 「資料」タブを新設。種別・タイトル・実施期間・概要・内容・タグ・添付の7項目。テキスト/CSV/Markdownはその場で本文へ取り込み、PDF・画像は保管のみ。
- AI: チャットと分析レポートの双方へ店舗ナレッジブロックを注入。**確定集計の対象期間と重なる資料は類似度に関係なく必ず添付**し、残りを2文字組の類似度で補完。上限5件・6000字。取得失敗時はナレッジ無しで通常回答へ退避する。
- Invariant: 数値の正本は確定済み集計データのまま。規約第8項で「本ナレッジを数値の出典にしてはいけない」「使う場合は登録資料によると明示」「推測には※これは推測です」を固定。
- Verification: 全テスト50件（本機能で3件追加）。本番DB往復テストと制約発火確認（テストデータ削除済み）、`admin-api` 型チェックで新規エラー0、実ブラウザでコンソールエラーなし。
- Docs: `docs/JOURNAL-STORE-KNOWLEDGE.md` を新設し、`docs/DOCS-INDEX.md` と `docs/店舗運用修正記録.md` を更新。

### 2026-08-02 - Journal AI period accuracy and stored-breakdown coverage

- Request: AIチャットの応答を自然にし、保存データを欠かさず正しく検索できるようにする。
- Cause: 続きの質問で直前の発話を丸ごと前置していたため古い年月を先に拾っていた。年月抽出が4桁年必須で、日単位の集計経路が無かった。`summarizeMatched` の戻り値に曜日別・時間帯別・昼夜・室料が無く、保存レポート検索がヒットすると開いているレポート由来の内訳も失われていた。一覧APIは商品明細を返さないのに商品質問時しか詳細取得していなかった。意図判定に素の「売上」が無く、商品明細判定と語彙が食い違っていた。
- Change: 続きの質問は年だけ引き継ぐ（日だけの発話は年月）。年を一度しか書かない比較を2期間として解釈。単日・日付範囲・今日/昨日/今週/先週の日単位集計を追加。曜日別・時間帯別・ランチ/ディナー・室料/チャージ/その他を確定集計とプロンプトへ追加し、対象3か月以内なら一般質問でも明細を取得。意図判定と商品明細判定の語彙を統一しつつ、「売上を分析して」のような開いた依頼は従来どおり一問だけ確認する。比較の片方が無い場合は取れた期間を返し欠損期間を明示する。
- Verification: リポジトリ全テスト47件（3件更新・5件追加）と実データ形状の統合テスト55件、実ブラウザ確認、公開Pagesとソースのバイト一致。フロントのみでDB・Edge Function変更なし。

### 2026-08-02 - Journal AI bottle/course fact grounding

- Request: ジャーナル明細にボトル・コース販売があるのに、AIレポートが「保存データには含まれていない」と注記する誤判定を修正する。
- Cause: ボトル／本数／コースを商品明細検索の対象語として扱っておらず、一覧サマリーだけをAIへ渡していた。また詳細取得時は、同じ明細から生成された`topProducts`と`sales.items`を足して上位商品を二重計上していた。
- Change: 対象語を商品明細検索へ追加し、質問に該当する商品だけを伝票明細から集計。明細がある場合は`sales.items`を正本、無い場合だけ`topProducts`をフォールバックにする。明細取得が不完全なら保存DB全体の不存在を断定しない。
- Field semantics: ボトル／コースの商品名・数量・売上は確定値として回答する。予約人数と宴会件数は専用項目が無いため、実来店客数・会計組数・コース商品を含む会計件数と明確に区別して参考表示する。
- Verification: Journal AIテスト24件、全体テスト114件。HTML 2入口同期、インラインJavaScript構文、実画面、本番Pagesを確認する。フロント／文書のみでDB・Edge Function変更なし。

### 2026-08-02 - Journal AI conversational intent clarification

- Request: 固定選択式ではなく、曖昧な質問の意図を自然な会話で引き出し、必要な保存データだけを使って正確に回答する。
- Change: 明確な質問は従来どおり即時検索し、曖昧な場合だけ`ai-analyze`の専用`clarify`アクションを使用。直近会話・保存範囲・利用可能項目だけから、短い確認質問または文脈を統合した`resolvedQuery`を構造化JSONで返す。売上金額・商品明細は確認段階で送信しない。
- Conversation: 既知の期間や指標は聞き直さず、一度に一問だけ確認。番号一覧は出さず、「前者／後者」「おまかせ／全部」、訂正（例:「違う、6月」）、確認中の新しい自己完結質問を状態として解決する。同じ曖昧点は最大2回まで確認し、意図と期間は別々に管理する。
- Accuracy: 「前月」「前年同月」は絶対年月2件へ展開し、比較対象の片方が無い場合は単月回答へ進まない。確認AIの初回`ready`、根拠のない期間補完、ユーザーが求めていない全期間・商品明細への拡大をクライアントでも拒否する。月間レポートが無い月は日別全件を合算し、クラウド一覧・詳細の未確認や部分取得はAI検索と売上予測の両方で「データなし／実績待ち」と断定しない。
- Token/latency: 確認AIは直近6発話・500字入力・短い出力上限・合計約11秒のprovider timeout。通常AI履歴も現在発言を重複させず、クライアント／Edge双方で直近12発話・各1600字に制限。商品明細は最新側から最大36か月。
- Fallback: AI失敗・不正JSON・タイムアウト時も、質問内容に応じた自然なローカル確認質問へ退避する。
- Scope: `public/jnm/jnl2txt.html` / `index.html`、`supabase/functions/ai-analyze/index.ts`、Journal AI回帰テスト。DB変更なし。

### 2026-08-02 - Journal AI mobile keyboard-safe composer

- Request: スマートフォン／タブレットでソフトウェアキーボード表示時も、AIチャットの入力欄と入力中の文字を見える状態にする。
- Change: 固定`100vh`をVisual Viewport追従の高さ・上端へ変更。入力欄を縮小対象外にし、フォーカス時の表示位置・最下部スクロールを同期。モバイルは全幅、入力文字16px、44pxタップ領域、safe-area対応。
- Input: 日本語IME変換中のEnterでは送信しない。
- Scope: `public/jnm/jnl2txt.html` / `index.html` とフロント回帰テストのみ。DB・Edge Function変更なし。

### 2026-08-02 - Journal AI conversational saved-data query planner

- Request: 保存済みレポートがあるのに曖昧な質問で「データなし／0」と返さず、必要範囲を対話で確認し、AIトークン量も抑える。
- Change: 保存レポートの軽量月次索引を先に確認。「最新月」「直近3/12か月」「全期間」は必要月だけ集約し、期間が曖昧なら保存範囲を踏まえた自然な一問で聞き返す（旧1〜4回答も互換維持）。取得・認証エラーはデータ不存在と区別。
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
