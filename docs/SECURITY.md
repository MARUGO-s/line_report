# セキュリティ概要（line_report）

LINE 売上／レシート／予約管理システム（約22店舗）の**セキュリティ構造・監査結果・是正内容・運用規約**をまとめた中核ドキュメント。
利用許可・ルーム承認の運用詳細は [LINE-USER-APPROVAL-SECURITY.md](./LINE-USER-APPROVAL-SECURITY.md)、用語は [DOCS-INDEX.md](./DOCS-INDEX.md) を参照。

**本番:** Supabase `hocbnifuactbvmyjraxy`（hocbn）／GitHub Pages `https://marugo-s.github.io/line_report/`
**最終監査:** 2026-08-28（一般利用者・ルーム管理者・店舗リンク・cronを含む認可境界を本番DBとコードで再検証）

---

## 1. セキュリティの基本構造（不変条件）

この8つは「新しい関数・エンドポイント・テーブルを足すたびに必ず守る」恒久ルール。

1. **公開フロントは全世界から読める前提で、秘密を置かない。** 売上・予約・レシート等の業務データは**すべてEdge Function経由**（`admin-api` / `line-webhook`等）。例外はM-talk専用の`chat_*`と非公開`chat-images`で、Supabase Authの本人JWT＋RLS＋権限検査付きRPCだけを使う。ブラウザへ`service_role`を渡さず、M-talkから業務テーブルへ直接到達させない。`public/pages-config.js`のanon JWTは公開キーであり、単体ではデータアクセス権にならない。
2. **anon に SECURITY DEFINER 関数の EXECUTE を渡さない。** `authenticated` への例外は、`auth.uid()` とM-talk権限を関数内で再検査するレビュー済みRPCだけに限定する。トリガ専用・管理用・service_role専用関数は `authenticated` からも実行不可にする。
3. **admin-api の店舗リンクは「店舗＋用途＋HTTPメソッド」の三重スコープで守る。** ある店舗・画面の資格で、他店舗、別画面、管理者向け書込みへ到達させない（IDOR・権限横展開防止）。
4. **LINE Webhook の署名検証はフェイルクローズ。** secret 未設定でも必ず拒否する（`return false`）。
5. **新しい関数には `SET search_path = pg_catalog, public`（必要な拡張schemaを追加）を固定**し、**新しい RLS ポリシーは `auth.x()` を `(select auth.x())` で包む**（Supabase Advisor規約）。
6. **本番スキーマ変更は必ず migration ファイル経由。** GitHub 統合が main マージで自動適用する。MCP 等で直接 DDL を打つと履歴がズレる。
7. **公開システムマップはコード・SQL構造だけ。** Graphify入力から`.env*`、`.local`、backups、data、node_modules、vendor、生成物を除外し、投稿/メッセージ/レシート/顧客/添付メディア等の実データを含めない。通常導線`public/system-map.html`（公開URL`/system-map.html`）は既存管理セッションを`/auth/verify`で検証してからiframeを読み込む。
8. **認証設定が無いときは管理APIを開けない。** Edge・レガシーExpressとも、secret/管理トークン未設定、DB照合失敗、不正応答を「許可」と解釈せず401/503でフェイルクローズする。大容量bodyは認証後にだけ解析する。

---

## 2. DB 層の防御

次の表は全業務DBを対象にした **2026-06-14 時点の監査スナップショット**。M-talk追加後の差分は表の直後に記載する。

| 検査項目 | 結果 |
|----------|------|
| anon / authenticated が EXECUTE できる SECURITY DEFINER 関数 | **0**（RLS バイパス不可） |
| RLS 無効かつ anon に権限があるテーブル | **0 / 148**（PostgREST 素通りなし） |
| anon / public を通すゆるい RLS ポリシー | **0**（全ポリシーが service_role 限定） |
| ストレージバケット `line-media` | **非公開**（anon 直接アクセス不可・署名URL/service_role経由のみ） |
| RLS 有効・ポリシー0（＝全拒否）のテーブル | 95（業務データは service_role 経由のみ＝設計どおり） |

