# LINE Report AI Handoff

## Project

- Production: `https://marugo-s.github.io/line_report/`
- Repository: `MARUGO-s/line_report`, branch `main`
- Working copy: `/Users/yoshito/Library/CloudStorage/Dropbox/web/line_report-main`
- Supabase production project: `hocbnifuactbvmyjraxy`
- Main surfaces: static GitHub Pages, `admin-api`, store-scoped `line-webhook`, cron Functions, Postgres/RLS, private `line-media` Storage.

## Active handoff — M-talk管理画面の次期改善（2026-08-24）

### 次のAIが最初に知ること

- ユーザーは、実装済みのM-talk専用管理画面を土台に、追加すると便利な管理機能を次のAIへ引き継ぎたい。
- 現行の管理・権限機能は本番反映済み。次の改善候補は**提案段階で、まだ未実装**。
- 作業対象は必ず `/Users/yoshito/Library/CloudStorage/Dropbox/web/line_report-main`。古いアーカイブ側を編集しない。
- 引き継ぎ開始コミットは `eef3c09`（`feat(chat): add M-talk admin permissions`）。このコミットは`main`へpush済み。
- 管理画面: `https://marugo-s.github.io/line_report/chat-admin.html`
- 詳細設計の正本: `docs/CHAT-ADMIN-PERMISSIONS.md`

### 現在、本番で利用できる機能

- ユーザー単位のM-talk利用停止、期限付き停止、理由表示、復元。
- M-talk全体の`1対1開始 / ルーム作成 / ユーザー一覧表示`権限。
- 1対1・通常ルームの参加者単位の`閲覧 / 送信 / 招待 / 管理`権限。
- 「M-talkから削除」による論理削除。過去発言、ルーム、Supabase Auth、LINE Reportの他画面は保持する。
- Bot保護、1対1の2人固定、管理操作の監査ログ。
- RLS、RPC、Storage、Realtime、検索、既読・未読、Web Push、予約送信まで同じ権限を強制。
- 管理者同士の同時更新は、ユーザー全体権限で`updated_at`競合を検出しHTTP 409、ルーム権限はDB行ロック後の部分更新で保護。

### おすすめ機能の優先順位

| 優先 | 機能 | 目的 |
| --- | --- | --- |
| 1 | 権限テンプレート・一括設定 | 「閲覧のみ」「一般」「ルーム管理者」などを複数ユーザー／ルームへ安全に適用する |
| 2 | ユーザー別アクセス一覧 | 1人を選び、全参加ルームと4権限、実際に利用不可となる理由を一画面で確認する |
| 3 | 監査ログから元に戻す | 誤変更を差分確認後に安全に復元する |
| 4 | M-talk専用管理者 | LINE Report全体の管理権限を渡さず、M-talk全体または指定ルームだけを管理させる |
| 5 | 期限付きルーム権限 | 指定日時まで閲覧のみ／送信停止などを設定し、DB判定で自動解除する |
| 6 | 新規ユーザー承認制 | 登録直後を承認待ちにし、所属先と初期テンプレートを管理者が決定する |
| 7 | 実効権限チェック | 全体停止、削除、期限、ルーム権限のどれが拒否理由かを明示する |
| 8 | 利用状況・休眠ユーザー | 最終利用日、参加ルーム数、Push登録状態を本文なしで表示する |
| 9 | 通報・モデレーション | 投稿の通報、管理者による論理非表示、理由記録、復元を行う |
| 10 | 権限変更通知 | 停止・閲覧専用等の理由と期限を対象ユーザーへ通知する |

### 推奨する最初の実装範囲

最初は次の3機能を一つの改善単位として扱う。日常の管理工数と誤設定を最も減らせる。

#### 1. 権限テンプレート・一括設定

- 初期テンプレートは`閲覧のみ / 一般メンバー / ルーム管理者`。将来は管理者が追加・編集できるようにする。
- 適用前に、対象ユーザー数、対象ルーム数、変更される項目をプレビューする。
- 一括処理はDBトランザクション内で行い、成功／失敗の混在を避ける。
- 監査ログへ、テンプレート名、対象、変更前後、操作者、日時を残す。
- Botは変更不可。1対1では`can_invite=false / can_manage=false`をDB側で維持する。
- `can_view=false`のとき他3権限もfalseにする既存制約を回避しない。

#### 2. ユーザー別アクセス一覧

