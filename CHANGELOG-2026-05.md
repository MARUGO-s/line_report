# 変更履歴・新機能まとめ（2026年5月）

本ドキュメントは、`line_report` リポジトリに **2026年5月頃** に入った主な機能追加・仕様変更・運用手順を一覧にしたものです。  
実装の詳細は各ソースファイルを参照してください。

**関連ドキュメント**

| ファイル | 内容 |
|----------|------|
| [README-PAGES.md](./README-PAGES.md) | GitHub Pages URL・Supabase 本番・デプロイ手順 |
| [RESERVATION-GMAIL-GUIDE.md](./RESERVATION-GMAIL-GUIDE.md) | Gmail 予約 → LINE 通知・予約表・DB・障害対応 |
| [ROOM-LINKING-GUIDE.md](./ROOM-LINKING-GUIDE.md) | ルーム自動連携・セキュリティ |
| [ROOM-PERMISSION-DETAIL-GUIDE.md](./ROOM-PERMISSION-DETAIL-GUIDE.md) | ルーム権限・カレンダー／Gmail 設定 |
| [LINE-RECEIPT-ANALYSIS.md](./LINE-RECEIPT-ANALYSIS.md) | LINE レシート解析の全体像 |
| [pages-config.js](./pages-config.js) | 店舗キー・Webhook URL・表示名の単一ソース |

---

## 1. 概要

| 領域 | 変更の要約 |
|------|------------|
| LINE Webhook | 店名に加え **電話番号** でも同一店舗判定。OCR 店名の揺らぎ補正を強化 |
| 管理画面 | Webhook 別設定の整理、**レシート照合電話**の編集 API・UI |
| Gmail 予約 | **hocbn** に Gmail API 統一。LINE 通知に **過去の予約日最大5件** |
| スプレッドシート | 双方向同期で **更新日時の新しい側を優先**。シート削除が DB に反映 |
| 売上分析 | LINE 経由は **1 店舗固定表示**・メディア/予約表/売上シート非表示 |
| セキュリティ | **`?t=` 廃止・`lt` ログイン・LINE セッション 3 日保持・`/auth/logout`・CSP** |
| DB | `store_webhook_tables.receipt_phones`、`reservation_customer_visit_history` など |
| 会話検索 | ルーム別テーブル＋横断インデックス（**1年保持**）。**常時記録**し、検索は `message_search_enabled` ON のルームのみ |
| LINE検索案内 | 「検索」等で Flex メニュー → 会話／予定／メディア／売上（`20260521`）の多段階検索（`line_search_bot.ts`） |
| GAS | タブ先頭行に同期用ウォーターマーク、日次タブの更新日時 |

**本番 Supabase プロジェクト:** `hocbnifuactbvmyjraxy`（hocbn）  
**GitHub Pages:** https://marugo-s.github.io/line_report/

---

## 2. レシート店舗照合（店名・電話）

### 2.1 店名の揺らぎ補正

レシート OCR の店名が Webhook 登録名とずれても、次のいずれかで **同一店舗** とみなして登録できます。

- 表示名・partition key の部分一致・正規化比較
- ブランド別名（例: `BISTRO CAVA CAVA` ↔ ビストロ サヴァサヴァ、`マルコ四谷` ↔ マルゴ 四谷）
- partition key による名寄せ（`receipt_store_name_resolve.ts`）

**不一致時**は登録せず、正しい店舗 Webhook への送り直しを案内（従来どおり）。

### 2.2 電話番号照合（新規）

レシートに印字された **TEL** を Groq 解析で `store_phone` として取得し、登録店舗の電話と照合します。

| ルール | 内容 |
|--------|------|
| 一致条件 | **店名 OR 電話** のどちらかが一致すれば登録 |
| 電話の保存 | 主: `store_webhook_tables.receipt_phones`（管理画面から編集） |
| フォールバック | コード内 `STORE_RECEIPT_PHONES`（未移行店舗・初期シード用） |

初期シード例（マイグレーション）:

- `marugoyotsuya` … `0353616205`
- `bistrocavacava` … `0364574938`

**実装ファイル**

- `supabase/functions/_shared/store_receipt_phones.ts`
- `supabase/functions/_shared/receipt_store_name_match.ts`
- `supabase/functions/line-webhook/index.ts`

---

## 3. 管理画面：レシート照合電話の編集

### 3.1 DB

マイグレーション: `supabase/migrations/20260525100000_store_receipt_phones.sql`

