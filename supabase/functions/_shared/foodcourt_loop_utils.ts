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
    content: `上記の直前回答は品質評価で改善が必要と判定されました。回答全文を確認した上で、以下の改善点を反映してください。根拠が確認できない主張は削除または仮説へ弱め、良かった点・出力形式は維持して回答全文を改稿してください。\n\n${feedback}`,
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
    .filter((candidate, index) => index === 0 || candidate.similarity >= 0.03)
    .slice(0, safeLimit)
    .map((candidate) => candidate.document)
}

export function compactFoodCourtEvaluationContext(context: string, maxChars = 14000): string {
  if (context.length <= maxChars) return context
  const marker = '\n\n...（評価用に中間部分を省略）...\n\n'
  const side = Math.max(1, Math.floor((maxChars - marker.length) / 2))
  return context.slice(0, side) + marker + context.slice(-side)
}