- ユーザー詳細に、参加ルーム、ルーム種別、4権限、全体利用状態を一覧表示する。
- 単なるチェック値だけでなく、`全体停止 / 論理削除 / 停止期限 / can_view=false`などの実効的な拒否理由を表示する。
- ルーム名、店舗、1対1／グループ、権限状態で絞り込めるようにする。
- 現在の`GET /chat-admin/state`は最大件数付き一括取得なので、規模増加を考え、必要ならユーザー詳細専用のページネーションAPIへ分ける。
- メッセージ本文や顧客情報を管理一覧へ追加しない。

#### 3. 監査ログから元に戻す

- 実行前に「現在値→復元後」の差分と対象を表示する。
- 監査ログの`after_state`と現在値が一致する場合だけ復元し、別の管理者が更新済みなら409で止める。
- 復元操作自体も新しい監査ログとして記録する。元ログIDも関連付ける。
- 物理削除、ルーム完全削除、メッセージ消去のような復元不能操作は対象外。
- ユーザー論理削除には既存の復元RPCがあるため、重複実装せず共通化を検討する。

### 第2段階以降の設計注意

#### M-talk専用管理者

- 現在の`/chat-admin/*`は本部フル管理セッションだけが利用可能。
- 委任する場合は`全M-talk / 指定ルーム / 監査閲覧のみ`などの明示的なスコープを新設する。
- M-talk専用管理セッションから、売上、予約、店舗設定など他の`admin-api`経路へ到達できないことをAPI側で強制する。
- `STORE_SCOPED_ALLOWED_PATHS`へ安易に`/chat-admin/*`を追加しない。別の専用スコープとして認証・認可を設計する。
- 画面でボタンを隠すだけでは不可。管理RPCとAPIの両方でスコープを確認する。

#### 期限付き権限・承認制

- 有効期限はブラウザのタイマーではなく、DBヘルパー関数とRLSで判定する。
- 期限終了後のRealtime、Storage署名URL、Push、予約送信も同じ判定にする。
- 新規登録を承認待ちへ変える場合、現在のセルフ登録・既定有効という運用変更になる。実装前にユーザーへ確認する。

### 変更時に壊してはいけない安全条件

- 権限は`chat.html`関連だけに効かせ、LINE Botの`line_user_permissions`や他画面の権限を変更しない。
- `auth.users`のban／削除、`chat_users`の物理削除を使わない。作成ルームや履歴をcascadeで失う危険がある。
- `service_role`をブラウザへ渡さない。管理変更は`admin-api`とservice-role専用RPCを経由する。
- UIだけでなくRLS、RPC、Storage、Push、予約送信、Realtime、未読・検索まで同じ権限を強制する。
- 1対1は当事者2人固定。第三者追加、招待、`is_direct`等の保護列変更を許可しない。
- 予約画像payloadの数値正規化と、画面側での安全なDOMスタイル設定を維持する。過去に保存型XSS経路を修正済み。
- ユーザー全体更新の`expected_updated_at`と、ルーム権限の部分PATCH＋行ロックを維持する。
- ルーム完全削除は従来どおり、管理権限を持つ作成者だけ。便利機能の対象に含めない。

### 主に確認・変更するファイル

- `public/chat-admin.html`: 管理UI、ユーザー／ルーム／監査画面。
- `public/chat.html`: 利用者側の権限反映、停止理由、Realtime再評価。
- `supabase/functions/admin-api/index.ts`: `/chat-admin/*`管理APIと認証スコープ。
- `supabase/functions/chat-push/index.ts`: Push対象者の全体・ルーム権限判定。
- `supabase/migrations/20260824010000_chat_admin_permissions.sql`: 現行権限モデルの基準。既存migrationは編集せず、新しいmigrationを追加する。
- `tests/chat_admin_permissions.test.mjs`: 管理API・RLS・UI契約テスト。
- `tests/chat_web_push.test.ts`: Push権限の回帰テスト。
- `docs/CHAT-ADMIN-PERMISSIONS.md`: 設計・運用の正本。
- `docs/CHAT-TALK-GUIDE.md`: M-talk利用者側の正本。

### 推奨する実装順序

1. `AGENTS.md`と下記の知識環境を読み、`knowledge:search`／`knowledge:check`を行う。
2. 現行migration、管理API、管理UIをGraphifyと直接読取で確認する。
3. 新migrationでデータモデル、service-role専用RPC、RLSを先に実装する。
4. `admin-api`を実装し、一般ユーザー、店舗スコープ、ルームスコープからの拒否をテストする。
5. `chat-admin.html`へプレビュー、差分、エラー表示を実装する。
6. 実DBでanon、一般ユーザー、非メンバー、停止ユーザー、競合更新を攻撃テストする。
7. PCと320／390pxスマホで実画面確認する。
8. 文書、Graphify、Obsidianを更新し、commit／push後にPages、migration、Functionsを確認する。