```sql
store_webhook_tables.receipt_phones  -- text[]、数字のみで保存
```

### 3.2 API

| メソッド | パス | 説明 |
|----------|------|------|
| GET | `/state` 内 `receipt_store_options` | 各店舗に `receipt_phones` 配列を含む |
| PUT | `/receipts/store-receipt-phones` | 店舗別電話の一括更新 |

リクエスト例:

```json
{
  "store_key": "marugoyotsuya",
  "receipt_phones": "03-5361-6205"
}
```

（改行・カンマ区切りの文字列、または配列どちらも可）

### 3.3 UI（`index.html`）

**Webhook別設定** の各店舗カードに **「レシート照合電話」** セクションを追加。

- 1 行 1 件、またはカンマ区切りで入力
- **電話番号を保存** → API 経由で DB 更新
- 保存後、次のレシート画像から `line-webhook` が DB の番号を参照

---

## 4. スプレッドシート連携（双方向同期）

### 4.1 同期の流れ（`both`）

1. **pull** … シート → DB（月間予算・過去売上の手入力）
2. **push** … DB → シート（日次売上・過去売上・予算の書き出し）

### 4.2 更新日時によるマージ（重要）

| 方向 | ルール |
|------|--------|
| **pull**（`both`） | シートの **更新日時列** と DB の `updated_at` を比較。**新しい方を優先** |
| **pull**（`both`） | シートに **存在しない月** は、シート側の方が新しければ **DB から削除** |
| **pull**（`pull` のみ） | シートにない月は **常に DB から削除**（シート優先） |
| **push**（`both`） | シートにない月は、DB が新しいときだけシートへ復元。シート削除直後は復活しない |

### 4.3 タブごとのウォーターマーク（GAS）

`Code.gs` の `onEdit` で、予算・過去売上・**日次売上**タブを編集すると:

- 変更した行の **更新日時列**（Q / I / J 列など）を更新
- **1 行目の同列** にも ISO 時刻を書き込み（行をまとめて削除したあとも「シート側が新しい」と判定）

### 4.4 店舗タブのクリア API

`receipt-sheets-sync-cron` に `clear_store_budget_tabs` を追加。

```json
POST /functions/v1/receipt-sheets-sync-cron
{
  "clear_store_budget_tabs": true,
  "store_partition_key": "marugoyotsuya",
  "skip_push": true
}
```

- `{店舗}_月間予算` / `{店舗}_過去売上` / `{店舗}_日次売上` のデータ行をクリア
- 1 行目にウォーターマークを記録
- `skip_push: true` ならレシート集計の push は行わない（空のまま維持）

### 4.5 日次売上タブと DB の関係

| データ | 保存先 |
|--------|--------|
| 月間予算 | `line_sales_month_budgets` |
| 過去売上（手入力） | `line_sales_manual_month_gross` |
| **日次売上タブ** | **専用テーブルなし**（`line_receipt__{店舗}` から push 時に組み立て） |

そのため、日次タブを空にしても **レシート行が DB に残っていると** push で再表示される。日次も含めて空にしたい場合はレシート削除が必要（下記スクリプト参照）。

**実装ファイル**

- `supabase/functions/_shared/receipt_sheets_pilot_sync.ts`
- `supabase/functions/_shared/clear_store_sheet_budget_tabs.ts`
- `google-apps-script/receipt-sheets-pilot/Code.gs`

---

## 5. 売上分析（`analytics.html`）— LINE 専用表示

### 5.1 LINE「売上推移を見る」の URL

`receipt_line_actions.ts` が生成する URL 例:

```
https://marugo-s.github.io/line_report/analytics.html
  ?store_key=marugoyotsuya
  &month=2025-05
  &from=line
  &lt={ONE_TIME_LOGIN_TOKEN}
```

| クエリ | 用途 |
|--------|------|
| `store_key` | 対象店舗（partition key） |
| `month` | 対象月（`YYYY-MM`） |
| `from=line` | LINE 経由であることを UI が判定 |
| `lt` | 短命のワンタイムログインチケット（交換後に URL から除去） |

### 5.2 LINE 経由で非表示にするもの

`from=line` または LINE アプリ内ブラウザ（User-Agent に `Line`）のとき:

| 要素 | 動作 |
|------|------|
| 管理画面リンク | 非表示 |
| メディア閲覧 | 非表示 |
| 予約表 | 非表示 |
| 売上シート（ヘッダー・絞り込み内） | 非表示（読み込み後も再表示しない） |

