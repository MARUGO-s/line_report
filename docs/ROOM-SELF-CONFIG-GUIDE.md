# ルーム・セルフ設定（LINEワンパス＋ルーム個別パスワード）

店舗スタッフが、自分のルームの Bot 機能 ON/OFF を**フル管理者を介さず・そのルーム1つだけ**設定できる仕組み。
LINE から届く使い捨てリンク（ワンパス）＋ルーム個別パスワードの二段で守る。2026-06-15 実装。

- **読者**: 運用（店舗スタッフ／本部）・開発
- **セキュリティ詳細**: [SECURITY.md](./SECURITY.md) §3.3（本書はその全体像＋運用）
- **スタッフ向け簡易手順**: [操作マニュアル.md](./操作マニュアル.md) §6.5
- **本番**: Supabase `hocbnifuactbvmyjraxy`／Pages `https://marugo-s.github.io/line_report/room_settings.html`

---

## 1. 何ができるか / 何ができないか

| できること（スタッフ） | できないこと（管理者専用・サーバ側で遮断） |
|------------------------|---------------------------------------------|
| そのルームの**機能トグル**のON/OFF（AI返信・検索・要約/レポート・レシート/メディア・予約/カレンダー） | **承認状態**（`bot_access_approved`）の変更＝自己承認の回避は不可 |
| 自分のルーム**1つだけ**の閲覧・編集 | **集計店舗の紐づけ**（`receipt_report_store_partition_key`）の変更＝他店データ参照は不可 |
| | **他のルーム**の閲覧・編集／管理画面全体（`/state`・`/settings/rooms` 等） |

> 既存の店舗スコープ・ログインリンク機構（`store_partition_key`）の「ルーム版」。`store_partition_key` を `room_id` に置き換えた scope として実装。

---

## 2. 利用フロー

### 2.1 管理者の準備（最初に1回・ルームごと）
1. 管理画面 **Webhook設定** → 対象店舗カード → **そのルームの「個別設定」**（店舗の「編集」ではない）。
2. 「レシート関連」タブ最下部の **「セルフ設定（LINEワンパス＋パスワード）— このルーム専用」**:
   - **「このルームのセルフ設定を有効化」** をON。
   - **アクセスパスワード**を入力（「表示」ボタンで平文確認可）→ 保存。
3. パスワードをそのルームの担当スタッフに口頭等で伝える。
   - ※このセクションは**ルーム個別モードのときだけ**表示される（店舗の既定設定モードでは非表示）。

### 2.2 スタッフの使い方
1. そのLINEルームで **「設定」**（または「権限設定」「ルーム設定」）と送信。
2. Botが**そのルーム専用リンク**を返す（有効化＋パスワード設定済みのルームのみ。未設定なら案内文）。
3. リンクを開く → **アクセスパスワード**を入力 → 機能をON/OFF（**その場で自動保存**）。
- リンクは **24時間・1回のみ**有効。使用済み／期限切れのときは再度「設定」を送る。

---

## 3. アーキテクチャ（認証フロー）

```
LINEルームで「設定」
   │  line-webhook → room_config_link.ts
   │  room_config_access_enabled=true かつ password設定済みを確認
   ▼
使い捨てリンク lrlt_… を発行（metadata: {scope:'room_config', room_id}）
   │  Flexボタンで room_settings.html?lt=…&room_id=… を返信
   ▼
スタッフがリンクを開く → パスワード入力
   │  POST /auth/room-config-login {login_token, password, room_id}
   │  admin-api → exchangeRoomConfigLoginLink
   │    ① lt を「消費せず」peek → metadata.room_id 取得
   │    ② room_config_password_hash と定数時間照合（誤り＝lt未消費で401）
   │    ③ 一致 → 原子的に lt を used_at で claim → roomスコープ session lrst_… 発行
   ▼
roomスコープ session（metadata: {scope:'room_config', room_id}）
   │  GET /room-config?room_id=…  → そのルームの安全サブセットを取得
   │  PUT /room-config            → 安全サブセットのみ保存（トグルごと自動保存）
   ▼  ※ scope強制: /room-config 以外は403、room_id はサーバ側で強制
```

---

## 4. データモデル

### room_summary_settings（追加列・migration `20260615120000_room_config_self_service.sql`）
| 列 | 型 | 意味 |
|----|----|------|
| `room_config_password_hash` | text | アクセスパスワードの SHA-256 ハッシュ。null=未設定。 |
| `room_config_access_enabled` | boolean (default false) | 管理者がこのルームのセルフ設定を許可しているか。 |

その他の機能トグル列（`bot_reply_enabled` 等）は既存。`room_id`(C…/R…/U…) がキー、1ルーム=1店舗（`receipt_report_store_partition_key`）。

