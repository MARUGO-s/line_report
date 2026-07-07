# AIループエンジニアリング機能 設計図

対象PDF: `/Users/yoshito/Downloads/AIループエンジニアリング機能 実装仕様.pdf`
対象実装: `supabase/functions/_shared/foodcourt_compare.ts`、`supabase/functions/admin-api/index.ts`
作成日: 2026-07-07

## 1. 結論

実装可能。

既存の売上分析AIは、すでに以下の構造を持っている。

- Q&A: `answerFoodCourtQuestion()`
- 日次サマリー: `generateFoodCourtDailySummary()`
- 期間サマリー: `generateFoodCourtPeriodSummary()`
- 専門AIメモ: 他店舗/過去データ、イベント/天気、運営改善
- 反証/品質管理メモ: `criticRes`
- 統合AI: 専門AIメモを1つの回答へ統合
- 使用量記録: `ai_usage_events`
- キャッシュ: `foodcourt_daily_ai_summary`、`foodcourt_period_ai_summary`

したがってPDFの「8AIオーケストレーション → 統合回答 → 品質評価AI → 改善点 → 再議論/再生成」を、既存構造を置き換えずに、統合回答の後段に追加するのが最も安全。

## 2. 現状構造

### 2.1 Q&A

`answerFoodCourtQuestion()` は以下の流れ。

1. レポート/イベント/天気/予測/競合情報を組み立てる
2. 専門AIを並列実行
   - 他店舗・過去データ分析AI
   - イベント・天気分析AI
   - 運営改善AI
3. 反証・品質管理AIを実行
4. 統合AIが最終回答を生成
5. `ai_usage_events` に使用量を保存

### 2.2 日次/期間サマリー

`generateFoodCourtDailySummary()` / `generateFoodCourtPeriodSummary()` も同様に、

1. 専門AI 3体
2. 反証AI
3. 統合AI
4. キャッシュ保存

という流れ。

現時点でも「品質管理AI」はあるが、これは最終回答を採点して再生成するループではなく、統合AIへ渡す反証メモである。

## 3. 目標構造

PDF要件に合わせて、次の後段ループを追加する。

```text
ユーザー入力 / サマリー生成要求
  ↓
既存の専門AIオーケストレーション
  ↓
統合回答生成
  ↓
品質評価AI
  ↓
合格？
  ├─ YES: 回答返却 + ログ保存
  └─ NO: 改善点のみ生成
          ↓
        専門AI/統合AIへ改善点をフィードバック
          ↓
        再生成
          ↓
        再評価
          ↓
        最大3ループ
          ↓
        最高得点回答を返却
```

## 4. 適用範囲

段階導入にする。

### Phase 1: Q&Aのみ

最初は `POST /foodcourt/ask` の `answerFoodCourtQuestion()` に限定する。

理由:

- ユーザー質問は自由度が高く、品質評価の効果が最も大きい
- キャッシュがなく、再生成しても既存キャッシュ破壊がない
- 日次/期間サマリーより検証しやすい

### Phase 2: 日次サマリー

`generateFoodCourtDailySummary()` に適用する。

注意:

- 既存キャッシュ `foodcourt_daily_ai_summary` の `model_version` を上げる
- 旧キャッシュは温存し、新バージョンだけ再生成対象にする

### Phase 3: 期間サマリー

`generateFoodCourtPeriodSummary()` に適用する。

注意:

- 期間サマリーはコストが高くなりやすいので、評価ループ回数をQ&Aより控えめにできる設計にする

## 5. 合格基準

PDF要件どおり。

- 総合点 >= 90
- 各項目 >= 80
- 最大ループ: 3
- 3回目でも不合格なら最高得点回答を返す

評価項目:

1. 正確性
2. 論理性
3. 専門性
4. 実用性
5. 根拠

売上分析向けに、内部的には以下のサブ観点を評価プロンプトに入れる。

- データに無い数値を作っていないか
- 売上日/レポート発行日を混同していないか
- 相関と因果を混同していないか
- 客数要因と客単価要因を取り違えていないか
- イベント/天気/曜日の根拠が実データと一致しているか
- 打ち手が具体的で、KPIまで落ちているか

