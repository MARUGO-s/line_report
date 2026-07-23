export type FoodCourtLoopMessage = { role: string; content: string }

export type FoodCourtLoopScores = {
  total_score: number
  scores: {
    accuracy: number
    logic: number
    expertise: number
    practicality: number
    evidence: number
  }
}

export const FOODCOURT_PASSING_SCORE_MIN = 30
export const FOODCOURT_PASSING_SCORE_MAX = 95
export const FOODCOURT_PER_AXIS_MARGIN = 5

export function normalizeFoodCourtPassingScore(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null
  const score = Number(value)
  if (!Number.isInteger(score)) return null
  if (score < FOODCOURT_PASSING_SCORE_MIN || score > FOODCOURT_PASSING_SCORE_MAX) return null
  return score
}

export function resolveFoodCourtPassingThresholds(
  configuredScore: unknown,
  fallbackTotal: number,
  fallbackEach: number,
): { passTotal: number; passEach: number } {
  const score = normalizeFoodCourtPassingScore(configuredScore)
  return score == null
    ? { passTotal: fallbackTotal, passEach: fallbackEach }
    : {
      passTotal: score,
      // 総合点と全5軸を同一点にすると、総合点を満たしていても1軸が2点低いだけで
      // 不合格・再生成となりやすい。総合品質を維持しつつ、各軸には5点の許容幅を持たせる。
      passEach: Math.max(FOODCOURT_PASSING_SCORE_MIN, score - FOODCOURT_PER_AXIS_MARGIN),
    }
}

export function foodCourtEvaluationSurfaceRules(surface: string): string[] {
  if (surface === 'daily_summary') {
    return [
      '【日次分析の評価基準】評価は入力に実際に含まれるデータだけで行う。',
      '入力にない他店のイベント捕捉率、統計的有意差、時間帯別実績、施策実績を追加要求して減点しない。未提供データは「確認できない」と明記できていればよい。',
      '実用性は、根拠のない数値目標を置くことではない。次回確認する観測可能なKPIまたは具体的な行動が1つあれば十分とする。',
      '日報ブロックが無い場合は「施策なし」と断定せず、「日報記録を確認できない」と区別できているかを見る。',
      '比較条件が違う前回分析を単純に肯定・否定せず、直接比較できない旨を明記できていれば減点しない。',
      'improvement_points は、与えられたデータだけで修正可能な内容に限定する。入力にないデータの追加取得を改善必須条件にしない。',
    ]
  }
  if (surface === 'ask') {
    return [
      '【Q&Aの評価基準】ユーザーの質問に直接答えていることを最優先する。回答に不要な網羅性を要求しない。',
      '入力にない競合ベンチマーク、施策効果実績、販売点数を追加要求して減点しない。無いデータを限界として明記できていればよい。',
      '施策案は効果を保証せず「検証仮説」と明記し、対象・実施方法・観測KPIの3点があれば実用的と評価する。根拠のないリフト率や増収額を置く必要はない。',
      '日報の主観情報は、主観と明記して検証KPIへ接続していれば分析材料として認める。定量実績がないことだけを理由に低得点にしない。',
      '相関を因果と断定せず、共通要因の可能性を明記している回答は、因果証明がないことだけを理由に減点しない。',
      'improvement_points は入力内の情報で改稿可能な内容に限定し、外部事例や未取得データの提示を合格必須条件にしない。',
    ]
  }
  return []
}

export function foodCourtEvaluationScoreAnchors(): string[] {
  return [
    '【採点アンカー】点数は次の絶対基準で付け、機械的に60点台へ寄せない。',
    '90〜100点: 重要な誤りがなく、根拠・論理・実行可能性が非常に高い。',
    '80〜89点: 強い回答。軽微な改善余地はあるが、そのまま意思決定に使える。',
    '70〜79点: 実用可能な合格水準。主要結論は妥当で、改善点は限定的。',
    '60〜69点: 複数の重要な根拠不足・論理矛盾・実行困難があり、改稿が必要。',
    '59点以下: 重大な事実誤認、捏造、質問への未回答などがある。',
    '不足データを明記し、断定を避け、利用可能な根拠で質問へ直接回答している場合、不足データの存在だけを理由に69点以下へ落とさない。',
  ]
}

export function buildFoodCourtRevisionMessages(
  messages: FoodCourtLoopMessage[],
  feedback: string,
  previousAnswer: string,
): FoodCourtLoopMessage[] {
  return [...messages, {
    role: 'assistant',
    content: previousAnswer,
  }, {
    role: 'system',
    content: `上記の直前回答は品質評価で改善が必要と判定されました。回答全文を確認した上で、以下の改善点を反映してください。根拠が確認できない主張は削除または仮説へ弱め、良かった点・出力形式は維持して回答全文を改稿してください。改善点が入力にないデータを要求している場合は数字を作らず、「現データでは確認できない」と明記し、代わりに次回記録すべき項目を1つ示してください。前回より主張や数値をむやみに増やさず、指摘箇所だけを修正してください。\n\n${feedback}`,
  }]
}

