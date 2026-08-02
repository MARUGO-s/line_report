# 🌐 システム全体アーキテクチャ & 運用ワークフロー仕様書 (SYSTEM_ARCHITECTURE_OVERVIEW.md)

本ドキュメントは、電子ジャーナル（`.jnl` / `.lzh`）全自動デコード・集計機能、Gemini 2.0 Flash を活用した店舗ナレッジ（メニュー画像等）のマルチモーダルAI解析、全自動 RAG チャンク生成、および売上データと施策・導入商品の「クロス効果測定・売上貢献度分析」を行うシステム全体の処理の流れとアーキテクチャを解説する包括仕様書です。

---

## 📐 1. システム全体アーキテクチャ図

```mermaid
flowchart TD
    subgraph フロントエンド ["Web UI (jnl2txt.html)"]
        UI_JNL["電子ジャーナル (.jnl/.lzh)\n一括ドラッグ＆ドロップ"]
        UI_KNOWLEDGE["店舗ナレッジ (施策/メニュー画像)\nドラッグ＆ドロップ / Paste / 参照"]
        UI_MODAL["✨ Gemini 2.0 Flash 解析結果\n確認・手入力修正モーダル"]
        UI_CHAT["対話型 AI チャット & \n売上分析ダッシュボード"]
    end

    subgraph バックエンド ["Supabase Edge Functions (admin-api / ai-analyze)"]
        API_PARSER["JNL / LZH ブラウザ内高速デコーダー\n(fflate.min.js & Shift-JIS)"]
        API_VISION["/analyze-image\n(Gemini 2.0 Flash 画像マルチモーダル解析)"]
        API_RAG["/process\n(全自動 RAG チャンク分割・検索用インデックス化)"]
        API_INSIGHT["/generate-insight\n(施策前後・新商品の売上貢献度自動比較)"]
        API_GEMINI["ai-analyze\n(売上データ × ナレッジデータ クロスプロンプト生成)"]
    end

    subgraph データベース ["Supabase PostgreSQL & Storage"]
        DB_DOCS["public.store_knowledge_documents\n(資料メタデータ・要約・本文)"]
        DB_CHUNKS["public.store_knowledge_chunks\n(RAG分割テキスト・pgvector/trgm)"]
        DB_REPORTS["public.reports\n(売上レポート・単品販売明細)"]
        STORAGE_BUCKET["Storage: store-knowledge\n(非公開原本画像・PDF保管)"]
    end

    subgraph 外部AI ["Google Gemini API"]
        GEMINI_VISION["Gemini 2.0 Flash (Vision / Multimodal)"]
        GEMINI_TEXT["Gemini 2.0 Flash / 3.6 Flash (Text Analysis)"]
    end

    %% データフロー
    UI_JNL --> API_PARSER --> DB_REPORTS
    UI_KNOWLEDGE --> API_VISION --> GEMINI_VISION
    GEMINI_VISION --> UI_MODAL --> DB_DOCS & STORAGE_BUCKET
    DB_DOCS --> API_RAG --> DB_CHUNKS
    DB_REPORTS & DB_CHUNKS --> API_GEMINI --> GEMINI_TEXT
    GEMINI_TEXT --> UI_CHAT
    DB_REPORTS & DB_DOCS --> API_INSIGHT --> DB_DOCS
```

---

## 🔄 2. システム全体の処理フロー（4大コア機能）

### 1. 電子ジャーナル (.jnl / .lzh) 全自動解凍・パース・売上集計
1. **読み込み**: ブラウザ上でレジの電子ジャーナル（`.jnl`）や LHA 圧縮書庫（`.lzh`）をドラッグ＆ドロップ。
2. **高速デコード**: ブラウザ内 JS (`fflate.min.js`) で全自動解凍し、Shift-JIS エンコーディングを解析。
3. **売上レポート生成**: 日別・月別・期間ごとの総売上、客数、客単価、フード/ドリンク比率、時間帯別・曜日別バランス、および**全商品の単品販売数量・売上金額**を自動計算して Supabase DB (`reports`) に保存。

---

