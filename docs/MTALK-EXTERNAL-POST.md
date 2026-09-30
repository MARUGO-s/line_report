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

`path` は `/recipients`・`/store-bots`・`/send`・`/alert`。署名のテストベクターは `tests/mtalk_external_post.test.ts` と gourmet の `server/tests/mtalk-share.test.js` で同じ値を使います。

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

- `GET /store-bots` — 削除されていない店舗Bot（`is_bot` かつ `store_key` あり）と、投稿できるルーム（Bot が参加しているグループ。1対1・ゴミ箱・管理者通知は除く）。`{ bots: [{ id, username, store_key, rooms: [{ id, name, is_store_room, members }] }] }`（名前順）。gourmet の口コミ通知の設定画面と自動判定が使います。
- `POST /alert` — gourmet の口コミ通知（新着口コミ・食べログ総合点の変化）。カードのみ（PDFなし）。gourmet の agent-api が取り込みの直後に店舗ごとに1回呼び、**店舗Bot として** Bot が参加しているグループのルームへ投稿します（ルームの全員に届く。Web Push は通常の投稿と同じ）。

```json
{
  "bot_id": "<店舗Bot の chat_users.id>",
  "room_ids": [5, 30],
  "dedupe_key": "gourmet-alert:<batch id>",
  "store_name": "BISTRO CAVACAVA",
  "score_changes": [{ "site": "食べログ", "from": "3.26", "to": "3.28", "diff": "+0.02", "date": "2026-10-01", "review_count_from": 49, "review_count_to": 50, "url": "https://tabelog.com/…/13245351/" }],
  "reviews": [{ "site": "食べログ", "rating": "3.6", "posted_date": "2026-09-30", "visit": "2026-09", "title": "…", "text": "本文（1000文字まで）", "text_note": null, "url": "https://tabelog.com/…/13245351/dtlrvwlst/B…/", "url_label": "口コミを見る" }],
  "more_count": 0,
  "app_url": "https://marugo-s.github.io/gourmet/"
}
```

`room_ids` を省くと Bot が参加している全グループ（1対1・ゴミ箱・管理者通知を除く）。指定しても参加していないルーム・1対1には送りません。投稿者名は既存の店舗Botの投稿と同じ「<店舗名> bot」（`loadMtalkStoreBot`）。店舗Bot以外（AI分析・予約通知・利用者）の id は 404。
カードはこの関数が組み立てます（総合点の変化 → 口コミごと（10件まで）→「ほか N件」とアプリへのリンク）。リンクは `https` の `tabelog.com`・`owner.tabelog.com`・`restaurant.ikyu.com`・`marugo-s.github.io` だけで、それ以外はリンクなしで送ります。
応答: `{ ok, bot_id, bot_name, rooms: [{ group_id, name, message_id, deduplicated }], deduplicated }`。同じルームに同じ `dedupe_key` は `chat_alert_dispatches`（`kind = gourmet_review_alert`）で1回だけ。1つでもルームへの投稿に失敗すると 502（gourmet は同じ `dedupe_key` でやり直し、投稿済みのルームは飛ばされる）。Bot が見つからない・投稿できるルームが無いは 404（gourmet はやり直しません）。
旧形式 `{ recipient_user_id, ... }`（「AI分析」Botとの1対1、応答 `{ ok, group_id, message_id, deduplicated }`）も互換のため受け付けます。新しい migration・秘密情報はありません。

## DB（migration `20261001000000_chat_ai_analysis_bot.sql`）

- Bot 利用者「AI分析」（auth は `banned_until = infinity`、`@marugo.invalid`、`store_key` なし）
- `chat_ensure_bot_direct(p_bot, p_user)` — service_role 専用。1 対 1 を作成または再利用し、ゴミ箱と非表示を戻す

## 配備

1. migration（`main` への push で GitHub Actions が `db push`）
2. `supabase secrets set GOURMET_MTALK_TOKEN=... --project-ref hocbnifuactbvmyjraxy`
3. `mtalk-external-post` を配備（Actions が `knowledge/supabase-ownership.json` の一覧から配備）
4. gourmet 側に同じトークンと `MTALK_API_URL=https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/mtalk-external-post` を設定

## 「AI分析」Bot への質問（`POST /chat-dispatch`、migration `20261001010000_chat_ai_analysis_bot_replies.sql`）

