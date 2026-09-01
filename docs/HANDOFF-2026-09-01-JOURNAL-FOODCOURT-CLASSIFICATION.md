# 引き継ぎ: Journal 商品分類拡張とマルゴエスAIのフードコート要約

更新日: 2026-09-01  
状態: **実装済み・この文書と同時に `main` へ push する想定**

後続のAIは、会話ログを読まずにこの文書と `AI_HANDOFF.md` 先頭、`PROJECT_PROGRESS.md` 先頭から再開できる。

## 0. 最初に読む要約

ユーザー依頼は2系統。

1. Journal Report の商品分類を使いやすくし、デキャンタ色とハイボール／カクテルを解析時に自動で付ける。
2. [foodcourt.html](https://marugo-s.github.io/line_report/foodcourt.html) の東京ドーム連動・コート内順位・ボトルネック・他店比較を、**マルゴエス（`marugos`）の Journal AI だけ**へ組み込む。通常経路は軽量要約を使い、さらに必要な質問だけ利用者確認後に専門AIを追加する。

数値の正本はジャーナル確定集計のまま。コート日報の順位・シェアは会場背景。他店舗へ東京ドーム要因を転用しない。

## 1. リポジトリ

- 作業コピー: `/Users/yoshito/Library/CloudStorage/Dropbox/web/line_report-main`
- ブランチ: `main`
- Origin: `https://github.com/MARUGO-s/line_report.git`
- Pages: `https://marugo-s.github.io/line_report/`
- Supabase: `hocbnifuactbvmyjraxy`
- Journal 正本: `public/jnm/jnl2txt.html`（`public/jnl2txt.html` は別入口。byte一致は必須ではない）
- 店舗キー: 保存・APIは小文字 `marugos`。画面マスターは `marugoS`。判定は `toLowerCase() === 'marugos'`

`~/Documents/Codex/.../line-report-mtalk-release` は別コピー。今回の正本ではない。

## 2. すでに `main` へ入っている分類UI（この作業の前提）

HEAD 直前までの関連コミット:

| コミット | 内容 |
|---|---|
| `70950dc` | ドラッグ移動した商品が「移動済みを隠す」で残るのを直す |
| `99edabe` | 分類の移動を1件ずつ戻せる |
| `fa03eef` | 同じ分類を押したとき何が起きたかを画面に出す |
| `6e3169d` | 大分類への確定（例: フード→フード）も分類済みとして一覧から外す |
| `f848af7` | 選択なしで分類をクリックすると中身を見られ、未分類（`自動分類`）へ戻せる |
| `970a149` | 未分類へ戻すときにチャージ判定 `isCharge` を上書きしない |
| `8a034f3` | 赤・白デキャンタ分類と店舗デキャンタml（既定375） |

続きを触るとき守ること:

- 「移動済みを隠す」は `data-moved` だけでなく pending queue と dragging 中の商品も隠す。
- 同じ大分類へのドロップは no-op にしない。分類済みとして扱う。
- `applyCategoryOverrideToSales` で `isCharge:` を書かない。チャージ対象が月次から消える。
- 店舗キーの大小文字を混ぜない。保存は `marugos`。

## 3. この push で足すもの

### 3.1 ロゼ／オレンジデキャンタ

飲料の細分類に `ロゼデキャンタ` と `オレンジデキャンタ` を追加。親は飲料。ワインml換算のデキャンタ枠に含める。ブラウザ（`jnl2txt.html` の `SUB_SALES_CATEGORY_PARENTS`）とサーバー（`pos_journal.ts`）の両方。

### 3.2 ハイボール／有名カクテルの名前自動分類

解析時、手動上書きより弱く、商品名から細分類を付ける。

| 名前の条件 | 細分類 | 親 |
|---|---|---|
| `ハイボール` / `はいぼーる` / `highball` | アルコール | 飲料 |
| 名前に `カクテル` / `cocktail` | カクテル | 飲料 |
| ジントニック、モヒート、マルガリータ、ブラッディマリー 等 | カクテル | 飲料 |

実装:

- ブラウザ: `classifyDrinkSubclassByName` → `classifyProductAuto`
- サーバー: `classifyPosJournalDrinkSubclassByName` → `classifyPosJournalReportItem`

正規化の注意: ラテンハイフンは消してよい。カタカナ長音 `ー` は消さない。消すと `ハイボール` が `ハイボル` になり一致しない。

手動の `productCategoryOverrides` は従来どおり勝つ。保存済みレポートは再読込しないと新しい自動分類は乗らない。

ユーザーが「腎と肉」と書いた有名カクテルはジントニックとして解釈済み。

### 3.4 ワインmlは細分類を見る（分類済みでも0点だった件）

`classifyWineProductForMl` は当初、名称の Glass Wine / Bottle Wine / デキャンタとデキャンタ分類だけを数えていた。グラス赤／ボトル赤へ振り分けた銘柄は0点になり、AIが「ワインは未取得」と返した。

いまは次を換算する。大分類「飲料」のままは入れない。

- グラス赤／白／ロゼ／泡／オレンジ → glass
- 赤／白／ロゼ／オレンジデキャンタ → decanter
- ボトル赤／白／ロゼ／泡／オレンジ → bottle

反映後は同じレポートでAI分析をやり直す。

### 3.3 マルゴエス Journal AI へのフードコート要約

**やってよいこと**

- マルゴエスの標準AI分析と AIチャットだけ、会場背景ブロックを付ける。
- 新しい軽量API `GET /foodcourt/journal-brief?store_key=&start=&end=` を使う。
- 返すのは期間内 `tokyo_dome_events` 最大36件と、期間内最新の `foodcourt_tenant_reports` 1件から作ったコート内比較。
- コート比較は自店の売上順位・シェア・客数順位・客単価順位・タイプ（総合上位／集客型／単価型／要改善）と売上上位5店名。
- 資料取得と並列。クライアント timeout 8秒、失敗しても分析続行。
- プロンプト注入は最大約2800字。`clampAiSystemInstruction` は資料本文から削るので、このブロックは店舗情報の直後・確定集計の前に置く。

**やってはいけないこと**

- `foodcourt.html` のDOMや全レポートJSONを Journal プロンプトへ載せない。
- 通常経路から `/foodcourt/period-summary`、`/foodcourt/daily-summary`、`/foodcourt/ask`、予測・Q&A・週次の Groq 再生成を呼ばない。追加深掘りは3.5の専用routeだけを使う。
- コート日報の売上金額をジャーナル確定売上の代わりに使わせない。
- 新宿三丁目など他店の Journal AI にドーム要因を付けない。`marugos` 以外は `{ skipped: true }`。
- 取得失敗を「イベントなし」と断定させない。

関数と配線:

| 場所 | 役割 |
|---|---|
| `admin-api` `GET /foodcourt/journal-brief` | マルゴエス限定の要約。`STORE_SCOPED_ALLOWED_PATHS` に追加済み |
| `isMarugoSStoreKey` | `marugoS` / `marugos` を同一視 |
| `loadFoodcourtJournalBrief` | 8秒・1回・fail-open |
| `formatFoodcourtJournalBriefForAi` | プロンプト文字列。`skipped` は空文字 |
| `buildIntegratedAnalysisContext` | 資料と並列取得し `foodcourtBlock` を返す |
| 標準AI分析 / AIチャット | `storeOpsBlock` の直後へ注入 |

チェックリストはマルゴエスだけ4系統。他店は従来の3系統。

### 3.5 マルゴエスWeb版AIチャットの任意フードコート深掘り

通常チャットは3.3の軽量briefで十分な背景をすでに使う。そのうえで、東京ドーム・イベント・天候・コート内順位・競合、または売上／客数の原因・戦略など、専門分析が有効な質問だけ次の確認を1回出す。

- 現在のAI分析でも、東京ドームイベントやフードコート内順位の要約をかなり踏まえている。
- 「さらに深掘りしてブーストする」は通常より数分かかる場合があり、複数AIを追加で呼ぶためAPI利用料金が高くなる。
- 失敗・再試行した処理にも料金が発生する場合がある。
- 「現在の分析で進める」または曖昧な返答では追加処理を起動しない。

対象は `marugos` の通常Web版AIチャットだけ。単純な数値照会、他店、M-talk埋込みでは確認しない。

同意後の配線:

1. Journal確定データ分析（`action: chat`, `orchestrationMode: data`）と `POST /foodcourt/journal-deep-analysis` を `Promise.allSettled` で同時開始する。深掘り時は軽量briefを重ねない。
2. dedicated routeは `marugos` と `CHAT_JOURNAL_AI_SCOPE` へ限定する。Journalが解決した期間だけを使い、会話履歴を渡さず、`foodcourt_qa_history` へ保存しない。既存 `/foodcourt/ask` の権限・履歴契約は変えない。
3. 両方成功時だけ `ai-analyze` の `action: integrate_foodcourt` を別途呼ぶ。2本は非信頼の下書きであり、売上・客数・商品数値はJournalの確定データを正本にする。矛盾は隠さず明記する。
4. 専門AI失敗時はJournal回答を警告付きで返す。最終統合失敗時は2本を未統合と明記して併記する。Journal失敗時は専門結果だけを店舗の完成分析にせず、不完全警告とローカル確定集計を返す。

一時的な長大timeoutだけに頼らない。並列実行、共有deadline、入力上限、専用routeの実HTTP失敗でEdge制限内に収める。

## 4. 主なファイル

- `public/jnm/jnl2txt.html`
- `supabase/functions/_shared/pos_journal.ts`
- `supabase/functions/admin-api/index.ts`
- `supabase/functions/ai-analyze/index.ts`
- `supabase/functions/_shared/journal_ai_privacy.ts`
- `supabase/functions/_shared/foodcourt_compare.ts`
- `supabase/functions/_shared/line_report_help_manual.ts`（JAI-01 / FCT-01。`npm run help:update` 済み）
- `docs/JOURNAL-REPORT-FEATURES.md`
- `SYSTEM_ARCHITECTURE_OVERVIEW.md`
- `docs/LINE-REPORT-JOURNAL-AI-MANUAL.md`（生成物。手編集しない）
- `scripts/verify-journal-ai-data-flow.mjs`
- `tests/journal_chat_query_planner.test.mjs`
- `tests/journal_ai_weather.test.mjs`
- `tests/pos_journal_auto_saved_reports.test.ts`

DB migration は不要。既存テーブル `tokyo_dome_events` と `foodcourt_tenant_reports` を読むだけ。

## 5. 検証（push 前）

成功済み:

- `node --test tests/journal_chat_query_planner.test.mjs tests/journal_ai_weather.test.mjs`（78件）
- `node scripts/verify-journal-ai-data-flow.mjs`（中核 24 OK / 0 NG。フードコート要約経路を含む）
- `deno test --no-lock --no-check --allow-read --allow-env tests/pos_journal_auto_saved_reports.test.ts tests/line_report_help_manual.test.ts tests/line_report_help_coverage.test.ts`

未実施（後続で必要なら）:

- 本番マルゴエスで AI分析／チャットを1回実行し、プロンプトに「東京ドーム・フードコート背景」が出ること
- 他店で同じ操作をしてブロックが付かないこと
- qualifying質問で確認が1回だけ出て、拒否時はdeep routeを呼ばないこと
- 同意時にJournalとdeep routeが並列になり、両成功後だけ `integrate_foodcourt` が動くこと
- dedicated routeが未認証401、他店403、Q&A履歴非保存になること
- 各部分失敗で完成扱い・正本が逆転しないこと
- `foodcourt.html` 本体の動作回帰（今回は読んでいない。API追加のみ）
- 保存済みレポートのハイボール再分類は、ジャーナル再読込後に確認

`deno check supabase/functions/admin-api/index.ts` は元から多数の型エラーがある。今回の追加で増やしていない想定。基準は `--no-check` の既存テスト。

## 6. デプロイ

push すると GitHub Actions が GitHub Pages と Edge Functions をデプロイする。`admin-api` の journal-brief／journal-deep-analysis と `ai-analyze` の integrate_foodcourt は Edge 側の反映待ち。Pages だけ先に出た場合も通常の軽量分析は維持するが、深掘り同意後は部分失敗として警告表示になる。

手動 `supabase functions deploy` は通常不要。

## 7. 後続がやりがちな誤り

1. フードコート全データを Journal に足して時間切れを再発させる。
2. `marugoS` だけ見て `marugos` を対象外にする。
3. ハイボール判定でカタカナ `ー` をストリップする。
4. 未分類へ戻す処理で `isCharge` を上書きする。
5. コート日報の売上をジャーナル正本と合算・置換する。
6. `docs/LINE-REPORT-JOURNAL-AI-MANUAL.md` を直接編集する。正本は `line_report_help_manual.ts`。
7. Codex 側の `line-report-mtalk-release` を編集して Dropbox の正本と分岐させる。
8. 深掘り確認前、拒否後、曖昧返答で追加AIを起動する。
9. `/foodcourt/ask` をJournal権限へ開放したり、深掘り結果をQ&A履歴へ保存する。
10. 2本を直列実行してEdge上限へ近づける、または専門結果だけを店舗完成分析として表示する。

## 8. 意図的にやっていないこと

- 来客予測・週次レポート本文を通常のJournal AIへ常時入れること
- フードコート画面自体の改修
- 他店 Journal への会場データ注入
- 保存済みレポートへの自動再分類バックフィル

必要なら次の依頼で、brief に「対象期間の自店日次順位の数行」を足す程度ならまだ軽い。期間サマリー再生成は足さない。
