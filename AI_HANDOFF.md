# LINE Report AI Handoff

## 2026-09-01 マルゴエスAIチャットの任意フードコート深掘り

- 通常のマルゴエスAI分析／チャットは、既存 `GET /foodcourt/journal-brief` の軽量な東京ドーム・コート内順位背景を維持する。
- Web版AIチャットで会場・競合要因が有効な質問だけ、「現在のAI分析でもかなり踏まえている」と説明してから、さらにブーストするかを1回確認する。追加時間・API料金増加・失敗／再試行分の課金可能性を同意前に表示する。他店・M-talk・単純照会は対象外。
- 同意時はJournal分析と専用 `POST /foodcourt/journal-deep-analysis` を並列開始し、両方成功時だけ `ai-analyze action=integrate_foodcourt` を別呼出しする。Journal確定集計が数値の正本。
- dedicated routeは `marugos` とJournal店舗スコープに限定し、通常 `/foodcourt/ask` を開放しない。会話履歴を使わず `foodcourt_qa_history` に保存しない。
- 部分失敗は成功結果を捨てない。専門側失敗はJournal、統合失敗は未統合2本＋警告、Journal側失敗は専門結果だけを完成分析にせずローカル確定集計へフォールバックする。
- 詳細は [docs/HANDOFF-2026-09-01-JOURNAL-FOODCOURT-CLASSIFICATION.md](./docs/HANDOFF-2026-09-01-JOURNAL-FOODCOURT-CLASSIFICATION.md) の3.5。

## 2026-09-01 Journal分類拡張とマルゴエスAIのフードコート要約

- 正本の続き: [docs/HANDOFF-2026-09-01-JOURNAL-FOODCOURT-CLASSIFICATION.md](./docs/HANDOFF-2026-09-01-JOURNAL-FOODCOURT-CLASSIFICATION.md)
- 分類UI改善（移動済みを隠す、1件戻す、大分類確定、中身閲覧、未分類へ戻す、チャージ上書き禁止、赤／白デキャンタml）はすでに `main`（`70950dc`〜`8a034f3`）。
- この続きで、ロゼ／オレンジデキャンタ、ハイボール→アルコール／有名カクテル→カクテルの名前自動分類、マルゴエス専用 `GET /foodcourt/journal-brief` を Journal AI へ要約注入した。
- 追記: ワインmlはグラス赤／ボトル赤など細分類も数える。大分類「飲料」のままの銘柄は0点のまま。分類済みでも「ワイン判断不可」と出たら、細分類まで入っているか確認する。
- **禁止:** `foodcourt.html` 全件・期間サマリーGroq再生成を Journal に載せない。コート売上をジャーナル正本にしない。他店へドーム要因を付けない。ハイボール判定でカタカナ `ー` を消さない。
- 作業コピーは Dropbox の `line_report-main`。Codex の `line-report-mtalk-release` ではない。

## 2026-08-28 CAVACAVA実LZHと店舗コード1020

- 実LZH`101520260605221707610001.lzh`を共通パーサーで解析し、本番の同一SHA-256原本ID 162と照合した。営業日2026-06-05、総売上70,400円、2組・6名・2会計が一致する。
- 本番には旧コード`1020`のCAVACAVA原本が35件あり、全件`bistrocavacava`、ファイル名・Storage原本・SHA-256も整合する。2025年2月／11月のKIOXIA再アップロード待ち35行という既存記録に該当する。
- `20260910020000_pos_journal_store_code_1020.sql`と`POS_JOURNAL_STORE_CODE_MAP`で、1020をBistro CAVACAVAへ追加する。別店舗へ誤登録済みならmigrationは上書きせず失敗する。
- 10分限定のCAVACAVA店舗セッションでStorage原本を読み、35/35件の再解析に成功。2025-02は13件・940,010円・42会計、2025-11は22件・1,383,300円・72会計。セッションは削除済み（残存0）。
- `npm run test:ci`、`npm run check`、POS関連76件、PC／390px実画面、Graphify／knowledge（SQL coverage 287/287）は成功済み。
- PR #215の本番反映後に35原本のファイル名・容量・SHA-256を再照合し、既存プレースホルダへ修復済み。新規0・重複0・失敗0、保存レポート4件と過去売上日次／月次を同じ確定額で更新し、一時セッションも残存0件。
- 2025-11-12は正常解析済みの売上0円・会計0件。今後これを未解析と誤認しないよう、パーサー出力に`parsed_complete=true`を付け、`20260910030000_pos_journal_zero_sales_complete_marker.sql`は検証済みファイル名・SHA-256・全ゼロ集計が一致する当該行だけを補正する。

## 2026-08-28 M-talk専用の委任管理者

