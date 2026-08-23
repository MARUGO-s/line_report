# M-talk（chat.html）専用管理・権限設計

`public/chat-admin.html` は M-talk だけを管理する画面。LINE Bot の
`line_user_permissions`、店舗管理権限、Supabase Auth の利用可否には連動しない。

- 管理画面: `https://marugo-s.github.io/line_report/chat-admin.html`
- 管理API: `admin-api /chat-admin/*`
- 対象アプリ: `public/chat.html` と、その通知・画像・予約送信・ルーム設定経路

## 信頼境界

```mermaid
flowchart LR
  A[本部管理者] -->|既存の管理セッション| B[chat-admin.html]
  B -->|x-admin-token| C[admin-api /chat-admin]
  C -->|service_role| D[(chat_user_access)]
  C -->|service_role専用RPC| E[(chat_group_members)]
  F[M-talk利用者] -->|Supabase Auth JWT| G[chat.html]
  G -->|RLS/RPC| D
  G -->|RLS/RPC| E
  G --> H[(chat_messages / Storage / Realtime)]
  D --> H
  E --> H
```

ブラウザへ `service_role` を渡さない。管理画面でボタンを隠すだけではなく、
Data APIを直接呼ばれてもDBのRLS・RPC・Storage policyで同じ判定を行う。
店舗限定、ルーム限定、cron用の管理セッションは `/chat-admin/*` を利用できない。

## 権限モデル

### ユーザー全体（`chat_user_access`）

| 項目 | 効果 |
| --- | --- |
| `access_enabled` | falseならM-talk全体を停止 |
| `restricted_until` | 未来日時なら、その日時まで一時停止 |
| `can_start_direct` | 新しい1対1トークを開始できる |
| `can_create_group` | 新しい複数人ルームを作成できる |
| `can_browse_users` | 友だち・招待候補のユーザー一覧を見られる |
| `deleted_at` | M-talk上の論理削除。再ログインしても利用不可 |

既存ユーザーと新規登録ユーザーは、現在の利用方法を壊さないため既定で有効。
Botは管理画面から停止・削除できない。

### ルーム別（`chat_group_members`）

| 項目 | 効果 |
| --- | --- |
| `can_view` | ルーム、参加者、参加時刻以降の本文、検索、画像、既読、未読、通知を利用 |
| `can_send` | 本文、画像、感情イラスト、リアクション、予約送信を利用 |
| `can_invite` | 招待リンクの発行・更新、利用中ユーザーの追加 |
| `can_manage` | ルーム名・アイコン・設定、メンバー退出、ゴミ箱・復元 |

`can_send`、`can_invite`、`can_manage` は `can_view` が前提。1対1は当事者2人だけで、
第三者の追加、招待、通常ルームへの書き換えを禁止する。

## 管理API

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/chat-admin/state` | 集計、ユーザー、ルーム、メンバー権限、監査ログ |
| PATCH | `/chat-admin/users/:id` | 全体利用と3つの全体権限、一時制限・理由 |
| POST | `/chat-admin/users/:id/remove` | 表示名再入力後にM-talkだけ論理削除 |
| POST | `/chat-admin/users/:id/restore` | 論理削除を解除 |
| PATCH | `/chat-admin/rooms/:id/members/:userId` | 4つのルーム権限を更新 |
| DELETE | `/chat-admin/rooms/:id/members/:userId` | 通常ルームの4権限を無効化（履歴保持・再設定可） |

変更は `chat_admin_audit_log` へ、操作者、対象、変更内容、日時を記録する。

## 「ユーザー削除」の意味

管理画面の削除は、Supabase Authや`chat_users`の物理削除ではない。

1. `chat_user_access` を無効化し `deleted_at` を設定する。
2. 全ルームへのアクセスは全体利用判定で即時遮断する。ルーム別の細かな権限値は、復元時に元どおり戻せるよう保持する。
3. 未送信の予約送信を取消し、Web Push購読を無効化する。
4. 過去の発言、他ユーザーの履歴、作成済みルームは保持する。

`chat_users`を物理削除すると外部キーのcascadeで作成ルームと履歴まで消え、
`auth.users`を削除・banするとM-talk以外にも影響するため、どちらも行わない。

## 主な防御

- 非メンバーはルームの存在、参加者、本文、画像を取得できない。
- 生の`chat_group_members` INSERT/DELETEによる自己参加・退出迂回を禁止する。
- ルーム作成・メンバー追加は権限検査付きRPCだけを使う。
- `created_by`、`is_direct`、`direct_key`、`store_key`等の保護列は直接更新できない。
- 停止・削除・閲覧不可のユーザーをRealtime、未読数、Web Push対象から外す。
- 予約送信は予約時と送信時の両方で`can_send`を確認する。
- 予約画像のpayloadは登録時と配信時に再構築し、画像サイズは数値だけに限定する。画面側もサイズをHTML文字列へ連結しない。
- ユーザー全体権限は`updated_at`で競合を検出して409にし、ルーム権限はDBで行ロック後に指定項目だけを更新する。別管理者の変更を古い画面値で巻き戻さない。
- `chat-icons`の書込みは本人のパス、または管理可能ルームのパスだけに限定する。
- `chat-images`は`can_view`で閲覧、`can_send`で保存する。

ルームの完全削除は復元不能なため、`can_manage`だけでは許可せず、従来どおり作成者本人に限定する。

署名済みの画像URLは発行後最大1時間有効。権限取消後の新しいURL発行は拒否するが、
発行済みURLを即時失効させる仕様ではない。

## 運用確認

1. anon、一般ユーザー、停止ユーザーで管理APIが403/401になる。
2. 停止ユーザーの既存JWTで本文・画像・Realtime・RPCを利用できない。
3. 閲覧のみでは本文を読めるが送信・リアクション・予約送信ができない。
4. 招待不可のメンバーが招待トークンを発行・更新できない。
5. 1対1の空席へ第三者が生INSERTできない。
6. 論理削除後もAuthユーザー、過去発言、既存ルームが残る。
7. 店舗・ルーム限定の管理セッションから`/chat-admin/state`を取得できない。
