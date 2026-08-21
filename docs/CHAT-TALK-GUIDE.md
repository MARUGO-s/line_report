# トーク（chat.html）ガイド

社内連絡用のグループチャット。`public/chat.html` の1ファイルに UI とロジックが入り、
Supabase Auth / Realtime / Storage / Edge Function で動く。

- 本番: `https://marugo-s.github.io/line_report/chat.html`
- Supabase プロジェクト: `hocbnifuactbvmyjraxy`
- ここに endpoint、暗号鍵、VAPID 秘密鍵、メッセージ本文、顧客名を書かない。

## 利用条件

1. メールアドレスとパスワードで新規登録する。
2. `chat_allowed_emails` に載っているメールだけがプロフィールを作れる。
   載っていないと `chat_users` への insert がトリガで弾かれ、チャットを一切使えない。
3. 初回のみ表示名とアイコンを決める。

## 店舗Botのロゴ

- `chat_users.is_bot=true` かつ `store_key` がある店舗Botは、`public/icons/store-bots/` の店舗ロゴを表示する。
- `public/chat.html` の `STORE_BOT_LOGOS` が `store_key` とロゴファイルの対応表。Botタブ、1対1トーク、ヘッダー、メンバー、招待、メンションで共通利用する。
- 店舗Botの `icon_url` より同梱ロゴを優先する。対応表にない新店舗だけ、従来どおり `icon_url` または店名の頭文字へフォールバックする。
- 店舗ロゴ画像は白背景・`object-fit: contain`・4px余白で表示し、円形アイコン内でロゴが切れないようにする。一般ユーザー画像は従来どおり `cover`。
- ユーザーアイコンは、従来の画像アップロードに加えて、同梱の標準アイコン70点から選べる。素材は中央を正方形に切り出した256px PNGとして `public/profile-icons/` に保存する。
- 標準アイコンの選択結果は `chat_users.icon_url` に保存するため、新規登録時・登録済みユーザーの変更時のどちらでも利用でき、端末を替えても維持される。
- 店舗ロゴの円内右下には、赤文字の `bot` マークを白い小型背景付きで重ね、通常ユーザーと見分けられるようにする。円形クリップで文字が切れないよう、右7px・下6pxの内側へ配置する。
- 店舗を追加するときは、ロゴSVG、`STORE_BOT_LOGOS`、`tests/chat_store_bot_logos.test.mjs` の期待値を同時に追加する。

## テーブル

### 参加時点からの履歴

- 新しくルームへ招待・参加したユーザーは、`chat_group_members.joined_at` 以降のメッセージだけを閲覧できる。参加前の本文は画面側の非表示ではなく、`chat_messages` のRLSで取得自体を拒否する。
- 同じ境界をメッセージ検索、Realtime、リアクション、画面の未読数、Web Pushのバッジ数にも適用する。
- 初回表示は最新50件だけを取得し、上端までスクロールしたときに50件ずつ過去へ読み足す。表示済み履歴は最大12ルーム分だけメモリへ保持し、ルームを行き来する際の再通信を減らす。
- メッセージ本文は共有端末へ残さないため、`localStorage` 等には永続キャッシュしない。

| テーブル | 役割 |
| --- | --- |
| `chat_allowed_emails` | 利用を許可するメール。`service_role` だけが操作でき、一般ユーザーからは存在ごと見えない |
| `chat_users` | 表示名とアイコン。`id` は `auth.users(id)` |
| `chat_groups` | トークルーム。`is_direct` が真なら1対1 |
| `chat_group_members` | 参加関係 |
| `chat_messages` | 発言。`kind` は `text` / `card` / `image` |
| `chat_read_states` | 既読位置。未読バッジと既読表示に使う |
| `chat_message_reactions` | リアクション。`(message_id, user_id, emoji)` |
| `chat_push_subscriptions` | Web Push の購読 |
| `chat_push_user_preferences` | 通知ON-OFFとプレビュー可否 |
| `chat_push_dispatches` | 同一メッセージの重複送信防止 |
| `chat_push_internal_config` | cron／pg_net から `chat-push` と `chat-knowledge` を叩くための内部シークレット |
| `chat_scheduled_messages` | 予約送信。本人だけが見て取り消せる。時刻到来で `chat_messages` へ投稿 |

