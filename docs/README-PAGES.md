# GitHub Pages — 本番（line_report）

**編集・デプロイともにこのリポジトリ（`MARUGO-s/line_report`）が本体です。**

**2026年5月の機能追加・仕様変更のまとめ:** [CHANGELOG-2026-05.md](./CHANGELOG-2026-05.md)（レシート電話照合・シート同期マージ・LINE 売上分析 UI など）  
**全ドキュメント索引・用語集:** [DOCS-INDEX.md](./DOCS-INDEX.md)

> ### 🔓 [ルーム「連携」ガイド（必読）](./ROOM-LINKING-GUIDE.md) — **自動連携は承認なし（セキュリティ注意）**
> Webhook 受信でルームは **管理者確認なしで連携**されます。リスクと `RECEIPT_ROOM_AUTO_LINK=0` での無効化はガイド必読。
>
> ### [ルーム権限・画面の細かい仕様](./ROOM-PERMISSION-DETAIL-GUIDE.md)
> 優先順位（全体／店舗／個別）、カレンダー一括とルーム個別（連携2件以上）、**Bistro CAVACAVA** 表示名 など。
>
> ### [Gmail 予約 → LINE 通知・予約表](./RESERVATION-GMAIL-GUIDE.md)
> Gmail 連携（hocbn）、過去の予約日 **最大5件** の LINE 表示、DB テーブル、デプロイ・障害対応。
>
> ### [利用許可・ユーザー管理（セキュリティ強化）](./LINE-USER-APPROVAL-SECURITY.md)
> 新規友だち／新規ルームの **承認待ち**、管理 Bot（@392hdime）、許可時の **管理画面への表示名登録**。

| 画面 | URL |
|------|-----|
| 管理画面 | https://marugo-s.github.io/line_report/index.html |
| 売上分析 | https://marugo-s.github.io/line_report/analytics.html |
| メディア | https://marugo-s.github.io/line_report/media.html |
| 会話検索 | https://marugo-s.github.io/line_report/message-search.html |
| トーク | https://marugo-s.github.io/line_report/chat.html |
| M-talk使い方（店舗スタッフ） | https://marugo-s.github.io/line_report/mtalk-help.html |
| M-talk管理（本部・委任管理者） | https://marugo-s.github.io/line_report/chat-admin.html |
| 予約表 | https://marugo-s.github.io/line_report/reservation.html |
| システムマップ | https://marugo-s.github.io/line_report/system-map.html |

- **Supabase（本番・hocbn）**: `https://hocbnifuactbvmyjraxy.supabase.co` — 管理 API・Webhook・Gmail・DB は **すべてここ**
- **Supabase（旧・jhpm）**: `https://jhpmzqxqvapdkyvvhyra.supabase.co`（レガシー参照用。運用は hocbn のみ）
- **API 方針**:
  - 管理（index / media / reservation / Gmail 連携確認）: `/functions/v1/admin-api`（hocbn）
  - 売上分析（analytics）: `/functions/v1/admin-api`（hocbn・店舗別 `line_receipt__*` を集計）
  - LINE Webhook: `/functions/v1/line-webhook/{store_partition_key}`（店舗別・hocbn）
  - 店舗別テーブル: `line_webhook_raw__{key}`（生イベント）, `line_receipt__{key}`（レシート）
  - 設定の単一ソース: `public/pages-config.js`
  - Google スプレッドシート（売上シート）: **BISTRO CAVA CAVA のみ**（`RECEIPT_SHEETS_PILOT_ENABLED = true`、hocbn）
  - GAS の `SUPABASE_RECEIPT_SHEETS_SYNC_URL` は hocbn の `receipt-sheets-sync-cron` を指す
- **DB マイグレーション**: `20260523140000_store_partition_webhook_tables.sql`, `20260523150000_sales_budget_tables.sql`, `20260526220000_reservation_customer_visit_history.sql` など
- **Edge Functions（hocbn）**: `line-webhook`（店舗別）, **`line-admin-webhook`**（承認専用 @392hdime）, `admin-api`, **`gmail-alert-cron`**（予約メール → LINE）
- **Edge Secrets（hocbn）**: `GROQ_API_KEY`, `LINE_CHANNEL_*`, `ADMIN_DASHBOARD_TOKEN`, **`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` / `GMAIL_ALERT_ENABLED`**
- **LINE Developers 側の必須設定**:
  - Messaging API の `Allow bot to join group chats` を ON にする
  - 1 つのグループ / 複数人トークには **1 つの LINE Official Account しか参加できない**
