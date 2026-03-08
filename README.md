# Wine Price Admin (Company-terms-main-5)

このフォルダは、ワイン価格管理DB (`wine_price.db`) を操作する管理画面/APIです。  
LINE Webhookにも対応しています。

## 含まれるもの

- `wine_price.db`: SQLite本体
- `schema.sql`: DBスキーマ
- `src/server.js`: Express API + LINE Webhook
- `src/db.js`: DBアクセス層
- `public/`: 管理画面 (`/admin`)

## セットアップ

```bash
cd /Users/yoshito/Downloads/Company-terms-main-5
npm install
cp .env.example .env
npm run start
```

デフォルトURL:

- 管理画面: `http://127.0.0.1:3200/admin/`
- ヘルス: `http://127.0.0.1:3200/api/health`
- LINE Webhook: `http://127.0.0.1:3200/webhooks/line`

## 環境変数

```env
PORT=3200
HOST=127.0.0.1
DB_PATH=./wine_price.db
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=
OCR_ENDPOINT=
OCR_AUTH_TOKEN=
OCR_REQUEST_FORMAT=json_base64
OCR_BASE64_FIELD=imageBase64
OCR_IMAGE_FIELD=image
OCR_TIMEOUT_MS=12000
```

- `LINE_CHANNEL_SECRET`: LINE署名検証に使用
- `LINE_CHANNEL_ACCESS_TOKEN`: LINE返信・画像取得に使用
- `OCR_ENDPOINT`: 任意。画像OCR APIエンドポイント
- `OCR_AUTH_TOKEN`: 任意。OCR APIへのBearerトークン
- `OCR_REQUEST_FORMAT`: `json_base64` または `multipart`
- `OCR_BASE64_FIELD`: `json_base64` 時の画像Base64フィールド名
- `OCR_IMAGE_FIELD`: `multipart` 時の画像フィールド名
- `OCR_TIMEOUT_MS`: OCR APIタイムアウト（ms）

## 主なAPI

- `GET /api/stores`
- `POST /api/stores`
- `GET /api/products`
- `POST /api/products`
- `GET /api/prices/current`
- `GET /api/prices/history`
- `POST /api/prices`
- `GET /api/ingestion/files`
- `GET /api/ingestion/files/:id/errors`
- `GET /api/ingestion/template`
- `GET /api/ingestion/mappings`
- `GET /api/ingestion/mappings/:storeId`
- `POST /api/ingestion/mappings`
- `POST /api/ingestion/csv`
- `GET /api/reply-templates`
- `POST /api/reply-templates`
- `POST /api/ocr/resolve`
- `POST /api/line/simulate`
- `POST /webhooks/line`

## LINE連携の動作

- テキスト: `価格 シャブリ` のように送ると `current_prices` から返信
- 画像: 受信イベントを `ocr_results` に記録。`OCR_ENDPOINT` が設定されていればOCR実行し、抽出テキストから価格照合を試行
- 受信イベントは `line_events` に保存（重複イベントは無視）

## CSV取り込み

- 管理画面の「CSV取り込み」から実行可能
- テンプレートは `GET /api/ingestion/template` から取得可能
- 取り込み結果は `ingestion_files`、行エラーは `ingestion_errors` に保存
- 正常行のみ `price_history` / `current_prices` に反映
- 同一CSV（同一ハッシュ）は重複投入を拒否（`409 Conflict`）
- 店舗ごとに `store_csv_mappings` でヘッダーマッピングを保存可能

対応列（列名ゆれを吸収）:

- 商品: `product_id` / `sku` / `product_name`（`商品名`, `ワイン名`）
- 店舗: `store_id` / `store_code` / `store_name`（画面の店舗IDをデフォルトにも指定可）
- 価格: `price`（`価格`）
- 適用日: `effective_date`（`適用日`, `日付`）
- 任意: `currency`

## 備考

- 価格登録は `price_history` に追記され、`current_prices` が自動更新されます。
- LINE Webhookをローカルで使う場合はトンネリング（例: ngrok, Cloudflare Tunnel）で公開URLを作成してください。
