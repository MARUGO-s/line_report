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

## テーブル

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
| `card` | `{v,kind,cards:[{header,sections,action}]}` | `service_role` のみ |

`chat_set_message_author` トリガが `auth.uid()` の有無で振り分ける。
ブラウザからの insert は必ず `text` か `image` になり、`card` を詐称できない。
`image` の `path` は `groups/<group_id>/…` であることを強制する。

## 予約通知の複製

予約通知のトーク配信は LINE と **同じ cron で発火するが、送信は独立**。
LINE の成否を待たない。重複は `chat_alert_dispatches` で防ぐ。

- 対応付け: `room_summary_settings.chat_group_id`。無ければ同じ店舗キーのトーク
- 新規予約・変更・キャンセル: `gmail-alert-cron`（先にトーク、続けて LINE）
- 本日の予約まとめ: `reservation-today-cron`（トークは 0 件でも送る。LINE は 0 件だと送らない）
- 共通処理: `supabase/functions/_shared/chat_bridge.ts`

投稿後は `chat-push?action=dispatch` を内部シークレットで叩き、Web Push まで配信する。

## 店舗固定ルームと #メモ

全店舗に `is_store_room` の固定ルームがある。退出・削除はできない。
店舗ルームへ `#メモ` / `#日報` / `#note`（全角シャープ可）を送ると、
`chat-knowledge` が Journal Report の「資料」へ登録し、Bot が結果を返す。

- テキスト: `#メモ 本文` でそのまま資料になる
- 画像・ファイル: LINE と同じ。`#メモ` が無ければメディア閲覧へ保存し、レシートなら解析して返す。資料にするときは画像にリプライして `#メモ`
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
