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
FOODCOURT_LOOP_MAX_ASK=2
FOODCOURT_LOOP_PASS_TOTAL=70
FOODCOURT_LOOP_PASS_EACH=65
FOODCOURT_LOOP_EVALUATOR_PROVIDER=claude
FOODCOURT_LOOP_EVALUATOR_MODEL=claude-haiku-4-5
FOODCOURT_LOOP_APPLY_TO_ASK=true
FOODCOURT_LOOP_APPLY_TO_DAILY=true
FOODCOURT_LOOP_APPLY_TO_PERIOD=true
FOODCOURT_LOOP_APPLY_TO_WEEKLY=true
FOODCOURT_AI_REQUEST_BUDGET_MS=110000
```

2026-08-07時点の本番はQ&A・日次・期間・週次の全surfaceをONにしている。管理画面の合格ライン設定が存在する場合は、環境変数より優先する。反証AI④は**全 surface で Claude Haiku**（→ Gemini → Groq）を使い、評価AI⑥も Claude Haiku を維持する。専門AI①は Groq `openai/gpt-oss-120b`（失敗時 Gemini）。**Qwen／Kimi（Moonshot）は情報流出対策で構成外**（旧 env に残っていても GPT-OSS／Claude へ強制退避）。

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

## 14. 学習データ再利用と将来拡張

2026-07-16時点で、安全に自動化できる収集・再利用・書き出しまで実装済み。モデルのファインチューニングと本番モデルの自動昇格は未実装で、準備度ゲートが満たされた後も手動承認を必須とする。

### 14.1 RAG（実装済み）

- DBトリガーが、品質合格または人が `helpful` とした回答だけを `foodcourt_ai_rag_documents` へ同期する。
- `not_helpful` は即時に無効化し、次回プロンプトへ混入させない。
- 同一店舗・同一surface内で日本語bigram類似度を計算し、類似度0.03未満は採用しない。
- 現在は字句検索であり、embeddingによる意味検索ではない。将来 `pgvector` を導入する場合も、現在の承認条件を前段ゲートとして維持する。

### 14.2 蒸留データ出力（実装済み）

`GET /foodcourt/ai-distillation-dataset` は、承認済みrunから以下をJSONL向け構造として出力する。

```json
{
  "input": {"task": "質問または定型分析", "source_ref": {}},
  "initial_response": "初回回答",
  "initial_evaluation": {"improvement_points": []},
  "preferred_response": "品質合格または人が承認した最終回答",
  "trajectory": [{"loop_index": 1, "score": 62, "evaluator_feedback": {}}]
}
```

この出力は教師データ候補であり、出力しただけで基盤モデルが学習するわけではない。

### 14.3 ユーザーフィードバック学習（実装済み）

- 管理画面の「役に立った」「改善が必要」を `foodcourt_ai_feedback` に保存する。
- `helpful` は品質点にかかわらず承認教材にできる。
- `not_helpful` はRAGと蒸留データセットの両方から除外する。

### 14.4 進化準備度ゲート（実装済み）

`GET /foodcourt/evolution-readiness` と `foodcourt-evolution.html` で次を監視する。

- RAG再利用: 承認済み1件以上
- プロンプト候補の比較評価: 承認済み20件、人の承認5件、日次分析5件
- モデル蒸留の検討: 承認済み100件、人の承認20件、日次分析30件、3種類以上のsurface

件数を満たしても `promotionMode=manual_only` を維持する。現行プロンプトと候補版の固定評価セット比較、回帰検査、コスト確認なしに本番昇格させない。

### 14.5 プロンプト候補の固定評価セット（Phase 2）

2026-08-13から、開始条件を満たした店舗だけが、承認済み教材から**固定評価セット**を一度だけ作成できる。

- `foodcourt_prompt_evaluation_sets` は、同一店舗で有効なセットを1つだけ保持する。
- `foodcourt_prompt_evaluation_cases` は、品質合格または人が `helpful` とした既存runの入力参照・ベースライン回答・点数を固定する。後から教材が増えても、比較基準は動かない。
- `foodcourt_prompt_candidates` には管理者が候補指示を下書き登録する。候補の自動生成、現在のプロンプトへの自動適用、モデル変更、自動昇格は行わない。
- 作成・候補登録は `admin-api` 経由だけで行い、3テーブルはRLS有効・`anon`/`authenticated`権限なしとする。

初回の固定セットは「現行回答の基準点」を保存する段階であり、候補の実行・採否は固定セット比較、回帰検査、コスト確認、人の承認をそろえた後に別途行う。

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
- **環境変数**: 9章の一覧をそのまま使用。`FOODCOURT_LOOP_ENABLED`とsurface別の`FOODCOURT_LOOP_APPLY_TO_*`が両方trueのときだけ有効化。**未設定時はfalse扱い＝既定は完全OFF**（無効時は`initialGenerate()`を1回呼ぶだけで、DB保存も含めループ導入前と全く同じ動作）。2026-07-22時点の本番はQ&A・日次・期間・週次の全surfaceを明示ON。

### 設計書からの変更点（実装中に見つけた修正）

- **合否判定は評価AIの`passed`自己申告を信用しない**: `parseLoopEvaluationJson`は`passed`を常に`false`で返し、`runFoodCourtLoopEngineering`が`total_score>=passTotal`かつ全項目`>=passEach`から算出し直す。
- **ベスト回答の選定ロジックにバグを発見し修正**: 単純に「総合点が高い方を残す」実装だと、①総合点は高いが各項目基準未達で不合格だった回答が、②実際に合格した回答（総合点が同点以下）より優先されて返ってしまう事故と、③評価AI自体が失敗(evaluation_failed)した1ループ目の生成結果が、スコア初期値(-1)に阻まれて取りこぼされる事故の2件を、擬似シミュレーションのテストで検出。「合格したループは無条件でbest」「まだ候補が無ければ最初の生成物を無条件でbest」を追加して解消済み（`runFoodCourtLoopEngineering`内のコメント参照）。

### 未実装

- 12.2「部分再実行」（改善点の内容に応じて特定の専門AIだけ再実行）。
- 14章の将来拡張（RAG・蒸溜・ユーザーフィードバック・回答ランキング）。

### 未実施

- なし（2026-07-22時点でSupabase本番(hocbn)へのマイグレーション適用・Edge Functionデプロイ・`FOODCOURT_LOOP_*`設定は完了）。本番ではQ&A・日次・期間・週次の全surfaceがONで、期間サマリーは本番ループ実行を確認済み。週次は次回生成時に同じ設定で適用される。

## 20. Phase 2（日次サマリー）実装状況（2026-07-07・追記）

### 実装したもの

- `generateFoodCourtDailySummary()`の最終統合AI呼び出しを`runFoodCourtLoopEngineering({surface:'daily_summary', ...})`経由に置き換え。Q&Aと同様、専門AI3体・反証AIは初回のみ実行し、再ループは統合AIのみ再生成。
- Q&Aと違い自由入力の質問文が無いため、評価AI向けに`「${baseName}」の${businessDate}の日次サマリーを、7見出しフォーマット厳守で生成するタスク`という固定タスク文言を`question`として渡す。
- `sourceRef`は`{report_id, business_date}`（設計書8.2どおり）。

### 前回の相談で挙げた3つの懸念への対応

1. **バージョン定数の共用問題**: `foodcourt_compare.ts`に`FOODCOURT_DAILY_ANALYSIS_AI_VERSION = 'foodcourt-analysis-ai-v12-loop'`を新設し、日次サマリー(`admin-api`の`/foodcourt/daily-summary`内の3箇所)だけこちらを参照するよう変更。期間サマリー(`/foodcourt/period-summary`)は従来どおり`FOODCOURT_ANALYSIS_AI_VERSION`のまま独立させたため、日次のバージョンアップが期間サマリーのキャッシュを巻き添えで無効化することはない。
2. **surfaceごとのmaxLoops**: `resolveFoodCourtLoopConfig`を拡張し、`FOODCOURT_LOOP_MAX_ASK` / `FOODCOURT_LOOP_MAX_DAILY` / `FOODCOURT_LOOP_MAX_PERIOD` / `FOODCOURT_LOOP_MAX_WEEKLY`という専用環境変数を用意（優先順位: surface専用 → 共通の`FOODCOURT_LOOP_MAX` → surfaceごとの既定値）。2026-07-22時点の既定値は全surface=2（初回＋最大1回の改善）。テストで正しく優先順位が働くことを確認済み。
3. **固定タスク文言**: 上記のとおり対応済み。

### 検証

- `deno check`: `foodcourt_compare.ts`・`admin-api/index.ts`とも既存の無関係なエラーのみ（新規エラーなし）。
- `resolveFoodCourtLoopConfig`のmaxLoops優先順位ロジックを疑似シナリオでテストし、既定値／共通上書き／surface別上書きの3パターンが正しく動くことを確認。

## 21. Phase 3（期間サマリー）実装状況（2026-07-07・追記・「控えめで」指示に基づく）

### 実装したもの

- `generateFoodCourtPeriodSummary()`の最終統合AI呼び出しを`runFoodCourtLoopEngineering({surface:'period_summary', ...})`経由に置き換え。Q&A・日次と同じパターン（専門AI3体・反証AIは初回のみ、再ループは統合AIのみ再生成）。
- 評価AI向けの固定タスク文言は`「${baseName}」の${startDate}〜${endDate}の期間サマリーを、7見出しフォーマット厳守で生成するタスク`。`sourceRef`は`{start_date, end_date}`。

### 「控えめで」の反映

当初は「期間: 最大1〜2ループ」の下限1を既定値にする案だったが、2026-07-22時点の実装は全surface共通で上限2（初回＋最大1回の改善）に揃えている。合格すれば即終了し、不合格続きでも最高点回答を返すため、過剰な再生成は避ける。

さらに、日次では新しい`FOODCOURT_DAILY_ANALYSIS_AI_VERSION`を発行してキャッシュを明示的に無効化したが、**期間サマリーの`model_version`（`FOODCOURT_ANALYSIS_AI_VERSION`）は意図的にそのまま据え置いた**。2026-07-22時点で`FOODCOURT_LOOP_APPLY_TO_PERIOD=true`に有効化済みだが、既存期間キャッシュを一斉再生成して課金を発生させないため、バージョンは引き続き据え置く。未キャッシュ期間、またはforce/キャッシュ更新が走る期間から品質ループが適用される。

### 検証

- `deno check`: `foodcourt_compare.ts`は既存の無関係なエラーのみ（新規エラーなし）。`admin-api/index.ts`は無変更（期間サマリーの`model_version`参照は触っていない）。
