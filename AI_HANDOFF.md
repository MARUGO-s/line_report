# LINE Report AI Handoff

## Project

- Production: `https://marugo-s.github.io/line_report/`
- Repository: `MARUGO-s/line_report`, branch `main`
- Working copy: `/Users/yoshito/Library/CloudStorage/Dropbox/web/line_report-main`
- Supabase production project: `hocbnifuactbvmyjraxy`
- Main surfaces: static GitHub Pages, `admin-api`, store-scoped `line-webhook`, cron Functions, Postgres/RLS, private `line-media` Storage.

## 引き継ぎメモ（2026-08-24 セッション終了時点）

前セッションが利用上限で中断した。**この節を最初に読むこと。**

### 本番反映済み（確認済み）

| PR | コミット | 内容 |
| --- | --- | --- |
| [#161](https://github.com/MARUGO-s/line_report/pull/161) | `52d5312` | 権限テンプレート一括適用／ユーザー別アクセス一覧／監査ログ復元 |
| [#162](https://github.com/MARUGO-s/line_report/pull/162) | `07d3fae` | `chat_admin_normalize_member_permissions` の search_path 固定＋反映記録 |

検証済み: 両ワークフロー成功、migration `20260825010000` / `20260825020000` 適用、
新5関数は `anon=false / authenticated=false / service_role=true`、
Pages 200・未認証API 401、Advisors は WARN 54（ベースラインへ復帰）で
増加は `chat_permission_templates` の意図的な INFO 1件のみ。

### 未マージ

- [#163](https://github.com/MARUGO-s/line_report/pull/163) ブランチ `docs/m-talk-complete-guide`
  — `docs/M-TALK-COMPLETE-GUIDE.md`（M-talk統合ガイド11章）。レビュー待ち。

### 未着手（ユーザーが依頼済み）

1. **店舗スタッフ向けの共有Webページ**（Artifact として公開）。
   統合ガイドのうち**使い方に関わる部分だけ**を対象にし、
   セキュリティ内部構造・テーブル名・管理APIパス・開発者向けルールは載せない。
   前セッションは `artifact-design` skill を読み込んだところで中断した。

### 未実施の検証（重要）

- **本番での実操作スモークテストがまだ。** これまでの検証は層ごとで、
  DB試験はすべて ROLLBACK している。「管理トークン → admin-api → RPC」を
  通した実行が本番で一度もない。特に supabase-js が `group_ids`(JS数値配列) を
  `bigint[]` へ、`user_ids` を `uuid[]` へ渡す部分が未検証。
- 確認方法: `chat-admin.html` でルームを選び「変更内容を確認」を押すだけ。
  `dry_run:true` なので行も監査ログも書き込まない（本番DBで確認済み）。

### 次に勧める実装

**複数ルームへの一括適用（UI）。** APIは複数ルーム対応済みだが、
管理UIは選択中の1ルームしか送っていない（`public/chat-admin.html` の
`group_ids:[Number(room.id)]`）。ルーム一覧にチェックボックスを足して
プレビューへ渡すだけで、DB変更なしに実現できる。

ロードマップ7（実効権限チェック）はアクセス一覧で実質達成済み。
8・9は現在の規模（有効ルーム26・参加行57）では時期尚早。
4・5・6はユーザーの判断待ち（下記の質問参照）。

### 注意

- migration `20260825*` はファイル名の日付が実施日（2026-08-24 JST）より1日進んでいる。
  適用済みのため改名しない。次のchat系は `20260825020000` より後の版番号にする。
- ローカルのプレビューサーバー（ポート8765）が起動したままの可能性がある。
  `lsof -ti tcp:8765 | xargs kill` で停止する。

---

## Active handoff — M-talk管理画面の次期改善（2026-08-24 / 2026-08-24更新）

### 次のAIが最初に知ること

- ユーザーは、実装済みのM-talk専用管理画面を土台に、追加すると便利な管理機能を次のAIへ引き継ぎたい。
- 2026-08-24時点の管理・権限機能は本番反映済み。
- **推奨3点セット（権限テンプレート／ユーザー別アクセス一覧／監査ログ復元）は本番反映済み（2026-08-24）。**
  詳細は下の「2026-08-24 実装・反映」を読む。優先度4以降は未着手。
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
| 1 | 権限テンプレート・一括設定 | **本番反映済み（2026-08-24）** |
| 2 | ユーザー別アクセス一覧 | **本番反映済み（2026-08-24）** |
| 3 | 監査ログから元に戻す | **本番反映済み（2026-08-24）** |
| 4 | M-talk専用管理者 | LINE Report全体の管理権限を渡さず、M-talk全体または指定ルームだけを管理させる |
| 5 | 期限付きルーム権限 | 指定日時まで閲覧のみ／送信停止などを設定し、DB判定で自動解除する |
| 6 | 新規ユーザー承認制 | 登録直後を承認待ちにし、所属先と初期テンプレートを管理者が決定する |
| 7 | 実効権限チェック | 全体停止、削除、期限、ルーム権限のどれが拒否理由かを明示する |
| 8 | 利用状況・休眠ユーザー | 最終利用日、参加ルーム数、Push登録状態を本文なしで表示する |
| 9 | 通報・モデレーション | 投稿の通報、管理者による論理非表示、理由記録、復元を行う |
| 10 | 権限変更通知 | 停止・閲覧専用等の理由と期限を対象ユーザーへ通知する |

### 2026-08-24 実装・本番反映

推奨3点セットを1つの改善単位として実装し、本番へ反映済み。
PR [#161](https://github.com/MARUGO-s/line_report/pull/161)、コミット `52d5312`。

追加・変更したもの:

- `supabase/migrations/20260825010000_chat_admin_templates_access_revert.sql`（新規）
  - `chat_admin_normalize_member_permissions`: ルーム4権限の正規化を1か所へ集約。既存の
    `chat_admin_update_member_permissions` もこの関数を通すよう `create or replace` した（署名は不変）。
  - `chat_permission_templates`: 組込3件（`viewer` / `member` / `room_admin`）。service_role専用。
  - `chat_admin_apply_room_template`: 一括適用。`dry_run`はプレビュー専用、上限100件、
    Botと論理削除済みユーザーはスキップ、書き込みは既存の単体更新RPCへ委譲。
  - `chat_admin_user_effective_access`: 実効アクセスと拒否理由コード、ページネーション。
  - `chat_admin_audit_log.source_audit_id` と `chat_admin_revert_audit`: ホワイトリスト＋409競合検出＋二重復元防止。
- `supabase/functions/admin-api/index.ts`: `/chat-admin/templates`、`/chat-admin/templates/apply`、
  `/chat-admin/users/:id/access`、`/chat-admin/audit/:id/revert` を本部専用ブロック内へ追加。
  `dry_run`の既定はtrue。`40001`は409へ。`/chat-admin/state` の監査ログへ `revertible` を付与。
- `public/chat-admin.html`: テンプレート適用バー＋プレビュー、ユーザー別アクセスダイアログ
  （ルーム名・店舗・種別・権限状態で絞り込み）、監査ログの「元に戻す」＋差分ダイアログ。
  メンバー表に一括適用の対象を選ぶチェックボックス列を追加。
- `tests/chat_admin_templates.test.mjs`（新規、`test:chat`へ登録済み）。
- `docs/CHAT-ADMIN-PERMISSIONS.md` に設計を追記（正本）。

ローカル検証の結果:

- `npm run test:chat` 66/66成功（従来57 + 新規9）。
- `npm run check` 成功。`deno check supabase/functions/chat-push/index.ts` 成功。
  `admin-api/index.ts` の `deno check` エラー数は変更前後とも184で、新規コード起因の型エラーはなし。
- `git diff --check` クリーン。
- `./scripts/local-line-report-pages.sh` でPC(1280) / 390px / 320px を実画面確認済み。
  行内ボタンの折返し、テンプレートバーの高さ、差分表の列幅を修正済み。

実DB試験（2026-08-24・本番hocbn・`BEGIN → 適用 → 試験 → ROLLBACK` を1トランザクションで実行）:

- **42アサーションすべて成功**。想定外の例外なし。
- ROLLBACK後の確認: テーブル・列・関数いずれも残存0、`chat_admin_audit_log` 0件、
  参加行57件のまま、`can_view=false` の行0、`supabase_migrations` 未記録、残留トランザクション0。
- 権限: 新4RPCすべて `anon=false / authenticated=false / service_role=true`。
  `chat_permission_templates` はRLS有効・policyなし・anon/authenticatedはSELECT不可。
- 挙動: dry_runは行も監査ログも書かない／viewer適用と`can_view=false`カスケード／
  1対1に`room_admin`を適用しても招待・管理はfalse／Botは`skipped`で変更0件／
  実効アクセスが`room_view_denied`を返す／復元で値が戻り`audit_revert`が`source_audit_id`付きで残る。
- 拒否: 二重復元、ホワイトリスト外(`template_apply`)の復元、対象未指定、不明テンプレート。
- 競合: 後から更新済みの復元は本実行・dry_runとも `40001`。
- 攻撃試験: `set local role anon` / `authenticated` から新3RPC・テンプレート表・監査ログの
  すべてが `42501` で拒否。

Advisors（適用前ベースライン・security）: 209件 / ERROR 1（`foodcourt_daily_features` の
SECURITY DEFINER view。本件と無関係の既存）/ WARN 54 / INFO 154。
`chat_admin_audit_log` の `rls_enabled_no_policy` は INFO で、service-role専用という意図的な構成。
反映後は `chat_permission_templates` の同種INFOが1件増えるのが想定どおりで、
新規のWARN/ERRORは出ない見込み（新4RPCはanon/authenticatedへEXECUTEを渡していないため）。

反映結果（2026-08-24）:

- Deploy Edge Functions `32655472145` 成功、Deploy GitHub Pages `32655472135` 成功。
- migration `20260825010000` 適用済み（`supabase_migrations` の最新）。
- 本番の新4RPCは `anon=false / authenticated=false / service_role=true`。
  `chat_permission_templates` はRLS有効・policyなし・組込3件。
- Pages `chat-admin.html` HTTP 200 で新UI（テンプレート／アクセス／復元）を配信中。
  未認証の `/chat-admin/templates`・`/chat-admin/state`・`/chat-admin/audit/1/revert` は401、
  不正トークンでの `POST /chat-admin/templates/apply` も401。
- `admin-api` v1005 ACTIVE、`chat-push` v123 ACTIVE。
- 既存データは無変化（参加行57件、`can_view=false` の行0、監査ログ0件）。

反映後のAdvisors差分（209 → 211）:

- `chat_permission_templates` の `rls_enabled_no_policy`（INFO）＝ service-role専用の意図的な構成。
- `chat_admin_normalize_member_permissions` の `function_search_path_mutable`（WARN）
  ＝ **付け忘れ**。`20260825020000_chat_admin_normalize_search_path.sql` で修正した
  （判定ロジックは不変、実行権限も service_role 専用のまま）。

**注意**: migration `20260825010000` / `20260825020000` はファイル名の日付が実施日
（2026-08-24 JST）より1日進んでいる。適用済みのため改名しない。次に追加する
chat系 migration は `20260825020000` より後の版番号にすること。

### 実装内容の要点（設計判断）

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

- `supabase/migrations/20260825010000_chat_admin_templates_access_revert.sql`: 2026-08-24追加分の基準。
- `tests/chat_admin_templates.test.mjs`: テンプレート／アクセス一覧／復元の契約テスト。
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

- 2026-08-24のローカル実装を、実DB試験のうえ本番へ反映してよいか。
- 一括適用の上限は100件。2026-08-24の本番実測（全参加行57、1ルーム最大3人、
  1ユーザー最大27ルーム）に対する被害範囲の制限として設定した。利用者が増えたら見直す。
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
