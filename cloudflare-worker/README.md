# line-wine-gateway (Cloudflare Worker)

Render本番APIの生存確認を行い、状態に応じて次を返します。

- 生存確認OK: Render本番URLへ `302` リダイレクト
- 生存確認NG: 休止中HTML (`503`) を表示
- 休止中ページの「稼働させる」押下: Worker経由で Render `resume` API を実行
- `POST /webhooks/line` 受信時: 稼働中はRenderへ中継、休止中は固定メッセージをLINE返信

## 1. 前提

- Cloudflareアカウント
- Node.js 18+

## 2. ローカル確認

```bash
cd cloudflare-worker
npm install
npm run dev
```

## 3. デプロイ

```bash
cd cloudflare-worker
npm install
npm run deploy
```

`wrangler.toml` の既定値:

- `APP_URL = "https://line-wine-api.onrender.com"`
- `HEALTH_URL = "https://line-wine-api.onrender.com/api/health"`
- `HEALTH_TIMEOUT_MS = "2500"`

追加で Dashboard > Worker > Settings > Variables へ以下を設定してください。

- `RENDER_API_KEY` (Secret)
- `RENDER_SERVICE_ID` (Plain text): `srv-d6mmfgvtskes73e082ag`
- `LINE_CHANNEL_ACCESS_TOKEN` (Secret): 休止中返信に必須
- `LINE_CHANNEL_SECRET` (Secret): 休止中返信時の署名検証に使用（推奨）
- `PAUSED_LINE_REPLY_TEXT` (Plain text, 任意): 休止中に返す文言

## 4. LINE休止中返信を有効化

LINE Developers の Webhook URL を Worker 側に向けます。

- `https://linewine.pingus0428.workers.dev/webhooks/line`

これで Render が休止中でも、Worker が
`PAUSED_LINE_REPLY_TEXT`（未設定時は「ただいまの時間はサーバーが休止中です。」）を返信します。

休止中にユーザーが `起動` / `再開` / `resume` と送ると、
Worker が Render 再開APIを呼び、結果をLINEに返信します。

稼働中にユーザーが `休止` / `停止` / `suspend` と送ると、
Worker が Render 休止APIを呼び、結果をLINEに返信します。

## 5. 休止中ページをカスタマイズ

Cloudflare Dashboard > Worker > Settings > Variables で
`MAINTENANCE_HTML` を追加すると、表示HTMLを差し替えできます。

## 6. Git連携で自動デプロイする場合

1. `cloudflare-worker` ディレクトリを別GitHubリポジトリにする（推奨）
2. Cloudflare Dashboard > Workers & Pages > Create > Import a repository
3. Build command は空欄、Deploy command は `npx wrangler deploy`
4. Environment variables に `APP_URL`, `HEALTH_URL` を設定

## 7. 注意

- このWorkerは「入口URL」です。LINE Webhook先を切り替える場合は挙動確認が必要です。
- 停止中のRender本体URLへ直接アクセスした場合、このWorkerは介在しません。