export function foodCourtEvaluationPassed(
  evaluation: FoodCourtLoopScores | null,
  passTotal: number,
  passEach: number,
): boolean {
  if (!evaluation || evaluation.total_score < passTotal) return false
  return Object.values(evaluation.scores).every((score) => score >= passEach)
}

export function foodCourtLoopHasBudget(deadlineAt: number, now: number, loopIndex: number): boolean {
  const minimumIterationMs = loopIndex === 1 ? 5000 : 12000
  return deadlineAt - now >= minimumIterationMs
}

function textBigrams(value: string): Set<string> {
  const s = String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

export function foodCourtTextSimilarity(a: string, b: string): number {
  const aa = textBigrams(a), bb = textBigrams(b)
  if (!aa.size || !bb.size) return 0
  let shared = 0
  for (const x of aa) if (bb.has(x)) shared++
  return shared / Math.max(aa.size, bb.size)
}

export type FoodCourtRagDocumentCandidate = {
  source_run_id: string
  search_text: string
  document_markdown: string
  final_score?: number | null
  updated_at?: string | null
}

export function rankFoodCourtRagDocuments(
  taskText: string,
  documents: FoodCourtRagDocumentCandidate[],
  limit = 2,
): FoodCourtRagDocumentCandidate[] {
  const safeLimit = Math.max(1, Math.min(5, Math.trunc(limit) || 1))
  return documents
    .map((document) => ({
      document,
      similarity: foodCourtTextSimilarity(taskText, document.search_text),
    }))
    .sort((a, b) => b.similarity - a.similarity
      || Number(b.document.final_score ?? 0) - Number(a.document.final_score ?? 0)
      || String(b.document.updated_at ?? '').localeCompare(String(a.document.updated_at ?? '')))
    .filter((candidate) => candidate.similarity >= 0.03)
    .slice(0, safeLimit)
    .map((candidate) => candidate.document)
}

export type FoodCourtEvolutionReadinessCounts = {
  totalRuns: number
  completedRuns: number
  acceptedExamples: number
  humanHelpfulExamples: number
  dailyAcceptedExamples: number
  acceptedSurfaces: number
}

export const FOODCOURT_EVOLUTION_READINESS_THRESHOLDS = {
  promptCandidate: {
    acceptedExamples: 20,
    humanHelpfulExamples: 5,
    dailyAcceptedExamples: 5,
  },
  modelDistillation: {
    acceptedExamples: 100,
    humanHelpfulExamples: 20,
    dailyAcceptedExamples: 30,
    acceptedSurfaces: 3,
  },
} as const

function safeCount(value: unknown): number {
  const count = Number(value)
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
}

function readinessRequirement(current: number, required: number) {
  return {
    current,
    required,
    met: current >= required,
  }
}

export function assessFoodCourtEvolutionReadiness(input: FoodCourtEvolutionReadinessCounts) {
  const counts: FoodCourtEvolutionReadinessCounts = {
    totalRuns: safeCount(input.totalRuns),
    completedRuns: safeCount(input.completedRuns),
    acceptedExamples: safeCount(input.acceptedExamples),
    humanHelpfulExamples: safeCount(input.humanHelpfulExamples),
    dailyAcceptedExamples: safeCount(input.dailyAcceptedExamples),
    acceptedSurfaces: safeCount(input.acceptedSurfaces),
  }
  const promptRequirements = {
    acceptedExamples: readinessRequirement(
      counts.acceptedExamples,
      FOODCOURT_EVOLUTION_READINESS_THRESHOLDS.promptCandidate.acceptedExamples,
    ),
    humanHelpfulExamples: readinessRequirement(
      counts.humanHelpfulExamples,
      FOODCOURT_EVOLUTION_READINESS_THRESHOLDS.promptCandidate.humanHelpfulExamples,
    ),
    dailyAcceptedExamples: readinessRequirement(
      counts.dailyAcceptedExamples,
      FOODCOURT_EVOLUTION_READINESS_THRESHOLDS.promptCandidate.dailyAcceptedExamples,
    ),
  }
  const distillationRequirements = {
    acceptedExamples: readinessRequirement(
      counts.acceptedExamples,
      FOODCOURT_EVOLUTION_READINESS_THRESHOLDS.modelDistillation.acceptedExamples,
    ),
    humanHelpfulExamples: readinessRequirement(
      counts.humanHelpfulExamples,
      FOODCOURT_EVOLUTION_READINESS_THRESHOLDS.modelDistillation.humanHelpfulExamples,
    ),
    dailyAcceptedExamples: readinessRequirement(
      counts.dailyAcceptedExamples,
      FOODCOURT_EVOLUTION_READINESS_THRESHOLDS.modelDistillation.dailyAcceptedExamples,
    ),
    acceptedSurfaces: readinessRequirement(
      counts.acceptedSurfaces,
      FOODCOURT_EVOLUTION_READINESS_THRESHOLDS.modelDistillation.acceptedSurfaces,
    ),
  }
  const promptCandidateReady = Object.values(promptRequirements).every((requirement) => requirement.met)
  const modelDistillationReady = Object.values(distillationRequirements).every((requirement) => requirement.met)
  return {
    status: promptCandidateReady ? 'candidate_evaluation_ready' : 'collecting_data',
    promotionMode: 'manual_only',
    counts,
    gates: {
      ragReuse: {
        ready: counts.acceptedExamples >= 1,
        requirements: {
          acceptedExamples: readinessRequirement(counts.acceptedExamples, 1),
        },
      },
      promptCandidate: {
        ready: promptCandidateReady,
        requirements: promptRequirements,
      },
      modelDistillation: {
        ready: modelDistillationReady,
        requirements: distillationRequirements,
      },
    },
  }
}

export function compactFoodCourtEvaluationContext(context: string, maxChars = 14000): string {
  if (context.length <= maxChars) return context
  const marker = '\n\n...（評価用に中間部分を省略）...\n\n'
  const side = Math.max(1, Math.floor((maxChars - marker.length) / 2))
  return context.slice(0, side) + marker + context.slice(-side)
}

// ===== AIフォールバック検知（docs/AI_LOOP_ENGINEERING_DESIGN.md 16章 リスク対策の可観測化） =====
// 各AI呼び出し（foodCourtAiChat）は preferred プロバイダから順に試し、失敗したら別プロバイダ/別モデルへ
// フォールバックする。従来はどのAIが反応せず退避したか内部ログにしか出ず、管理画面から見えなかった。
// ここでは「1回のAI呼び出しの試行ログ」から、フォールバックとして記録すべきか（＝希望どおりでなかったか）を
// 判定する純関数を提供する。DB書き込み・fetchは行わないためユニットテストできる。

export type FoodCourtAiAttempt = {
  provider: string
  model: string | null
  ok: boolean
  // 失敗理由（http_5xx / http_4xx / empty_content / exception / missing_key / timeout など）。成功時は null。
  reason?: string | null
}

export type FoodCourtFallbackEvent = {
  preferredProvider: string
  preferredModel: string | null
  usedProvider: string | null
  usedModel: string | null
  outcome: 'fallback_success' | 'all_failed'
  attempts: FoodCourtAiAttempt[]
}

// 試行ログから、フォールバック記録が必要かを判定して整形する。
// 記録する条件:
//  - 1つ目の希望が失敗し、別プロバイダ/別モデルで成功した（fallback_success）
//  - あるいは全滅（どの試行も ok=false）だった（all_failed）
// 記録しない条件（null を返す）:
//  - 試行が空（deadline 等で1回も呼べなかった）
//  - 1つ目の試行がそのまま成功した（＝フォールバックしていない）
export function buildFoodCourtFallbackEvent(
  preferredProvider: string,
  attempts: FoodCourtAiAttempt[],
): FoodCourtFallbackEvent | null {
  if (!Array.isArray(attempts) || attempts.length === 0) return null
  const first = attempts[0]
  const preferredModel = first?.model ?? null
  const success = attempts.find((a) => a && a.ok) ?? null

  if (success) {
    // 1つ目がそのまま成功＝フォールバックしていない → 記録不要。
    if (first && first.ok) return null
    return {
      preferredProvider,
      preferredModel,
      usedProvider: success.provider,
      usedModel: success.model ?? null,
      outcome: 'fallback_success',
      attempts,
    }
  }

  // すべて失敗＝全滅。最初の希望が単発失敗でも「反応しなかった」ので記録する。
  return {
    preferredProvider,
    preferredModel,
    usedProvider: null,
    usedModel: null,
    outcome: 'all_failed',
    attempts,
  }
}

// ===== 回答内の数値の根拠チェック（コード側の決定論的検査） =====
// 統合AIの最終回答に、コードが渡した事実ブロック（evaluationContext）に存在しない
// 「係数」や「金額/客数」が混入していないかを検査する純関数。DB/fetch非依存でテスト可能。
// 目的: 評価AIが繰り返し指摘する「データに無い係数」「根拠のない金額・客数」を、
// 再生成フィードバックへ決定論的に差し込み、捏造数値を減らす。

export type FoodCourtNumberAudit = {
  // 事実ブロックに存在しない係数（×0.76 / 1.27倍 / 係数0.60 等）。捏造の可能性が高い。
  ungroundedCoefficients: string[]
  // 事実ブロックに存在しない金額（¥）・客数（人）の種類数。新規の目標値かもしれないため soft シグナル。
  ungroundedValueCount: number
}

// 文字列から数値集合（カンマ除去後の Number）を作る。比較は数値の一致で行う。
function fcExtractNumberSet(text: string): Set<number> {
  const set = new Set<number>()
  for (const m of String(text ?? '').matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''))
    if (Number.isFinite(n)) set.add(n)
  }
  return set
}

