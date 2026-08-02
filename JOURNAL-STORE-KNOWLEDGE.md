# Journal Report 店舗ナレッジ（施策・メニュー資料）

Journal Report（`public/jnm/jnl2txt.html`）のAIが、売上数値だけでなく
**「その期間に店舗が何をしていたか」** を踏まえて分析できるようにする仕組みの仕様と現状。

- 対象: 22店舗すべて（`store_partition_key` で分離）
- 画面: Journal Report の「資料」タブ
- 状態: **フェーズ1・2・3 実装完了**（2026-08-02：全自動テキスト抽出・RAGチャンク分割・効果測定インサイト機能）

---

## 1. 何を解決するか

これまでAIへ渡していたのは保存済みレポート由来の売上集計だけだった。
そのため「7月の売上が伸びた要因は？」と聞いても、AIは数字の増減しか説明できず、
実際に店舗が実施したワインフェアやメニュー改定を考慮できなかった。

店舗が施策・メニューを登録しておけば、AIは対象期間に実施していた施策を
**必ず**参照したうえで分析する。数値の正本は従来どおり確定集計のままで、
ナレッジは背景説明にのみ使う。

---

## 2. データモデル

`supabase/migrations/20260802220000_store_knowledge_documents.sql`

テーブル `public.store_knowledge_documents`

| 列 | 型 | 役割 |
|---|---|---|
| `store_partition_key` | text | 店舗分離キー。API層で他店アクセスを拒否 |
| `category` | text | 施策 / メニュー / 価格改定 / イベント / マニュアル / その他（CHECK制約） |
| `title` | text | 必須。空白のみは不可 |
| `summary` | text | AIが最初に読む要約 |
| `body_text` | text | 貼り付け原文・抽出テキスト |
| `search_text` | text | title+summary+body+tags をNFKC小文字化した検索用。API側で組み立てる |
| `period_start` / `period_end` | date | **null は「常時有効」**。グランドメニューやマニュアルは全期間の質問に添付される |
| `tags` | text[] | 任意 |
| `storage_bucket` / `storage_path` | text | 添付原本の保管先（非公開バケット `store-knowledge`） |
| `original_file_name` / `mime_type` / `file_size_bytes` / `sha256_hex` | | 添付メタ。同一ファイルの二重登録は部分ユニークで防止 |
| `source_type` | text | manual / upload / ai_insight（ai_insight はフェーズ3の自動生成用に予約） |
| `is_active` | boolean | 論理削除。無効化しても過去期間の質問では参照される |
| `created_by` / `created_at` / `updated_at` | | 監査用 |

インデックス

- `(store_partition_key, is_active, period_start desc)` — 期間重なり抽出
- `(store_partition_key, category, is_active)` — 種別フィルタ
- `gin (search_text public.gin_trgm_ops)` — フリーワード部分一致（pg_trgm は導入済み）
- `unique (store_partition_key, sha256_hex) where is_active and sha256_hex is not null`

セキュリティ

- RLS 有効。`anon` / `authenticated` から全権限を revoke し、`service_role` のみ許可
- Storage バケット `store-knowledge` は **非公開**・20MB上限・許可MIMEのみ
- 公開Pagesはテーブルへ直接アクセスせず、必ず `admin-api` 経由（`pos_journal_files` と同方針）

---

## 3. API（`supabase/functions/admin-api/index.ts`）

