# リポジトリ構成 — LINE Report

この文書は、`line_report-main`のファイルを「どこに置くか」と「なぜルートに残すか」を定める正本です。

## 1. 先に知っておくこと

GitHub Actionsが`public/`をGitHub Pagesへデプロイします。

- 本番: `https://marugo-s.github.io/line_report/`
- 公開元: `main /public`
- `index.html`などの既存URLは、LINE通知・ブックマーク・運用資料から参照されています。

`public/`の内容はPages上ではサイト直下へ配置されるため、`public/index.html`は従来どおり`/line_report/index.html`で公開されます。ソース上は一か所に集約しながら、既存URLを維持します。

## 2. ディレクトリの役割

```text
line_report-main/
├── public/
│   ├── *.html / *.js             GitHub Pagesの公開入口（既存URL維持）
│   ├── icons/ / vendor/          公開画像・ブラウザ用ライブラリ
│   └── system-map/               公開する自動生成システム図
├── supabase/                     Edge Functions・migration・設定
├── src/ / schema.sql             旧LINE-WINE用ローカルExpress/SQLite
├── cloudflare-worker/            補助・レガシーWebhook経路
├── ocr-bridge/                   OCR補助サービス
├── google-apps-script/           Google Apps Script連携
├── scripts/                      開発・運用・知識更新コマンド
├── tests/                        自動テスト
├── docs/                         設計・運用・セキュリティ文書
├── knowledge/                    環境図の正本データ
├── graphify-out/                 Graphifyローカル生成物（Git対象外）
└── .local/                       DB・バックアップ等の端末ローカル状態（Git対象外）
```

## 3. `public/`にまとめる公開互換ファイル

次はGitHub PagesのURLそのものなので、`public/`直下の名前を維持します。

- 公開ページ: `index.html`、`analytics.html`、`chat.html`、`chat-admin.html`、`foodcourt*.html`、`media.html`、`message-search.html`、`petty_cash.html`、`reservation.html`、`reviews.html`、`room_settings.html`、`ai-usage.html`、`system-map.html`
- Journal Report: `public/jnm/`（`jnl2txt.html` / `index.html` / `ai-chat-pdf-history.html` ほか）
- 共通ブラウザコード: `pages-config.js`、`auth-session.js`、`app-theme.js`、`menu-logout.js`、`site-cache.js`
- PWA: `line-report.webmanifest`、チャット専用 `chat.webmanifest` / `chat-sw.js`
- Pages制御: `public/.nojekyll`

## 4. 端末ローカル状態

リポジトリ直下へDBやバックアップを増やさず、`.local/`へ集約します。

```text
.local/
├── sqlite/
│   ├── wine_price.db
│   ├── wine_price.db-shm
│   └── wine_price.db-wal
└── backups/
    ├── runtime/                   旧Expressアプリの自動バックアップ
    └── restore-work/              手動復旧用の作業資料
```

- `.local/`はGit・Graphify・Obsidianミラーの対象外です。
- 秘密値、顧客情報、メッセージ本文、レシート画像、実データSQLをGitへ追加しません。
- ローカルExpress/SQLiteの既定値は`.local/sqlite/wine_price.db`と`.local/backups/runtime`です。
- 旧配置の`wine_price.db*`または`backups/`が存在する場合は、互換性のため旧配置を優先します。移行後は`.local/`を使用します。

## 5. 新しいファイルの配置ルール

| 内容 | 配置先 |
|---|---|
| 新しい公開ページ | `public/`。既存URL要件を先に確認 |
| 共通フロント資産 | `public/icons/`、`public/vendor/`、または用途別の公開サブディレクトリ |
| Edge Function | `supabase/functions/<function>/` |
| DB変更 | `supabase/migrations/` |
| 自動テスト | `tests/` |
| 開発・運用コマンド | `scripts/` |
| 設計・運用文書 | `docs/` |
| 環境図の正本 | `knowledge/` |
| 一時ファイル・DB・復旧作業 | `.local/` |

## 6. 整理時の確認

```bash
npm run check
npm test
npm run knowledge:update
npm run knowledge:check
git diff --check
```

UIや公開資産を変更した場合は、`./scripts/local-line-report-pages.sh`で既存の`/line_report/*.html` URLを実画面確認します。

## 7. GitHub Pagesデプロイ

- ワークフロー: `.github/workflows/deploy-pages.yml`
- 配信元: `public/`
- 配信先URL: 従来どおり`https://marugo-s.github.io/line_report/`
- `public/`以外のソース、テスト、`.local/`、Graphify作業キャッシュはPagesへ含めません。
