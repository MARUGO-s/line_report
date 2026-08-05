# Journal Report AIチャットの決まりごと

Journal Report（`public/jnm/jnl2txt.html` / `index.html`）の AI チャットが、**何を確定事実として扱い、どう質問を解釈し、どう答えるか**の運用・実装規約です。

関連:

- Cursor ルール（実装時の不変条件）: [`.cursor/rules/ai-enrichment-additive.mdc`](../.cursor/rules/ai-enrichment-additive.mdc)
- 店舗ナレッジ（資料タブ）: [JOURNAL-STORE-KNOWLEDGE.md](./JOURNAL-STORE-KNOWLEDGE.md)
- 障害・修正ログ: [店舗運用修正記録.md](./店舗運用修正記録.md)

---

## 1. 基本方針

1. **数値の正本は確定集計**  
   保存済みレポート＋ジャーナル横断検索から組み立てた数値だけを売上の根拠にする。店舗ナレッジや Web／X の情報は施策・文脈用であり、金額の出典にしない。

2. **「表示されていません」で止めない**  
   プロンプトに載っている確定節（商品初出・コースラインナップ・コホート比較・予約事実など）があるのに、「TOP5に無い」「追加比較が必要」だけで打ち切らない。

3. **Additive only（追加のみ）**  
   新機能は新しい `enrich*` / 新フィールド / 新プロンプト節として足す。既存レイヤを「これで足りるから削除」しない。詳細は Cursor ルール参照。

4. **店舗固有商品名を制御面にハードコードしない**  
   「SP専用」などの店名・商品名分岐を増やさない。`targets[]` 抽出とジャーナル上の名称×単価を正本にする。

---

## 2. 確定集計パイプライン（順序を差し替えない）

`summarizeMatched` 内の追加順:

| 順 | レイヤ | 役割 |
|---:|--------|------|
| 1 | `enrichMonthlyMealCategorySplit` | 昼夜別 F/D など |
| 2 | `enrichMonthlyAnomalyItemFacts` | 異常月の商品ドリルダウン |
| 3 | `enrichProductTimelineFacts` | 商品初出・銘柄／コードの月次（`targets[]` 並列） |
| 3b | `enrichCourseLineupFacts` | コース在庫（必ず `q=コース`）。主力は点数。漏れは `coverageGaps` |
| 4 | `enrichJournalCohortComparisons` | 汎用会計比較（利用/非利用は互換で `productCohortFacts` にも投影） |
| 5 | 商品ランキング | `rankProductsForAiDisplay` / `selectRequestedProductsForQuery` |

競合したら置き換えず併用する（異常月・初出・ラインナップ・コホートはそれぞれ別節）。

---

## 3. 商品・銘柄・コードの質問（重要）

売れ筋 TOP や保存レポート明細に無い商品でも、**ジャーナル商品月次インデックス**（`journal_product_monthly_index`）経由の `GET /pos-journals/product-search` で月次点数・金額を載せられる。

### 3.1 クライアントが検索を起動する条件

`wantsProductTimelineSearch` が真のとき `enrichProductTimelineFacts` が走る。概ね次のいずれか:

- 固有名称（コース名・カタカナ／漢字銘柄など）＋ 売れ行き／月別／売上 等
- **商品コード（下4桁）** ＋ 売れ行き／月別／売上 等

関連関数:

- `extractNamedProductMentions` … コース名・引用名・銘柄（カタカナ／漢字。「季の美」など名称中の「の」も可）
- `extractProductCodeHints` … `商品コード0023` / `下4桁2103` / `2103の売れ行き` など
- `extractProductSearchHints` … **`targets[]` が正本**（単一 `q` に勝者を決めない）
- `listTimelineSearchTargets` … 初出用は言及・単価帯・コード。ファミリー広域は初出の正本に使わない

### 3.2 質問の書き方（運用向け）

| 聞きたいこと | 例 |
|--------------|-----|
| 銘柄の月次 | `2026年のサッポロ赤星の売れ行きを月ごとにまとめて` |
| 漢字銘柄 | `2026年の季の美の売れ行きを教えて` |
| コード下4桁 | `商品コード0023の2026年の売れ行きを月ごとにまとめて下さい` |
| 下4桁の別表記 | `下4桁2103の売上` / `2103の売れ行きを月ごとに` |

フルコード（例: `0000000002103`）も下4桁に正規化して照合する。

### 3.3 商品コードと西暦を混同しない（必須）

**禁止されていた誤動作:**  
`商品コード0023の2026年の…` を **「0023年」** のデータ無しと返す。