export function auditFoodCourtAnswerNumbers(answer: string, factsText: string): FoodCourtNumberAudit {
  const factNums = fcExtractNumberSet(factsText)
  const a = String(answer ?? '')

  // 係数: ×0.76 / x1.27 / ✕0.6 / 係数0.62 / 係数×0.62 / 1.5倍 など。整数倍(2倍等)は日本語表現で頻出のため対象外。
  const coeffSet = new Set<number>()
  const coeffRe = /(?:[×xX✕＊*]|係数[×xX]?)\s*(\d+\.\d+)|(\d+\.\d+)\s*倍/g
  for (const m of a.matchAll(coeffRe)) {
    const raw = m[1] ?? m[2]
    if (raw == null) continue
    const v = Number(raw)
    if (Number.isFinite(v)) coeffSet.add(v)
  }
  const ungroundedCoefficients: string[] = []
  for (const v of coeffSet) {
    if (!factNums.has(v)) ungroundedCoefficients.push(String(v))
  }

  // 金額(¥)・客数(人)で、事実ブロックに無い値の種類数。
  // 1〜31は日付由来の数値と衝突しやすいため無視するが、32以上は目標客数（65→80等）も検知する。
  const seen = new Set<number>()
  let ungroundedValueCount = 0
  for (const m of a.matchAll(/¥\s*([\d,]+)|([\d,]+)\s*人/g)) {
    const raw = m[1] ?? m[2]
    if (raw == null) continue
    const v = Number(raw.replace(/,/g, ''))
    if (!Number.isFinite(v) || v < 32) continue
    if (seen.has(v)) continue
    seen.add(v)
    if (!factNums.has(v)) ungroundedValueCount++
  }

  return { ungroundedCoefficients: ungroundedCoefficients.slice(0, 12), ungroundedValueCount }
}

