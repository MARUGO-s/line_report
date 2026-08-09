# 引き継ぎ: Journal Report 店舗資料 A+B 複合案・全経路監査・デプロイ

更新日: 2026-08-10  
状態: **完了**（commit `d7d18bb` を push、Pages / Edge Functions ともデプロイ成功、本番確認済み）

## 0. 完了記録（後続セッションが最初に読む要約）

- commit `d7d18bb`（16ファイル・+1,735/−503行）を `main` へ push。作業開始HEAD `74b44e6` の続き。
- 検証: `npm run check` / `test:ci` / `journal:integration:check`（21 OK / 0 NG）すべて exit 0。`deno check` ai-analyze 0エラー。`git diff --check` clean。2入口HTMLは byte一致。
- デプロイ: GitHub Actions の `Deploy GitHub Pages` と `Deploy Edge Functions` が両方 success。**push で全 Edge Function が自動デプロイされるため、§7-6 の手動 `npx supabase functions deploy` は不要だった**（`supabase` CLI もこの環境に無い）。
- 本番確認: Pages 2入口とも HTTP 200・824,895 bytes・ローカルと byte一致。公開HTMLに `AI_KNOWLEDGE_MAX_ITEMS = 20` / `MAX_CHARS = 12000` / `CATALOG_MAX_CHARS = 4000`。未認証で `admin-api/pos-journals/knowledge`・`.../knowledge/items`・`ai-analyze` はいずれも HTTP 401。
- §7-10 の非gitコピー同期も完了。`解凍変換ソフト/` の HTML/JS 9ファイルと `supabase/functions` が本番と一致。同期前に差分方向を確認し、作業フォルダ側の独自行は旧版のみ（廃止した「12月はクリスマスディナーが必ず発生する」断定を含む）で、失うものが無いことを確認した。
- 残件は §6 の Graphify CLI 不在による stale のみ。製品動作・デプロイへの影響なし。

**補足（リポジトリ構成の誤解を防ぐため）**: `~/Library/CloudStorage/Dropbox/web/line_report` は `line_report-main` へのシンボリックリンクで、実体は1つ。クローンが二重化しているわけではない。

## 1. ユーザーの依頼

1. 中断していた Journal Report の店舗資料機能を、A案（選定資料の詳細）＋B案（全資料目次）の複合案で引き継いで実装する。
2. デプロイする。
3. 実装本体だけでなく、LINE等の連絡系統とAI判断系統も監査し、バグと改善点を修正してから本番確認する。

## 2. リポジトリと本番

- Repo: `/Users/yoshito/Library/CloudStorage/Dropbox/web/line_report-main`
- Branch: `main`
- 作業開始HEAD: `74b44e6876ceaa226578426ab323e31b5d3dd356`
- Origin: `https://github.com/MARUGO-s/line_report.git`
- Pages: `https://marugo-s.github.io/line_report/`
- Supabase project: `hocbnifuactbvmyjraxy`
- 現在の差分は未commit。ユーザーの変更を含む可能性があるため、reset/checkoutで捨てないこと。

## 3. 実装済みの要点

### A+B検索と精度

- A案: 詳細資料を最大20件、店舗資料ブロック全体を最大12,000字へ拡張。
- B案: 全有効資料のタイトル・期間・タグを最大4,000字の存在確認専用目次として渡す。
- 選定証拠を先、目次を後に配置。目次は期間内実施、引用、因果、数値の根拠に使わせない。
- RAGは最大8チャンク。1資料でもRAGがあると全資料の本文を止めていたバグを修正し、資料ごとに本文へフォールバック。
- 離れた比較期間をmin〜maxの一本に潰さず、区間配列のまま重なり判定。
- 日本語/ISO期間を解析。無効化資料は、その期間を明示した過去分析だけで参照。
- LINE `#メモ`は送信日を期間として扱い、類似度だけで他期間へ混ぜない。

### 取得状態と性能