**結論:** フロントの公開 anon キーでは業務データに一切到達できない。実質的な防衛線は **admin-api の独自認証＋店舗スコープ** と **LINE Webhook 署名** に集約される。

### 2026-08-27 M-talk差分監査

- 全27個のM-talk関連テーブルでRLS有効を確認。架空のauthenticated非メンバーJWTから、ルーム・メッセージ・メンバー・添付メタデータはいずれも0件だった。
- `chat-images`は非公開。`chat-icons`だけはプロフィール・ルームアイコン表示用の公開バケットで、重要ファイルを置かない。
- M-talk追加後に、匿名ロールへ残っていた`chat_*`の直接GRANT、トリガ専用関数3件のEXECUTE、停止ユーザーのKeep・個人メモ操作、`chat_store_bot_id`の可変`search_path`を検出した。`20260909010000_chat_least_privilege_cleanup.sql`で是正した。Keep・個人メモのRLSは、任意ユーザーを検査できるservice_role専用helperを直接呼ばず、`20260909020000_chat_keep_private_active_policy_helper.sql`で`auth.uid()`本人に固定されたauthenticated用wrapperへ接続する。
- Advisorのauthenticated向けSECURITY DEFINER 42件を用途で全件分類した。画面が直接使う20 RPCと、RLS・Storageが使う13自己スコープgateだけをauthenticatedに残し、内部helper 9件は`20260909060000_revoke_authenticated_chat_internal_helpers.sql`で`postgres / service_role`専用にした。残る33件はanon/public実行可0件、固定`search_path`漏れ0件。
- `chat_can_see_admin_notice(group_id, user_id)`はRLSからauthenticated実行が必要だが、任意の`user_id`で管理者状態を推測できないよう、`20260909070000_self_scope_admin_notice_gate.sql`で本人またはservice-roleに固定した。管理者本人=true、他ユーザーからの照会=false、Push用service-role=trueを本番DBで確認した。
- 本番DBで架空非メンバー、正規利用者、非参加ルーム、transaction内で一時停止した利用者を再検証した。非メンバーと非参加ルームは本文・所属・添付0件、停止時は本文・Keep・個人メモ・添付0件。停止操作は同一transactionでROLLBACKし、本番データを変更していない。
- `20260910040000_security_authorization_hardening.sql`で`pg_trgm`を`extensions` schemaへ移し、既存indexのOID参照を保ったままpublic配置警告を解消する。併せて重複index、RLS initplan、重複SELECT policyも権限を広げず整理する。

### 2026-09-02 M-talkメニュー画像の確認登録

- M-talkへ投稿した画像がメニューと判定された場合も、解析結果だけで店舗資料へ自動登録しない。`chat_menu_knowledge_drafts`へ7日間の確認待ち下書きを作り、投稿者本人がカードの「このまま資料に登録」を押した場合だけ、Journal Reportの店舗資料へ保存する。
- `chat_menu_knowledge_drafts`はRLSを有効にし、`public / anon / authenticated`の直接権限をすべて剥がしてservice-roleだけに限定する。ブラウザは表を直接更新せず、本人JWT付きの`POST /chat-menu-knowledge-decision`だけを使用する。
- 決定APIは、投稿者本人、送信可能なルーム参加者、現在承認済みの店舗所属、ルームと店舗Botの結び付き、下書きの店舗、画像の非公開Storageパスを毎回照合する。別ルーム・別店舗・別ユーザーの下書きIDを指定しても登録できない。
- 登録時は同じ非公開`chat-images`原本をサーバ側で再取得し、SHA-256重複検査後に非公開の店舗資料Storageへ保存する。画像パスや解析本文をブラウザから受け直さず、クライアント改ざんによる別画像登録を防ぐ。
- BotカードはDBの編集禁止規則を緩めない。決定後は、操作ボタンを除いた解決済みカードをservice-roleで新規作成して旧カードを削除し、二重クリックは画面側の即時無効化とDB状態遷移の両方で防止する。

### 2026-08-28 全体認可再監査

