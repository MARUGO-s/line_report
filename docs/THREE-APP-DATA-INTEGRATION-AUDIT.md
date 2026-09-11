# 3アプリのデータ連携監査（2026-09-11）

対象は現行のLINE Report、Journal Report（`public/jnm/`）、M-talk（`public/chat/`）。接続設定、実装、デプロイ先、DB原本と日次同期値、権限を照合した。旧Expressアプリや別アプリのデータを統合・移動する作業ではない。

## 結論と参照先

3アプリの本番接続先は同じSupabase `hocbnifuactbvmyjraxy`。独立した3つの業務DBではない。ただし、同じDBであっても「原本」「現在の統一売上」「生成時点の履歴」「権限により未参照の情報」は区別する必要がある。

| データ | 正本・実装 | 各アプリの扱い |
|---|---|---|
| 接続先 | `public/pages-config.js`、`public/chat/core.js`、Journalの`SUPABASE_URL` | 現行公開HTML/JSのSupabaseホストを自動検査。管理画面も固定URLを使用 |
| 現在の日次売上・客数・組数・税 | `_shared/sales_reconciliation.ts` / `line_sales_manual_day` / 店舗別レシート表 | 管理画面、LINE/M-talk定型返信、定期報告、売上シートは共通採用処理。日別手修正 > 同期済みジャーナル > レシート。重複加算しない |
| POS原本と商品明細 | `pos_journal_files`＋非公開Storage / `saved_reports` | 電子ジャーナルとJournal Reportは共有。M-talk Journal AIは許可済み店舗・期間の読取のみ。金額の共通採用と原本内訳を混同しない |
| 予約 | `tabelog_reservation_visit_events` / `ikyu_reservation_visit_events` / `manual_reservation_visit_events` | M-talkの`handleChatSchedule`も管理画面と同じ`fetchReservationCalendarState`を呼ぶ。コピーDBではない |
| 予定 | `line_room_calendar_events` | M-talkも店舗・ルームの対応を解決して同じ予定を参照。予約と予定は別種の情報 |
| 予約のAI用事実 | `reservation_ai_store_cache`＋予約原本 | 過去は日次キャッシュ、未来と欠落日はライブ参照。履歴・取込開始範囲を明示する。M-talk専用Journal AIへ予約者情報を追加しない |
| 店舗資料 | `store_knowledge_documents` / chunks＋非公開Storage | JournalとLINEの明示資料登録、M-talkの確認済みメニュー登録は共通保存。M-talk Journal AIが全資料を読めるという意味ではない |
| 店舗営業情報 | `store_operation_profiles` / `_shared/journal_store_context.ts` | 利用者承認済み。通常JournalとM-talk Journal AIの両方で、認可後にサーバーが毎回同じ店舗の共有情報を取得。端末キャッシュ・初期値を正本にしない |
| チャット本文・会員・個人メモ | 同じDBの`chat_*`、Supabase Auth＋RLS | M-talk専用であることが正常。全アプリに無条件共有しない |
| 予測・AI文章・PDF | `sales_forecasts` / AI履歴 / Storage | 生成時点のスナップショット。現時点の売上・最新予測として過去値を上書きしない。Journalの月次予測とフードコート日次予測は対象・モデルが異なる |

`src/db.js`のSQLite（`.local/sqlite/wine_price.db`）は旧LINE-WINE Express用で、上記3つの公開アプリの売上・予約の保存先ではない。旧コードの存在だけを理由にDBを削除しない。別アプリと共存するSupabaseなので、配備は所有リストの20関数に限定する。

## 検出・修正

1. **高: 同期エラーの黙殺。** `saveSavedReport`とPOS自動レポート作成は、レポート保存後の売上同期失敗を成功として返していた。保存済み／同期失敗を別に返し、画面で再保存・再取込を案内する。設定取得失敗も「同期OFF」へ変換しない。再実行は同一ID・日付で冪等、既存の手修正を保持する。
2. **中: 古いデータで取得失敗を隠す。** Journalの期限切れ一覧・詳細への無表示フォールバックを廃止。詳細は一覧の`updated_at`が変われば無効化し、AI検索時は一覧を再取得、画面復帰時もキャッシュを破棄する。日別取得失敗を月次だけの完全成功にしない。常時リアルタイム配信ではなく、表示中の保存済み文章は更新操作が必要。
3. **中: 設定・認証の二重読込。** Journalの3画面で共通JSの後に古いコピーを読み込んでいた。共通`../pages-config.js`と`../auth-session.js`だけを読み込む。旧認証コピーも用途・委譲ID確認を現行に合わせる。旧SupabaseホストのCSP許可を除去する。
4. **中: 確認済み0円日の同期漏れ。** 原本の解析完了、日付一致、全項目0、明細0、同期ON、重複原本なし、既存日次行なしを全て満たす場合だけmigrationで追加する。既存行・原本・手修正・同期設定には触れず、繰り返し適用しても増殖しない。
5. **中: 設定の保存状態が不正確。** 未ログインでクラウド保存をスキップしても「同期済み」と表示されていた。端末保存とクラウド保存を区別する。店舗情報の取得失敗やM-talkでの未参照を店舗初期値で埋めない。
6. **低: 端末限定の変換設定が共通設定に見える。** Journalのコード範囲設定はローカル変換用。保存メッセージを「この端末のみ・他アプリには未反映」へ変更。共有の商品分類上書きルールやPOS側分類ルールとは別であり、勝手に互いを上書きしない。

