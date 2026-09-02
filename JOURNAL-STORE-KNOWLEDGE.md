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

**LINE `#メモ` を含む登録済み資料の閲覧・編集は、このタブが一覧の正本です。** LINE 上だけでは履歴一覧できません。

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
- PDF・画像・Excel・Word・テキストはAIが解析し、概要・本文・タグをフォームへ反映する。メニュー画像は商品名・価格・説明の構造化一覧も作る
- 一覧は種別・有効/無効・キーワードで絞り込み、実施中の資料に「実施中」バッジを表示

### メニュー画像のプロンプトブロック設計（2026-09-02）

メニュー画像解析は、小口レシート解析と同じ加算式のブロック設計である。

1. 全店共通の資料抽出規約
2. メニュー／価格表にだけ適用する全店共通のメニュー規約
3. 認証済み店舗キーに一致した場合だけ追加する店舗専用規約
4. 全経路共通のJSON Schema出力契約

MARUGO Sにはワイン表専用ブロックがあり、区分、生産者・銘柄・品種、`Glass / Decanter / Bottle`の価格、
`50ml / 375ml`等の容量を分離する。他店舗にはこのブロックを適用しない。
商品件数と価格付き件数をコードで検算し、不足時は1回再解析、なお不足なら`needs_review`として保存前確認へ回す。

詳細と店舗専用ブロックの追加手順は
[店舗資料メニュー画像解析 — 共通・種別・店舗専用プロンプトブロック設計](./docs/JOURNAL-KNOWLEDGE-MENU-PROMPT-BLOCKS.md)を参照。

---

## 5. AIへの渡し方

### 選定ロジック（`jnl2txt.html`）

1. **期間一致は無条件で添付** — 確定集計の対象期間と `period_start` / `period_end` が重なる資料は、
   質問文との類似度に関係なく必ず入れる。類似度検索だけだと施策を取りこぼすため
2. 語句一致で補完 — `knowledgeTextSimilarity`（2文字組の共通率。フードコートAIと同じ考え方）が
   0.03以上のものを追加
3. 選定詳細は最大20資料、RAGは最大8チャンク。資料ごとにRAGが無ければ自身の本文へフォールバックする
4. B案として全有効資料のタイトル・期間・タグだけを存在確認用目次へ載せる。目次は実施・因果・数値の根拠にしない
5. 文字枠 — 店舗資料ブロック全体は最大12000字、目次は最大4000字。詳細を先に確保し、長い目次が証拠本文を押し出さない

対象期間は確定集計から求める（`resolveKnowledgePeriodRange`）。

| 質問の形 | 期間の求め方 |
|---|---|
| 単月・年・レンジ | `monthlyBreakdown` の先頭月初〜最終月末 |
| 日単位（◯月◯日・今日・先週） | `dailyBreakdown` の先頭日〜最終日 |
| 比較（複数期間） | 離れた期間を1本へ広げず、期間区間の配列として保持 |
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

## 6-2. LINE から資料を登録する（引用返信 `#メモ`）— 2026-08-03 稼働

Web の「資料」タブと同じ登録を、LINE からも行える。**画像・PDF・Excel・Word・テキスト**に対応。

### 使い方

1. ルームに**ファイルを送る**（画像でもPDFでもよい）
2. **その送信メッセージにリプライ（引用返信）して `#メモ` と送る**（`＃メモ` の全角シャープも可。`#日報` / `#note` も同義）
3. Bot が「✅ 引用元のファイルを店舗ナレッジ（資料）に登録しました」と返信

本文を足すと（例: `#メモ 8月のグラスワイン`）、AI解析が空振りしたときの本文として使われる。

### なぜ「引用返信」なのか

**LINE の画像・ファイルメッセージには `text` フィールドが無い。** キャプションを付けて送る手段が
Messaging API に存在しないため、「画像に `#メモ` と書いて送る」ことは原理的にできない。
実データのキーは `contentProvider, id, markAsReadToken, quoteToken, type` のみ。

引用返信のテキストイベントには `quotedMessageId`（引用元のID）が入るので、これを唯一の
指定手段として使う。**将来ここを「画像メッセージの text を見る」実装に戻してはいけない。**
一度その実装が入り、まったく発火しないまま放置されていた。

### 通数（PUSH無料枠）について

- **引用返信は店舗からの受信メッセージ**なので無料枠を消費しない
- 完了・失敗の通知は `replyToken` による**返信メッセージ**で、これも無料枠の対象外
  （枠を消費するのは PUSH のみ。Webhookログの「返信◯回＝枠外」表示と同じ考え方）
- `POST /v2/bot/message/react`（リアクション付与）は **LINE Messaging API に存在しない**。
  一時期これで通知しようとしていたが、成功しても利用者には何も見えなかった

### 処理の流れ

```
添付を受信 → line_message_media へ先行保存（メディア閲覧用）
   ↓ その添付に引用返信で #メモ
LINE content API から本体を取得（Content-Type で種別判定）
   ↓
POST /pos-journals/knowledge/analyze-image   … Gemini 解析
   ↓  画像・PDF は inlineData でそのまま／Excel・Word はサーバでテキスト化
POST /pos-journals/knowledge/upload          … 原本を store-knowledge へ
   ↓
POST /pos-journals/knowledge                 … 登録（source_type='line_post'）
   ↓  rebuildStoreKnowledgeChunks が RAG チャンクを生成
line_message_media から取り消し（資料側へ移したので複製を残さない）
```