- 本番のブラウザ権限、全public tableのRLS、Storage bucket/policy、anon/authenticatedのSECURITY DEFINER実行権を再列挙した。業務テーブルはRLS有効で、anonが実行できるSECURITY DEFINERは0。`chat-images`は非公開、公開bucketは重要ファイルを置かない`chat-icons`だけ。
- 重大な境界不備として、通常ルームの作成者に付く`can_manage`が、全店舗の新規登録・所属店舗変更の承認者判定にも流用されていた。一般ルーム管理者が本番トランザクション内で全体承認RPCへ到達できることを確認し、ROLLBACKした。
- `can_review_access`を本部が個人単位で明示付与する方式へ変更した。ルーム作成・`can_manage`だけでは全体承認不可。承認通知ルームも明示承認者だけへ同期し、取消と退出を同一トランザクションで反映する。
- M-talk電子ジャーナルAIは`can_use_journal_ai`を本部が明示付与した利用者だけに限定した。専用30分セッションを店舗・ルーム・本人へ結び、毎API呼び出しで利用状態、制限、ルーム参加、閲覧権限、現在承認済みの店舗所属、ルーム内Botと固定店舗の一致を再確認する。予約者情報・資料・設定・取込・削除APIには到達できない。
- M-talkの店舗Bot経由処理、予定・設定、メディア、電子ジャーナルAIは、ルーム参加だけでなく現在の`chat_user_stores`も必須にした。過去に参加したカスタムルームへ残っていても、所属取消後は次のAPIまたはBot処理からフェイルクローズで拒否する。
- LINE等の店舗リンクを予約、小口現金、売上分析、フードコート閲覧・日報・週次の用途へ分離した。各用途のmethod/path allowlistを最初に適用し、画面の非表示だけに依存せず、許可外操作はAPIで403にする。用途のない旧店舗セッションは失効する。
- 全owned `verify_jwt=false` cronを共通のフェイルクローズ認証へ統一した。公開anon keyへのfallbackを廃止し、`CRON_AUTH_TOKEN`のEdge SecretまたはVault値だけを定数時間比較する。管理APIへ渡したcron資格も予約キャッシュ再構築と週次レポート生成の2経路以外は403。
- レート制限DBが失敗・不正応答になった場合は、管理APIとAI APIを通さず503/拒否にする。LINE署名はHMACの`crypto.subtle.verify`で検証し、テスト送信秘密はURLクエリで受けず専用headerだけに限定する。
- 旧LINE-WINE用Express管理APIは、`ADMIN_TOKEN`未設定時に全`/api`を許可していたため、ヘルスチェック以外を503で閉鎖した。20MB JSON parserより先に認証を実行し、無認証healthからDBパス・モデル・外部サービスIDを除外、新規トークンを32文字以上にした。
- Excel/CSV取込は圧縮前8MB・10万行で制限する。店舗ナレッジのPDF/Word/Excelは解析・保存前に形式を検査し、Office ZIPのentry数、展開後容量、圧縮率、必須XML、危険なentry pathを確認する。安全な事前検査ができない旧`.xls`は拒否し`.xlsx`だけを受ける。
- 外部APIキーはAPIが対応する限り認証headerで送る（Gemini/Places New等）。SerpAPIとPlaces Legacyのように仕様上query keyが必要な例外はHTTPS限定・URL非ログ・API制限付きキーとし、対応APIへ移行できる経路では残さない。
- 週次フードコート画面は、AI本文・店舗名をHTMLとして解釈せず`textContent`中心の許可リスト描画にした。Chart.jsは同一オリジンの固定vendor資産を使い、CSPと`no-referrer`を付ける。AIやDB値から`script`・event属性・外部scriptを注入できない。
- 本番DDL後のAdvisor再検査はINFO 157件（RLS有効・policyなし＝内部表の全拒否）とWARN 33件（本人・所属・権限を内部検査するM-talk RPC）で、ERROR 0件。匿名実行可能なSECURITY DEFINERは0件を維持する。

### Supabase Advisor（DB リンタ）
- 2026-06-14監査では `function_search_path_mutable` 26件と `auth_rls_initplan` 51件を0件まで是正した。
- 以後に追加された機能は警告が再発し得る。**DDL 変更後は `get_advisors` を再実行**し、機能名・関数名単位で新規警告を確認する。

