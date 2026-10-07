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

`path` は `/recipients`・`/store-bots`・`/send`・`/alert`・`/store-post`・`/chat-notice`。署名のテストベクターは `tests/mtalk_external_post.test.ts` と gourmet の `server/tests/mtalk-share.test.js` で同じ値を使います。

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

## 店舗Botの投稿（`POST /store-post`、gourmet の週報）

gourmet の週報（食べログ・一休）を、**店舗Bot として** Bot が参加しているグループのルーム（例: BISTRO CAVA CAVA の店舗ルーム）へ届ける入口です。
要約カード 1 通（kind `gourmet_store_post`）と、任意の PDF（最大 3 つ、`file` メッセージ・`is_silent: true`、kind `gourmet_store_post_file`）を続けて投稿します。
口コミ通知（`/alert`）とは別の入口・別の kind・別の形式です（`/alert` の `score_changes`・`reviews`・`recipient_user_id` を付けると 400）。「AI分析」Bot の 1 対 1 には送りません。

gourmet の `agent-api POST /weekly/deliver`（Grok Bot の月曜の作業から `INGEST_TOKEN` で呼ぶ）が、店舗Bot・ルームを `GET /store-bots` と gourmet の口コミ通知の設定（自動＝店舗名で判定／指定／送らない）で決めてから、署名つきで呼びます。
`GOURMET_MTALK_TOKEN` は両方の Edge Function の秘密情報だけにあり、Grok Bot は持ちません。

```json
{
  "bot_id": "<店舗Bot の chat_users.id>",
  "room_ids": [30],
  "dedupe_key": "gourmet-weekly:<gourmet の店舗 UUID>:2026-10-05",
  "type": "weekly_report",
  "store_name": "BISTRO CAVA CAVA",
  "title": "BISTRO CAVA CAVA 週報（食べログ・一休）",
  "subtitle": "2026/10/05 作成 · 直近7日 9/28〜10/4",
  "sections": [
    { "heading": "食べログ", "fields": [{ "label": "直近7日のPV", "value": "1,234 PV（前週比 +5.2%）" }, { "label": "評価", "value": "3.28（口コミ 50件）" }], "items": ["ネット予約は前月比 +12.0%"] },
    { "heading": "一休", "fields": [{ "label": "直近7日のPV", "value": "456 PV" }, { "label": "予約", "value": "7件（受付日ベース）" }] }
  ],
  "note": "数値は各サイトの管理画面・公開ページの取得値です。",
  "links": [{ "label": "アプリで見る", "url": "https://marugo-s.github.io/gourmet/" }],
  "files": [{ "pdf_base64": "JVBERi0…", "filename": "BISTRO CAVA CAVA weekly 2026-10-05.pdf" }],
  "dry_run": false
}
```

- `type` は `weekly_report` だけ（カードの見出しは「週報」。タイトルに店舗名が無ければ「週報 · 店舗名」）。種類を増やすときは `STORE_POST_TYPES` に足す。
- 上限: `sections` 4・各 `fields` 8（ラベル 24 文字・値 120 文字）・`items` 3（200 文字）・`note` 300 文字・`links` 2・`files` 3（PDF の合計 8MB、本文は 12MB まで）・`room_ids` 20。
- PDF だけを添付できます（先頭が `%PDF-` でないものは 400。HTML は添付できません。見せたいときは許可したホストのリンクで）。ファイル名は `/send` と同じ規則（英数字と `._() -`）。保存先は `chat-images/groups/<group_id>/store-posts/<uuid>.pdf`。
- リンクは `/alert` と同じ許可したホスト（https の `tabelog.com`・`owner.tabelog.com`・`restaurant.ikyu.com`・`marugo-s.github.io`）だけ。それ以外は黙って落とす。
- お客様の個人情報らしき文字列（メールアドレス・日本の電話番号）がカードのどこかにあれば 422 で受け付けません（gourmet 側でも同じ確認をします）。カードは件数・評価・PV などの集計だけにしてください。
- `room_ids` を省くと Bot が参加している全グループ（1対1・ゴミ箱・管理者通知を除く）。指定しても参加していないルームには送りません（全部外れたら 404）。投稿者名は「<店舗名> bot」（`loadMtalkStoreBot`）。
- 冪等性: 同じルームに同じ `dedupe_key` のカードは 1 回だけ、PDF は `<dedupe_key>:f<番号>` ごとに 1 回だけ（`chat_alert_dispatches`）。gourmet は店舗×週（作成日の週の月曜、日本時間）で同じキーを使うので、月曜の作業をやり直しても二重に届きません。
- 応答: `{ ok, bot_id, bot_name, rooms: [{ group_id, name, card_message_id, file_message_ids, deduplicated }], deduplicated }`。1 つでもルームへの投稿に失敗すると 502（同じ `dedupe_key` でやり直すと投稿済みのカード・PDF は飛ばされる）。Bot・ルームが見つからないは 404、同じ PDF を処理中は 409。
- `dry_run: true`: 何も投稿・予約せず、Bot・送り先ルーム（`already_sent` 付き）・組み立てたカード（`text`・`cards`）・PDF の名前と大きさだけを返す。最初の配信の前の確認に使う。

