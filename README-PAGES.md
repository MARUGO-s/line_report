# GitHub Pages — 本番（line_report）

**編集・デプロイともにこのリポジトリ（`MARUGO-s/line_report`）が本体です。**

| 画面 | URL |
|------|-----|
| 管理画面 | https://marugo-s.github.io/line_report/index.html |
| 売上分析 | https://marugo-s.github.io/line_report/analytics.html |
| メディア | https://marugo-s.github.io/line_report/media.html |
| 予約表 | https://marugo-s.github.io/line_report/reservation.html |

- **Supabase（本番・管理/分析 API）**: `https://jhpmzqxqvapdkyvvhyra.supabase.co`
- **Supabase（Webhook 受信・新 DB）**: `https://hocbnifuactbvmyjraxy.supabase.co`
- **API 方針**:
  - 管理（index / media / reservation）: `/functions/v1/admin-api`（jhpm）
  - 売上分析（analytics）: `/functions/v1/admin-api`（hocbn・店舗別 `line_receipt__*` を集計）
  - LINE Webhook: `/functions/v1/line-webhook/{store_partition_key}`（店舗別・hocbn）
  - 店舗別テーブル: `line_webhook_raw__{key}`（生イベント）, `line_receipt__{key}`（レシート）
  - 設定の単一ソース: `pages-config.js`
- **DB マイグレーション**: `supabase/migrations/20260523140000_store_partition_webhook_tables.sql`, `20260523150000_sales_budget_tables.sql`
- **Edge Functions（hocbn）**: `line-webhook`, `admin-api`（売上・予算・月次集計）
- **Edge Secrets（hocbn）**: `GROQ_API_KEY`, `LINE_CHANNEL_ACCESS_TOKEN`（または店舗別）, `LINE_CHANNEL_SECRET`（または店舗別）, `ADMIN_DASHBOARD_TOKEN`（analytics 認証）
- **hocbn への反映**:
  ```bash
  npx supabase link --project-ref hocbnifuactbvmyjraxy
  npx supabase db push
  npx supabase functions deploy line-webhook admin-api --project-ref hocbnifuactbvmyjraxy
  ```
- **ダミー売上（テスト）**: `./scripts/dummy-sales-seed.sh seed` で全店舗に過去3年分を投入。削除は `./scripts/dummy-sales-seed.sh delete`（識別子 `raw_payload._seed_tag = line_report_dummy_sales_v1`）
  店舗ごとの LINE 署名検証は Edge Secret `LINE_CHANNEL_SECRET__{STORE_KEY}`（例: `LINE_CHANNEL_SECRET__MARUGO`）または共通 `LINE_CHANNEL_SECRET`。
- **本番反映**: このリポジトリへ commit & push（GitHub Pages が自動配信）
- **ローカル確認**: `./scripts/local-line-report-pages.sh`

従来 URL `LINE-management` も並行稼働（同一 API・同一データ）。新規リンク・UI 改修は **line_report** を正とします。