### 2.1 トークWeb Push
- `chat_push_subscriptions`のendpoint・暗号鍵はData APIへ公開せず、`chat-push`がservice roleで管理する。
- ブラウザの購読登録／解除／設定変更はSupabase Auth access tokenを関数内で検証する。
- `chat_messages` INSERT後の内部dispatchはDB生成シークレットを定数時間比較し、VAPID秘密鍵はSupabase Vault（またはEdge Secret）だけに置く。
- 購読endpointはHTTPS/443かつFCM、Mozilla Push、Apple Pushの公式ホストだけを許可する。endpoint長とP-256/auth鍵のbase64url長を検査し、不正な既存購読は送信せず自動停止する。任意URLへのWeb Pushを許可せずSSRFを防ぐ。
- 自分の送信は除外、メッセージID単位で重複防止、Pushサービスが404/410を返した購読は自動停止する。
- アイコン用未読合計は`chat_push_unread_totals(uuid[])`で計算する。このSECURITY DEFINER関数は`service_role`だけにEXECUTEを許可し、メッセージ本文や購読鍵を返さない。
- Service Workerは通知URLを同一オリジンの`/line_report/chat.html`（任意の正整数`group`だけ）へ再検証する。通知由来の外部URL・任意パス・任意アイコンを開かず、診断キューと静的asset cacheも別cacheへ固定する。

### 2.2 M-talk専用の利用・ルーム権限

- `chat_user_access`はM-talkだけの利用停止・一時制限・論理削除を保持する。Supabase AuthやLINE Botの`line_user_permissions`は変更しない。
- `can_review_access`（新規登録・所属店舗変更の全体承認）と`can_use_journal_ai`（電子ジャーナルAI）は本部限定の明示権限。一般利用者、通常ルーム管理者、委任管理者は付与・変更できない。
- `is_full_admin`は本部だけが認定・解除できるM-talk全権管理者。認定時に全店舗・全共有ルーム・全機能を同期し、将来追加される店舗・共有ルームも自動付与する。個人間の1対1は含めない。通常の委任管理者・ルーム管理者・本人による変更はDBで拒否する。
- `chat_group_members`の`can_view / can_send / can_invite / can_manage`を、画面表示だけでなくメッセージ、Realtime、検索、既読・未読、リアクション、Storage、Push、予約送信、ルームRPCで強制する。
- Data APIの列権限も最小化する。一般利用者が直接`UPDATE`できるのは、`chat_groups`の表示名・アイコン、`chat_users`の自分の表示名・アイコン、`chat_messages`の本文・メンションだけ。ルーム所有者・店舗紐付け・投稿者・投稿先・投稿種別・作成時刻・編集履歴等は、RLSと保護トリガに加えてSQL GRANTでも変更不可にする。
- 店舗Botを通じる管理APIと`chat-knowledge`は、ルーム権限に加えて現在承認済みの`chat_user_stores`を毎回確認する。所属取消、Bot退出・差替え、ルームと固定店舗の不一致は既存リンク・セッションを含め拒否する。
- 生のメンバーINSERT/DELETEとルームINSERTは許可せず、権限検査付きRPCだけでルーム作成・招待参加・メンバー追加を行う。
- `anon`から全`chat_*`テーブル・sequence権限を剥がす。RLSだけでなくSQL GRANTでも匿名アクセスを拒否する。
- 停止・一時制限・論理削除中は、本文・添付に加えてKeepと個人メモもData APIから取得・変更できない。
- トリガ専用のSECURITY DEFINER関数は`public / anon / authenticated`のEXECUTEを剥がし、RPCとして露出させない。
- M-talkのauthenticated JWTを管理者資格として使わない。AI使用量集計、予約集計再構築、cron起動・履歴削除などの内部関数は`public / anon / authenticated`から剥がし、service_role・postgresだけに限定する。
- `using (true)`のRLSポリシーを名前だけでservice-role専用と判断しない。週次経営レポート等の内部テーブルはGRANTとpolicyの両方をservice_roleに限定し、公開データを読む必要がある表もanon/authenticatedにはSELECTだけを与える。
- 内部テーブルを束ねるviewも公開しない。`foodcourt_daily_features`は`security_invoker`を有効にし、Data APIの`anon / authenticated`からSELECT権限を剥がしてservice_roleだけに限定する。
- 店舗Bot UUID生成などの補助関数も`search_path`を固定し、名前解決の差し替えを許さない。
- `public/chat-admin.html`は`admin-api /chat-admin/*`を使用する。ブラウザへservice roleを渡さない。本部は`chat_admin_delegations`でM-talk全体／選択店舗／選択ルームと8つの操作能力を最小付与できる。委任は有効期限必須・初期`view`だけ。委任セッションは`scope=mtalk_admin`専用で、通常の売上・予約・資料・店舗設定APIは入口で403。各書込みは`chat_admin_delegated_execute`が委任行をロックし、`chat_admin_delegation_allows_*`による対象確認と実変更を同一トランザクションで行う。委任停止・期限切れは既存セッションにも即時反映する。管理範囲・操作権限・期限の変更、停止・再開ごとに`session_version`を増やし、旧リンクと旧セッションを恒久失効させる。復元不能なルーム完全削除は本部だけ。従来の店舗・ルーム・cronスコープは`/chat-admin/*`を403にする。
- 新規の人間ユーザーは全店舗ルームへ自動参加しない。所属店舗の承認後、その店舗ルームだけ閲覧権限で入る。`chat_group_members`の送信・招待・管理の既定は false。プロフィール作成は `chat_complete_signup` のみ（authenticated の INSERT は不可）。新規登録・所属変更の許可カードは`can_review_access=true`の承認者だけが参加する管理者通知ルームへ送り、予約通知の1対1は復活させない。通常ルームの`can_manage`や店舗ルームの一般メンバーには見せない。
- 管理画面の「ユーザー削除」はM-talk上の論理削除。`auth.users`と`chat_users`を物理削除せず、作成ルーム・過去発言・他アプリのログインを保持する。
- 公開`chat-icons`バケットへの新規アップロードはJPEG/PNG/WebP/GIFだけを許可し、SVGは画面とStorage APIの両方で拒否する。メッセージ添付の`chat-images`は非公開のまま、ルーム権限と保存先パスを照合する。
- 詳細: [CHAT-ADMIN-PERMISSIONS.md](./CHAT-ADMIN-PERMISSIONS.md)