## 6. DB設計

将来のRAG/蒸溜/ランキング/再利用に使えるよう、実行単位とループ単位を分ける。

### 6.1 `foodcourt_ai_loop_runs`

1回のユーザー質問またはサマリー生成単位。

```sql
create table public.foodcourt_ai_loop_runs (
  id uuid primary key default gen_random_uuid(),
  store_partition_key text not null,
  surface text not null, -- 'ask' | 'daily_summary' | 'period_summary'
  source_ref jsonb not null default '{}'::jsonb,
  user_input text,
  context_hash text,
  model_version text not null,
  max_loops integer not null default 3,
  status text not null default 'completed', -- completed | failed | skipped
  final_loop_index integer,
  best_loop_index integer,
  final_score numeric(5,2),
  final_answer text,
  returned_reason text, -- passed | max_loop_best | evaluation_failed | generation_failed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

`source_ref` 例:

```json
{
  "report_id": 123,
  "business_date": "2026-07-06",
  "start_date": "2026-07-01",
  "end_date": "2026-07-06",
  "viewing_date": "2026-07-06"
}
```

### 6.2 `foodcourt_ai_loop_iterations`

各ループの生成物と評価。

```sql
create table public.foodcourt_ai_loop_iterations (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.foodcourt_ai_loop_runs(id) on delete cascade,
  loop_index integer not null,
  feedback_from_previous text,
  specialist_outputs jsonb not null default '{}'::jsonb,
  critic_note text,
  integrated_answer text,
  evaluation jsonb,
  total_score numeric(5,2),
  score_accuracy numeric(5,2),
  score_logic numeric(5,2),
  score_expertise numeric(5,2),
  score_practicality numeric(5,2),
  score_evidence numeric(5,2),
  passed boolean not null default false,
  improvement_points text,
  usage_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(run_id, loop_index)
);
```

### 6.3 RLS方針

- 両テーブルは `enable row level security`
- public/anon/authenticated には直接権限なし
- Edge Functions の `service_role` のみ読み書き
- 管理画面で閲覧する場合は `admin-api` 経由で集計済み情報だけ返す

## 7. コード設計

### 7.1 新規型

`foodcourt_compare.ts` に以下の型を追加する。

```ts
type FoodCourtLoopSurface = 'ask' | 'daily_summary' | 'period_summary'

type FoodCourtLoopConfig = {
  enabled: boolean
  maxLoops: number
  passTotal: number
  passEach: number
  evaluatorProvider: FoodCourtChatProvider
  evaluatorMaxTokens: number
}

type FoodCourtLoopEvaluation = {
  total_score: number
  scores: {
    accuracy: number
    logic: number
    expertise: number
    practicality: number
    evidence: number
  }
  passed: boolean
  improvement_points: string[]
  risk_flags: string[]
  factuality_notes: string[]
}

