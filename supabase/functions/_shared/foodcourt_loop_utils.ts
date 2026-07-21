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
  if (surface !== 'daily_summary') return []
  return [
    '【日次分析の評価基準】評価は入力に実際に含まれるデータだけで行う。',
    '入力にない他店のイベント捕捉率、統計的有意差、時間帯別実績、施策実績を追加要求して減点しない。未提供データは「確認できない」と明記できていればよい。',
    '実用性は、根拠のない数値目標を置くことではない。次回確認する観測可能なKPIまたは具体的な行動が1つあれば十分とする。',
    '日報ブロックが無い場合は「施策なし」と断定せず、「日報記録を確認できない」と区別できているかを見る。',
    '比較条件が違う前回分析を単純に肯定・否定せず、直接比較できない旨を明記できていれば減点しない。',
    'improvement_points は、与えられたデータだけで修正可能な内容に限定する。入力にないデータの追加取得を改善必須条件にしない。',
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
