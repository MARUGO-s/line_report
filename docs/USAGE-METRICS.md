# 利用状況：集計元と数値の読み方

2026-09-11改訂。本部管理画面の「利用状況」が対象。AI使用料・売上集計とは別機能です。

## 何を見るか

| 表示 | 正本・単位 | 注意点 |
|---|---|---|
| 業務テーブル容量 | PostgreSQL publicの実テーブル・実体ビュー。索引/TOAST込み | 同じDBの他機能も含む。パーティションは物理実体を一度ずつ計上 |
| DB全体容量 | pg_database_size | 認証・システム領域等を含む。契約ディスク上限やStorage画像原本の容量ではない |
| PUSH配信記録・返信成功記録 | 保存済みログ、JST月初以上〜翌月初未満 | LINE利用枠ではない。未記録・削除・分割配信・重複記録の影響あり |
| LINE公式の当月利用量 | Bot設定ごとのquota/consumption API | 公式APIも概算。確定値はLINE Official Account Manager |

グループへの1回のPUSHは人数分の利用枠を消費します。返信は枠外です。全店舗のログ合計から一律200件を引いて残量にする計算は廃止しました。[LINEの数え方](https://developers.line.biz/ja/docs/messaging-api/sending-messages/#counting-messages)、[公式利用量API](https://developers.line.biz/ja/reference/messaging-api/#get-consumption)。

「利用状況を更新」でDB/ログを再取得。「LINE公式利用量を取得」で既存の店舗Bot/共通・管理Bot設定を照会します。同一アクセストークンの設定はまとめますが、別トークンが同一チャネルを指すこともあるため全行の合算値は出しません。契約変更・送信・外部AI呼出しは行いません。

## 設計と監査所見

```text
public物理テーブル → get_storage_usage_stats ┐
保存済み配信ログ   → get_usage_monthly       ├→ admin-api（本部のみ）→ 利用状況
設定済みLINE Bot   → 公式quota API（手動）  ┘
```

- 旧DB表示は8表に限定。publicの新しい表も自動的に対象にする。割合とバーは同じ合計を分母にし、全テーブル一覧を展開可能にした。DB全体の円グラフではない。
- 旧ログ取得にはページングがなく、API行上限に達すると過少集計。SQL単一スナップショットでGROUP BY/COUNTを行い、内訳と総数を整合させる。店舗未割当も消さず返す。
- M-talk専用`mtalk-group-N`、東京ドーム週次のイベント0件（未送信予約）、未知の送信方式、失敗Webhookを除外する。
- レシート定期報告・東京ドーム週次には送信前の予約行があり、過去の成功は証明できない。この2系統を「成功未確認」として残す。成功したように履歴を書き換えない。共通配信IDのない別ログの重複を日時の近さだけで削除しない。
- 取得失敗・Bot未設定・未取得と、確認済み0件を区別する。更新失敗後のキャッシュ表示も明示。
- 4つのKPIの比較しやすさは維持。容量の日本語名・元テーブル名、更新日時、残量80%以上/上限到達の文字表示を追加。色だけで警告しない。

## API・安全境界

- 既存`GET /state`の`storage_usage`/`push_usage_monthly`を使用。後者が失敗しても管理設定全体を停止させず`status=unavailable`とnull件数を返す。
- `GET /usage/push-monthly`: 同じSQL集計。内部RPC`get_usage_monthly(p_month)`はテスト用月指定可、公開画面は当月のみ。
- `GET /usage/line-quota`: 本部限定。店舗/ルーム/M-talk委任/cronのallowlistには追加しない。Bearerトークンはサーバー→LINE公式HTTPSにのみ送付し、応答・ログに出さない。
- 公式照会は同時4設定、1リクエスト5秒、インスタンス内60秒キャッシュ。通常の`/state`ポーリングでは呼ばない。月が変わればキャッシュを再取得する。設定数に応じて照会時間がかかる。
- 新旧RPCは固定search_path、service_role専用。元データ・送信処理・保存期限は変更しない。

## 検証・運用

`npm run test:usage`は実PostgreSQL互換エンジンで1,105行超、JST境界、未割当、0件/除外、パーティションの二重計上防止、anon/authenticated拒否を検査。APIモックで同一トークン、上限なし、0、401、不正応答、例外、秘密非露出を検査する。

本番配備はmigration→admin-api→Pages。Graphify/ヘルプ生成後に全回帰検証。PC/スマートフォンで正常・失敗・更新を確認する。新RPCに問題がある場合も元データは変更されていない。UI/APIは対応コミットをrevertし、RPCの復旧は追加migrationで管理する。旧UIへ戻すと旧無料枠推計が復活するため、単独の画面巻戻しは避ける。

長期の配信成功率や請求額をこのログから保証しない。過去の成功状態を完全復元するには送信元で共通の配信ID/成功台帳を導入する別対応が必要。