- **hocbn への反映**:
  ```bash
  npx supabase link --project-ref hocbnifuactbvmyjraxy
  npx supabase db push
  npx supabase functions deploy line-webhook line-admin-webhook admin-api gmail-alert-cron --project-ref hocbnifuactbvmyjraxy
  ```
- **ダミー売上・予算（テスト）**:
  - 投入: `./scripts/dummy-sales-seed.sh seed-all`（売上＋予算）
  - 削除: `./scripts/dummy-sales-seed.sh delete-all`
  - 売上識別: `raw_payload._seed_tag = line_report_dummy_sales_v1`
  - 予算識別: `store_closed_dates._seed_tag = line_report_dummy_budget_v1`
  店舗ごとの LINE 署名検証は Edge Secret `LINE_CHANNEL_SECRET__{STORE_KEY}`（例: `LINE_CHANNEL_SECRET__MARUGO`）または共通 `LINE_CHANNEL_SECRET`。
- **本番反映**: `public/`を更新してcommit & push（GitHub ActionsがPagesへ自動配信）
- **ローカル確認**: `./scripts/local-line-report-pages.sh`

## トークのスマホ新着通知

- トーク画面のベルを押して通知を許可すると、新着メッセージをWeb Pushで受信する。
- iPhone／iPad: Safariの共有メニューから「ホーム画面に追加」→ ホーム画面の「トーク」を起動 → ベルを押す。
- Android／PC: トーク一覧のベルを押し、ブラウザの通知許可を承認する。
- 自分の送信は自分へ通知しない。通知を押すと対象トークを直接開く。
- Badging API対応のホーム画面アプリでは、全トークの未読合計をアイコンの数字で表示する。既読・通知OFF・ログアウト時に更新／解除する。
- スマホはsafe-areaとVisual Viewportへ追従し、ノッチ／Dynamic Island／角丸／ホームインジケータ、横向き、ソフトウェアキーボード表示を避ける。表示倍率は固定し、ピンチ拡大を抑止する。
- 通知設定がONのまま端末購読だけ切れた場合は、ホーム画面版M-talkの上部に「通知が切れたので、ここをタップして再開」と表示する。タップすると古い購読を破棄して再登録する。
- ベルが`🔔`になったら「通知テスト」で現在の端末だけへテスト通知を送れる。自分の通常投稿は自分へ通知されないため、端末設定の確認には通知テストを使う。
- ベルが`🚫`なら端末側で拒否されている。iPhone／iPadは「設定」→「通知」→「M-talk」で許可し、ホーム画面版M-talkへ戻って再開バーまたはベルを押す。
- 通知を止める場合はベルをもう一度押す。設定は同じユーザーの端末間で同期する。
- サーバー設定: Supabase Vaultの`chat_vapid_config`へ`public_key` / `private_key` / `subject`をJSON保存する（Edge Secretsに空きがある環境では`CHAT_VAPID_*`でも可）。本番hocbnはEdge Secretsが上限のためVaultを使用する。
- **AI/構成確認**:
  ```bash
  npm run knowledge:search -- "<依頼・症状・機能名>"
  npm run knowledge:check
  npm run knowledge:update
  ```
  `system-map.html`は管理セッションを確認してからコード/SQL構成と3層環境図を表示する。

従来 URL `LINE-management` も並行稼働（同一 API・同一データ）。新規リンク・UI 改修は **line_report** を正とします。

## LINE 予約通知: 過去の予約日（最大5件）

**詳細は [RESERVATION-GMAIL-GUIDE.md](./RESERVATION-GMAIL-GUIDE.md) を参照。**

- `gmail-alert-cron` が Gmail 予約メールを取り込み、**Gmail予約通知 ON** のルームへ LINE 送信
- テーブル `reservation_customer_visit_history` に来店ログを蓄積
- LINE の「予約回数」（食べログ）／「履歴」（一休）に **来店 N 回** と **過去の予約日（最大5件・日時付き）** を表示
- 管理画面の「Gmail連携先を確認」は **hocbn** の `GET /gmail/account`（管理トークンと同一プロジェクト）

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