### 必須検証

```bash
npm run knowledge:search -- "M-talk 管理 権限 テンプレート 一括 復元"
npm run knowledge:check
npm run test:chat
npm run check
deno check --no-lock supabase/functions/chat-push/index.ts
git diff --check
npm run knowledge:update
npm run knowledge:check
```

- UI変更は`./scripts/local-line-report-pages.sh`でPC・スマホを確認する。
- DB変更は既存chat migration群から新migrationまでをトランザクション適用し、RLS impersonation試験後にROLLBACKする。
- 本番反映後は、管理画面HTTP 200、未認証管理API 401、migration存在、管理RPCのauthenticated実行不可／service_role実行可、Edge Functions ACTIVEを確認する。
- Supabase Advisorsを確認する。`chat_admin_audit_log`のRLS有効・一般向けpolicyなしはservice-role専用という意図的な構成。

### 現行実装の検証記録

- `npm run test:chat`: 57/57成功。
- 管理画面と`chat.html`のinline JavaScript構文解析成功。
- 実DB試験: 停止ユーザーの閲覧・送信拒否、閲覧専用の送信拒否、非メンバー自己参加拒否、管理RPCの一般実行拒否、競合更新409、部分PATCH保持を確認。
- 予約画像payloadを使った保存型XSS試験を、登録時・配信時・表示時の三層防御で通過。
- Pages workflow: `32649962831`成功。
- Edge Functions／DB migration workflow: `32649962818`成功。
- 本番`admin-api`と`chat-push`はACTIVE、migration `20260824010000`適用済み。

### 次のAIがユーザーへ最初に確認すること

- 最初の実装を、推奨どおり`権限テンプレート＋ユーザー別一覧＋監査ログ復元`の3点セットで進めるか。
- M-talk専用管理者を誰へ委任したいか。本部全体、店舗責任者、指定ルーム管理者のどれが必要か。
- 新規登録を現在どおり即時有効にするか、承認待ちへ変えるか。

## Knowledge environment

- AI rules: `AGENTS.md`
- Current state: `PROJECT_PROGRESS.md`
- Security source: `docs/SECURITY.md`
- Documentation index: `docs/DOCS-INDEX.md`
- Talk (chat.html) guide: `docs/CHAT-TALK-GUIDE.md`
- Repository layout: `docs/REPOSITORY_STRUCTURE.md`
- Architecture model: `knowledge/system-architecture.json`
- Public system page source: `public/system-map.html`
- Generated code/SQL graph: `public/system-map/graph.html`
- Generated environment diagrams: `public/system-map/environment.html`
- Obsidian app folder: `アプリ知識/10_アプリ別/LINE Report`
- AI entry note: `70_AI作業環境/00_AI_START_HERE.md`
- Repository docs mirror: `80_リポジトリ文書/`
- Graphify notes: `90_Graphify/`

## Commands

```bash
npm run knowledge:search -- "<task or symptom>"
npm run knowledge:check
graphify query "<question>"
graphify path "<A>" "<B>"
graphify explain "<node>"
npm run knowledge:update
```

## Required investigation order

1. Search Obsidian/manual repository docs.
2. Check Graphify freshness and SQL coverage.
3. Use Graphify to locate relevant code/migrations.
4. Read exact source sections and live service state.
5. Implement and verify.
6. Write durable knowledge back and regenerate.

## Important boundaries

- `public/pages-config.js` is the frontend URL/store catalog source.
- `public/auth-session.js` manages scoped `lrst_` sessions and one-time `lrlt_` exchange.
- Public Pages never read business tables directly; use protected Edge Functions.
- `docs/SECURITY.md` invariants remain mandatory.
- Own-store reviews (`store_review_*`) and competitor reviews remain separate.
- Talk cards (`chat_messages.kind='card'`) are service-role only; browser inserts are forced to `text`/`image` by trigger.
- Talk images live in the private `chat-images` bucket and are read through signed URLs, unlike the public `chat-icons`.
- `line_receipt__*` source rows and `line_room_receipt_search` index are separate.
- Graphify excludes vendor/node_modules/generated/secret paths but includes SQL migrations.
- GitHub Actions publishes `public/` to GitHub Pages at the existing `/line_report/*` URLs. Local DBs and backups belong under `.local/`.
