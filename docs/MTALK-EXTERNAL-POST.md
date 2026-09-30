# M-talk 外部投稿 API（mtalk-external-post）

gourmet（MARUGO-s/gourmet）の「AI分析」画面から、保存済みレポートを M-talk の利用者 1 人へ送るための入口です。
送信は専用 Bot「AI分析」（`00000000-0000-4000-8000-00000000b073`）との 1 対 1 トークに届きます。

- カード（kind `ai_report_share`）: 送信者・店舗・期間・主要数値・要点・施策
- PDF（`file` メッセージ、`is_silent: true`）: レポート全文。保存先は `chat-images/groups/<group_id>/ai-reports/<uuid>.pdf`

## 認証

`verify_jwt = false`（`supabase/config.toml`）。関数の中で次の両方を確認します。CORS は返しません（サーバー間専用）。

| ヘッダー | 内容 |
| --- | --- |
| `Authorization` | `Bearer <GOURMET_MTALK_TOKEN>`（32 文字以上。固定時間比較） |
| `X-Mtalk-Timestamp` | UNIX 秒。前後 300 秒以内 |
| `X-Mtalk-Signature` | `v1=` + HMAC-SHA256(key=token, `v1:<ts>:<METHOD>:<path>:<body>`) の hex |

`path` は `/recipients` か `/send`。署名のテストベクターは `tests/mtalk_external_post.test.ts` と gourmet の `server/tests/mtalk-share.test.js` で同じ値を使います。

## ルート

- `GET /recipients` — 利用中（`chat_has_active_access` 相当）かつ Bot でない利用者。`{ recipients: [{ id, username, stores[] }] }`
- `POST /send` — JSON（最大 12MB、PDF は base64 で 8MB まで）

```json
{
  "recipient_user_id": "uuid",
  "report_id": "uuid",
  "sender_label": "送信者の表示名",
  "title": "レポート名",
  "card": { "subtitle": "店舗・期間", "fields": [{"label":"店舗", "value":"…"}], "highlights": ["…"], "recommendations": ["…"], "note": "" },
  "pdf_base64": "JVBERi0…",
  "filename": "ai-report-2026-09.pdf",
  "dedupe_key": "gourmet:<share id>"
}
```

応答: `{ ok, group_id, card_message_id, file_message_id, deduplicated }`。
同じ `dedupe_key` の再送は `chat_alert_dispatches` で重複を防ぎます（カードと PDF を別々に記録）。

## DB（migration `20261001000000_chat_ai_analysis_bot.sql`）

- Bot 利用者「AI分析」（auth は `banned_until = infinity`、`@marugo.invalid`、`store_key` なし）
- `chat_ensure_bot_direct(p_bot, p_user)` — service_role 専用。1 対 1 を作成または再利用し、ゴミ箱と非表示を戻す

## 配備

1. migration（`main` への push で GitHub Actions が `db push`）
2. `supabase secrets set GOURMET_MTALK_TOKEN=... --project-ref hocbnifuactbvmyjraxy`
3. `mtalk-external-post` を配備（Actions が `knowledge/supabase-ownership.json` の一覧から配備）
4. gourmet 側に同じトークンと `MTALK_API_URL=https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/mtalk-external-post` を設定