**決まり:**

1. 期間解析の前に `maskProductCodesInQueryForPeriodParse` で商品コード数字を伏せる。
2. 年照会は **`20xx年` を優先**（`extractPrimaryYearOnlyRef` / `extractAllYearRefs`）。
3. 「年」なしの4桁を安易に西暦にしない。とくに `コード` / `下4桁` 文脈では禁止。

### 3.4 同一コードの名称変更

POS はコードを再利用することがある（例: 同じ下4桁で以前は「八つ星」、のちに「季の美」）。

- 名称一致の月次（`by_month`）と、**同一コードの過去・別名**（`code_linked_aliases`）は別節。
- 別名の点数を質問商品の月次へ**合算しない**。ただし「同じコードで以前は別名だった」事実として併記してよい。
- コード指定の質問では、そのコードに紐づく名称履歴を月次の根拠にしてよい。

### 3.5 コース分析

- コース在庫・単価帯比較は必ず **`courseLineupFacts`（q=コース）**。
- 固有別名だけで検索して通常コースを落とさない。
- ファミリー最古の `first_seen` で固有商品の開始月を置き換えない。

---

## 4. プロンプト側の決まり（要約）

`MARUGO_AI_COMPANY_CONTEXT` / `strictSystemInstruction` に載せる趣旨（削除せず追記）:

- 【商品初出・導入月】があれば初出月・単価帯・月次点数を使え。「開始月は表示されていません」で止めない。
- 月次点数が載っている銘柄・単品は、売れ筋 TOP に無くてもその数値で述べる。
- 【同一商品コードの過去・別名】は質問商品そのものではない。合算禁止・併記は可。
- コード検索節があればコード月次で述べ、「コードだけでは分析できない」で止めない。
- 【コースラインナップ】【異常月】【コホート】【予約確定事実】も、載っていれば数値を使う。
- 「1月〜7月」は端点2か月ではなく連続全月。欠ける月だけ月単位で述べる。

---

## 5. API・データ（開発向け）

| 用途 | 経路 |
|------|------|
| 商品月次検索（インデックス優先） | `GET /pos-journals/product-search?store_key=&q=&code=`（`live=1` でフルスキャン） |
| インデックス再構築 | `POST /pos-journals/product-index/rebuild` |
| 利用/非利用（互換） | `GET /pos-journals/product-cohort` |
| 汎用比較 | `POST /pos-journals/cohort-compare` |

索引テーブル: `journal_product_monthly_index`（粒: 店舗×年月×名称正規化×単価）。  
正規化は `normalizePosProductSearchText`（検索互換のため長音→ハイフン等。勝手に変えない）。

---

## 6. 実装時のチェックリスト

変更・デプロイ前に、少なくとも次が残っていること:

- [ ] 昼夜別 F/D の月次行
- [ ] 異常月の詳細解析
- [ ] 商品初出・導入月（ターゲット別）
- [ ] コースラインナップ（q=コース・漏れ検知）
- [ ] 商品利用/非利用・汎用コホート
- [ ] コース合算の売れ筋（★大分類だけの最大を禁止）
- [ ] 商品コード下4桁質問が西暦に化けない
- [ ] 銘柄（カタカナ／漢字）の月次がインデックス経由で載る
- [ ] HTML オフロード／軽量一覧が巻き戻っていない

テストの入口:

- `tests/journal_chat_query_planner.test.mjs`（質問プランナ・コード／年の切り分け）
- `tests/journal_product_index.test.ts`（正規化・集約）

---

## 7. やってはいけないこと（再掲）

- 新検索があるから異常月ドリルダウン等を削除する
- 商品初出のために質問対象外の月を `monthlyBreakdown` 本体へ混ぜる
- 複数の確定事実を1ブロックに潰して片方の数値を消す
- 汎用比較 API を商品利用/非利用専用に戻す
- コース分析で一部名称だけ検索し通常コースを落とす
- ファミリー最古の単一 first_seen で固有商品の開始月を上書きする
- 特定店舗の商品名を全店共通の唯一正解としてハードコードする
- 商品コード4桁を西暦年として期間解決する

---

## 8. 主なコード位置

| 内容 | 場所 |
|------|------|
| 質問プランナ・enrich・プロンプト | `public/jnm/jnl2txt.html`（`index.html` と同一 Twin） |
| 商品インデックス／product-search | `supabase/functions/_shared/journal_product_index.ts` / `admin-api` |
| Additive ルール（エージェント用） | `.cursor/rules/ai-enrichment-additive.mdc` |
