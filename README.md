# LINE-WINE Admin（レガシー）

> **本リポジトリの本番 LINE レポート（レシート・検索・管理画面）** は別系統です。  
> → [**README-PAGES.md**](./README-PAGES.md) ／ [**DOCS-INDEX.md**](./DOCS-INDEX.md)

---

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
WEB_SEARCH_ENABLED=false
WEB_SEARCH_TIMEOUT_MS=5000
WEB_SEARCH_MAX_RESULTS=3
WEB_SUMMARY_MAX_SOURCES=6
WEB_SEARCH_PROVIDER=auto
WEB_SEARCH_PRIORITY_DOMAINS=www.wine-searcher.com,www.vivino.com,www.cellartracker.com
WEB_SEARCH_QUERY_SUFFIX=wine
WEB_SEARCH_WIKIPEDIA_LANGS=en,ja
SERPAPI_API_KEY=
WEB_SEARCH_SERPAPI_ENGINE=google
WEB_SEARCH_SERPAPI_HL=ja
WEB_SEARCH_SERPAPI_GL=jp
WEB_SEARCH_SERPAPI_NUM=5
LLM_PROVIDER=auto
VISION_PROVIDER=groq
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash-lite
GEMINI_TIMEOUT_MS=5000
GEMINI_MAX_CANDIDATES=3
GEMINI_WINE_FLOW_ENABLED=true
GEMINI_WINE_ANALYSIS_MODEL=gemini-2.0-flash-lite
GEMINI_WINE_REPLY_MODEL=gemini-2.0-flash-lite
GEMINI_WINE_TIMEOUT_MS=12000
GROQ_API_KEY=
GROQ_MODEL=llama-3.1-8b-instant
GROQ_TIMEOUT_MS=5000
GROQ_MAX_CANDIDATES=3
GROQ_WINE_FLOW_ENABLED=true
GROQ_WINE_ANALYSIS_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
GROQ_WINE_REPLY_MODEL=llama-3.1-8b-instant
GROQ_WINE_TIMEOUT_MS=12000
USD_TO_JPY=150
EUR_TO_JPY=165
GEMINI_VISION_ENABLED=true
GEMINI_VISION_MODEL=gemini-2.0-flash-lite
GEMINI_VISION_TIMEOUT_MS=12000
GEMINI_VISION_MAX_CANDIDATES=3
GEMINI_VISION_MAX_IMAGE_BYTES=3500000
GROQ_VISION_ENABLED=true
GROQ_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
GROQ_VISION_TIMEOUT_MS=12000
GROQ_VISION_MAX_CANDIDATES=3
GROQ_VISION_MAX_IMAGE_BYTES=3500000

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

注: `line-wine-ocr` を Render Free で動かすと、OCR実行時にメモリ不足になる可能性があります。実運用は `Standard (2GB)` 以上を推奨します。

### DB未一致時のWeb検索フォールバック

`WEB_SEARCH_ENABLED=true` を設定すると、OCRでDB照合できなかった場合に Web 候補を返信します。