- 優先度4「M-talk専用管理者」を実装した。本部は`public/chat-admin.html`から、M-talk全体／選択店舗／選択ルームと、8つの操作能力を組み合わせて最小権限の管理リンクを発行できる。初期値は閲覧だけ、有効期限は必須（画面初期値30日）。
- 委任セッションは`scope=mtalk_admin`に固定し、`/chat-admin/*`以外の売上・予約・資料・ファイル・店舗設定APIを入口で403にする。従来の店舗・ルーム・cronセッションからM-talk管理APIへ入る逆方向の横展開も拒否する。
- 表示データは許可ルーム・所属ユーザー・店舗Bot・監査ログへ絞ってからJSON化する。投稿本文、添付パス、署名URLは委任管理レスポンスへ含めない。
- 書込みはAPIの能力確認だけで終わらせず、service-role専用`chat_admin_delegated_execute`が委任行を`FOR SHARE`でロックし、有効性・対象範囲の再確認と既存管理RPCの実行を同一DBトランザクションで行う。停止完了後に古い判定の変更が滑り込まない。
- 管理範囲・能力・期限の変更、停止・再開はDBトリガで`session_version`を進める。停止前のログインリンク／セッションは再開しても復活せず、新しいリンクが必要。復元不能なルーム完全削除は本部だけ。
- ローカル実DBの攻撃テストは、許可店舗の更新成功、他店舗・期限切れ・停止済み・一般`authenticated`ロール・完全削除の拒否、監査範囲、世代更新を確認して全成功。`npm run test:chat`はDeno 63/63・Node 137/137、`npm run check`成功。`admin-api`の既存型エラー内訳は基準ブランチと完全一致し、新規増加なし。
- 正本は`docs/CHAT-ADMIN-PERMISSIONS.md`。DB攻撃テストは`tests/chat_admin_delegation_security.sql`。

## 2026-08-27 chat.html分割・M-talk最小権限化

- `public/chat.html`は約10,600行の単一ファイルから、画面構造497行＋`public/chat/`のCSS・11責務別JSへ分割した。読込順と`chat-sw.js`の`CHAT_SHELL`はセットで保つ。
- フロントの権限判定は`public/chat/permissions.js`へ集約したが、正本の強制はDBのRLS・RPC・Storage policy。UIの非表示だけを認可に使わない。
- `20260909010000_chat_least_privilege_cleanup.sql`でanonの`chat_*` GRANT、トリガ専用関数の公開EXECUTE、停止ユーザーのKeep・個人メモ経路を追加で閉じる。`20260909020000_chat_keep_private_active_policy_helper.sql`で、Keep・個人メモのRLSをauthenticatedから実行可能な本人固定ゲート`chat_is_registered()`へ接続する。
- `20260909030000_revoke_authenticated_internal_rpcs.sql`で、M-talk JWTからチャット外のAI使用量・予約再集計・cron／trigger内部関数へ到達する経路を閉じ、service_role/postgresだけを残す。
- `20260909040000_lock_public_write_policies.sql`で、無条件ALLだった週次経営レポートと試合結果のRLSを修正する。週次経営レポートは内部専用、試合結果は公開SELECTのみで、書込みはservice_role専用。
- `20260909050000_harden_security_advisor_boundaries.sql`で、公開SELECT可能だった`foodcourt_daily_features`をsecurity_invoker＋service_role専用へ変更し、予約番号抽出・PV cron関数の`search_path`とEXECUTEも内部ロールへ限定する。
- `20260909060000_revoke_authenticated_chat_internal_helpers.sql`で、画面・RLSから直接使わない内部helper 9件をauthenticatedから剥がした。`20260909070000_self_scope_admin_notice_gate.sql`で、管理者通知の可視性判定を本人またはservice-roleへ固定した。
- 本番Advisorのauthenticated向けSECURITY DEFINERは42件から33件。残りは画面用20 RPC＋RLS/Storage用13 gateに全件分類済みで、anon/public実行可0件・固定`search_path`漏れ0件。架空非メンバー、別ルーム、transaction内停止ユーザー、管理者なりすましをDBで再検証済み。
- 静的テストが実装全体を読めるよう`tests/helpers/chat-page-source.mjs`を追加。`npm run test:chat`はDeno 57/57・Node 132/132（最終権限監査テストを含む）。

## Project

- Production: `https://marugo-s.github.io/line_report/`
- Repository: `MARUGO-s/line_report`, branch `main`
- Working copy: `/Users/yoshito/Library/CloudStorage/Dropbox/web/line_report-main`
- Supabase production project: `hocbnifuactbvmyjraxy`
- Main surfaces: static GitHub Pages, `admin-api`, store-scoped `line-webhook`, cron Functions, Postgres/RLS, private `line-media` Storage.

## 引き継ぎメモ（2026-08-24 時点、複数セッション分を統合・更新済み）

**この節を最初に読むこと。** 前々セッションが利用上限で中断し、その後別セッションが
15コミット分の機能追加を行い、今のセッションがドキュメント整合を取った。

### 本番反映済み（確認済み）