## 承認済みの共有店舗情報連携

2026-09-11、利用者が対象情報と送信先OpenAI／Anthropic（Claude）を明示承認した。`ai-analyze`で現在のセッション・M-talk本人/所属/ルーム/AI権限・店舗・レート制限を検証した後、`store_operation_profiles`を店舗キー完全一致で1回取得する。ブラウザー用の設定API allowlist、設定変更権限、RLSは変更しない。

- 対象: 定休・昼夜営業・特別営業・共有店舗メモ・ワイン換算設定、指定した各分析期間に重なる施策カレンダー。個人メモ、他店、予約者原本、店舗資料全体は追加しない。共有情報は既存のOpenAI／Claude統合処理だけへ送り、Web検索用Perplexity／Grokの引数には追加しない。
- 読取: 最大8秒、呼出元キャンセルを伝搬し、通信がabortを無視しても待ち続けない。DB障害・店舗/更新版数不一致は`503 shared_store_context_unavailable`。未登録は`not_registered`、旧プロフィールで項目が無ければ`null`。設定初期値や古いキャッシュへ戻さない。
- カレンダー: 比較期間の間の月を含めず、該当0件の際に全イベントへ戻さない。登録最大100件、AI投入最大40件。省略数・不正日付数を明示する。施策の登録だけで実施済み・因果を断定しない。
- 数値: 商品点数を変えず共有ml設定で再換算する。未設定の換算値は0にしない。商品数量は原本参考値であり、この連携がサーバー検算済み実測量へ格上げするものではない。総売上・税額・客数等の正本は引き続き`unified_sales`。
- 送信前: 既存privacy sanitizerで結合後の文章を再処理し、検出した予約氏名は仮名化、電話・メールは除去、アレルギー詳細は有無だけにする。自由文の全個人情報を完全検出する保証ではなく、共有メモへ不要な顧客情報を記入しない。原本は変更しない。メモ内の命令は非信頼データとして扱う。
- 性能: 長い英数字列でメール検出が全ての後続文字から再試行し約30秒かかるケースを再現。候補先頭に限定する同じ正規表現をブラウザー/サーバーに適用し、マスク結果の一致と長文処理の回帰テストを追加した。
- 画面: 回答注記に共有情報の登録状態・更新日時を表示し、APIのメタデータには出所・店舗・確認日時だけを返す。共有情報／統一売上の取得失敗時はローカル相談回答へ退避せず安全停止。通常・深掘り・最終統合も同じ方針。

現在の共有設定は過去時点の設定履歴ではない。原本・生成済みAI文章・PDFは過去のスナップショットとして保持するため、「全情報を無条件に同一参照」「AI回答も完全一致」とは保証しない。

## 検証と運用

- 回帰: `tests/three_app_integration.test.mjs`、`tests/zero_journal_backfill.test.mjs`、`tests/journal_sales_sync_runtime.test.ts`に加え、`tests/journal_store_context.test.ts`と`tests/journal_store_context_integration.test.mjs`。実handlerはDB/認証判定/AIを合成fixtureへ置換して、呼出順、拒否、送信前マスク、検索への非混入、画面の安全停止を検査する。外部AIの実回答品質を保証するテストではない。
- 全体: `npm run test:ci`、`npm run test:knowledge`、`npm run check`、`git diff --check`。公開検査はコード構造のみで、顧客本文・売上金額・原本をテストfixtureや公開文書へ転記しない。
- ローカルUI: 実データAPIを模擬応答に置き換えたPC/モバイル表示で、未ログイン保存・同期失敗・旧詳細拒否・共通JS読込を検査する。
- 本番: Pagesとのコード照合、保護APIの未認証拒否、migration適用履歴、0円欠落件数、既存日次行と原本の不変性、RLS/書込RPC権限を確認する。認証済み利用者の実送信・実売上変更を伴うE2E操作は行わない。
- 品質評価: 正確性は無表示フォールバックと部分失敗を是正、セキュリティは既存スコープ維持、保守性は共通JSと回帰検査を強化。性能はキャッシュを全廃せず一覧90秒・詳細10分の上限と版数確認を併用する。
- 配備結果は対応PRとmainのPages / Deploy Edge Functions履歴を正本とする。[統一売上仕様](./UNIFIED-SALES-SOURCE-POLICY.md)、[セキュリティ](./SECURITY.md)、[所有範囲](./SUPABASE-OWNERSHIP.md)も参照。