- 正常0件と、取得失敗、未認証、staleキャッシュ、上限到達、詳細部分失敗を区別。
- AI実行直前に一覧を再検証し、直前にLINE登録されたメモも反映。
- 一覧APIは本文をDBから取得しない。安定ソート付きページングを追加。
- 選定した最大20件は `POST /pos-journals/knowledge/items` で一括取得し、更新日時連動で詳細キャッシュ。

### AI判断とプロンプト安全性

- `ai-analyze`所有の固定規約をOpenAIのdeveloper/systemまたはClaudeのsystemへ配置。
- ブラウザのsystemInstruction、確定集計、店舗資料、目次、外部知見、会話履歴を非信頼user証拠として分離。
- 資料内の命令、役割変更、区切り偽装、プロンプト開示要求を無視する固定規約を追加。
- 数値の正本を確定済み集計に限定し、資料は施策・メニュー等の背景証拠に限定。
- 39,000字超過時に店舗情報・確定集計・実資料を丸ごと落とす切断バグを修正。
- 全店でクリスマスディナーが必ずあるという断定を廃止。確定商品/選定資料があるときだけ事実、無ければ仮説。

### admin-api / Storage / LINE連絡経路

- 添付済み資料を新しいファイルなしで編集しても、Storageパス、ファイルメタ、由来、作成者、有効状態を保持。
- 店舗キーを小文字へ正規化し、既存の大小文字混在行は大文字小文字を無視して取得。
- `storage_path`を対象店舗のプレフィックス内に限定し、他店オブジェクトの保存・署名・削除を拒否。
- 公開クライアントによる `source_type` / `created_by` の由来偽装を防止。内部LINE経路だけ信頼済み由来を設定。
- LINE引用添付はStorage保存成功後だけDB登録・成功返信・元メディア削除。失敗時は失敗返信し元メディアを残す。
- DB保存失敗時は今回アップロードした孤児Storageを清掃。
- テキスト `#メモ`の非OK、`processed=false`、例外もconsoleだけで握り潰さず利用者へ失敗返信。

## 4. 主な変更ファイル

- `public/jnm/jnl2txt.html`
- `public/jnm/index.html`（上記とbyte parity済み）
- `supabase/functions/admin-api/index.ts`
- `supabase/functions/ai-analyze/index.ts`
- `supabase/functions/line-webhook/index.ts`
- `tests/journal_chat_query_planner.test.mjs`
- `scripts/verify-journal-ai-data-flow.mjs`
- `docs/JOURNAL-STORE-KNOWLEDGE.md`
- `docs/JOURNAL-REPORT-FEATURES.md`
- `PROJECT_PROGRESS.md`
- `docs/店舗運用修正記録.md`
- 本ファイル

Obsidian手動知識ノートにも追記済み:

- `/Users/yoshito/Library/CloudStorage/Dropbox/web/アプリ知識/10_アプリ別/LINE Report/60_機能別知識/売上分析と口コミ.md`

## 5. 完了済み検証

- `npm run test:ci` → exit 0。
- `npm run test:journal-ai` → Deno 13/13、Node 55/55 pass。
- `npm run journal:integration:check` → 21 OK / 0 NG、exit 0。
- `npm run check` → pass。
- `git diff --check` → pass。
- `deno check --no-lock supabase/functions/ai-analyze/index.ts` → pass。
- `public/jnm/index.html` と `public/jnm/jnl2txt.html` → byte-identical。
- ローカルPagesを `PORT=8786 scripts/local-line-report-pages.sh` で起動し、`jnm/jnl2txt.html` がHTTP 200、824,486 bytes、作業ファイルと完全一致することを確認。
- `npm run knowledge:generate` → 4,158 nodes / 9,725 relationships / 342 communities、Obsidian AI workspace同期成功。

`admin-api`と`line-webhook`の単体Deno checkには、作業開始前から存在する共有型定義/DOM/EdgeRuntime等のエラーが残る。今回追加箇所の回帰は静的テストと全体CIで確認済み。最終統合後の差分をサブエージェントが再監査中なので、結果を受け取ってからcommitすること。