利用者が「AI分析」Bot との 1 対 1 に文章を書くと、Bot が gourmet の AI分析（`ai-analyst POST /mtalk-chat`。画面の AI分析と同じモデル・同じ 7 つの集計関数）で答えます。
扱うのは PV・予約・口コミの分析だけで、再取得（スクレイピング）や PDF レポートの作成はしません（PDF は gourmet の画面から送ります）。

1. トリガー `chat_messages_enqueue_ai_analysis_reply`（after insert）が、次をすべて満たす発言だけを pg_net で `/chat-dispatch` へ渡す:
   `kind = 'text'`・本文あり・送信者が Bot でない・部屋が「AI分析」Bot と送信者の 1 対 1（`direct_key`）でゴミ箱でない。
   Bot 自身の返信は渡さないので、返信が返信を呼ぶことはありません。
2. `/chat-dispatch` は `chat_push_internal_config.dispatch_secret`（chat-search と同じ。Bearer、固定時間比較）で認証し、
   送信者が利用中の人間か・Bot がその部屋の参加者かを改めて確認、`chat_alert_dispatches`（kind `ai_chat_reply`、`msg:<message id>`）で同じ発言への二重回答を防ぐ。
3. 受け付けたら 202 を返し、バックグラウンド（`EdgeRuntime.waitUntil`）で直前 10 件の発言（Bot は assistant、利用者は user。カードは本文、PDF はファイル名だけ、画像は送らない）を付けて
   gourmet へ署名つきで問い合わせる。署名は gourmet → M-talk と同じ規則・同じ `GOURMET_MTALK_TOKEN`（パスは `/mtalk-chat`、テストベクターは両リポジトリで同じ値）。
4. 回答（プレーンテキスト、1 通 2000 文字以内・最大 3 通）を Bot の `text` 発言として投稿。通知は既存の `chat_messages_enqueue_push` が送る。
   失敗時は「すみません、…」の短い案内を 1 通返す（回数制限・準備中など gourmet が返した利用者向けの文だけを使い、内部の詳細は出さない）。
5. 返事が必ず届くようにする（migration `20261001030000_chat_ai_analysis_reply_timeouts.sql`）:
   - `chat_alert_dispatches.status`（`ai_chat_reply` のときだけ）は `pending` で確保し、答え・案内を送る前に `answered` / `failed` へ **pending のときだけ 1 回**確定する。
   - gourmet への問い合わせは 100 秒で打ち切る（Edge Function の実行時間の上限 150 秒より前）。打ち切り・通信失敗・500 系・例外はすべて
     「すみません、返事に時間がかかっています。エラーが起きた可能性があるので、もう一度送ってください。」を 1 通送る。
   - 関数が止まったなどで 2 分たっても `pending` のまま、または確定したのに 1 通目が記録されていない（`message_id` なし）質問は、
     `chat_ai_analysis_reply_timeouts()`（既存の `high-frequency-dispatcher-cron-job` から毎分）が `timed_out` に確定し、同じ文を Bot として 1 通送る。
     確定と投稿は 1 行ずつまとめて行い、投稿に失敗したら確定も戻して次の回にやり直す（対象は 1 日以内）。
   - 見張りが先に確定したら、遅れて届いた答えは関数側で捨てる（確定が 0 行）。案内と答えが重なることはない。
   - 画面（`public/chat/messages.js`）は送信直後から末尾に「・・・」を出し、120 秒で同じ文の案内（端末だけの表示、保存しない）に切り替える。
     どちらも Bot の発言が届くかトークを離れると消える。

gourmet 側で決めること（README 参照）: 読むデータの持ち主は、その部屋へ最後にレポートを送った gourmet 利用者（無ければ `INGEST_USER_ID`）。
回数は M-talk 利用者ごとに 1 時間 60 回（gourmet の `ai_usage`、`kind = 'mtalk'`）。OpenAI のキーは gourmet の秘密情報だけにあり、line_report には置きません。
問い合わせ先は既定で `https://ycsqfajidusuibqljjwr.supabase.co/functions/v1/ai-analyst`（秘密情報ではない。`GOURMET_AI_ANALYST_URL` で https の `…/functions/v1/ai-analyst` だけ上書き可）。

配備の順番: gourmet（migration 016・ai-analyst）→ line_report（main へのマージで migration と `mtalk-external-post` を配備）。新しい秘密情報はありません。