type FoodCourtLoopIteration = {
  loopIndex: number
  answer: string
  specialistOutputs: Record<string, string>
  criticNote: string
  evaluation: FoodCourtLoopEvaluation | null
  feedback: string
  usages: FoodCourtAiUsage[]
}
```

### 7.2 新規関数

#### `evaluateFoodCourtAnswer()`

統合回答を採点する。

入力:

- surface
- question / task
- contextBlock
- finalAnswer
- specialistNotes
- criticNote
- strict format requirements

出力:

JSONのみ。

```json
{
  "total_score": 88,
  "scores": {
    "accuracy": 90,
    "logic": 85,
    "expertise": 82,
    "practicality": 78,
    "evidence": 86
  },
  "passed": false,
  "improvement_points": [
    "打ち手が抽象的でKPIが不足",
    "イベント影響の根拠が弱い"
  ],
  "risk_flags": ["相関と因果の断定に注意"],
  "factuality_notes": ["対象日は売上日に補正済みである点は守られている"]
}
```

#### `buildLoopFeedback()`

評価JSONから、再生成AIに渡す「改善点のみ」を作る。

重要:

- 前回回答全文を渡さない
- 改善点だけ渡す
- 「不足部分だけ改善、形式は維持」と指示する

#### `runFoodCourtLoopEngineering()`

共通ループエンジン。

```ts
async function runFoodCourtLoopEngineering(params: {
  surface: FoodCourtLoopSurface
  initialGenerate: (feedback?: string) => Promise<GeneratedAnswer>
  evaluationContext: string
  userInput?: string
  sourceRef: Record<string, unknown>
  supabase?: SupabaseClient | null
  storeKey?: string
}): Promise<{ answer: string | null; loopMeta: FoodCourtLoopRunMeta }>
```

役割:

1. `initialGenerate()` で回答生成
2. `evaluateFoodCourtAnswer()` で評価
3. 合格なら返す
4. 不合格なら改善点を作り、`initialGenerate(feedback)` で再生成
5. 最大3回
6. 最高点回答を返す
7. 全ループをSupabaseに保存

## 8. 既存関数への差し込み方法

### 8.1 Q&A

現在:

```ts
const r1 = await foodCourtAiChat(messages, ...)
return r1.content
```

変更後:

```ts
const result = await runFoodCourtLoopEngineering({
  surface: 'ask',
  userInput: q,
  sourceRef: { viewing_date: viewingDate ?? null },
  evaluationContext: contextBlock,
  initialGenerate: async (feedback) => {
    const loopMessages = feedback
      ? appendLoopFeedback(messages, feedback)
      : messages
    return generateIntegratedAnswer(loopMessages)
  },
  supabase,
  storeKey,
})
return result.answer
```

### 8.2 日次サマリー

`generateFoodCourtDailySummary()` の統合AI呼び出し部分を同じ形に置き換える。

- `surface='daily_summary'`
- `sourceRef={report_id,business_date}`
- `model_version` を上げる

### 8.3 期間サマリー

`generateFoodCourtPeriodSummary()` の統合AI呼び出し部分を同じ形に置き換える。

- `surface='period_summary'`
- `sourceRef={start_date,end_date}`
- `maxLoops` は環境変数で1または2に抑えられるようにする

## 9. 環境変数

```text
FOODCOURT_LOOP_ENABLED=true
FOODCOURT_LOOP_MAX=3
FOODCOURT_LOOP_PASS_TOTAL=90
FOODCOURT_LOOP_PASS_EACH=80
FOODCOURT_LOOP_EVALUATOR_PROVIDER=claude
FOODCOURT_LOOP_EVALUATOR_MODEL=claude-haiku-4-5
FOODCOURT_LOOP_APPLY_TO_ASK=true
FOODCOURT_LOOP_APPLY_TO_DAILY=false
FOODCOURT_LOOP_APPLY_TO_PERIOD=false
```

初期はQ&AだけON推奨。

## 10. 評価AIプロンプト設計

評価AIは、最終回答を直接書き直さない。
採点と改善点だけを返す。

プロンプト骨子:

```text
あなたはフードコート売上分析AIの品質評価者です。
以下の実データ、専門AIメモ、統合回答を比較し、100点満点で採点してください。

評価軸:
1. 正確性
2. 論理性
3. 専門性
4. 実用性
5. 根拠

合格基準:
総合90点以上、かつ各項目80点以上。

禁止:
- データに無い数字を正しいものとして扱う
- 相関を因果と断定する
- 売上日とレポート発行日を混同する
- 抽象的な打ち手だけで終える