いずれも `STORE_SCOPED_ALLOWED_PATHS` に登録済みで、店舗スコープのログインからも利用できる。
店舗キーの不一致は 403。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/pos-journals/knowledge` | 一覧。`category` / `active` / `q` / `limit` で絞り込み。本文は先頭200字の抜粋のみ返す |
| GET | `/pos-journals/knowledge/item` | 単体取得（本文全文） |
| POST | `/pos-journals/knowledge` | 登録・更新（`id` があれば更新） |
| POST | `/pos-journals/knowledge/upload` | 添付アップロード（multipart）。SHA-256を計算しStorageへ保存 |
| GET | `/pos-journals/knowledge/download` | 署名URL発行（`createSignedMediaUrl` を流用） |
| DELETE | `/pos-journals/knowledge/item` | 既定は論理削除。`purge: true` + `confirmation: "delete"` で完全削除＋添付消去 |

**削除の既定を論理削除にしている理由**: 終了した施策も「去年の同じ月は何をしていたか」に
答えるために必要なため。無効化＝現在の提案には使わない、という意味にしている。

---

## 4. 画面（「資料」タブ）

登録フォーム

| 項目 | 必須 | 補足 |
|---|---|---|
| 種別 | ○ | 6種から選択 |
| タイトル | ○ | 例「7月ワインフェア（グラス3種入替）」 |
| 開始日 / 終了日 | 施策・イベントは推奨 | 空欄＝常時有効 |
| 概要 | ○（内容と択一） | AIが最初に読む |
| 内容 | − | メニュー表などの貼り付け用 |
| タグ | − | カンマ区切り |
| 添付 | − | 20MBまで |

- テキスト / CSV / Markdown を添付すると、その場で読み取って「内容」へ取り込む
- PDF・画像は保管のみ（AIは読まない）。要点は概要へ記入する運用
- 一覧は種別・有効/無効・キーワードで絞り込み、実施中の資料に「実施中」バッジを表示

---

## 5. AIへの渡し方

### 選定ロジック（`jnl2txt.html`）

1. **期間一致は無条件で添付** — 確定集計の対象期間と `period_start` / `period_end` が重なる資料は、
   質問文との類似度に関係なく必ず入れる。類似度検索だけだと施策を取りこぼすため
2. 語句一致で補完 — `knowledgeTextSimilarity`（2文字組の共通率。フードコートAIと同じ考え方）が
   0.03以上のものを追加
3. 上限 — 5件 / 6000字。`systemInstruction` の40000字上限に対して余裕を取る

対象期間は確定集計から求める（`resolveKnowledgePeriodRange`）。

| 質問の形 | 期間の求め方 |
|---|---|
| 単月・年・レンジ | `monthlyBreakdown` の先頭月初〜最終月末 |
| 日単位（◯月◯日・今日・先週） | `dailyBreakdown` の先頭日〜最終日 |
| 比較（複数期間） | 全期間を包含する最小レンジ |
| 期間が特定できない | null（全資料を候補にし、類似度で上位のみ） |

### プロンプト

チャット（`sendAiChat`）と分析レポート（`aiAnalyze`）の両方へ
`【店舗ナレッジ（この店舗が登録した施策・メニュー資料）】` ブロックを差し込み、
絶対遵守規約に第8項を追加している。

> - 売上・客数などの数値は必ず【確定済み集計データ】から引用すること。**本ナレッジを数値の出典にしてはいけない**
> - 施策・メニュー・価格の内容や背景の説明にのみ使い、その場合は「登録資料によると」と明示する
> - 資料に書かれていないことを推測で補わない
> - 施策と数値を結びつけた考察は歓迎するが、因果の断定は避け「※これは推測です」を付ける

取得失敗時はナレッジ無しで通常どおり回答する（チャットを止めない）。

---

## 6. 検証結果（2026-08-02）

- リポジトリ全テスト 50件 pass（本機能で3テスト追加）
  - 期間重なりによる添付、対象外月の施策を混ぜないこと、無効資料の除外
  - プロンプトブロックの文言と6000字上限
  - `admin-api` の4ルート登録・他店拒否・論理削除の既定
  - マイグレーションのRLS / revoke / grant / バケット非公開
- 本番DBで往復テスト（登録・期間抽出・trgm検索）を実施し、テストデータは削除済み
- 制約の発火を確認（不正な `category`、空白のみ `title`、`period_start > period_end`）
- `admin-api` 型チェック: 本機能で追加した型エラー 0
- 実ブラウザでコンソールエラーなし、タブ・フォーム・一覧の描画を確認

---

## 7. 運用上の注意

- **資料の鮮度管理** — 終了した施策や廃止メニューが残っていると誤解の元になる。
  実施期間を必ず入れ、恒常的でなくなったものは「無効にする」で外す
- **数値は書かない** — 「7月は売上◯◯円だった」のような数値を資料に書くと、AIが
  確定集計と混同しかねない。施策の内容・狙い・対象商品を書く
- **他店の資料は見えない** — 店舗スコープのログインは自店固定。フル管理者は店舗切替で参照
- **PDFの中身はまだ読まない** — フェーズ1では保管のみ。要点は概要へ

---

## 8. 今後（フェーズ2以降）

| フェーズ | 内容 | 接続点 |
|---|---|---|
| 2 | PDF・画像・ExcelのAI自動テキスト抽出と要約、チャンク分割 | `store_knowledge_chunks` を追加するだけ。本テーブルは変更不要 |
| 3 | 施策の効果測定を自動生成（施策期間の売上 vs 前期間）し `source_type='ai_insight'` として蓄積、👍👎学習、pgvector 埋め込み検索 | `vector` 拡張は利用可能（未インストール）。`embedding` 列は nullable で後付け可能 |

フェーズ3の循環は、フードコートAI側で稼働している
`foodcourt_ai_loop_runs` → `foodcourt_ai_feedback` → `foodcourt_ai_rag_documents`
（DBトリガー `sync_foodcourt_ai_rag_document` が自動蓄積）と同じ型で構築できる。

---

## 関連

- [AI_KNOWLEDGE_SYSTEM.md](./AI_KNOWLEDGE_SYSTEM.md) — Graphify / Obsidian の知識基盤
- [店舗運用修正記録.md](./店舗運用修正記録.md) — 不具合と対策の運用ログ
- [SECURITY.md](./SECURITY.md) — RLS・service_role・Storage の不変条件