| PR | コミット | 内容 |
| --- | --- | --- |
| [#161](https://github.com/MARUGO-s/line_report/pull/161) | `52d5312` | 権限テンプレート一括適用／ユーザー別アクセス一覧／監査ログ復元 |
| [#162](https://github.com/MARUGO-s/line_report/pull/162) | `07d3fae` | `chat_admin_normalize_member_permissions` の search_path 固定＋反映記録 |
| [#163](https://github.com/MARUGO-s/line_report/pull/163) | — | `docs/M-TALK-COMPLETE-GUIDE.md`（M-talk統合ガイド）追加。**マージ済み** |

その後、別セッションが以下を追加・本番反映済み（migration `20260825030000`〜`20260826040000`）:

- 感情イラストの予約配信・cronディスパッチ統合
- メッセージ単位のサイレント送信（`chat_messages.is_silent`、通知🔔/🔕トグル）
- 検索ランチャー（投稿・通知を発生させないダイアログ直接起動）
- カレンダー予定リマインダーの複数スロット化（最大5件・前日/当日）

検証済み: migration ドリフト0（リポジトリとDBが7件で一致）、Supabase Advisors 210件で
前回セッション終了時から増減なし、`npm run test:chat` 77/77、`npm run check` 成功。

### 今回のセッションで直したこと

前セッションが機能を追加した際、**運用ログ（PROJECT_PROGRESS.md・店舗運用修正記録.md）は
更新したが、機能仕様書2つの更新が漏れていた。** 以下を追随させた。

- `docs/CHAT-TALK-GUIDE.md`（正本）: サイレント送信の新セクション、検索ランチャーの説明、
  予定リマインダーの複数スロット化を反映。
- `docs/M-TALK-COMPLETE-GUIDE.md`（統合版）: 同じ3点を同期。

**この文書自体の記述も是正**: このメモが「#163未マージ」と誤って書いたままになっていたため
更新した（実際は前々セッション終了直後にマージ済みだった）。

### 未着手（ユーザーが依頼済み・繰り越し）

1. **店舗スタッフ向けの共有Webページ** — **実装済み（2026-08-27）**。
   `public/mtalk-help.html`（本番 `/mtalk-help.html`）。使い方だけ。
   テーブル名・管理APIパス・内部構造は載せない。`chat.html` のログイン画面と
   アカウントメニュー「使い方」から開ける。

### 未実施の検証（重要・繰り越し）

- **本番 dry_run の通し実行** — **ユーザー実施済み（2026-08-27）**。
  `chat-admin.html` でルームを選び「変更内容を確認」（`dry_run:true`）を押した。
  管理トークン → admin-api → RPC の配列渡し（`group_ids` / `user_ids`）は本番で通った。

### 次に勧める実装

**検索ジャンプ中の新着穴** — **実装済み（2026-08-27）**。
途中へジャンプ中に新着が来たら `fillLatestGap()` が間を読み足す。見ていた位置は維持。

**一覧の参加ボタン** — **実装済み（2026-08-27）**。
「招待で参加」に改称し、招待リンクを貼ると `chat_join_by_invite` で入る。
グループIDでの無断参加はしない。

複数ルームへの一括適用UIは実装済み（2026-08-27）。

ロードマップ7（実効権限チェック）はアクセス一覧で実質達成済み。
8・9は現在の規模（有効ルーム26・参加行57、2026-08-24時点）では時期尚早。
4・6・7は実装済み。5・8・9・10は今後の判断対象。

### 教訓（次のセッションへ）

機能追加のたびに、運用ログ（PROJECT_PROGRESS.md・店舗運用修正記録.md）と
**機能仕様書（CHAT-TALK-GUIDE.md・必要なら統合ガイド）の両方**を更新する。
片方だけ更新して終わると、次のセッションが仕様書だけを見て古い情報のまま作業する。

### 注意

- migration `20260825*` はファイル名の日付が実施日（2026-08-24 JST）より1日進んでいる。
  適用済みのため改名しない。
- ローカルのプレビューサーバー（ポート8765）が起動したままの可能性がある。
  `lsof -ti tcp:8765 | xargs kill` で停止する。

---

## Active handoff — M-talk管理画面の次期改善（2026-08-24 / 2026-08-24更新）

### 次のAIが最初に知ること

- ユーザーは、実装済みのM-talk専用管理画面を土台に、追加すると便利な管理機能を次のAIへ引き継ぎたい。
- 2026-08-24時点の管理・権限機能は本番反映済み。
- **推奨3点セット（権限テンプレート／ユーザー別アクセス一覧／監査ログ復元）は本番反映済み（2026-08-24）。**
  詳細は下の「2026-08-24 実装・反映」を読む。優先度4のM-talk専用管理者、6の承認制、7の実効権限表示も実装済み。
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
| 4 | M-talk専用管理者 | **実装済み（2026-08-28）。M-talk全体／店舗／ルーム＋操作能力を最小付与** |
| 5 | 期限付きルーム権限 | 指定日時まで閲覧のみ／送信停止などを設定し、DB判定で自動解除する |
| 6 | 新規ユーザー承認制 | **実装済み（2026-08-27）。許可後は閲覧のみ** |
| 7 | 実効権限チェック | **実装済み。全体停止、削除、期限、ルーム権限の拒否理由を表示** |
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
- 管理画面のinline JavaScriptと、`public/chat/`へ外部化した全JavaScriptの構文解析成功。
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
