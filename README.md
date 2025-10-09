# Company-terms

## 概要
会社規約を管理し、LINE Bot経由でAIアシスタントが規約に関する質問に答えるシステムです。

## 主な機能

### ✅ PDFファイル読み込み対応
- **TXTファイル**: そのままテキストとして読み込み
- **PDFファイル**: 自動的にテキストを抽出して読み込み（pdf-parseライブラリを使用）
- **DOCXファイル**: mammothでテキストを抽出して読み込み
- **XLSXファイル**: シートごとにテキスト化して読み込み（xlsxライブラリを使用）
- **会話履歴**: ユーザーごとに直近のやり取り（最大5往復）を保持して文脈を維持（サーバー再起動でリセット）
- Supabaseストレージに保存されたファイルを自動的に読み込み、AIアシスタントの知識ベースとして活用

### 📄 ドキュメント管理
- `/public/admin.html` から規約ファイル（PDF/TXT）をアップロード
- アップロードされたファイルはSupabaseストレージに保存
- ファイル一覧の表示、ダウンロード、削除が可能

### 🤖 LINE Bot連携
- LINE Messaging API経由でユーザーの質問を受け付け
- Groq AI（llama-3.3-70b-versatile）を使用してアップロードされた規約に基づいて回答
- 規約に記載されていない内容については明示的に通知

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
2. `/public/admin.html` にアクセスして規約ファイル（PDF/TXT/DOCX/XLSX）をアップロード
3. LINE Bot で最初に利用する AI モデルを選択（`1` = コスト重視 8B / `2` = 精度重視 70B。`モデル変更` で再選択）
4. AIアシスタントがアップロードされた規約に基づいて回答

## 技術スタック
- **バックエンド**: Node.js + Express
- **AI**: Groq SDK (Llama 3 系 8B / 70B を切り替え)
- **ストレージ**: Supabase Storage
- **PDF処理**: pdf-parse
- **Word処理**: mammoth
- **Excel処理**: xlsx
- **会話管理**: Groq API + インメモリ履歴
- **メッセージング**: LINE Messaging API