## 発言の種別

`chat_messages.kind` と `payload` の組み合わせ。`content` にはどの種別でも
プレーンテキスト版を入れる。トーク一覧のプレビューと Web Push の本文は
`content` を見るため、`payload` が読めなくても表示が壊れない。

| kind | payload | 誰が作れるか |
| --- | --- | --- |
| `text` | なし | 全員 |
| `image` | `{v,kind,image:{path,w,h}}` | 全員。ただしトリガが作り直す |
| `sticker` | `{v,kind,sticker:{id,label,path}}` | 全員。ただし有効な `chat_stickers.id` だけをトリガが台帳から作り直す |
| `card` | `{v,kind,cards:[{header,sections,action}]}` | `service_role` のみ |

## 感情イラスト

- 入力欄の大きな `☺`（28px）から39点の感情イラストを選び、テキストの代わりに送信できる。
- `chat_stickers` がID・表示名・公開画像パス・並び順・有効状態のDB台帳。画像本体は `public/stickers/face/` に置く。
- 送信履歴は `chat_messages.kind='sticker'` と正規化済みpayloadへ保存する。クライアント指定のパス・名称は信用せず、DBトリガが有効なIDから再構成する。
- トーク一覧・検索・Web Pushには `content` の `[感情イラスト] 表示名` を使う。返信・転送にも対応する。

`chat_set_message_author` トリガが `auth.uid()` の有無で振り分ける。
ブラウザからの insert は必ず `text` か `image` になり、`card` を詐称できない。
`image` の `path` は `groups/<group_id>/…` であることを強制する。

## 予約通知の複製

予約通知のトーク配信は LINE と **同じ cron で発火するが、送信は独立**。
LINE の成否を待たない。重複は `chat_alert_dispatches` で防ぐ。

- 対応付け: `room_summary_settings.chat_group_id`。無ければ同じ店舗キーのトーク
- 新規予約・変更・キャンセル: `gmail-alert-cron`（先にトーク、続けて LINE）
- 本日の予約まとめ: `reservation-today-cron`（トークは 0 件でも送る。LINE は 0 件だと送らない）
- 明日の予定まとめ: `calendar-tomorrow-cron`（ルーム設定の時刻。トークは 0 件でも送る。LINE は 0 件だと送らない。カードの「予定カレンダーを開く」は `group_id` 付きの `mtalk_schedule.html`）
- 共通処理: `supabase/functions/_shared/chat_bridge.ts`

投稿後は `chat-push?action=dispatch` を内部シークレットで叩き、Web Push まで配信する。

## Web Push購読の復旧

- Service Workerの登録URLは`chat-sw.js`へ固定する。`chat-sw.js?v=...`のようにURL自体を
  変更すると、ブラウザが別Workerとして扱い、既存のWeb Push購読がHTTP 410になる端末がある。
- Worker資産を更新するときは、登録URLではなく`chat-sw.js`内の`CHAT_CACHE`名を更新する。
- ユーザー設定が通知ONで、通知権限も許可済みなのに`PushManager.getSubscription()`が
  nullなら、自動で権限プロンプトを出さず、画面上部に
  「通知が切れたので、ここをタップして再開」を表示する。
- 再開はユーザー操作内で行い、残っている古い購読を`unsubscribe()`してから
  `pushManager.subscribe()`し直す。新しい購読は`activate=true`で`chat-push`へ保存する。
- 任意の画面タップを再開操作にしてはいけない。正常な購読まで毎回作り直し、同一端末由来の
  endpointが増殖する。再開は再開バーまたはベルの明示操作に限定する。
- 購読保存時は新endpointを先にupsertし、その後で同じユーザー・同じUser-Agentの
  別endpointを停止する。先に旧購読を停止すると、新規保存失敗時に通知をすべて失う。
- `chat-push?action=test`は認証ユーザー本人が提示した有効endpointだけへテスト通知を送る。
  ルーム参加、ミュート、送信者除外、メッセージ重複防止を通らない端末診断専用経路とする。
  ページ起動時や再購読直後には自動送信せず、「通知テスト」の明示操作時だけ送る。
