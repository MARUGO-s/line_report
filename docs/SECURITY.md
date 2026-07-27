# セキュリティ概要（line_report）

LINE 売上／レシート／予約管理システム（約22店舗）の**セキュリティ構造・監査結果・是正内容・運用規約**をまとめた中核ドキュメント。
利用許可・ルーム承認の運用詳細は [LINE-USER-APPROVAL-SECURITY.md](./LINE-USER-APPROVAL-SECURITY.md)、用語は [DOCS-INDEX.md](./DOCS-INDEX.md) を参照。

**本番:** Supabase `hocbnifuactbvmyjraxy`（hocbn）／GitHub Pages `https://marugo-s.github.io/line_report/`
**最終監査:** 2026-06-14（多観点コード監査＋DB権限/ストレージ直接検証＋是正）

---

## 1. セキュリティの基本構造（不変条件）

この7つは「新しい関数・エンドポイント・テーブルを足すたびに必ず守る」恒久ルール。

1. **公開フロントは直接DB/RPCを叩かない。** GitHub Pages の静的HTML/JS は全世界に公開される前提。業務データへのアクセスは**すべて Edge Function 経由**（`admin-api` / `line-webhook` 等）。Edge Function は `SUPABASE_SERVICE_ROLE_KEY` で接続する。`public/pages-config.js` の anon JWT は Edge Function 呼び出しの Bearer 用で**公開して問題ない**（脆弱性にしない）。
2. **anon / authenticated に SECURITY DEFINER 関数の EXECUTE を渡さない。** SECURITY DEFINER は RLS をバイパスするため、公開 anon キーで叩けると致命的。
3. **admin-api の店舗スコープは「許可リスト＋store強制」で守る。** ある店舗の資格で他店舗のデータを読めてはいけない（IDOR 防止）。
4. **LINE Webhook の署名検証はフェイルクローズ。** secret 未設定でも必ず拒否する（`return false`）。
5. **新しい関数には `SET search_path = public` を固定**し、**新しい RLS ポリシーは `auth.x()` を `(select auth.x())` で包む**（[supabase-advisor 規約]）。
6. **本番スキーマ変更は必ず migration ファイル経由。** GitHub 統合が main マージで自動適用する。MCP 等で直接 DDL を打つと履歴がズレる。
7. **公開システムマップはコード・SQL構造だけ。** Graphify入力から`.env*`、`.local`、backups、data、node_modules、vendor、生成物を除外し、投稿/メッセージ/レシート/顧客/添付メディア等の実データを含めない。通常導線`public/system-map.html`（公開URL`/system-map.html`）は既存管理セッションを`/auth/verify`で検証してからiframeを読み込む。

---

## 2. DB 層の防御（2026-06-14 に実データで検証）

| 検査項目 | 結果 |
|----------|------|
| anon / authenticated が EXECUTE できる SECURITY DEFINER 関数 | **0**（RLS バイパス不可） |
| RLS 無効かつ anon に権限があるテーブル | **0 / 148**（PostgREST 素通りなし） |
| anon / public を通すゆるい RLS ポリシー | **0**（全ポリシーが service_role 限定） |
| ストレージバケット `line-media` | **非公開**（anon 直接アクセス不可・署名URL/service_role経由のみ） |
| RLS 有効・ポリシー0（＝全拒否）のテーブル | 95（業務データは service_role 経由のみ＝設計どおり） |

**結論:** フロントの公開 anon キーでは業務データに一切到達できない。実質的な防衛線は **admin-api の独自認証＋店舗スコープ** と **LINE Webhook 署名** に集約される。

### Supabase Advisor（DB リンタ）
- セキュリティ WARN は **0**（`function_search_path_mutable` 26→0 で是正済み）。残 WARN は `extension_in_public`(pg_trgm) 1件＝意図的据え置き。
- パフォーマンス WARN は **0**（`auth_rls_initplan` 51→0 で是正済み）。残は INFO の `unused_index` / `unindexed_foreign_keys`（低優先）。
- **DDL 変更後は `get_advisors` を再実行**して RLS 付け忘れ等を早期検知すること。

---

## 3. 認証・認可

### 3.1 admin-api（管理画面 API）
- 認証は `x-admin-token`。生 admin トークン（`/auth/session`）と、LINE ログインリンク由来のセッショントークン（`/auth/link-login` → `lrst_` セッション・TTL 24h・単一使用）の2系統。比較は SHA-256＋`secureEqual`。
- **店舗スコープ強制**: ログインリンク由来セッションは `store_partition_key` を持ち、認証ゲート直後で①許可パス(`STORE_SCOPED_ALLOWED_PATHS`)以外は403、②URL/body の `store`/`store_key`/`store_partition_key` を scope へ強制（他店明示で403）、③petty-cash の id 編集/削除は自店行のみ。**スコープ付きページに新パスを足したら `STORE_SCOPED_ALLOWED_PATHS` にも追加**（逆に全店専用パスは足さない）。
- **レート制限**（2026-06-14 堅牢化）: キーに使うクライアントIPを**詐称不可の情報源優先**で解決（`Deno.serve` の `info.remoteAddr`(公開IP時)→`cf-connecting-ip`→`x-real-ip`→`x-forwarded-for` の**末尾**）。`/auth/session` は **20回/分**、アップロードは 12回/分、既定 180回/分。`consume_security_rate_limit`(SECURITY DEFINER, service_role)で集計。