### 2. 店舗ナレッジ（メニュー・施策画像）の Gemini 2.0 Flash 全自動解析 & 手動修正
1. **多様な入力に対応**: 資料タブへのファイル選択・ドラッグ＆ドロップ・クリップボードからの画像貼り付け (`Ctrl+V` / `Cmd+V`) のいずれの操作でも画像を検知。
2. **AI画像解析 (`/analyze-image`)**: Supabase Edge Function 経由で **Gemini 2.0 Flash**（優先）に画像バイナリを送信。メニュー写真やチラシからタイトル、カテゴリ、1〜3行の要約、文字起こし詳細（メニュー名・価格・説明）、タグを自動抽出。
3. **確認・手動修正モーダル**: 解析完了後、画面にポップアップ表示。AIの誤認識や補足したい点をユーザーが**その場で直接手入力で確認・修正**。
4. **確実な保管**: 原本画像は Supabase Storage (`store-knowledge`) へ、修正済みテキストは DB (`store_knowledge_documents`) へ保存。

---

### 3. 全自動 RAG チャンク生成 & ベクトル検索基盤
1. **自動テキストチャンク化 (`/process`)**: 保存された資料テキスト（要約＋本文）を約600文字ごとの最適な文脈単位に自動分割。
2. **RAGデータベース (`store_knowledge_chunks`) へ格納**: 分割されたチャンクは `store_knowledge_chunks` テーブルに保存され、`pg_trgm` 部分一致および将来の `pgvector` 1536次元埋め込みベクトルインデックスが自動付与。
3. **ハイブリッド検索**: 質問や売上分析の実行時に、対象期間やキーワードに合致するRAGチャンクを瞬時にピンポイント抽出。

---

### 4. 売上データ × 店舗ナレッジの「売上貢献度・効果測定クロス分析」
1. **クロスマッチング**: 新メニューボトルや施策の導入日（ナレッジデータ）と、ジャーナルの単品売上・カテゴリ売上（レポートデータ）を同期。
2. **売上貢献度の自動算出**:
   - 該当ボトルの「販売本数」「売上金額」「ドリンク全体に占める売上構成比」「客単価への影響額」を自動集計。
3. **AIアナリストによる多角レポート**:
   - AIチャットで「新しく導入したロゼワインの売上貢献度は？」等と質問すると、AIが売上数値とナレッジ背景を掛け合わせ、「新ボトル導入によりドリンク客単価が +320円 向上」「売上全体の8.4%を占める主力商品化」といった具体的な成果・インパクト・改善提案を出力。
4. **効果測定インサイトの自動蓄積 (`/generate-insight`)**: 前後期間の売上変化から「※これは推測です」付きの効果測定レポート（`source_type='ai_insight'`）をナレッジDBへ継続的に自動蓄積。

---

## 🗄️ 3. データベース & API 設計

### 主要テーブル

| テーブル名 | 役割・内容 |
|---|---|
| `public.reports` | 保存済み売上レポート（サマリー数値・曜日時間帯推移・単品販売明細） |
| `public.store_knowledge_documents` | 店舗ナレッジ（タイトル・カテゴリ・要約・本文・期間・添付パス・`source_type`） |
| `public.store_knowledge_chunks` | RAG検索用分割チャンク（`document_id`, `chunk_index`, `chunk_text`, `search_text`, `embedding`） |
| `storage.buckets ('store-knowledge')` | 非公開原本画像・PDF等の保管先（上限 20MB） |

### バックエンド API ルート (`supabase/functions/admin-api`)

- `POST /pos-journals/knowledge/analyze-image`: Gemini 2.0 Flash マルチモーダル画像解析
- `POST /pos-journals/knowledge`: ナレッジ新規保存・更新 & 自動RAGチャンク化
- `POST /pos-journals/knowledge/upload`: 添付ファイルアップロード (Storage + SHA-256)
- `POST /pos-journals/knowledge/process`: ドキュメントのRAGチャンク再生成
- `POST /pos-journals/knowledge/generate-insight`: 施策効果測定インサイト自動生成
- `GET /pos-journals/knowledge`: ナレッジ＆合致RAGチャンクのハイブリッド検索
- `GET /pos-journals/knowledge/download`: 署名付きURL発行
- `DELETE /pos-journals/knowledge/item`: 論理削除 / 物理削除

---

## 🚀 4. デプロイメント・運用仕様

- **本番Webアプリ**: [https://marugo-s.github.io/line_report/jnm/jnl2txt.html](https://marugo-s.github.io/line_report/jnm/jnl2txt.html)
- **GitHubリポジトリ**: `MARUGO-s/line_report` (`main` ブランチ)
- **店舗分離セキュリティ**: `store_partition_key` により22店舗のデータアクセスを完全隔離。

---
*本ドキュメントにより、後続のAIアシスタントや開発チームがシステム全体のデータフロー、画像AI解析、RAGチャンク生成、売上貢献度分析の仕組みを正確に把握できます。*