### 5.3 店舗の固定（新規）

LINE 経由かつ URL に `store_key` がある場合:

- **「店舗を選択してください」は出さない**
- 店舗名ラベル（例: **マルゴ 四谷**）のみ表示
- 店舗プルダウンは非表示・**他店舗は選択不可**
- `month` があれば対象月に自動設定

通常（管理画面から開く等）は **従来どおり全店舗を選択可能**。

### 5.4 ログイン（自動）

| 条件 | 動作 |
|------|------|
| URL に `lt` がある | `/auth/link-login` で **session token（`lrst_`）に交換** → URL から `lt` を除去 → 接続カード非表示 |
| すでに有効な `lrst_` がある | `lt` が使い済みでもエラーにせず、そのまま利用（同じ LINE メッセージの再タップ向け） |
| `lt` が無い・期限切れ | 「接続」で固定トークンを手動入力（従来どおり） |
| **LINE 経由**（`from=line` または LINE アプリ内ブラウザ） | 交換した `lrst_` を **`localStorage`（`line_summary_admin_session__line`）にも保存**。次回 LINE から開いても再入力不要になりやすい |
| **管理画面・通常ブラウザ** | **`sessionStorage` のみ**（タブを閉じるとログアウト） |

※ 旧 `?t=` 直ログインは **無効化**。URL に付いていても保存せず除去のみ行う。

**サーバー側セッション有効期限（`admin_dashboard_link_auth.ts`）**

| 種別 | 有効期限 |
|------|----------|
| LINE 経由で交換（`remember_login: true`） | **3 日** |
| 通常タブ（`remember_login: false`） | **12 時間** |
| URL の `lt`（ログインリンク） | **30 日**（再タップ・古いメッセージからの再開用。交換後は `used_at` が付くが、有効な `lrst_` があれば再交換不要） |

### 5.5 セキュリティ強化（2026-05-25 追記）

この回で、管理画面まわりの認証と公開ページ配信を次のように強化した。

| 項目 | 変更内容 |
|------|----------|
| 自動ログイン | 生の `ADMIN_DASHBOARD_TOKEN` を URL に載せる方式を廃止し、`lt` ワンタイムチケット方式へ統一 |
| トークン保存 | `auth-session.js` の保存先を **localStorage から sessionStorage に変更**。旧 persistent token は初回読込時に移して削除 |
| API キャッシュ | `site-cache.js` の保存先も **sessionStorage** に変更。旧 localStorage キャッシュは削除 |
| セッション失効 | `admin-api` に `POST /auth/logout` を追加。ログアウト時に **サーバー側 session token を revoke** |
| トークンローテーション | `PUT /auth/token` 実行時、既存の login link / session token を **全 revoke** |
| 固定トークン fallback | DB に `admin_dashboard_token_hash` がある場合、Edge Secret fallback では通らないように変更 |
| 公開ページ保護 | `index.html` / `analytics.html` / `media.html` / `reservation.html` に **meta CSP** と frame-busting を追加 |
| 外部 JS | `analytics.html` の `Chart.js` を CDN 直読みから **`vendor/chart.umd.min.js` のローカル配信**へ変更 |

補足:

- 固定トークンの手入力ログインは残しているが、**このタブだけ有効**で永続保持しない（生トークンは `localStorage` に保存しない）。
- `GitHub Pages` はレスポンスヘッダで `CSP` や `X-Frame-Options` を返せないため、現状は **meta CSP + frame-busting** で補っている。

### 5.6 LINE 再ログイン問題の修正（2026-05-23 追記）

LINE アプリ内ブラウザは **`sessionStorage` が閉じるたびに消える**ため、セキュリティ強化後に「売上推移を見る」のたびに管理トークン入力が必要になっていた。

| 対応 | 内容 |
|------|------|
| `auth-session.js` | LINE 経由の `lt` 交換時に `remember_login: true` を送り、返却 `lrst_` を **LINE 専用 `localStorage` キー**にも保存 |
| 再タップ | 有効な `lrst_` があるときは `lt` の再交換をスキップ |
| `admin_dashboard_link_auth.ts` | LINE セッション（remember）の TTL を **3 日**に設定（`SESSION_TTL_REMEMBER_SEC`） |

**デプロイ:** `auth-session.js` は GitHub Pages、`admin-api` / `line-webhook` は Edge Functions の再デプロイが必要。