// 数値監査の結果を、再生成フィードバックに差し込む短い指示文へ整形する。問題なしなら空文字。
export function buildFoodCourtNumberAuditFeedback(audit: FoodCourtNumberAudit): string {
  const lines: string[] = []
  if (audit.ungroundedCoefficients.length) {
    lines.push(
      '【コード検査・要修正】次の係数は提供データに存在しません。該当する統計/予測ブロックの数値だけを使い、' +
      'データに無い係数は必ず削除すること: ' + audit.ungroundedCoefficients.join(', '),
    )
  }
  if (audit.ungroundedValueCount > 0) {
    lines.push(
      '【コード検査・注意】提供データに無い金額/客数が約' + audit.ungroundedValueCount +
      '件あります。新規の金額・客数は実績値として断定せず、「検証用の目標/判定ライン（設定根拠つき）」または「仮説」と明記すること。',
    )
  }
  return lines.join('\n')
}

// 推論系モデルが本文に漏らした <think> ブロックを除去する。
// 未クローズの <think>（トークン上限で思考途中終了）も、本文が無ければ空文字へしてフォールバック可能にする。
export function stripFoodCourtThinkingBlocks(text: string): string {
  let s = String(text ?? '')
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, ' ')
  const lastClose = s.toLowerCase().lastIndexOf('</think>')
  if (lastClose >= 0) s = s.slice(lastClose + '</think>'.length)
  const openIdx = s.toLowerCase().indexOf('<think>')
  if (openIdx >= 0) {
    const after = s.slice(openIdx + '<think>'.length)
    const markers = ['【総評】', '【週次', '## ', '### ', '# ', '回答:', '結論:']
    let cut = -1
    for (const m of markers) {
      const i = after.indexOf(m)
      if (i >= 0 && (cut < 0 || i < cut)) cut = i
    }
    s = cut >= 0 ? after.slice(cut) : s.slice(0, openIdx)
  }
  return s.trim()
}
