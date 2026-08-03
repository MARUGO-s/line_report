# 📋 JNL → TXT 変換ツール & 売上分析AI アプリケーション 引き継ぎドキュメント (HANDOVER.md)

本ドキュメントは、本プロジェクトの技術スタック、現状のシステム構造、実装済み機能、および開発上の絶対遵守ルールを他のAIやエンジニアへ引き継ぐための仕様書です。

---

## 🌐 1. プロジェクト基本情報

- **アプリケーション概要**: レジの電子ジャーナルファイル（`.jnl` / `.lzh`）をブラウザ内でデコード・集計し、店舗経営レポートの作成・AIコンサルティング分析・保存データに基づく対話型AIチャットを提供するWebアプリケーション。
- **公開WebアプリURL**: [https://marugo-s.github.io/line_report/jnm/jnl2txt.html](https://marugo-s.github.io/line_report/jnm/jnl2txt.html)
- **GitHubリポジトリ**: `MARUGO-s/line_report` (`main` ブランチ)
- **主要ソースファイル**: `/jnl2txt.html`
- **デプロイパス**: `public/jnm/jnl2txt.html` および `public/jnm/index.html`

---

## 🛠️ 2. 技術スタック & アーキテクチャ

- **フロントエンド**: HTML5, Vanilla JavaScript (ES6+), Vanilla CSS (デザインシステム変数活用)
- **ライブラリ**: `fflate.min.js`（ブラウザ内 `.lzh` / `.zip` アーカイブ全自動高速解凍）
- **バックエンド / データベース**: Supabase (PostgreSQL / REST API / Edge Functions)
  - **Supabase URL**: `https://hocbnifuactbvmyjraxy.supabase.co`
  - **テーブル**: `reports` (売上レポート保存), `ai_analysis_history` (AIコンサル分析履歴)
  - **Edge Function**: `ai-analyze` (`https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/ai-analyze`)
- **ローカルストレージ**: `jnl2txt_reports_v2`, `jnl2txt_ai_history_v1` (デュアル永続化)
- **運用形態**: **純粋なWebアプリケーション**（※かつて存在した Electron / macOS / Windows ネイティブアプリ資産は完全に全削除済み）。

---

## ✨ 3. 実装済み主要機能

1. **電子ジャーナル (.jnl / .lzh) 全自動解凍・パース・CSV/TXT出力**
   - Shift-JIS / UTF-8 / EUC-JP 対応。ドラッグ＆ドロップでフォルダ・ファイルを一括読み込み。
   - 完了した売上のみ、取消・エラーのみ、全データ抽出の切り替え。
   - レジ商品コードマッピング設定（店舗別カスタマイズ）。

2. **売上レポート自動生成 (日別・月別・期間集計)**
   - 総売上高、取引件数、組数、総客数、平均客単価、ランチ/ディナー客単価。
   - フード/ドリンク/室料/その他/チャージの売上金額および構成比率。
   - 曜日別売上バランス、時間帯別売上推移、売上高 TOP 5 メニューの自動計算。

3. **ビジュアルAI分析ダッシュボード & コンサルティングレポート**
   - KPIカード（総売上、客単価、フード売上、ドリンク売上）。
   - フード vs ドリンク比率 / ランチ vs ディナー比率のプログレスバー表示。
   - 曜日別売上バランスバー、時間帯別推移バー、売上高 TOP 5 メニューグラフ。
   - AIによる強み・弱み・売上アップの具体的改善施策レポート出力。

4. **デュアル保存・同期エンジン (Supabase & LocalStorage)**
   - クラウドDBとローカルストレージの同時自動保存。
   - 保存済みレポート一覧（「すべて」「日別レポート」「月間レポート」のフィルター切替機能）。
   - 複数レポートを選択して合算分析する機能。
   - AI分析履歴一覧、プレビュー閲覧機能、削除機能。

5. **対話型 AI チャット (メイン画面 & レポート画面常時対応)**
   - 右側スライドイン方式のチャットパネル（`#aiChatPanel`）。
   - パネルを閉じるまで**会話履歴（`aiChatHistory`）を100%全件記憶・文脈保持**。

---

## 🔒 4. AIチャットにおける【絶対遵守ルール】

AIチャット処理 (`sendAiChat`, `generateLocalConsultantReply`, `searchSavedReportsByQuery`) には以下のプロンプト制約および検索ロジックが組み込まれています。今後の開発・改修でもこの規約を絶対に崩さないでください。

> **【絶対遵守プロンプト規約】**
> 1. AIは店舗の保存済み売上データ専用の厳密なアナリストAIとして動作すること。
> 2. 質問に対する回答や数値・金額に関しては、**必ず提示・保存されたデータ・資料のみから厳密に引用・計算して回答**すること。
> 3. **推測やWeb情報、外部の一般的な曖昧な推量で数字を答えることは【完全禁止】**。
> 4. チャットパネルを閉じるまでの過去の会話履歴（`chatHistory`）をすべて踏まえ、前後の文脈を完璧に引き継いで会話すること。
> 5. 提供されたデータ内に存在しない期間や項目について質問された場合は、「ご提示いただいた保存データ内には〇〇のデータが含まれておりません」と正確・正直に回答すること。

---

## 🔍 5. 重要コード構造 & 直近の修正知見

1. **保存ジャーナル横断検索エンジン (`searchSavedReportsByQuery`)**:
   - ユーザーのチャット入力から `202606`, `2026年6月`, `2026-06`, `2025年より前` などの年月・期間表現を正規表現で自動判別。
   - `readSavedReports()` 内の全保存データおよび `currentReport` から該当データを動的抽出し、**総売上高・フード売上・ドリンク売上・構成比・客数・客単価** を計算して即答。

2. **ダッシュボード描画の「¥0 / 白紙バグ」予防措置 (`buildAiVisualDashboardHTML`)**:
   - レポート保存時や履歴閲覧時に伝票明細配列 `d.sales` が除外されている場合でも、`currentReport` 自身に格納された事前計算サマリー属性（`totalSales`, `foodTotal`, `drinkTotal`, `weekdayBreakdown`, `hourlyBreakdown`, `topProducts` 等）を直接参照して描画するため、グラフや数値が空っぽになりません。

3. **アクティブタブのCSSスタイリング規則**:
   - 選択中のタブボタンには `.active` クラスが付与され、`.rv-btn.active`, `button[data-filter].active` に対する最高優先度のCSS（背景色 `#2563eb` / `#3b82f6` ＋ 太字白文字 `#ffffff` ＋ ドロップシャドウ）によって視認性が保たれます。

---

## 🚀 6. 開発・デプロイの手順

### リポジトリ更新と GitHub Pages 反映コマンド
コードを変更した際は、必ず構文チェックを行った上で以下を実行してデプロイします：

```bash
# 1. public ディレクトリへコピー
cp /Users/yoshito/Library/CloudStorage/Dropbox/web/解凍変換ソフト/jnl2txt.html /tmp/line_report_repo/public/jnm/jnl2txt.html
cp /Users/yoshito/Library/CloudStorage/Dropbox/web/解凍変換ソフト/jnl2txt.html /tmp/line_report_repo/public/jnm/index.html

# 2. Git コミット & プッシュ
cd /tmp/line_report_repo
git add public/jnm/jnl2txt.html public/jnm/index.html
git commit -m "Update application logic and documentation"
git push origin main
```

---

## ⚠️ 7. スタンドアロン作業フォルダとの同期に関する絶対注意事項

`/Users/yoshito/Library/CloudStorage/Dropbox/web/解凍変換ソフト/`（以下「作業フォルダ」）は、`jnl2txt.html` を編集するための非git作業コピーです。セクション6のコピー運用を行う際は、以下を必ず守ってください。

### 7-1. 作業フォルダの `supabase/` 配下からリポジトリへコピーしないこと

作業フォルダには `supabase/functions/`（`line-webhook` / `admin-api` / `ai-analyze`）も置かれていますが、これは**本リポジトリの内容を写しただけの参照専用ミラー**です。正本は常に本リポジトリ側であり、作業フォルダ側は放置すると古くなります。

> **絶対にやってはいけないこと**
> `cp .../解凍変換ソフト/supabase/functions/... → 本リポジトリ/supabase/functions/...`
> セクション6のデプロイ手順は **`jnl2txt.html` と `index.html` のみ**が対象です。`supabase/` 配下は決してコピー対象に含めないでください。

**実際に起きた事故（2026-08-03）**

`supabase/functions/line-webhook/index.ts` で、`#メモ` 画像処理の関数 `maybeProcessKnowledgeImageMessage` が `Deno.serve` 内のイベントループ本体に宣言され、その呼び出しが同一ブロックで後から `const` 宣言される `lineAccessTokenForSearch` を引数に渡していたため、**TDZ（Temporal Dead Zone）エラー**が発生しました。

```
ReferenceError: Cannot access 'lineAccessTokenForSearch' before initialization
```

これが画像メッセージ処理の `try` 冒頭で投げられ、`processReceiptImageEvent` に到達する前に `catch` へ落ちたため、全店舗で「レシート処理中にエラーが発生しました」を返し続けました（`line-webhook` v751 / 05:57 JST 〜 v752 / 13:27 JST の約7時間半、レシート登録が完全停止）。修正は PR #38。

このとき作業フォルダ側の `line-webhook/index.ts` は**修正前の状態のまま残っていた**ため、そこからコピーしていれば同じ障害が再発していました。

### 7-2. 更新の向きは「本リポジトリ → 作業フォルダ」の一方向

`supabase/` 配下を変更する必要がある場合は、**本リポジトリ側**で `origin/main` から切ったブランチに修正 → PR → `main` マージ（GitHub Actions が Edge Function を自動デプロイ）を行ってください。作業フォルダ側を編集して持ち込む運用は禁止です。

### 7-3. `#メモ` 機能の対応範囲（混同しやすい点）

| 経路 | 画像 | 状態 |
|---|---|---|
| Web「資料」タブに **Ctrl+V / Cmd+V で貼り付け** | ✅ 動作する | `handleKnowledgeFileChange()` → `analyze-image`（Gemini解析）→ `upload`（原本保存）→ ナレッジ登録 |
| LINE に **テキスト**で `#メモ` を送る | — | ✅ 動作する（テキストのみ登録。`source_type` は `manual` にフォールバック） |
| LINE に **画像**を送る | ❌ 動作しない | LINE の画像メッセージには `text` フィールドが無く（実データのキーは `contentProvider, id, markAsReadToken, quoteToken, type`）、`#メモ` 判定が成立しない。加えて本番DBの CHECK 制約が `source_type='line_post'` を許可していない |

「画像貼り付けで `#メモ` が動く」のは表の1行目（Web「資料」タブ）です。LINE に画像を送る経路は一度も成功しておらず、`store_knowledge_documents` に `storage_path` を持つ行は存在しません。LINE 画像経由を実装する場合は、画像に対する**リプライで `#メモ` と返す**方式が推奨です（画像イベントに `quoteToken` が含まれることを実データで確認済み）。

---
*本ドキュメントにより、後続のAIアシスタントやエンジニアがプロジェクトの全仕様・制約を正確に把握して開発を継続できます。*