---

## 6. 管理画面（`index.html`）その他

会話内で実施した主な UI / 運用まわり（詳細はコミット履歴参照）:

| 項目 | 内容 |
|------|------|
| Webhook別設定 | 店舗単位カード、連携ルーム `<details>` の開閉状態を自動更新で維持 |
| 同期 | サーバー `background_sync` を優先（GAS 6 分制限回避） |
| GAS メニュー | 「⚡ 全店舗を同期」「接続設定」のみに整理（不要メニュー削除） |
| 接続 UI | 「同じアドレスなら自動ログイン」チェックを **非表示**（全画面） |
| Gmail 確認 | `GET /gmail/account` を **hocbn** で呼ぶ（`pages-config.js`） |

---

## 6b. Gmail 予約 → LINE 通知（過去5件）

**詳細: [RESERVATION-GMAIL-GUIDE.md](./RESERVATION-GMAIL-GUIDE.md)**

| 項目 | 内容 |
|------|------|
| Edge Function | `gmail-alert-cron`（リポジトリに同梱、hocbn へデプロイ） |
| 新テーブル | `reservation_customer_visit_history` |
| RPC 戻り値 | `record_tabelog_reservation_visit` / `record_ikyu_reservation_visit` → `{ visit_count, recent_visits[] }` |
| LINE 表示 | `来店N回` + `過去の予約日:` + 最大5行（今回メール分を除く） |
| マイグレーション | `20260526220000_reservation_customer_visit_history.sql` |
| シークレット移行 | `scripts/sync-gmail-secrets-jhpm-to-hocbn.mjs`（jhpm → hocbn） |

ルーム側: **カレンダー／予約** タブの「Gmail予約通知」が ON のルームのみ送信先。

---

## 7. 運用スクリプト

### 7.1 店舗の予算・レシート・シートを一括削除

```bash
HOCBN_SERVICE_ROLE_KEY=... node scripts/clear-store-budget-data.mjs marugoyotsuya
```

| 削除対象 | 説明 |
|----------|------|
| `line_sales_month_budgets` | 月間予算（`weather:{店舗}` 含む） |
| `line_sales_month_store_closed_days` | 休業日 |
| `line_sales_manual_month_gross` | 過去売上（手入力） |
| `receipt_sheets_past_sales_export_snapshot` | シート同期スナップショット |
| `line_receipt__{店舗}` | レシート本体（**日次売上の元**） |
| `line_webhook_raw__{店舗}` | Webhook 生ログ |
| pending 3 テーブル | 重複・修正・店名不一致の保留 |

レシートだけ残す場合:

```bash
node scripts/clear-store-budget-data.mjs marugoyotsuya --keep-receipts
```

### 7.2 Gmail シークレットを jhpm から hocbn へコピー

```bash
SECRET_BRIDGE_TOKEN=... node scripts/sync-gmail-secrets-jhpm-to-hocbn.mjs
```

前提: jhpm に `secret-bridge` をデプロイし、`SECRET_BRIDGE_TOKEN` / `HOCBN_SERVICE_ROLE_KEY` を設定済みであること。

### 7.3 指定店舗以外の売上データ削除（要注意）

```bash
HOCBN_SERVICE_ROLE_KEY=... node scripts/purge-sales-except-allowed-stores.mjs
# 事前確認: --dry-run
```

保持店舗: `bistrocavacava`, `marugoS`, `marugoyotsuya`, `sushikoruri`

### 7.4 GAS のデプロイ

```bash
cd google-apps-script/receipt-sheets-pilot
clasp push
```

スプレッドシート ID: `1ykltznAplFvOsj_DCXPXla_6z_PrCxTthROlsUrr7Rs`  
スクリプト ID: `.clasp.json` 参照

---

## 8. デプロイ手順（本番）

### 8.1 GitHub Pages（静的 UI）

```bash
git add .
git commit -m "説明"
git push origin main
```

反映対象: `index.html`, `analytics.html`, `pages-config.js`, `auth-session.js` など

### 8.2 Supabase Edge Functions（hocbn）

```bash
npx supabase link --project-ref hocbnifuactbvmyjraxy
npx supabase db push   # 未適用マイグレーションがある場合
npx supabase functions deploy admin-api line-webhook gmail-alert-cron receipt-sheets-sync-cron \
  --project-ref hocbnifuactbvmyjraxy
```

### 8.3 主なコミット（参考）