## 6. Graphifyの既知制約

`npm run knowledge:check` は失敗中。`graphify` CLIがこの環境に無く、既存Graphify manifestが今回以前の複数ファイルでもstaleなため。

主な残件:

- 今回変更: `admin-api/index.ts`、`line-webhook/index.ts`、`ai-analyze/index.ts`、Journalテスト/checker等。
- 既存変更: `package.json`、foodcourt/groq/petty-cash関連等。
- SQL coverage: `20260805031441`、`20260806133001`、`20260807030000` の3 migrationが既存manifestに未収録。

Graphify CLIを勝手に別パッケージから導入しないこと。製品テスト/デプロイの阻害要因ではないが、最終報告では「生成ミラーは同期済み、Graphify抽出だけCLI不在でstale」と明記する。

## 7. 未完了タスク（この順で継続）

1. 3サブエージェントの最終再監査結果を受け取り、必要な修正があれば反映。
2. `git status -sb` / `git diff --stat` / `git diff --check`を再確認。
3. 変更が入った場合は最低限 `npm run test:journal-ai`、`npm run journal:integration:check`、`npm run check`を再実行。リスクがあれば `npm run test:ci`も再実行。
4. `PROJECT_PROGRESS.md`と`docs/店舗運用修正記録.md`の「検証/Deploy」仮記載を、実測結果へ更新。
5. 意図した全差分だけをcommitし、`main`へpush。
6. 変更したEdge Functionだけをデプロイ:
   - `npx supabase functions deploy admin-api ai-analyze line-webhook --project-ref hocbnifuactbvmyjraxy --use-api`
7. Pages/Actionsの反映を待ち、本番を確認:
   - `https://marugo-s.github.io/line_report/jnm/jnl2txt.html`
   - `https://marugo-s.github.io/line_report/jnm/index.html`
   - ローカルとの内容マーカー/byte parity、最大20件/12,000字/目次4,000字の定数を確認。
8. 未認証で保護APIが401になることを確認:
   - `https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/admin-api/pos-journals/knowledge?store_key=bistrocavacava`
   - `https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/ai-analyze`
9. 本番commit SHA、Functions deploy結果、Pages Actions run、HTTP確認を運用記録へ追記。必要ならdocs-onlyの2回目commit/push。
10. 最後に、作業開始元の非gitコピーを慎重に同期する。対象候補:
    - `/Users/yoshito/Library/CloudStorage/Dropbox/web/解凍変換ソフト/jnl2txt.html`
    - `/Users/yoshito/Library/CloudStorage/Dropbox/web/解凍変換ソフト/index.html`
    先にdiffを見て、現行アプリがこの2ファイルを使うことを確認してから、完成した `public/jnm/*` と同期する。`archive/`内の旧版は触らない。

## 8. デプロイ前の注意

- DB migrationは今回追加していない。`db push`は不要。
- secret値、顧客データ、LINE本文、添付内容をログ/ドキュメント/commitへ書かない。
- dirty worktreeをresetしない。`public/jnm/index.html`と`jnl2txt.html`の同期を壊さない。
- Pagesはpush後に実際の公開HTMLを直接確認する。Functionsはデプロイ成功表示だけでなく未認証401も確認する。
- LINEの本番成功系は実メディアを勝手に送信して試さない。失敗系契約はテストで確認し、必要ならユーザー立会いで実機確認する。

## 9. 最終報告で伝える内容

- A+Bを実装し、目次を根拠から分離したこと。
- 取得失敗、期間、RAG、プロンプト切断、添付更新、LINE誤成功、店舗キー/Storage境界を修正したこと。
- AIの固定規約と非信頼証拠をprovider roleで分離したこと。
- テスト件数、commit SHA、Functions/Pagesの本番確認結果。
- Graphify CLI不在によるstaleだけが製品外の既知残件であること。