- Apple/WebKit向けを含むペイロードはDeclarative Web Push形式（`web_push: 8030`）にする。
  `notification.navigate`は絶対HTTPSの同一origin URL。`app_badge`はWebKit公式どおり
  `notification`内の文字列にする。対応WebKitはService Worker処理に失敗してもOSがfallback通知を表示する。
- iPhoneの通知テストは、ホーム画面へ戻せるよう約4秒遅らせて送る。アプリを開いたままでは
  バナーが出ないことがある。
- `chat-sw.js`は同じ宣言辞書を従来形式へ変換して`showNotification()`するため、
  Declarative Web Push未対応ブラウザでも通知を維持する。
- `navigatePath`に外部originを渡しても、`chat_push_payload.ts`でM-talkトップへ固定する。
- iPhone/iPadはホーム画面のstandalone版M-talkだけを対象にする。通常Safariタブでは
  ホーム画面への追加を案内する。`Notification.permission === 'denied'`なら端末設定での
  許可が必要で、ページから再プロンプトはできない。

## 予約・予定

M-talk のトーク下部「予約・予定」から、同じルームの予約表と予定をタブ切替で見る。

- 予約タブは Gmail 予約取り込み（食べログ／一休／手入力）と同じ店舗データを表示する。カレンダーの印も予約だけ。
- 予定タブは、その M-talk ルームと、同じ店舗キーの LINE ルームに登録されたカレンダー予定を表示する。カレンダーの印も予定だけ。
- 注意事項・特記事項（アレルギー、お誕生日、苦手、要望）だけ赤。ダークでも赤。時刻・氏名・コースなどその他はダークで白、ライトで黒。
- ルームメンバーはこの画面から予約・予定の追加、編集、日付変更、キャンセル（予約は非表示、予定は削除）ができる。管理トークンは使わない。
- 会話の「予定の自動登録」は Googleカレンダーではなく `line_room_calendar_events`（M-talkの予定カレンダー）へ保存する。LINEルームならその `room_id`、M-talkなら `mtalk-group-{id}`。
- 予約の新規追加は手入力として店舗に保存する。食べログ／一休の取込予約も同じ店舗なら編集・キャンセルできる。
- 閲覧はルームメンバーのログイン JWT のみ。予約の生 JSON（`reservation_detail`）は返さない。

## 店舗固定ルームと #メモ

全店舗に `is_store_room` の固定ルームがある。退出・削除はできない。
作成者は、店舗固定以外のルームを先にゴミ箱へ移せる。ゴミ箱タブから復元できる。完全削除はゴミ箱からだけでき、そのルームのメッセージ・画像・`mtalk-group-{id}` の予定だけが消える。他のルームや店舗の予約・売上は消えない。完全削除前にルーム名の再入力が必要。ゴミ箱のルームには送信できない。
店舗ルームへ `#メモ` / `#日報` / `#note`（全角シャープ可）を送ると、
`chat-knowledge` が Journal Report の「資料」へ登録し、Bot が結果を返す。

- テキスト: `#メモ 本文` でそのまま資料になる
- 画像・ファイル: LINE と同じ。`#メモ` が無ければメディア閲覧へ保存し、レシートなら LINE と同じ解析・同じ売上レポートカード（予算・前年比・修正／削除／売上推移）を返す
- 入力: PC は Enter で送信・Shift+Enter で改行。スマホは送信ボタンで送り、Enter は改行
- 予約配信: 入力欄の「予約配信」から日時指定。画像の添付・ドロップ・貼り付けでも「今すぐ送る／予約配信」を聞く。毎分の cron が到来分を本人として投稿する
- `chat-knowledge` は pg_net の内部シークレットで認可する。ゲートウェイ JWT 検証は
  `verify_jwt=false`。設定を忘れると `UNAUTHORIZED_INVALID_JWT_FORMAT` で無反応になる

## 画像

