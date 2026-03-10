# line-wine-gateway (Cloudflare Worker)

Render本番APIの生存確認を行い、状態に応じて次を返します。

- 生存確認OK: Render本番URLへ `302` リダイレクト
- 生存確認NG: 休止中HTML (`503`) を表示
- 休止中ページの「稼働させる」押下: Worker経由で Render `resume` API を実行

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
- `RESUME_KEY` (Secret): 休止ページで入力する管理キー

## 4. 休止中ページをカスタマイズ

Cloudflare Dashboard > Worker > Settings > Variables で
`MAINTENANCE_HTML` を追加すると、表示HTMLを差し替えできます。

## 5. Git連携で自動デプロイする場合

1. `cloudflare-worker` ディレクトリを別GitHubリポジトリにする（推奨）
2. Cloudflare Dashboard > Workers & Pages > Create > Import a repository
3. Build command は空欄、Deploy command は `npx wrangler deploy`
4. Environment variables に `APP_URL`, `HEALTH_URL` を設定

## 6. 注意

- このWorkerは「入口URL」です。LINE Webhook先を切り替える場合は挙動確認が必要です。
- 停止中のRender本体URLへ直接アクセスした場合、このWorkerは介在しません。