JSONのみで返してください。
```

## 11. コスト/速度設計

PDFでは品質優先だが、実運用ではAPIコストも重要。

初期設定:

- Q&A: 最大3ループ
- 日次: 最大2ループ
- 期間: 最大1〜2ループ
- 評価AIは軽量モデル優先
- 合格したら即終了
- 3回すべて再生成しない
- 既存 `ai_usage_events` に全AI呼び出しを記録

注意:

現状のQ&Aは専門AI3体 + 反証AI + 統合AIで最低5回程度のAI呼び出しがある。
ループを3回にすると、単純には最大15回以上になる。
そのため、再ループ時は以下の軽量化を行う。

1. 専門AI全部を毎回再実行しない
2. 原則、統合AIだけを改善点付きで再生成
3. 評価で「専門AIメモ自体が弱い」と判定された時だけ該当専門AIを再実行

## 12. 再生成戦略

### 12.1 標準再生成

- 専門AIメモは再利用
- 反証メモも再利用
- 統合AIに改善点だけ追加

### 12.2 部分再実行

評価AIが次のような改善点を出した場合のみ、該当専門AIを再実行する。

- イベント根拠不足 → イベント・天気AIだけ再実行
- 過去比較不足 → 他店舗・過去データAIだけ再実行
- 打ち手が抽象的 → 運営改善AIだけ再実行

Phase 1では標準再生成のみでよい。
Phase 2以降で部分再実行を追加。

## 13. キャッシュ設計

### Q&A

- 原則キャッシュしない
- ただし将来、`context_hash + normalized_question` で回答再利用可能

### 日次/期間

既存キャッシュを維持。

- `model_version` を `foodcourt-analysis-ai-v12-loop` のように上げる
- キャッシュには最終回答だけ保存
- ループ詳細は `foodcourt_ai_loop_*` に保存

## 14. 将来拡張

PDF要件に対応する拡張先。

### 14.1 RAG

- `foodcourt_ai_loop_iterations` から `passed=true` かつ `total_score>=90` の回答を抽出
- `improvement_points` とともに成功/失敗例として検索可能にする
- 将来 `embedding` 列または別テーブル `foodcourt_ai_answer_embeddings` を追加

### 14.2 蒸溜

学習データとして以下を出力できる。

```json
{
  "input": "ユーザー質問 + 実データコンテキスト",
  "draft_answer": "初回回答",
  "evaluation": {...},
  "improvement_points": [...],
  "final_answer": "合格または最高点回答"
}
```

### 14.3 ユーザーフィードバック学習

管理画面に「この回答は役に立った/違う」ボタンを追加する場合:

```sql
create table public.foodcourt_ai_answer_feedback (
  id bigint generated always as identity primary key,
  run_id uuid references public.foodcourt_ai_loop_runs(id),
  rating integer check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);
