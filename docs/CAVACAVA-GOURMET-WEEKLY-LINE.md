# BISTRO CAVA CAVA グルメサイト週報 → LINE

BISTRO CAVA CAVA（新宿区荒木町）のグルメサイト掲載・口コミ分析レポート（HTML）を毎週 GitHub Pages に公開し、
そのリンクを LINE グループ「Cava Cava」（`C162737896a6b9b50ab39376568e3b05a`）へ 1 通送る仕組みです。
MARUGO S と同じ Edge Function（`marugo-gourmet-weekly-line`）とスクリプトを、`--store cavacava` で使います。
宛先は関数内の許可リストで固定しており、`room_id` を引数では受けません。

Gourmet Site Bot の `gourmet_weekly_line` や東京ドーム週次配信とは別経路です。混ぜません。

毎週土曜 9:00 ごろ（日本時間）にレポートを作り直してから、共有の作業用コンピューターで次を実行します。

```bash
/workspace/line_report_main/scripts/marugo-gourmet-weekly.sh \
  --store cavacava \
  --html /workspace/BistroCAVACAVA_gourmet_report.html \
  --summary $'1行目\n2行目\n3行目' \
  --date YYYY-MM-DD
```

確認だけ（LINE へは送らない）:

```bash
/workspace/line_report_main/scripts/marugo-gourmet-weekly.sh \
  --store cavacava \
  --html /workspace/BistroCAVACAVA_gourmet_report.html \
  --summary $'1行目\n2行目\n3行目' \
  --date YYYY-MM-DD \
  --dry-run
```

すでに HTML を公開済みで、送信（または dry-run）だけする場合は `--skip-publish` を足します。

| 段階 | 内容 |
| --- | --- |
| 公開 | `public/cavacava/gourmet-report/<日付>.html` と `latest.html` を main へ push（専用 clone `~/.marugo-line/line_report-publish`）。`noindex` を付ける |
| 待機 | `https://marugo-s.github.io/line_report/cavacava/gourmet-report/<日付>.html` が 200 で同じ内容を返すまで（既定 12 分） |
| 送信 | Edge Function が本文 `【BISTRO CAVA CAVA グルメサイト週報 YYYY/MM/DD】` ＋要約（3行まで）＋URL を組み立てて push |
| `--dry-run` | 公開・待機まで行い、関数を `dry_run: true` で呼んで本文・送り先・トークンの有無・ロックダウン・送信済み・LINE メッセージ枠を表示（LINE へは送らない） |

MARUGO S 側は `--store` を省略（または `--store marugo-s`）すれば従来どおりです。公開先・見出し・宛先・手元の送信記録の場所は変わりません。詳細は `docs/MARUGO-GOURMET-WEEKLY-LINE.md`。

## Edge Function（共通）

- `POST /functions/v1/marugo-gourmet-weekly-line`、`verify_jwt = false`。本文の `store` は `marugo-s`（省略時）または `cavacava` だけ。
- 認証・要約の制限（3 行・各 160 文字、URL・メール・電話らしき文字列は 400）・URL の 200 確認は MARUGO S と同じ。
- CAVACAVA の URL は `https://marugo-s.github.io/line_report/cavacava/gourmet-report/<report_date>.html`（または `latest.html`）だけ。
- LINE トークンはルームの店舗キー（`room_summary_settings.receipt_report_store_partition_key`、現在 `bistrocavacava`、無ければ `bistrocavacava`）の
  `LINE_CHANNEL_ACCESS_TOKEN__BISTROCAVACAVA`（無ければ共通トークン）。
  `MARUGOSECOND_PUSH_LOCKDOWN` は店舗キー `marugosecond` だけが対象なので、このグループには影響しない。
- 二重送信防止: `marugo_gourmet_weekly_line_sends`（ルーム×日付で 1 回）。スクリプト側は `~/.marugo-line/gourmet-weekly-sent/cavacava/<日付>`。
- 呼び出しキーは MARUGO S と共通（`~/.marugo-line/gourmet_weekly_key`）。

CAVACAVA チャネルは月次のプッシュ上限に達することがあります。dry-run の `line_quota`（`type` / `limit` / `used`）で、送る前に枠を確認できます。上限は通常、翌月1日にリセットされます。

## 毎回のレポートに入れる「掲載内容チェック」

参照: 社内ガイド（2026-11-21、特長ワード・広告表現・横断の食い違い・5手順）。

HTML レポート（広幅レイアウト: `.page{max-width:1180px}`、項目列 `min-width:7.5em`）に、セクション「掲載内容チェック」を毎回入れる。食べログの評点は店舗ページの本文から取り、取得時刻を日本時間で記録する。数値も文言も、公開ページに出ているものだけを引用する。発明しない。取れない項目は「取得不可」と理由を書く。

### 5手順

1. **いま出している提供内容を確認する。** 基準は公式サイト（https://www.bistro-cavacava.com/）の公開情報。コース品数、価格、飲み放題の有無と時間、営業時間、席・個室・貸切、アクセス、産地を公式の文言で記録する。公式にない提供は「公式では確認できず」と書く。店内オペレーションや管理画面の実在確認は、公開ページだけではできない旨を明記する。
2. **媒体の正しい欄に入っているかを見る。** 食べログ（店舗・PR文・こだわり・営業・席・交通・利用シーン、コース、料理、ランチ。PR文に予約方法・営業時間がないか）、一休（https://restaurant.ikyu.com/112789/。curl が 403 のときは公開表示の取得に切り替え、取得方法を注記。コース詳細が 404 なら取得不可）、ぐるなび、Retty、ヒトサラ、公式。ホットペッパー・PayPayグルメは掲載の有無を毎回確認し、無ければ「掲載なし」とする。同名の別店は混ぜない。
   - 特長ワードの設定そのものは管理画面にしか出ない。公開ページに「お店の特長ワード」欄が無ければ、その旨を「確認できなかったこと」に書く。公開のキャッチ・利用シーン・こだわりは、特長ワード欄そのものではない。ジャンル・エリア・駅名と重なる語が一フレーズに入っていても、管理画面に登録されているとは断定しない。他店の資料で「表示対象外」と指摘された語を、この店や他媒体へ一般化しない。
3. **広告表現と横断の食い違い。** 根拠のない No.1・最上級、効果保証、産地の食い違い。食べログPR文への予約方法・営業時間の混入。価格、コース品数（タイトルと本文、媒体間）、飲み放題の有無と時間、営業時間（とくに金・土ランチ）、席数・個室の呼び方・貸切、アクセス徒歩分数、期間限定案内の取り残し。ホットペッパー・ぐるなび・一休・PayPayに固有の欄。
4. **管理画面の入力エラー。** 公開ページからは確認できない。毎回「確認できなかったこと」に含める。他店で指摘された登録エラーを、この店の事実としては書かない。
5. **公開後の検索・アクセス・予約。** 検索順位や予約数との因果は測定しない。効果を断定しない。「測定していない」と書く。

### 表の列

媒体 / 欄 / 現在の記載（引用） / 問題の可能性 / 修正案 / 重要度（高・中・低）

現在の記載はページの文言を「」で引用する。取得時刻を本文に日本時間（Asia/Tokyo）で書く。確認できなかったことは表の下に箇条書きする。問題が見つからなくても、点検した媒体・欄と取得時刻は残す。