```env
WEB_SEARCH_ENABLED=true
WEB_SEARCH_TIMEOUT_MS=5000
WEB_SEARCH_MAX_RESULTS=3
WEB_SUMMARY_MAX_SOURCES=6
WEB_SEARCH_PROVIDER=auto
WEB_SEARCH_PRIORITY_DOMAINS=www.wine-searcher.com,www.vivino.com,www.cellartracker.com
WEB_SEARCH_QUERY_SUFFIX=wine
WEB_SEARCH_WIKIPEDIA_LANGS=en,ja
SERPAPI_API_KEY=<Renderの秘密環境変数>
WEB_SEARCH_SERPAPI_ENGINE=google
WEB_SEARCH_SERPAPI_HL=ja
WEB_SEARCH_SERPAPI_GL=jp
WEB_SEARCH_SERPAPI_NUM=5
LLM_PROVIDER=auto
VISION_PROVIDER=groq
GEMINI_API_KEY=<Renderの秘密環境変数>
GEMINI_MODEL=gemini-2.0-flash-lite
GEMINI_TIMEOUT_MS=5000
GEMINI_MAX_CANDIDATES=3
GEMINI_WINE_FLOW_ENABLED=true
GEMINI_WINE_ANALYSIS_MODEL=gemini-2.0-flash-lite
GEMINI_WINE_REPLY_MODEL=gemini-2.0-flash-lite
GEMINI_WINE_TIMEOUT_MS=12000
GROQ_API_KEY=<Renderの秘密環境変数>
GROQ_MODEL=llama-3.1-8b-instant
GROQ_TIMEOUT_MS=5000
GROQ_MAX_CANDIDATES=3
GROQ_WINE_FLOW_ENABLED=true
GROQ_WINE_ANALYSIS_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
GROQ_WINE_REPLY_MODEL=llama-3.1-8b-instant
GROQ_WINE_TIMEOUT_MS=12000
USD_TO_JPY=150
EUR_TO_JPY=165
GEMINI_VISION_ENABLED=true
GEMINI_VISION_MODEL=gemini-2.0-flash-lite
GEMINI_VISION_TIMEOUT_MS=12000
GEMINI_VISION_MAX_CANDIDATES=3
GEMINI_VISION_MAX_IMAGE_BYTES=3500000
GROQ_VISION_ENABLED=true
GROQ_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
GROQ_VISION_TIMEOUT_MS=12000
GROQ_VISION_MAX_CANDIDATES=3
GROQ_VISION_MAX_IMAGE_BYTES=3500000
```

- `WEB_SEARCH_PROVIDER=auto` の場合、`SERPAPI_API_KEY` が設定されていれば SerpAPI（Google検索）を優先し、未設定時は Wikipedia / DuckDuckGo を使います。
- `WEB_SEARCH_PRIORITY_DOMAINS` の既定値は `www.wine-searcher.com,www.vivino.com,www.cellartracker.com` です。まずこの3サイトを `site:` 指定で検索し、ヒット結果を統合して要約します。
- 3サイトでヒットしない場合のみ、通常のWeb検索（SerpAPI全体検索 / Wikipedia / DuckDuckGo）へフォールバックします。
- `WEB_SUMMARY_MAX_SOURCES` は要約時に参照するWebソース数です。市場価格/セパージュ/味わい/特徴/評価ポイント/受賞歴/飲み頃/ワイナリー歴史の抽出率を上げたい場合は `6-8` を推奨します。
- `WEB_SEARCH_PROVIDER=serpapi` で SerpAPI のみ、`WEB_SEARCH_PROVIDER=free` で無料ソースのみを使います。
- `LLM_PROVIDER=auto` では Gemini APIキーがあれば Gemini を優先し、未設定なら Groq を使います。固定する場合は `gemini` か `groq` を指定します（Web要約/解析のLLM）。
- `VISION_PROVIDER=groq` で、画像候補抽出（ラベル画像入力）は Groq を優先します。`auto` の場合は `groq -> gemini` の順で利用します。
- Gemini最小コスト運用は `GEMINI_MODEL=gemini-2.0-flash-lite` を推奨します。
- `GEMINI_API_KEY` を設定すると、OCR誤字補正・Web要約・LINE返信を Gemini で実行できます。
- `GROQ_API_KEY` を設定すると、OCR誤字を補正した候補名を先に生成してから Web 検索します。
- `GROQ_VISION_ENABLED=true` で、画像から Groq Vision 候補名を抽出して DB照合精度を上げます。
- `GROQ_WINE_FLOW_ENABLED=true` で、DB未一致時に「画像+Web根拠」から構造化JSONを作成し、LINE向けに再要約して返信します。
- `USD_TO_JPY` / `EUR_TO_JPY` で価格換算レートを固定指定できます（LINE返信の価格帯は常に日本円表示）。
- DB未一致時の返信は `1.このワインの正体 / 2.生産者・産地 / 3.生産者・ワイナリーの歴史 / 4.セパージュ / 5.味わい / 6.受賞・評価ポイント（年付き履歴） / 7.価格帯（円表示）` の順で返し、末尾に `参照ソース / 検索モード / 参照URL` を付与します。

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
- `POST /api/ocr/vision-url`
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