---

## 3. 認証・認可

### 3.1 admin-api（管理画面 API）
- 認証は `x-admin-token`。生 admin トークン（`/auth/session`）と、LINE等のログインリンク（`lrlt_`、原則24時間・単一使用）から交換した`lrst_`セッションの2系統。通常セッションは記憶あり3日／なし12時間。閲覧専用の週次リンクも発行から35日、交換後30分へ制限する。比較はSHA-256＋定数時間比較。
- **店舗・用途スコープ強制**: ログインリンクは`store_partition_key`に加えて`scope`を必須にし、`STORE_LINK_ALLOWED_REQUESTS`で用途ごとのmethod/pathを許可する。その後、URL/bodyの`store`/`store_key`/`store_partition_key`をscopeへ強制（他店明示で403）する。用途のない旧店舗セッション、別用途の交換endpoint、管理者書込みは拒否する。**新しい限定ページを追加する場合は、専用scope、専用allowlist、画面の`targetScopeKind`、拒否テストを同時に追加する。**
- **M-talk委任スコープ強制**: `scope=mtalk_admin` は `/chat-admin/*` とログアウト以外を403にし、`STORE_SCOPED_ALLOWED_PATHS`へ追加しない。`manage_users`はM-talk全体だけ、店舗・ルーム委任は対象内メンバー操作だけ。`revert_audit`も元操作に必要な`manage_users`または`manage_members`を併せて要求する。
- **レート制限**: キーに使うクライアントIPを**詐称不可の情報源優先**で解決（`Deno.serve`の`info.remoteAddr`→`cf-connecting-ip`→`x-real-ip`→`x-forwarded-for`末尾）。全認証交換は20回/分、アップロードは12回/分、既定180回/分。`consume_security_rate_limit`（service_role専用）がエラーまたは不正応答ならフェイルクローズで503にし、無制限へfallbackしない。
- **旧Express API**: `src/server.js`は現行LINE Report本番とは別系統だが、保持する限り同じフェイルクローズ原則を適用する。`ADMIN_TOKEN`未設定時は`GET /api/health`以外を503、誤トークンは401。無認証healthは認証設定済みかだけを返し、詳細診断は正しい管理トークン提示時だけ返す。