### admin_dashboard_auth_tokens（既存テーブル・metadata で scope 駆動）
- ログインリンク `lrlt_`（token_kind=login_link・24h・単一使用 used_at）。metadata: `{scope:'room_config', room_id, source:'line_room_config'}`。
- セッション `lrst_`（token_kind=session）。metadata に `scope`/`room_id` を継承 → `authenticateAdminDashboardSessionToken` が `roomScope` を返す。
- パスワードハッシュは**フロントに出さない**（`stripRoomConfigSecret` が `/state`・PUT応答から除去し `room_config_password_set`(boolean) に置換）。

---

## 5. API（admin-api・全て verify_jwt=false で関数側認可）

| メソッド/パス | 用途 | 認可 |
|----------------|------|------|
| `POST /auth/room-config-login` | lt＋パスワードを roomスコープ session に交換 | パスワード定数時間照合・**20回/分**レート制限・誤りでlt未消費 |
| `GET /room-config?room_id=X` | そのルームの安全サブセットを取得 | roomスコープ session のみ・room_id 強制 |
| `PUT /room-config` | 安全サブセットのみ保存（部分更新可） | 同上＋**サーバ側 whitelist**（機微フィールドは送られても無視） |

**roomスコープ強制ブロック**（`admin-api/index.ts`・store スコープブロックの隣）: `scopeKind==='room_config'` の session は
- allowlist = `{ /room-config, /auth/logout }` 以外は **403**。
- URL/body の `room_id` を session の scope に**強制**（他ルーム指定は 403）。

**安全サブセット whitelist**（`ROOM_CONFIG_SAFE_BOOL_FIELDS`）= 下記§7の機能トグル＋`today_reservation_alert_hour/minute` のみ。
除外（管理者専用）: `bot_access_approved` / `receipt_report_store_partition_key` / `is_enabled` / `room_name` / パスワード列。

---

## 6. LINE コマンド・画面

- **コマンド**（`_shared/room_config_link.ts`）: 完全一致で「設定」「権限設定」「せってい」「ルーム設定」。`line-webhook` のテキスト振り分け先頭で判定（予算/小口/レシート/検索より前。トリガー不一致なら即フォールスルーで既存処理に干渉しない）。
- **ページ**（`room_settings.html`・GitHub Pages・モバイルファースト）:
  - パスワード入力（表示/非表示トグル）→ `/auth/room-config-login` → roomスコープ session（sessionStorage）。
  - **4カテゴリのアコーディオン**（AI返信・検索／要約・レポート／レシート・メディア／予約・カレンダー）。件数バッジ（緑）＋全体「有効 n/総数」＋すべて展開、設定検索、各設定に説明文、iOS風スイッチ。
  - **AIキルスイッチ**（AI返信を完全に無し）ON時は他AI行を淡色化。
  - **その場で自動保存**（トグルごと `PUT /room-config`・楽観更新＋失敗時ロールバック＋トースト）。
  - ヘッダのチップは**ルーム名**（`room_name`・未設定時は room_id）。

---

## 7. 設定項目（安全サブセット＝スタッフが触れる範囲）

| カテゴリ | 表示名 | DB列 |
|----------|--------|------|
| AI返信・検索 | AI会話返信 | `bot_reply_enabled` |
| | AI返信を完全に無しにする（キルスイッチ） | `bot_reply_hard_mute_enabled` |
| | 会話検索 | `message_search_enabled` |
| | 資料検索 | `message_search_library_enabled` |
| 要約・レポート | ルーム要約の配信 | `send_room_summary` |
| | 全体要約レポートを受信 | `receive_overall_summary_enabled` |
| | 売上の中間報告 | `receipt_midreport_enabled` |
| | 売上の月末レポート | `receipt_monthend_report_enabled` |
| レシート・メディア | LINE添付ファイルの保存 | `media_file_access_enabled` |
| | メディアを保存 | `media_save_enabled` |
| | レシート解析結果を送信 | `image_analysis_reply_enabled` |
| | レシート修正の返信 | `receipt_correction_reply_enabled` |
| | レシート以外の画像解析結果を送信 | `non_receipt_image_reply_enabled` |
| | 予算登録を許可 | `budget_entry_enabled` |
| | 小口レシートの解析 | `petty_receipt_analysis_enabled` |
| 予約・カレンダー | Gmail予約通知 | `gmail_reservation_alert_enabled` |
| | 本日の予約状況を配信 | `today_reservation_alert_enabled`（時刻: `today_reservation_alert_hour` / `today_reservation_alert_minute`） |
| | 明日の予定を配信 | `calendar_tomorrow_reminder_enabled`（時刻: `calendar_tomorrow_reminder_hour` / `calendar_tomorrow_reminder_minute`、未設定は 19:00） |
| | 予定の自動登録（M-talkの予定カレンダー） | `calendar_ai_auto_create_enabled` |
| | 無返信で自動登録 | `calendar_silent_auto_register_enabled` |
| | 低確度のときに確認返信 | `calendar_low_confidence_confirm_reply_enabled` |
| | 登録内容をLINEで返信 | `calendar_registration_reply_enabled` |