- バケット `chat-images`（**非公開**）。パスは `groups/<group_id>/<uuid>.jpg`
- 表示のたびに署名URL（1時間）を作る。アイコン用 `chat-icons` は公開だが、
  トーク画像はレシートや予約表など顧客名の写った写真が流れる前提なので分ける
- 読み書きできるのはそのグループの参加者だけ。update / delete のポリシーは作らない
- 送信前に長辺1600px・JPEG品質0.82へ縮小する

## 検索

M-talkの店舗Bot検索メニューでは、予定・メディア・売上検索だけを提供する。会話検索はBotとのコマンド形式では行わず、トーク一覧上部の「トークルームとメッセージ検索」に一本化する。古い会話検索ボタンや「会話検索」コマンドが使われた場合も、上部検索欄を案内する。

「検索」および検索メニューの定型ボタンは、画像・レシート解析等を含む `chat-knowledge` を経由せず、軽量な `chat-search` が直接応答する。検索キーワードの実検索と検索以外の店舗Bot機能は従来の処理へ渡す。

ユーザーアイコンと感情イラストはWeb表示用の解像度へ縮小し、Service Workerの実行時キャッシュを使う。一覧画像は `loading=lazy` と非同期デコードで必要な範囲から読み込み、感情イラストのDB台帳は端末へ24時間キャッシュする。新規アップロードのアイコンは192px WebPへ変換して長期キャッシュする。

参加中の全トークを `ILIKE '%…%'` で引く。日本語は空白で区切られず
`to_tsvector` が効かないため、全文検索ではなく pg_trgm の GIN インデックスを使う。

> このプロジェクトの `pg_trgm` は `extensions` ではなく **`public` スキーマ**にある。
> `extensions.gin_trgm_ops` と書くと索引作成が失敗するので、
> 演算子クラスのスキーマを決め打ちしない。

2文字以上で検索し、250ms デバウンスする。結果をタップすると前後25件を
読み込んでその発言へ飛ぶ。

## 既読・リアクション・返信・メンション

- **既読**: `chat_read_states` は当初「自分の行だけ」だった。同じグループの
  参加者どうしは互いの既読時刻を参照できる（書き込みは自分の分のみ）。
  自分の発言へ「既読 N」、1対1では人数を出さず「既読」だけ
- **リアクション**: 👍 ✅ 🙏 😂 ❤️ 😮。発言と違い自分の分は取り消せる。
  取り消しを Realtime で拾うため `replica identity full`
- **返信**: `reply_to_id`。返信先が同じトークルームの発言であることをトリガで強制する
- **メンション**: `mentions uuid[]`。クライアントの申告を信用せず、トリガで
  そのグループの参加者だけに絞る。名指しされた人の Web Push は本文の頭に「@あなた宛」が付く

## Realtime

`chat-global` チャンネルで購読する。RLS がそのまま効くため、
未参加グループの新着は配信自体されない。

- `chat_messages` INSERT
- `chat_groups` INSERT
- `chat_group_members` INSERT
- `chat_message_reactions` すべて
- `chat_read_states` すべて

## 設計上の割り切り

- **発言は追記のみ**。送信取消・編集・削除はできない。誤送信を消せない代わりに
  改竄もされない。変えるなら意図的な判断が要る
- 検索から途中へジャンプしている間は新着を継ぎ足さない。間の発言を読み込んで
  いないため並びに穴が空く。「最新へ」で読み直す

## 確認項目

1. 許可リストに無いメールでプロフィールを作れない。
2. 未参加グループの本文が読めない。
3. 画像の署名URLが期限切れ後に作り直される。
4. 他グループのパスを指定した画像投稿が弾かれる。
5. 他ルームの発言を返信先に指定できない。
6. メンションに非参加者を混ぜても保存されない。
7. リアクションを他人の分として付けられない。
8. 通知ONのまま購読が消えた端末で再開バーが出て、タップ後に新しい購読が保存される。
9. Service Worker更新後も登録URLが`chat-sw.js`のままで、通知配信がHTTP 410にならない。
10. 正常な購読がある状態で画面をタップしてもendpointが増えない。
11. 通知テストが現在のendpoint1件だけへ送られ、他端末・他ユーザーへ送られない。
