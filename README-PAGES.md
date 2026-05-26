# GitHub Pages — 本番（line_report）

**編集・デプロイともにこのリポジトリ（`MARUGO-s/line_report`）が本体です。**

**2026年5月の機能追加・仕様変更のまとめ:** [CHANGELOG-2026-05.md](./CHANGELOG-2026-05.md)（レシート電話照合・シート同期マージ・LINE 売上分析 UI など）

> ### 🔓 [ルーム「連携」ガイド（必読）](./ROOM-LINKING-GUIDE.md) — **自動連携は承認なし（セキュリティ注意）**
> Webhook 受信でルームは **管理者確認なしで連携**されます。リスクと `RECEIPT_ROOM_AUTO_LINK=0` での無効化はガイド必読。
>
> ### [ルーム権限・画面の細かい仕様](./ROOM-PERMISSION-DETAIL-GUIDE.md)
> 優先順位（全体／店舗／個別）、カレンダー一括とルーム個別（連携2件以上）、**Bistro CAVACAVA** 表示名 など。

| 画面 | URL |
|------|-----|
| 管理画面 | https://marugo-s.github.io/line_report/index.html |
| 売上分析 | https://marugo-s.github.io/line_report/analytics.html |
| メディア | https://marugo-s.github.io/line_report/media.html |
| 予約表 | https://marugo-s.github.io/line_report/reservation.html |

- **Supabase（本番・管理/予約/Gmail）**: `https://hocbnifuactbvmyjraxy.supabase.co`
- **Supabase（旧・jhpm）**: `https://jhpmzqxqvapdkyvvhyra.supabase.co`（レガシー。Gmail シークレットは hocbn へ移行済み）
- **Supabase（Webhook 受信・新 DB）**: `https://hocbnifuactbvmyjraxy.supabase.co`
- **API 方針**:
  - 管理（index / media / reservation / Gmail 連携確認）: `/functions/v1/admin-api`（hocbn）
  - 売上分析（analytics）: `/functions/v1/admin-api`（hocbn・店舗別 `line_receipt__*` を集計）
  - LINE Webhook: `/functions/v1/line-webhook/{store_partition_key}`（店舗別・hocbn）
  - 店舗別テーブル: `line_webhook_raw__{key}`（生イベント）, `line_receipt__{key}`（レシート）
  - 設定の単一ソース: `pages-config.js`
  - Google スプレッドシート（売上シート）: **BISTRO CAVA CAVA のみ**（`RECEIPT_SHEETS_PILOT_ENABLED = true`、hocbn）
  - GAS の `SUPABASE_RECEIPT_SHEETS_SYNC_URL` は hocbn の `receipt-sheets-sync-cron` を指す
- **DB マイグレーション**: `supabase/migrations/20260523140000_store_partition_webhook_tables.sql`, `20260523150000_sales_budget_tables.sql`
- **Edge Functions（hocbn）**: `line-webhook`, `admin-api`（売上・予算・月次集計）
- **Edge Secrets（hocbn）**: `GROQ_API_KEY`, `LINE_CHANNEL_ACCESS_TOKEN`（または店舗別）, `LINE_CHANNEL_SECRET`（または店舗別）, `ADMIN_DASHBOARD_TOKEN`（analytics 認証）
- **LINE Developers 側の必須設定**:
  - Messaging API の `Allow bot to join group chats` を ON にする
  - 1 つのグループ / 複数人トークには **1 つの LINE Official Account しか参加できない**
- **hocbn への反映**:
  ```bash
  npx supabase link --project-ref hocbnifuactbvmyjraxy
  npx supabase db push
  npx supabase functions deploy line-webhook admin-api --project-ref hocbnifuactbvmyjraxy
  ```
- **ダミー売上・予算（テスト）**:
  - 投入: `./scripts/dummy-sales-seed.sh seed-all`（売上＋予算）
  - 削除: `./scripts/dummy-sales-seed.sh delete-all`
  - 売上識別: `raw_payload._seed_tag = line_report_dummy_sales_v1`
  - 予算識別: `store_closed_dates._seed_tag = line_report_dummy_budget_v1`
  店舗ごとの LINE 署名検証は Edge Secret `LINE_CHANNEL_SECRET__{STORE_KEY}`（例: `LINE_CHANNEL_SECRET__MARUGO`）または共通 `LINE_CHANNEL_SECRET`。
- **本番反映**: このリポジトリへ commit & push（GitHub Pages が自動配信）
- **ローカル確認**: `./scripts/local-line-report-pages.sh`

従来 URL `LINE-management` も並行稼働（同一 API・同一データ）。新規リンク・UI 改修は **line_report** を正とします。

## 予約表: キャンセル時の来店履歴カウント

- 対象 API: `/reservations/calendar`, `/reservations/search`
- 実装: `supabase/functions/admin-api/index.ts`
- 目的: 予約イベントの中にキャンセルが含まれる場合、予約表の `visit_count`（来店履歴 / 予約回数表示）を **-1** して見せる

### キャンセル判定

次のどれかに `キャンセル / 取消 / 取り消し / cancel / cancelled / canceled` が含まれると、そのイベントはキャンセル扱いにする。

- `reservation_type`
- `reservation_detail` の生テキスト
- `reservation_detail` が JSON の場合は次のキー
  - `status`
  - `reservationStatus`
  - `action`
  - `eventType`
  - `mailType`
  - `subject`
  - `title`
  - `summary`
  - `note`

### どの予約回数から引くか

- 顧客の紐付けキーは `customer_name + customer_phone`
- 同じ氏名かつ同じ電話番号のイベント履歴をまとめ、
  - 通常予約: `+1`
  - キャンセル: `-1`
 で `visit_count` を再計算する

### 注意

- これは **予約ID単位ではなく顧客単位** の減算
- 名前表記ゆれ、電話番号表記ゆれ、キャンセル表現の揺れがあると想定どおり減らないことがある
- ずれが出た場合は、該当メールの `reservation_type` / `reservation_detail` の実値に合わせて判定語を追加する