```

### 14.4 回答ランキング/成功回答再利用

- `total_score`
- ユーザーフィードバック
- 再利用回数
- 類似質問一致度

でランキング可能。

## 15. 実装順序

### Step 1: DB migration

- `foodcourt_ai_loop_runs`
- `foodcourt_ai_loop_iterations`
- RLS/権限

### Step 2: ループ共通ユーティリティ

- `evaluateFoodCourtAnswer()`
- `parseLoopEvaluationJson()`
- `buildLoopFeedback()`
- `saveFoodCourtLoopRun()`
- `saveFoodCourtLoopIteration()`

### Step 3: Q&Aに適用

- `answerFoodCourtQuestion()` の統合AI呼び出しをループ化
- 環境変数でON/OFF
- `ai_usage_events` に評価AI/再生成AIの使用量を記録

### Step 4: 検証

- 固定データで質問を投げる
- 1回目で合格するケース
- 1回目不合格→2回目合格するケース
- 3回不合格→最高点回答を返すケース
- DBに全ループが保存されること

### Step 5: 日次/期間へ展開

- `FOODCOURT_ANALYSIS_AI_VERSION` を上げる
- キャッシュ再生成
- コストを見ながらON

## 16. リスクと対策

### リスク1: APIコスト増

対策:

- Q&Aから段階導入
- 再ループ時は統合AIのみ再生成
- 合格したら即終了
- 使用量を既存 `ai_usage_events` に必ず記録

### リスク2: 回答が遅くなる

対策:

- 日次/期間は初回生成後キャッシュ
- ループON/OFFをsurface別に制御
- max loopを環境変数化

### リスク3: 評価AIが厳しすぎて毎回ループする

対策:

- 評価JSONを保存して閾値を調整可能にする
- Phase 1ではQ&Aのみ
- 不合格でも最高点回答を返す

### リスク4: 評価AI自体のハルシネーション

対策:

- 評価AIには実データ/専門メモ/回答のみを渡す
- JSON schemaを固定
- 改善点は「不足・禁止・弱める」形式に限定

## 17. 受け入れ基準

- Q&AでループON時、回答が必ず評価される
- 評価スコアと改善点がDBに保存される
- 合格基準を満たすと即返却される
- 最大3ループで停止する
- 不合格続きなら最高点回答を返す
- 使用モデル/トークン/時刻が保存される
- 既存8AI/専門AI構造は壊さない
- 既存キャッシュは旧バージョンとして温存される

## 18. 最小実装案

最初の実装は以下だけで十分。

1. DB2テーブル追加
2. Q&Aだけループ化
3. 評価AIはClaudeまたはOpenAI/Gemini fallback
4. 再ループは統合AIのみ
5. 全ログ保存
6. 環境変数でOFF可能

これでPDFの中核要件である「回答品質評価→改善点→再生成→最大3ループ→ログ保存→将来RAG/蒸溜」を満たせる。

## 19. 実装状況（2026-07-07・追記）

「18. 最小実装案」の範囲（Step 1〜4・Q&Aのみ）を実装済み。

### 実装したもの

- **DB**: `supabase/migrations/20260707140000_foodcourt_ai_loop_engineering.sql` に `foodcourt_ai_loop_runs` / `foodcourt_ai_loop_iterations` を追加（本設計書6章とほぼ同一。`improvement_points`は独立列にせず`evaluation` jsonbに含める形に簡略化）。
- **ループ共通ユーティリティ**（`supabase/functions/_shared/foodcourt_compare.ts`、`foodCourtAiChat`の直後に追加）:
  `parseLoopEvaluationJson` / `evaluateFoodCourtAnswer` / `buildLoopFeedback` / `appendLoopFeedback` / `saveFoodCourtLoopRun` / `updateFoodCourtLoopRun` / `saveFoodCourtLoopIteration` / `runFoodCourtLoopEngineering`（`export`）。
- **Q&Aへの適用**: `answerFoodCourtQuestion()`の最終統合AI呼び出しを`runFoodCourtLoopEngineering()`経由に置き換え。専門AI3体・反証AIは初回の1回だけ実行し、再ループ時は統合AIのみ`appendLoopFeedback`で改善点を追加して再生成（12.1「標準再生成」のみ実装。12.2「部分再実行」は未実装）。
- **環境変数**: 9章の一覧をそのまま使用。`FOODCOURT_LOOP_ENABLED`と`FOODCOURT_LOOP_APPLY_TO_ASK`が両方truenのときだけ有効化。**未設定時は両方false扱い＝既定は完全OFF**（無効時は`initialGenerate()`を1回呼ぶだけで、DB保存も含めループ導入前と全く同じ動作）。

### 設計書からの変更点（実装中に見つけた修正）

- **合否判定は評価AIの`passed`自己申告を信用しない**: `parseLoopEvaluationJson`は`passed`を常に`false`で返し、`runFoodCourtLoopEngineering`が`total_score>=passTotal`かつ全項目`>=passEach`から算出し直す。
- **ベスト回答の選定ロジックにバグを発見し修正**: 単純に「総合点が高い方を残す」実装だと、①総合点は高いが各項目基準未達で不合格だった回答が、②実際に合格した回答（総合点が同点以下）より優先されて返ってしまう事故と、③評価AI自体が失敗(evaluation_failed)した1ループ目の生成結果が、スコア初期値(-1)に阻まれて取りこぼされる事故の2件を、擬似シミュレーションのテストで検出。「合格したループは無条件でbest」「まだ候補が無ければ最初の生成物を無条件でbest」を追加して解消済み（`runFoodCourtLoopEngineering`内のコメント参照）。

### 未実装

- 12.2「部分再実行」（改善点の内容に応じて特定の専門AIだけ再実行）。
- 14章の将来拡張（RAG・蒸溜・ユーザーフィードバック・回答ランキング）。

### 未実施

- Supabase本番(hocbn)へのマイグレーション適用・Edge Functionデプロイ、および環境変数(`FOODCOURT_LOOP_*`)の設定。`deno check`によるQ&A/日次/期間サマリー実装ファイル（`foodcourt_compare.ts`・`admin-api/index.ts`）の型チェックは通過済み（既存の無関係なエラーのみ残存）。実際のAI呼び出しを伴う動作確認は本番デプロイ後に必要。

## 20. Phase 2（日次サマリー）実装状況（2026-07-07・追記）

### 実装したもの

- `generateFoodCourtDailySummary()`の最終統合AI呼び出しを`runFoodCourtLoopEngineering({surface:'daily_summary', ...})`経由に置き換え。Q&Aと同様、専門AI3体・反証AIは初回のみ実行し、再ループは統合AIのみ再生成。
- Q&Aと違い自由入力の質問文が無いため、評価AI向けに`「${baseName}」の${businessDate}の日次サマリーを、7見出しフォーマット厳守で生成するタスク`という固定タスク文言を`question`として渡す。
- `sourceRef`は`{report_id, business_date}`（設計書8.2どおり）。

### 前回の相談で挙げた3つの懸念への対応

1. **バージョン定数の共用問題**: `foodcourt_compare.ts`に`FOODCOURT_DAILY_ANALYSIS_AI_VERSION = 'foodcourt-analysis-ai-v12-loop'`を新設し、日次サマリー(`admin-api`の`/foodcourt/daily-summary`内の3箇所)だけこちらを参照するよう変更。期間サマリー(`/foodcourt/period-summary`)は従来どおり`FOODCOURT_ANALYSIS_AI_VERSION`のまま独立させたため、日次のバージョンアップが期間サマリーのキャッシュを巻き添えで無効化することはない。
2. **surfaceごとのmaxLoops**: `resolveFoodCourtLoopConfig`を拡張し、`FOODCOURT_LOOP_MAX_ASK` / `FOODCOURT_LOOP_MAX_DAILY` / `FOODCOURT_LOOP_MAX_PERIOD`という専用環境変数を用意（優先順位: surface専用 → 共通の`FOODCOURT_LOOP_MAX` → surfaceごとの既定値）。既定値はask=3・daily=2・period=1（後述のとおりperiodは控えめ指示によりさらに引き下げ）。テストで正しく優先順位が働くことを確認済み。
3. **固定タスク文言**: 上記のとおり対応済み。

### 検証

- `deno check`: `foodcourt_compare.ts`・`admin-api/index.ts`とも既存の無関係なエラーのみ（新規エラーなし）。
- `resolveFoodCourtLoopConfig`のmaxLoops優先順位ロジックを疑似シナリオでテストし、既定値／共通上書き／surface別上書きの3パターンが正しく動くことを確認。

## 21. Phase 3（期間サマリー）実装状況（2026-07-07・追記・「控えめで」指示に基づく）

### 実装したもの

- `generateFoodCourtPeriodSummary()`の最終統合AI呼び出しを`runFoodCourtLoopEngineering({surface:'period_summary', ...})`経由に置き換え。Q&A・日次と同じパターン（専門AI3体・反証AIは初回のみ、再ループは統合AIのみ再生成）。
- 評価AI向けの固定タスク文言は`「${baseName}」の${startDate}〜${endDate}の期間サマリーを、7見出しフォーマット厳守で生成するタスク`。`sourceRef`は`{start_date, end_date}`。

### 「控えめで」の反映

ユーザー指示により、11章「期間: 最大1〜2ループ」のうち**下限の1を既定値に変更**（`FOODCOURT_LOOP_DEFAULT_MAX.period_summary = 1`。日次のask=3・daily=2はそのまま）。合格しなければ即座に最高点回答（実質1回生成した回答）を返す、最も保守的な設定。

さらに、日次では新しい`FOODCOURT_DAILY_ANALYSIS_AI_VERSION`を発行してキャッシュを明示的に無効化したが、**期間サマリーの`model_version`（`FOODCOURT_ANALYSIS_AI_VERSION`）は意図的にそのまま据え置いた**。ループは既定でOFFのため、有効化するまでは生成ロジックが実質変わらず、バージョンを上げても「中身は同じだが課金だけ発生する」再生成が起きるだけになる。バージョンを上げる（＝既存キャッシュを一斉に無効化する）のは、実際に`FOODCOURT_LOOP_APPLY_TO_PERIOD=true`にして有効化する段になってから、まとめて行うのが合理的と判断した。

### 検証

- `deno check`: `foodcourt_compare.ts`は既存の無関係なエラーのみ（新規エラーなし）。`admin-api/index.ts`は無変更（期間サマリーの`model_version`参照は触っていない）。