メディア保存は**受信時点**で走るため「保存しない」ことはできない。登録に**成功したときだけ**
`removeRoomMediaByMessageId` で取り消す。失敗時は残すので、添付が両方から消える事故は起きない。

### 送信日時と分析の時間軸（2026-08-07）

LINE `#メモ` / `#日報` / `#note` は **Messaging API の `event.timestamp`（送信時刻）** を保存する。

| 保存先 | 内容 |
|---|---|
| `created_at` | LINE 送信時刻（ISO）。処理遅延で「受信日」にずれない |
| `period_start` / `period_end` | 送信日の **JST 暦日**（同日）。常時有効にはしない |

これにより、7月の分析には7月に送ったメモだけが期間一致で必ず添付され、他月の現場メモは類似度だけで混ざらない。
AI プロンプトには `送信 YYYY-MM-DD HH:MM`（JST）を載せ、期間外メモを当該月の主因にしない指示を付ける。

テキスト経路: `line-webhook` → `process-line-post`（`line_timestamp`）。
引用添付経路: 同じく `line_timestamp` を `POST /knowledge` へ渡し、`saveStoreKnowledge` が period／created_at を埋める。

### 実装の要点（踏んだ地雷）

| 箇所 | 注意 |
|---|---|
| タグ判定 | `_shared/knowledge_memo_tag.ts` に集約。**半角 `#` だけを見ると全角 `＃` が素通りする**（日本語入力では全角になりやすい）。同じ正規表現を各所へコピーしない |
| 店舗キー | 登録APIへ送るのは **`store_key`**。DB列名の `store_partition_key` で送ると 400 `store_key is required.` になる。`x-store-key` ヘッダは内部ブリッジ経路では `storeScope=null` のため効かない |
| 関数間認証 | `x-internal-key`（service_role）。**`x-admin-token: 'demo'` は管理者認証を通らず全て 401** |
| 関数の位置 | `registerQuotedImageAsKnowledge` は**必ずトップレベル**に置く。`Deno.serve` 内のイベントループ本体に置くと、同ブロックで後から `const` 宣言される変数を巻き込み TDZ エラーになる（レシート登録が全店で7時間半停止した実績あり） |

### 検証結果（2026-08-03）

実際に LINE からワイン紹介画像を引用返信で登録し、以下を確認。

| 項目 | 結果 |
|---|---|
| `store_knowledge_documents` | id=21 / `source_type='line_post'` / marugogrande |
| タイトル | 「ロレンツォン プロセッコ・スプマンテ・ブリュット ミレジマート D.O.C. トレヴィーゾ」（画像から自動抽出） |
| カテゴリ | メニュー |
| タグ | 13件（ワイン・プロセッコ・イタリアワイン・ペアリング 等を自動付与） |
| 原本 | `store-knowledge` に 413,623 バイト保存 |
| **RAGチャンク** | **2件生成** |
| `line_message_media` | 取り消し済み |

### 既知の課題

`body_text` に Gemini の生レスポンス（```json … ``` のコードフェンス込み）がそのまま
入る場合がある。`parsed.body_text` が空のときのフォールバックが生テキストを使うため。
検索・RAG は機能するが本文としては読みにくいので、整形が望ましい。

---

## 7. 運用上の注意

- **資料の鮮度管理** — 終了した施策や廃止メニューが残っていると誤解の元になる。
  実施期間を必ず入れ、恒常的でなくなったものは「無効にする」で外す
- **数値は書かない** — 「7月は売上◯◯円だった」のような数値を資料に書くと、AIが
  確定集計と混同しかねない。施策の内容・狙い・対象商品を書く
- **他店の資料は見えない** — 店舗スコープのログインは自店固定。フル管理者は店舗切替で参照
- **PDF・Excel・Word の中身は読める（2026-08-03〜）** — Web の「資料」タブでも LINE の
  引用返信 `#メモ` でも、Gemini が中身を解析して本文・タグを自動抽出する。
  以前は「保管のみ」だったため、説明文と実装が食い違っていた時期がある

---

## 8. 今後（フェーズ2以降）

| フェーズ | 内容 | 接続点 |
|---|---|---|
| 2 | PDF・画像・ExcelのAI自動テキスト抽出と要約、チャンク分割 | **完了（2026-08-03）**。Word も対応。`store_knowledge_chunks` 作成済み |
| 3 | 施策の効果測定を自動生成（施策期間の売上 vs 前期間）し `source_type='ai_insight'` として蓄積、👍👎学習、pgvector 埋め込み検索 | `vector` 拡張は **2026-08-03 に導入済み**（`extensions` スキーマ）。`embedding` 列は nullable のままで、埋め込み生成は未実装 |

フェーズ3の循環は、フードコートAI側で稼働している
`foodcourt_ai_loop_runs` → `foodcourt_ai_feedback` → `foodcourt_ai_rag_documents`
（DBトリガー `sync_foodcourt_ai_rag_document` が自動蓄積）と同じ型で構築できる。

---

## 関連

- [AI_KNOWLEDGE_SYSTEM.md](./AI_KNOWLEDGE_SYSTEM.md) — Graphify / Obsidian の知識基盤
- [店舗運用修正記録.md](./店舗運用修正記録.md) — 不具合と対策の運用ログ
- [SECURITY.md](./SECURITY.md) — RLS・service_role・Storage の不変条件
