# NDLOCR-Lite Bridge

`line-wine-api` から利用するために、[NDLOCR-Lite](https://github.com/ndl-lab/ndlocr-lite) を HTTP API 化する小さなサービスです。

## 1. エンドポイント

- `GET /health`
- `POST /ocr` (`multipart/form-data` で `image` フィールドに画像を送信)

レスポンス例:

```json
{
  "text": "...OCR抽出テキスト...",
  "confidence": 0.8123,
  "provider": "ndlocr-lite",
  "lines": 27
}
```

## 2. Render でのデプロイ

1. Render で `New -> Web Service` を作成
2. 対象リポジトリ: `line_wine`
3. Environment: `Docker`
4. Root Directory: `ocr-bridge`
5. Build/Start command は空欄（Dockerfile を使うため）

推奨環境変数:

```env
OCR_BRIDGE_TOKEN=<ランダムな長い文字列>
NDLOCR_TIMEOUT_SEC=60
MAX_UPLOAD_BYTES=10485760
```

## 3. line-wine-api 側設定

`line-wine-api` サービスの環境変数を以下に変更します。

```env
OCR_ENDPOINT=https://<ocr-bridgeのURL>/ocr
OCR_AUTH_TOKEN=<OCR_BRIDGE_TOKENと同じ値>
OCR_REQUEST_FORMAT=multipart
OCR_IMAGE_FIELD=image
OCR_EXTRA_FIELDS=
OCR_TIMEOUT_MS=60000
```

## 4. ローカル確認

```bash
cd /Users/yoshito/Desktop/LINE-WINE/ocr-bridge
docker build -t line-wine-ndlocr-bridge .
docker run --rm -p 8080:8080 -e OCR_BRIDGE_TOKEN=test-token line-wine-ndlocr-bridge
```

確認コマンド:

```bash
curl -sS http://127.0.0.1:8080/health
curl -sS -X POST 'http://127.0.0.1:8080/ocr' \
  -H 'Authorization: Bearer test-token' \
  -F 'image=@/path/to/wine-label.jpg'
```

## 5. 注意点

- 初回ビルドは重く、数分以上かかることがあります。
- OCR処理は画像サイズに比例して遅くなるため、LINE webhook の応答時間制限を超えないよう、ラベル写真はできるだけトリミングしてください。
- NDL OCR-Lite の仕様変更があった場合はこのブリッジ側の更新が必要です。
