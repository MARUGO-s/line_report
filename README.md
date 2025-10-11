# MARUGO-s ファイル管理システム

## 概要
各種ドキュメントファイルを管理し、LINE Bot経由でAIアシスタントがファイル内容に関する質問に答えるシステムです。

## 主な機能

### ✅ 多様なファイル形式対応
- **TXTファイル**: そのままテキストとして読み込み
- **Markdownファイル（.md）**: そのままテキストとして読み込み
- **PDFファイル**: 自動的にテキストを抽出して読み込み（pdf-parseライブラリを使用）
- **Word文書（.docx）**: mammothライブラリでテキストを抽出して読み込み
- **Excel文書（.xlsx/.xls）**: シートごとにテキスト化して読み込み（xlsxライブラリを使用）
- **CSVファイル**: そのままテキストとして読み込み
- **会話履歴**: ユーザーごとに直近のやり取り（最大5往復）を保持して文脈を維持（サーバー再起動でリセット）
- Supabaseストレージに保存されたファイルを自動的に読み込み、AIアシスタントの知識ベースとして活用

### 📄 ドキュメント管理
- `/` (index.html) からファイル（PDF、Word、Excel、Markdown、TXT、CSV）をアップロード
- 対応形式: `.pdf`, `.docx`, `.xlsx`, `.xls`, `.md`, `.txt`, `.csv`
- アップロードされたファイルはSupabaseストレージに保存
- ファイル一覧の表示、ダウンロード、削除が可能

### 🤖 LINE Bot連携
- LINE Messaging API経由でユーザーの質問を受け付け
- Groq AI（llama-3.1-8b / llama-3.3-70b）またはChatGPT（gpt-4o-mini）を使用してアップロードされたファイルに基づいて回答
- ファイルに記載されていない内容については明示的に通知

## セットアップ

### 必要な環境変数（`.env`）
```
GROQ_API_KEY=your_groq_api_key
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
LINE_CHANNEL_ACCESS_TOKEN=your_line_channel_access_token
PORT=3000
```

### インストール
```bash
npm install
```

### 起動
```bash
npm start
```

## 使い方

1. サーバーを起動
2. `/` にアクセスしてファイル（PDF、Word、Excel、Markdown、TXT、CSV）をアップロード
3. LINE Bot で最初に利用する AI モデルを選択（`1` = Llama 8B / `2` = Llama 70B / `3` = ChatGPT。`モデル変更` で再選択）
4. AIアシスタントがアップロードされたファイルに基づいて回答

## 技術スタック
- **バックエンド**: Node.js + Express
- **AI**: Groq SDK (Llama 3.1 8B / Llama 3.3 70B) + OpenAI API (GPT-4o-mini)
- **ストレージ**: Supabase Storage
- **PDF処理**: pdf-parse
- **Word処理**: mammoth
- **Excel処理**: xlsx
- **会話管理**: インメモリ履歴（ユーザーごとに最大5往復）
- **メッセージング**: LINE Messaging API
