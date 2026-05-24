# 変更履歴・新機能まとめ（2026年5月）

本ドキュメントは、`line_report` リポジトリに **2026年5月頃** に入った主な機能追加・仕様変更・運用手順を一覧にしたものです。  
実装の詳細は各ソースファイルを参照してください。

**関連ドキュメント**

| ファイル | 内容 |
|----------|------|
| [README-PAGES.md](./README-PAGES.md) | GitHub Pages URL・Supabase 本番・デプロイ手順 |
| [LINE-RECEIPT-ANALYSIS.md](./LINE-RECEIPT-ANALYSIS.md) | LINE レシート解析の全体像 |
| [pages-config.js](./pages-config.js) | 店舗キー・Webhook URL・表示名の単一ソース |

---

## 1. 概要

| 領域 | 変更の要約 |
|------|------------|
| LINE Webhook | 店名に加え **電話番号** でも同一店舗判定。OCR 店名の揺らぎ補正を強化 |
| 管理画面 | Webhook 別設定の整理、**レシート照合電話**の編集 API・UI |
| スプレッドシート | 双方向同期で **更新日時の新しい側を優先**。シート削除が DB に反映 |
| 売上分析 | LINE 経由は **1 店舗固定表示**・メディア/予約表/売上シート非表示 |
| DB | `store_webhook_tables.receipt_phones` 列追加 |
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
  &t={ADMIN_DASHBOARD_TOKEN}   # Secret 設定時のみ
```

| クエリ | 用途 |
|--------|------|
| `store_key` | 対象店舗（partition key） |
| `month` | 対象月（`YYYY-MM`） |
| `from=line` | LINE 経由であることを UI が判定 |
| `t` | 管理トークン（自動ログイン用・URL から除去後も `store_key` 等は残る） |

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
| `ADMIN_DASHBOARD_TOKEN` が hocbn Edge Secret に設定されている | URL の `?t=` で **自動保存** → 接続カード非表示 → データ読み込み |
| トークン未設定・URL に `t` なし | 「接続」で手動入力（従来どおり） |
| ログイン状態を保持（既定 ON） | localStorage に保持 → 次回も自動 |

※ Face ID / 指紋認証への置き換えは **未実装**（WebAuthn 等の別途開発が必要）。

---

## 6. 管理画面（`index.html`）その他

会話内で実施した主な UI / 運用まわり（詳細はコミット履歴参照）:

| 項目 | 内容 |
|------|------|
| Webhook別設定 | 店舗単位カード、連携ルーム `<details>` の開閉状態を自動更新で維持 |
| 同期 | サーバー `background_sync` を優先（GAS 6 分制限回避） |
| GAS メニュー | 「⚡ 全店舗を同期」「接続設定」のみに整理（不要メニュー削除） |

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

### 7.2 GAS のデプロイ

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
npx supabase functions deploy admin-api line-webhook receipt-sheets-sync-cron \
  --project-ref hocbnifuactbvmyjraxy
```

### 8.3 主なコミット（参考）

| コミット | 内容 |
|----------|------|
| `ba21e29` | 店名または電話番号でレシート照合 |
| `5354dba` | 管理画面のレシート電話編集・シート同期マージ・DB 列 |
| `0d259fe` | LINE 時に売上シートボタン非表示 |
| `3cf1f98` | LINE 時に店舗固定表示 |

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
| `supabase/functions/admin-api/index.ts` | REST ルーティング |
| `supabase/functions/line-webhook/index.ts` | レシート受信 |
| `supabase/functions/receipt-sheets-sync-cron/index.ts` | 同期 cron |
| `index.html` | 管理画面・Webhook・電話 UI |
| `analytics.html` | 売上分析・LINE 専用 UI |
| `pages-config.js` | 店舗一覧・`receipt_phones` マージ |
| `google-apps-script/receipt-sheets-pilot/Code.gs` | スプレッドシート onEdit |
| `scripts/clear-store-budget-data.mjs` | 店舗データ一括削除 |

---

*最終更新: 2026-05-25（会話・実装内容に基づく）*