| コミット | 内容 |
|----------|------|
| `ba21e29` | 店名または電話番号でレシート照合 |
| `5354dba` | 管理画面のレシート電話編集・シート同期マージ・DB 列 |
| `0d259fe` | LINE 時に売上シートボタン非表示 |
| `3cf1f98` | LINE 時に店舗固定表示 |
| `de55cdc` | LINE 自動ログインを短命ログインチケット方式へ変更 |
| `59ad7b1` | `?t=` 廃止、sessionStorage 化、`/auth/logout`、CSP、ローカル Chart.js |
| `e1e23e2` | LINE ログインリンクの再タップ対応（有効 `lrst_` 時は `lt` 再交換をスキップ） |
| （本番反映） | LINE セッション **3 日**保持・`auth-session.js` の LINE `localStorage` 保存 |

---

## 9. よくある質問

### Q. スプレッドシートを空にして双方向同期したのに DB のデータが戻った

**A.** 旧仕様では push が DB 全件をシートに書き戻していました。2026-05 以降は **更新日時マージ＋シートにない月の DB 削除** に対応済みです。  
それでも日次売上は **レシートテーブル** 由来のため、レシートが残っていると push で再表示されます。

### Q. シートに去年の予算・過去売上を入力して both すると DB に入るか

**A.** はい。DB が空でも pull で `line_sales_month_budgets` / `line_sales_manual_month_gross` に挿入されます（有効列・正の予算・店舗キー一致が必要）。

### Q. LINE から開いたのに店舗を選べる

**A.** `from=line` または `store_key` が URL に無い、または Pages の `analytics.html` が未更新の可能性があります。最新 `main` を push 済みか、ハードリロードを確認してください。

### Q. 電話番号を管理画面で変えたらすぐ効くか

**A.** はい。次のレシート画像から `line-webhook` が DB の `receipt_phones` を読みます。コード内フォールバックは DB が空のときのみ使われます。

### Q. LINE から開くたびに管理トークンを入れないといけない

**A.** 2026-05-23 以降は、LINE 経由で一度 `lt` からログインできれば **`lrst_` を端末に最大 3 日保持**します。次を確認してください。

1. GitHub Pages の `auth-session.js` が最新か（ハードリロード）
2. `admin-api` / `line-webhook` が再デプロイ済みか（`lt` 発行・3 日セッション）
3. **新しい日報メッセージ**の「売上推移を見る」から開いているか（古い `?t=` 付きリンクは無効）
4. 3 日経過・ログアウト・別端末の場合は、新しい日報リンクから再度開く

---

## 10. 変更ファイル一覧（主要）

| パス | 役割 |
|------|------|
| `supabase/migrations/20260525100000_store_receipt_phones.sql` | 電話番号列 |
| `supabase/functions/_shared/store_receipt_phones.ts` | 電話正規化・照合 |
| `supabase/functions/_shared/receipt_store_name_match.ts` | 店名＋電話の一致判定 |
| `supabase/functions/_shared/receipt_store_name_resolve.ts` | OCR 店名の別名・名寄せ |
| `supabase/functions/_shared/receipt_sheets_pilot_sync.ts` | シート同期・更新日時マージ |
| `supabase/functions/_shared/clear_store_sheet_budget_tabs.ts` | 店舗タブクリア |
| `supabase/functions/_shared/admin_receipt_sales.ts` | 予算 API・電話 PUT |
| `supabase/functions/_shared/receipt_line_actions.ts` | 売上分析 URL 生成 |
| `supabase/functions/_shared/admin_dashboard_link_auth.ts` | `lt` / `lrst_` 発行・TTL（LINE セッション 3 日） |
| `auth-session.js` | ログイン保持・LINE `localStorage`・`lt` 交換 |
| `supabase/functions/admin-api/index.ts` | REST ルーティング |
| `supabase/functions/line-webhook/index.ts` | レシート受信 |
| `supabase/functions/receipt-sheets-sync-cron/index.ts` | 同期 cron |
| `index.html` | 管理画面・Webhook・電話 UI |
| `analytics.html` | 売上分析・LINE 専用 UI |
| `pages-config.js` | 店舗一覧・`receipt_phones` マージ |
| `google-apps-script/receipt-sheets-pilot/Code.gs` | スプレッドシート onEdit |
| `scripts/clear-store-budget-data.mjs` | 店舗データ一括削除 |

---

*最終更新: 2026-05-23（LINE セッション 3 日・ドキュメント追記）*
