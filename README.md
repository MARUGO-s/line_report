# LINE-WINE Admin

ワイン価格管理アプリ（Node.js + SQLite + LINE Webhook + OCR連携）の管理API/管理画面です。

## 1. ローカル起動

```bash
cd /Users/yoshito/Desktop/LINE-WINE
npm install
cp .env.example .env
npm run start
```

- 管理画面: `http://127.0.0.1:3200/admin/`
- ヘルス: `http://127.0.0.1:3200/api/health`
- LINE Webhook: `http://127.0.0.1:3200/webhooks/line`

## 2. 環境変数

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
OCR_EXTRA_FIELDS=
OCR_TIMEOUT_MS=12000

ADMIN_TOKEN=
BACKUP_DIR=./backups
BACKUP_RETENTION=30
```

- `ADMIN_TOKEN`: 設定すると `/api/*`（`/api/health` 以外）で管理認証が必須
- `BACKUP_DIR`: バックアップ `.db` の保存先
- `BACKUP_RETENTION`: 保持世代数（古いファイルは自動削除）

### OCR設定例（無料テスト向け）

`ocr.space` を使う場合:

```env
OCR_ENDPOINT=https://api.ocr.space/parse/image
OCR_REQUEST_FORMAT=multipart
OCR_IMAGE_FIELD=file
OCR_EXTRA_FIELDS=apikey=helloworld&language=jpn&isOverlayRequired=false&OCREngine=1
```

本番利用では `helloworld` ではなく、正式APIキーへ置き換えてください。

### 国会図書館OCR-Liteを使う場合（推奨）

NDLOCR-Lite は公式にHTTP APIを提供していないため、このリポジトリ内の `ocr-bridge` でAPI化して利用します。

- 詳細手順: `ocr-bridge/README.md`

`line-wine-api` 側の設定例:

```env
OCR_ENDPOINT=https://<your-ocr-bridge>.onrender.com/ocr
OCR_AUTH_TOKEN=<OCR_BRIDGE_TOKEN>
OCR_REQUEST_FORMAT=multipart
OCR_IMAGE_FIELD=image
OCR_EXTRA_FIELDS=
OCR_TIMEOUT_MS=60000
```

注: `line-wine-ocr` を Render Free で動かすと、OCR実行時にメモリ不足になる可能性があります。実運用は `Starter` 以上を推奨します。

## 3. 管理認証

- 管理画面の「管理認証」で `ADMIN_TOKEN` を保存すると、以降のAPI呼び出しに `x-admin-token` ヘッダーが付きます。
- APIを直接叩く場合は以下のどちらかを指定します。
  - `x-admin-token: <ADMIN_TOKEN>`
  - `Authorization: Bearer <ADMIN_TOKEN>`

## 4. バックアップ

- `GET /api/admin/backups`: バックアップ一覧
- `POST /api/admin/backup`: 手動バックアップ作成

例:

```bash
curl -sS -X POST 'http://127.0.0.1:3200/api/admin/backup' \
  -H 'Content-Type: application/json' \
  -H 'x-admin-token: <ADMIN_TOKEN>' \
  -d '{"reason":"manual"}'
```

## 5. 主なAPI

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

## 6. 実運用チェックリスト

1. `ADMIN_TOKEN` を必ず設定
2. HTTPSで公開（LINE Webhook URLもHTTPS必須）
3. `npm run start` を `pm2` / `systemd` などで常駐化
4. `/api/health` の死活監視を設定
5. 定期バックアップ（例: cronで `POST /api/admin/backup` を1日1回）
6. `backups/` を別ストレージへ二次保管
7. LINE DevelopersでWebhook URLを本番URLに設定
8. NDLOCR-Lite を使う場合は `ocr-bridge` の `/health` と `/ocr` も監視

## 7. 備考

- 価格登録は `price_history` に追記され、`current_prices` が自動更新されます。
- 同一CSV（同一ハッシュ）の再投入は `409 Conflict` で拒否されます。
- 店舗ごとのCSV列マッピングは `store_csv_mappings` に保存されます。