> このリストは `room_settings.html` の `SECTIONS` と `admin-api` の `ROOM_CONFIG_SAFE_BOOL_FIELDS` で**完全一致**させること。片方だけ増やすと「画面に出るが保存されない／その逆」になる。

---

## 8. 運用

- **有効化/パスワード設定**: §2.1（管理画面のルーム個別設定）。または DB で `room_config_access_enabled=true` ＋ `room_config_password_hash=encode(digest('パスワード','sha256'),'hex')`。
- **初回一括設定（2026-06-15 実施）**: 全64ルームをセルフ設定有効化＋共通パスワード「marugo」に統一（`room_config_password_hash` を一括 UPDATE）。※共通の弱いパスワードのため、本格運用時は**ルームごとに別パスワード**へ変更推奨。
- **パスワード変更**: ルーム個別設定で再入力して保存（空欄＝変更なし）。
- **無効化**: 「セルフ設定を有効化」をOFF（パスワードが残っていても、無効化されていれば「設定」コマンドはリンクを返さない）。
- **ルーム名表示**: 画面チップは `room_name`。未登録なら Webhook設定の「ルーム名を再取得」で取り込む。

---

## 9. トラブルシュート

| 症状 | 原因 / 対処 |
|------|-------------|
| ルームで「設定」しても「管理者が有効化していません」と返る | `room_config_access_enabled=false` か `room_config_password_hash` 未設定。管理画面で有効化＋パスワード設定。 |
| 管理画面のルーム設定に「セルフ設定」欄が出ない | 店舗の既定設定モードでは非表示（ルーム個別モード専用）。**そのルームの「個別設定」**を開く。＋ブラウザを強制再読込（⌘+Shift+R）。 |
| リンクを開いて「リンクまたはパスワードが正しくありません」 | パスワード誤り／リンク使用済み・期限切れ（24h・1回のみ）。再度「設定」を送る。 |
| 設定画面で「設定が切れました」 | session 期限切れ（最大12h）。パスワード再入力（リンク使用済みなら再度「設定」）。 |
| 保存しても反映されない／機微項目が変わらない | `bot_access_approved`・集計店舗はサーバ側 whitelist で**意図的に無視**（管理者専用）。機能トグルは反映される。 |

---

## 10. 仕様の単一ソース（コード）

| 領域 | ファイル |
|------|----------|
| 認証トークン交換・roomスコープ | `supabase/functions/_shared/admin_dashboard_link_auth.ts`（`exchangeRoomConfigLoginLink` / `authenticateAdminDashboardSessionToken`） |
| API・scope強制・whitelist・hash除去 | `supabase/functions/admin-api/index.ts`（`ROOM_CONFIG_SAFE_BOOL_FIELDS` / `buildRoomConfigSafePayload` / `stripRoomConfigSecret`） |
| LINE「設定」コマンド・リンク発行 | `supabase/functions/_shared/room_config_link.ts`（line-webhook から呼ばれる） |
| スタッフ向け画面 | `room_settings.html` |
| 管理者の有効化/パスワードUI | `index.html`（ルーム設定モーダル `#roomConfigSelfEnabled` / `#roomConfigSelfPassword`） |
| DB列 | `supabase/migrations/20260615120000_room_config_self_service.sql` |

---

## 11. M-talk（トーク）側

LINE と同じ `room_settings.html` を、M-talk のルームでも使う。

- 開き方: ルームで「設定」「権限設定」「せってい」「ルーム設定」と送る。またはトーク画面右上の歯車／メニュー「ルーム設定」。
- 認証: M-talk にログイン済みならパスワード不要。`GET/PUT /chat-room-config`（メンバーのみ）。
- 保存先: `room_summary_settings.room_id = mtalk-group-{chat_groups.id}`。`chat_group_id` にそのトークを入れる。店舗キーは招待された店舗Botまたは店舗固定ルームから自動で入る（スタッフは変更不可）。
- 配信: 「本日の予約状況配信」「Gmail予約通知」を ON にすると、そのトークへカードが届く（LINE へは送らない）。
- 既定: レシート解析の返信は ON。予約配信は OFF（設定画面で入れる）。

---

*最終更新: 2026-08-20（M-talk ルーム設定を追加）。検証: デプロイ環境で 誤パス401・正パス200・lt未消費・/state 403・他ルーム403・機微フィールド無視・自動保存PUT 200・画面実描画 を実証。*