### 3.2 verify_jwt=false の Edge Function
`line-webhook` / `line-admin-webhook` / `admin-api` / 各cron / `chat-push` / `chat-knowledge` / `chat-search`は`config.toml`で`verify_jwt=false`（Supabaseゲートウェイ認証なし）。**認可は関数側で実施**する:
- LINE Webhook → 署名検証（§4）
- cron → `CRON_AUTH_TOKEN` ゲート（§5）／テスト経路は `X-*-Test-Key`
- `chat-push`は本人JWTまたは内部dispatch secret、`chat-knowledge` / `chat-search`は内部dispatch secretを検証する（pg_netのBearerはJWTではない）。
- いずれもシークレット照合は**定数時間比較**（タイミング攻撃対策）。

> 新しく `verify_jwt=false` の関数を足すときは、関数側で必ず認可を実装すること。`config.toml` への `verify_jwt=false` 追記を忘れると新形式キーで毎分401になり**サイレント停止**する（過去に gmail-alert-cron で発生）。

### 3.3 ルーム・セルフ設定（room_config スコープ・2026-06-15）
店舗スタッフが**そのルーム1つだけ**の Bot 機能 ON/OFF を、フル管理者を介さず設定できる仕組み。店舗スコープ機構の「ルーム版」。
- **二段ゲート**: LINEで「設定」送信→使い捨てリンク `lrlt_`(24h・単一使用・room_id 埋め込み) ＋ **ルーム個別パスワード**(`room_summary_settings.room_config_password_hash`・SHA-256)。`/auth/room-config-login` がパスワードを**定数時間照合**してから room スコープ session を発行。**誤パスワードでは lt を消費しない**（リトライ可・`/auth/room-config-login` は20回/分）。
- **スコープ強制**: room スコープ session が触れるのは `/room-config`(GET/PUT) のみ（allowlist）。`/state`・`/settings/rooms`・他ルームは 403。`room_id` はサーバ側で session の scope に強制。
- **安全サブセット whitelist**: 保存は機能トグルのみ反映。`bot_access_approved`(承認)・`receipt_report_store_partition_key`(集計店舗)・`is_enabled` 等の機微フィールドはクライアントが送っても**サーバ側で無視**（`ROOM_CONFIG_SAFE_BOOL_FIELDS`）。
- **ハッシュ非露出**: `/state`・PUT応答から `room_config_password_hash` を除去し `room_config_password_set`(boolean) に置換（`stripRoomConfigSecret`）。
- **有効化は管理者のみ**: `room_config_access_enabled` とパスワード設定はフル管理者の `PUT /settings/rooms` 経由（room スコープからは到達不可）。
- 検証済み(2026-06-15): 誤パス401・正パス200・lt未消費・`/state`403・他ルーム403・機微フィールド無視 をデプロイ環境で実証。実装: `_shared/admin_dashboard_link_auth.ts`(exchangeRoomConfigLoginLink)・`admin-api/index.ts`・`_shared/room_config_link.ts`・`room_settings.html`。

---

## 4. LINE Webhook セキュリティ

- **署名検証はフェイルクローズ**。`verifyLineSignature`はsecret/header未設定、Base64不正、HMAC長不正を拒否し、HMAC-SHA256を`crypto.subtle.verify`で照合する。対象: `line-webhook/index.ts`と`_shared/line_admin_webhook.ts`。
- 各店舗・ADMIN の `LINE_CHANNEL_SECRET__<STORE>` / `LINE_CHANNEL_SECRET__ADMIN` は全て設定済み（HMAC-SHA256 で検証）。
- 承認管理者 ID は **`LINE_USER_APPROVAL_ADMIN_USER_IDS`(env) からのみ解決**（ハードコードは撤去済み＝公開リポジトリでの露出を防止）。
- 別系統の `cloudflare-worker/src/index.js`・`src/server.js`（旧 LINE-WINE アプリ）にも同種の署名検証があるが、本番は Supabase Edge が処理する。