### 3.2 verify_jwt=false の Edge Function
`line-webhook` / `line-admin-webhook` / `admin-api` / 各 cron は `config.toml` で `verify_jwt=false`（Supabaseゲートウェイ認証なし）。**認可は関数側で実施**する:
- LINE Webhook → 署名検証（§4）
- cron → `CRON_AUTH_TOKEN` ゲート（§5）／テスト経路は `X-*-Test-Key`
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

- **署名検証はフェイルクローズ**（2026-06-14 是正）。`verifyLineSignature` は `channelSecret` 未設定なら `return false`（旧実装は `return true` で素通し＝偽造 webhook 注入の穴だった）。対象: `line-webhook/index.ts` と `_shared/line_admin_webhook.ts`。
- 各店舗・ADMIN の `LINE_CHANNEL_SECRET__<STORE>` / `LINE_CHANNEL_SECRET__ADMIN` は全て設定済み（HMAC-SHA256 で検証）。
- 承認管理者 ID は **`LINE_USER_APPROVAL_ADMIN_USER_IDS`(env) からのみ解決**（ハードコードは撤去済み＝公開リポジトリでの露出を防止）。
- 別系統の `cloudflare-worker/src/index.js`・`src/server.js`（旧 LINE-WINE アプリ）にも同種の署名検証があるが、本番は Supabase Edge が処理する。

---

## 5. cron セキュリティ

- `gmail-alert-cron` / `receipt-midreport-cron` の**本処理（定期実行パス）に `CRON_AUTH_TOKEN` 一致ゲート**を追加（フェイルクローズ・定数時間比較）。未認証での乱用＝コスト/クォータ増幅 DoS を防ぐ。
- pg_cron は `Authorization: Bearer <resolve_edge_cron_auth_token()>` で各関数を呼ぶ。`resolve_edge_cron_auth_token()` は vault の `CRON_AUTH_TOKEN`→無ければ anon キーへフォールバック。
- ⚠️ **ゲートを有効化するには `CRON_AUTH_TOKEN` を「vault（pg_cron 送信用）」と「Edge Secret（関数の検証用）」の両方に同値で設定**する必要がある。**未設定の現状はゲートが無効（＝従来どおり通す＝無停止）**。設定するまで cron 本処理は実質無認証（ただし冪等性で多重送信は防止）。
- `receipt-sheets-sync-cron` は191行に全体の `isAuthorized` フェイルクローズ・ゲートあり（pg_cron 非スケジュール・GAS/admin から呼ばれる）。

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
| CSP の `unsafe-inline` 排除 | 629KB の index.html のインライン JS を全面 nonce 化が必要＝高工数・高リスク |
| セッショントークンの localStorage 保持 | sessionStorage 化はログイン永続の UX 変更＝要ユーザー判断 |
| 管理トークンが未ソルト SHA-256・最小8文字 | トークン強度の運用判断（強い値の設定で緩和可） |
| レガシー webhook `src/server.js` 撤去 | 旧 LINE-WINE アプリの一部・README が参照＝保持 |
| webhook の timestamp 鮮度チェック | LINE の再送（遅延あり）を誤って落とすリスク＋イベントID冪等で代替済み |
| レシート OCR のプロンプトインジェクション | 経理値の汚染リスクだが影響限定 |

---

## 9. 新規追加時のチェックリスト

- [ ] 新しい SECURITY DEFINER 関数 → anon/authenticated に EXECUTE を**渡さない**＋`SET search_path = public`
- [ ] 新しい RLS ポリシー → `auth.x()` を `(select auth.x())` で包む。anon に開けるなら店舗スコープを必ず確認
- [ ] 新しいテーブル → 内部用なら「RLS 有効・ポリシー無し（全拒否）」、クライアント可読なら店舗スコープのポリシー
- [ ] 新しい admin-api パス → スコープ付きページが使うなら `STORE_SCOPED_ALLOWED_PATHS` に追加、全店専用なら追加しない
- [ ] 新しい `verify_jwt=false` 関数 → 関数側で認可を実装＋`config.toml` に `verify_jwt=false` を追記
- [ ] 新しい署名/トークン照合 → 定数時間比較・secret 未設定はフェイルクローズ
- [ ] スキーマ変更 → migration ファイル経由（直接 DDL 禁止）。適用後に `get_advisors` を再実行
- [ ] コード/SQL構造変更 → `npm run knowledge:update` と `npm run knowledge:check`。GraphifyのSQL coverageが全migrationを含むこと

---

## 10. 検証クエリ（不変条件のセルフチェック）

```sql
-- ① anon/authenticated が EXECUTE 可能な SECURITY DEFINER 関数（0 であること）
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prosecdef
  and (has_function_privilege('anon',p.oid,'EXECUTE')
       or has_function_privilege('authenticated',p.oid,'EXECUTE'));

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