新しい migration・秘密情報はありません（`chat_alert_dispatches` に新しい kind の行が増えるだけ）。配備は `main` へのマージで Actions が `mtalk-external-post` を配備します。gourmet の `agent-api` は、この配備の後に配備してください（先に gourmet だけ配備すると `/store-post` が 404 "not found" になり、gourmet は 502 として失敗を返します）。

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
扱うのは PV・予約・口コミの分析だけで、PDF レポートの作成はしません（PDF は gourmet の画面から送ります）。データの質問にも常にすぐ、gourmet の取り込み済みのデータ（毎日の取得でためた確定値）で答えます。答えの最後に各サイトの最終取得日時（日本時間）と対象期間（例「データ：一休 10/1 18:30取得（9/1〜9/30）」）が付き、36 時間より古い・未取得のサイトはそう書かれます。

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

## 「最新を調べる／今あるデータで答える」の選択（廃止、migration `20261001190000_chat_ai_analysis_live_watch_noop.sql`）

2026-10-01 18:40 の利用者の決定で、選択のカードは廃止しました。gourmet の DB は毎日の取得で確定した数値をためておく保存場所で、
「AI分析」Bot はデータの質問にも常にすぐ、そのデータで答えます（推測・予想は「（推測）」「（予想）」と明記して事実と分ける）。

- `/chat-dispatch` は選択のカード（kind `ai_chat_choice`）も「最新を調べる」の見張り（kind `ai_chat_live`）も作らない。gourmet の古い版が
  `choice` / `live` / `live_close` を返しても無視し、`parts` の文をふつうの返事として送る。
- `POST /chat-reply` は削除（404）。gourmet も送らない。
- `chat_ai_analysis_live_timeouts()` は何も投稿しない関数に置き換え、閉じ忘れの `ai_chat_live` の行を `failed` で閉じるだけにした。
  毎分の `high-frequency-dispatcher-cron-job`（`invoke_high_frequency_dispatcher_cron()`）の定義は変えていない。過去の行・カードは履歴として残る。
- 以前のカードの「1」「2」のボタンを押した場合は、gourmet が直前の質問にすぐ答えるか、「質問をそのまま送ってください」と案内する。

## 「ログイン情報を更新」のボタンと gourmet からのお知らせ（`/mtalk-chat` の返事の `links`・`POST /chat-notice`）

gourmet の取得がログイン情報の問題（gourmet の `failure_kind = needs_relogin`）で止まっているサイトのデータを使って答えたとき、回答に店舗×サイトごとの
「ログイン情報を更新」のボタンを添えます。パスワードはトークに書かせず、トークを通しません（ボタンは gourmet のアプリの登録画面を開くだけ）。

- gourmet の `/mtalk-chat` の返事は任意で `links: [{ kind: "relogin", source, store_name, url }]` を持つ。答え（parts）を送ったあと、カード
  （kind `ai_chat_login_links`、dedupe は `msg:<message id>`）を 1 回だけ投稿する（`aiChatLinks`）。ボタンの文（`ログイン情報を更新（一休（BISTRO CAVACAVA））`）と
  注意書き（「パスワードはこのトークに書かないでください」）はこの関数が決め、gourmet からは受け取らない。
- URL は gourmet のアプリ（`https://marugo-s.github.io/gourmet/?view=accounts&source=<サイト>&store=<店舗コード>&retry=<依頼のUUID>`）だけを通す
  （https・ホスト・パス・問い合わせのキーが完全に一致しないもの、`source` が `links` の値と違うもの、`kind` が `relogin` 以外のものは捨てる）。最大 6 個。
  チャット画面では URL のボタンとして新しいタブで開く（既存のカードの表示のまま。画面の変更なし）。
- カードを送れなくても答えは届いているので失敗にしない（ログだけ）。`links` の無い返事はこれまでどおり。
- 「私は人間です」の確認（gourmet の `needs_human_check`）にはボタンを付けない（gourmet が本文で「次の回に自動でやり直します。続くときは Grok Bot のアプリで SiteBot に伝えてください」と案内する）。

`POST /chat-notice`（署名つき）`{ notice_id, mtalk_user_id, mtalk_group_id, parts[1..3], links? }`: gourmet からのお知らせ
（例: ログイン情報を更新したあとの「【再ログイン後の取得結果】」）。送り先はその利用者と「AI分析」Bot の 1 対 1 だけ（違えば 404）。
`chat_alert_dispatches`（kind `ai_chat_notice`、`notice:<notice_id>`）を先に確保してから送るので、同じ `notice_id` の再送は送らず成功扱い。
1 通目を送る前に失敗したら確保を取り消す（gourmet が 3 回までやり直す）。`links` があれば同じ規則でカードを付ける。2 分の見張りとは関係しない。