---

## 5. cron セキュリティ

- owned cron本処理は共通`isInternalCronAuthorized`を最初に通す。`Authorization: Bearer <CRON_AUTH_TOKEN>`をEdge SecretまたはVaultの同名secretと定数時間比較し、空値、RPC失敗、不一致は必ず拒否する。
- `resolve_edge_cron_auth_token()`はVaultの`CRON_AUTH_TOKEN`だけを返す。ブラウザへ公開される`SUPABASE_ANON_KEY`へfallbackせず、`public / anon / authenticated`からのEXECUTEも剥がす。
- pg_cronは`Authorization: Bearer <resolve_edge_cron_auth_token()>`で呼ぶ。Edge SecretとVaultは同値で維持する。未設定時は処理を継続せず401になるため、監視で設定漏れを検知する。
- cron資格で`admin-api`を呼べるのは`POST /reservations/ai-cache/rebuild`と`POST /foodcourt/weekly-report`だけ。`/auth/verify`を含む他の管理APIは403にする。
- テスト送信は専用`X-*-Test-Key` headerだけを受け、URLクエリに秘密を置かない。`receipt-sheets-sync-cron`はservice_role完全一致、専用同期secret、共通cron認証のいずれかだけを許可し、DBエラーからservice roleを推測しない。

---

## 6. 秘密情報の管理

- **ハードコードされた秘密はゼロ**（git 全コミット走査で確認）。フロントに出るのは anon キーのみ（公開想定）。
- 秘密は hocbn の **Edge Secrets**（`supabase secrets set`）に直接設定。service_role キー・LINE トークン・Google SA 鍵・各 AI キー等。コード/スクリプトは `Deno.env` / CLI 経由で受け取り、リテラル埋め込みなし。
- 移行用 `secret-bridge`（任意の環境変数を平文 DB へ吸い出す経路）と `migration_secret_staging` テーブルは **2026-06-14 に撤去**（本番 undeploy＋コード削除＋テーブル drop）。
- ⚠️ **未了の手動作業**: 撤去した secret-bridge の `SECRET_BRIDGE_TOKEN` / `HOCBN_SERVICE_ROLE_KEY` のダッシュボードでの失効。

---

## 7. 2026-06-14 セキュリティ監査の結果

多観点のコード監査（並列レビュー＋敵対的再検証）＋ DB 権限/ストレージの直接検証を実施。

### 是正した項目
| # | 内容 | コミット |
|---|------|---------|
| 1 | LINE Webhook 署名のフェイルクローズ化＋管理者IDの env 化 | `c226c45` |
| 2 | 移行用 secret-bridge 撤去＋`migration_secret_staging` drop | `045b5aa` |
| 3 | cron 本処理に `CRON_AUTH_TOKEN` 認可ゲート（段階導入） | `5eafa48` |
| 4 | レート制限 IP キーを詐称不可情報源へ＋`/auth/session` 厳格化 | `076f018` |
| 5 | verify_jwt=false 関数のシークレット照合を定数時間比較へ | `1d8ef77` |

加えて DB 健全化（関数 `search_path` 固定 `c42f6e3`／RLS `auth_rls_initplan` 最適化）。

### 良好（確認済み・対応不要）
- admin-api 本体の認証と店舗スコープ IDOR 対策は堅牢。
- DB 層は §2 のとおり anon からの到達不可。

### 敵対的検証が排除した誤検知
- 「`receipt-sheets-sync-cron` が完全無認証(critical)」は**誤検知**。191行の `if(!isAuthorized(req)) return 401` 全体ゲートを見落とした指摘で、実際はフェイルクローズ済み。

---

## 8. 残課題（対応見送り・理由つき）

いずれも影響限定で優先度低。無理に実装すると UX 破壊・機能喪失・大規模改修になるため見送り。

| 項目 | 見送り理由 |
|------|-----------|
| CSP のinline属性排除 | `chat.html`は注入されたinline script要素を遮断済み。ただし既存のinline event属性を105箇所移設するまで`script-src-attr 'unsafe-inline'`が必要 |
| 記憶する限定セッション | 生の本部管理トークンは永続化しない。利用者が「ログイン保持」を選ぶ用途限定`lrst_`だけは期限・scope付きで保持 |
| 固定管理トークンの運用 | 旧Expressの新規トークンは32文字以上。現行Edgeの本部固定トークンも十分なランダム値・定期ローテーションを運用で維持 |
| レガシー webhook `src/server.js` 撤去 | 旧 LINE-WINE アプリの一部・README が参照＝保持 |
| webhook の timestamp 鮮度チェック | LINE の再送（遅延あり）を誤って落とすリスク＋イベントID冪等で代替済み |
| レシート OCR のプロンプトインジェクション | 経理値の汚染リスクだが影響限定 |

---

## 9. 新規追加時のチェックリスト

- [ ] 新しい SECURITY DEFINER 関数 → anonにはEXECUTEを**渡さない**。authenticatedへ公開するのは`auth.uid()`と権限を内部検査するレビュー済みRPCだけ。トリガ・管理・service_role専用関数はauthenticatedにも渡さない＋`SET search_path`固定
- [ ] 新しい RLS ポリシー → `auth.x()` を `(select auth.x())` で包む。anon に開けるなら店舗スコープを必ず確認
- [ ] 新しいテーブル → 内部用なら「RLS 有効・ポリシー無し（全拒否）」、クライアント可読なら店舗スコープのポリシー
- [ ] 新しい admin-api パス → スコープ付きページが使うなら `STORE_SCOPED_ALLOWED_PATHS` に追加、全店専用なら追加しない
- [ ] M-talk権限変更 → RLSだけでなくStorage、Realtime、Push、未読、予約送信時点、`admin-api`のチャットJWT経路にも同じ判定を適用
- [ ] 新しい `verify_jwt=false` 関数 → 関数側で認可を実装＋`config.toml` に `verify_jwt=false` を追記
- [ ] 新しい署名/トークン照合 → 定数時間比較・secret 未設定はフェイルクローズ
- [ ] スキーマ変更 → migration ファイル経由（直接 DDL 禁止）。適用後に `get_advisors` を再実行
- [ ] コード/SQL構造変更 → `npm run knowledge:update` と `npm run knowledge:check`。GraphifyのSQL coverageが全migrationを含むこと

---

## 10. 検証クエリ（不変条件のセルフチェック）

```sql
-- ① anon/authenticated が EXECUTE 可能な SECURITY DEFINER 関数を列挙する。
-- anonは0件であること。authenticatedはレビュー済みM-talk RPCの許可リストと突合する。
select p.oid::regprocedure as function_name,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prosecdef
  and (has_function_privilege('anon',p.oid,'EXECUTE')
       or has_function_privilege('authenticated',p.oid,'EXECUTE'))
order by 1;

-- ② RLS 無効かつ anon に権限があるテーブル（0 であること）
select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity=false
  and (has_table_privilege('anon',c.oid,'SELECT') or has_table_privilege('anon',c.oid,'INSERT')
       or has_table_privilege('anon',c.oid,'UPDATE') or has_table_privilege('anon',c.oid,'DELETE'));

-- ③ anon/public を通すゆるい RLS ポリシー（0 であること）
select count(*) from pg_policies where schemaname='public'
  and roles && array['anon','authenticated','public']::name[]
  and coalesce(qual,'') !~ 'service_role' and coalesce(qual,'') !~* '\(\s*select\s+auth';
```
Advisor は MCP `get_advisors`（type=security / performance）で随時確認。

---

*関連: [LINE-USER-APPROVAL-SECURITY.md](./LINE-USER-APPROVAL-SECURITY.md)（承認フロー運用）／ [DOCS-INDEX.md](./DOCS-INDEX.md)（用語・索引）／ `docs/店舗運用修正記録.md` 2026-06-14（各是正の詳細ログ）*