配備の順番: gourmet migration 020 → line_report（main へのマージで `mtalk-external-post`）→ gourmet の `agent-api`・`review-api`・Pages。新しい秘密情報・migration はありません。

### 内部の言葉を M-talk へ出さない（念のため）

gourmet は取得の失敗を「一休（BISTRO CAVACAVA）：ログイン情報の確認が必要です」のような決まった文で書き、Grok Bot の理由の文は送らない。
そのうえで念のため、`/chat-notice` の parts と「AI分析」の返答（`aiChatReplyParts`）は、内部の言葉
（computerUse・サブエージェント・executor・Shell・claim・Playwright・INGEST_TOKEN など。`INTERNAL_TERMS`、gourmet の `failure-text.js` と同じ一覧）を含む行を落としてから投稿する。
すべての行が落ちたときは「（回答を表示できませんでした。もう一度質問してください）」を 1 通だけ送る。

配備の順番（選択の廃止）: gourmet（migration 022・`ai-analyst`・`agent-api`）→ line_report（main へのマージで migration `20261001190000` と `mtalk-external-post`）。新しい秘密情報はありません。

## 貸借管理の月次報告（`mtalk-loan-report`、2026-10-07）

貸借管理アプリ（MARUGO-s/management）の GAS が毎月1日 6時台に、前々月・前月の2か月分（月が変わってから前月分を入力する人もいるため、前月分は次の報告でもう一度見る）の「重複チェック」（重複・入力ミスの疑い）を集計して送る入口です。前回の報告より後に入力された疑いには「【新】」が付きます。
`mtalk-external-post` とは別の Edge Function・別の秘密情報（`LOAN_MTALK_TOKEN`）にしています（gourmet の `GOURMET_MTALK_TOKEN` では通りません）。認証の形（`Authorization: Bearer`・`X-Mtalk-Timestamp`・`X-Mtalk-Signature`、署名文字列 `v1:<ts>:POST:/report:<body>`）は上と同じです。

- 送信元: 専用Bot「貸借管理 報告」（`00000000-0000-4000-8000-00000000b074`、店舗に属さない。migration `20261007120000_chat_loan_report_bot.sql`）
- 送り先: 現在の全権管理者（`chat_is_full_admin`）それぞれとの1対1（`chat_ensure_bot_direct` で作成・再利用、非表示・ゴミ箱は戻す。全権管理者でなくなった人には送らない）と、Botが参加しているグループのルーム（1対1・ゴミ箱・管理者通知を除く）
- Bot との1対1・ルームへの招待は全権管理者だけ（`chat_shares_affiliation` の例外）。店舗ルームには入れない（Bot の店舗とルームの店舗が一致しないため）。M-talk の Bot タブにも全権管理者にだけ表示する
- `POST /report`（本文 64KB まで）

```json
{
  "dedupe_key": "loan-duplicate:2026-08_2026-09",
  "title": "重複チェック（2026年8月〜9月分）",
  "subtitle": "2026/08/01〜2026/09/30 · 10/1 06:10 作成",
  "sections": [
    { "heading": "重複の疑いが強い", "fields": [{ "label": "件数", "value": "3件（2グループ）" }, { "label": "重複分", "value": "¥15,354" }], "items": ["2026-09-03 焼肉マルゴ→MARUGO MARUNOUCHI シャンティ ¥3,948 ×6"] }
  ],
  "note": "重複と確認できた行は、貸借管理の「逆取引修正」で取り消してください。",
  "links": [{ "label": "重複チェックを開く", "url": "https://marugo-s.github.io/management/pages/marugo.html" }],
  "dry_run": false
}
```

- 上限: `sections` 4・各 `fields` 8（ラベル 24 文字・値 120 文字）・`items` 5（200 文字）・`note` 300 文字・`links` 2。リンクは `/alert` と同じ許可したホストだけ。入力者名は送らない前提で、メールアドレス・電話番号らしき文字列があれば 422。
- 冪等性: 同じルームに同じ `dedupe_key` は1回だけ（`chat_alert_dispatches`、kind `loan_duplicate_report`）。1つでも失敗すると 502（同じキーでやり直すと送信済みは飛ばす）。送り先が無いと 404。
- `dry_run: true`: 投稿せず（1対1も作らず）、送り先の全権管理者名・ルーム（`already_sent` 付き）と組み立てたカードを返す。
- 応答: `{ ok, bot_name, targets: [{ group_id, name, kind: "direct" | "room", deduplicated }], deduplicated }`
- 配備: migration（main への push で `db push`）→ `supabase secrets set LOAN_MTALK_TOKEN=... --project-ref hocbnifuactbvmyjraxy`（32文字以上）→ Actions が `mtalk-loan-report` を配備 → 貸借管理の GAS のスクリプトプロパティに同じトークンを設定。
