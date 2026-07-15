import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessFoodCourtEvolutionReadiness,
  buildFoodCourtRevisionMessages,
  compactFoodCourtEvaluationContext,
  foodCourtEvaluationPassed,
  foodCourtLoopHasBudget,
  foodCourtTextSimilarity,
  normalizeFoodCourtPassingScore,
  rankFoodCourtRagDocuments,
  resolveFoodCourtPassingThresholds,
} from '../supabase/functions/_shared/foodcourt_loop_utils.ts'

test('configured passing score controls both total and per-axis thresholds', () => {
  assert.deepEqual(resolveFoodCourtPassingThresholds('72', 75, 65), { passTotal: 72, passEach: 72 })
  assert.deepEqual(resolveFoodCourtPassingThresholds('', 75, 65), { passTotal: 75, passEach: 65 })
})

test('passing score accepts only whole numbers within the slider range', () => {
  assert.equal(normalizeFoodCourtPassingScore(30), 30)
  assert.equal(normalizeFoodCourtPassingScore('95'), 95)
  assert.equal(normalizeFoodCourtPassingScore(29), null)
  assert.equal(normalizeFoodCourtPassingScore(96), null)
  assert.equal(normalizeFoodCourtPassingScore('65.5'), null)
})

test('evaluation context keeps both ends within the size budget', () => {
  const compact = compactFoodCourtEvaluationContext('A'.repeat(200) + 'MIDDLE' + 'Z'.repeat(200), 120)
  assert.ok(compact.length <= 120)
  assert.ok(compact.startsWith('A'))
  assert.ok(compact.endsWith('Z'))
  assert.match(compact, /中間部分を省略/)
})

test('revision includes the previous answer before feedback', () => {
  const messages = buildFoodCourtRevisionMessages(
    [{ role: 'user', content: '分析してください' }],
    '根拠を追加する',
    '初回回答',
  )
  assert.equal(messages.at(-2)?.role, 'assistant')
  assert.equal(messages.at(-2)?.content, '初回回答')
  assert.match(messages.at(-1)?.content ?? '', /根拠を追加する/)
})

test('evaluation requires total and every axis to pass', () => {
  const base = { total_score: 90, scores: { accuracy: 80, logic: 80, expertise: 80, practicality: 80, evidence: 80 } }
  assert.equal(foodCourtEvaluationPassed(base, 90, 80), true)
  assert.equal(foodCourtEvaluationPassed({ ...base, scores: { ...base.scores, evidence: 79 } }, 90, 80), false)
  assert.equal(foodCourtEvaluationPassed({ ...base, total_score: 89 }, 90, 80), false)
})

test('later loop requires enough remaining budget', () => {
  assert.equal(foodCourtLoopHasBudget(20_000, 14_000, 1), true)
  assert.equal(foodCourtLoopHasBudget(20_000, 14_000, 2), false)
  assert.equal(foodCourtLoopHasBudget(20_000, 8_000, 2), true)
})

test('Japanese bigram similarity ranks related questions higher', () => {
  const related = foodCourtTextSimilarity('イベント日の客数を分析', 'イベントによる来客数の変化')
  const unrelated = foodCourtTextSimilarity('イベント日の客数を分析', '消耗品の勘定科目')
  assert.ok(related > unrelated)
})

test('RAG ranking keeps the most relevant approved document first', () => {
  const ranked = rankFoodCourtRagDocuments('東京ドームイベント日の客数を分析', [
    {
      source_run_id: 'unrelated',
      search_text: '消耗品の勘定科目とレシート',
      document_markdown: '# unrelated',
      final_score: 98,
    },
    {
      source_run_id: 'related',
      search_text: '東京ドームのイベント開催日に来客数と売上が増えた',
      document_markdown: '# related',
      final_score: 85,
    },
  ])
  assert.equal(ranked[0]?.source_run_id, 'related')
  assert.equal(ranked.some((row) => row.source_run_id === 'unrelated'), false)
})

test('RAG ranking returns no document when every candidate is unrelated', () => {
  const ranked = rankFoodCourtRagDocuments('東京ドームイベント日の客数を分析', [
    {
      source_run_id: 'unrelated',
      search_text: '消耗品の勘定科目とレシート',
      document_markdown: '# unrelated',
      final_score: 98,
    },
  ])
  assert.deepEqual(ranked, [])
})

test('evolution readiness never enables automatic promotion', () => {
  const readiness = assessFoodCourtEvolutionReadiness({
    totalRuns: 200,
    completedRuns: 200,
    acceptedExamples: 120,
    humanHelpfulExamples: 25,
    dailyAcceptedExamples: 35,
    acceptedSurfaces: 4,
  })
  assert.equal(readiness.gates.promptCandidate.ready, true)
  assert.equal(readiness.gates.modelDistillation.ready, true)
  assert.equal(readiness.promotionMode, 'manual_only')
})

test('evolution readiness remains in data collection below evidence thresholds', () => {
  const readiness = assessFoodCourtEvolutionReadiness({
    totalRuns: 29,
    completedRuns: 28,
    acceptedExamples: 3,
    humanHelpfulExamples: 0,
    dailyAcceptedExamples: 0,
    acceptedSurfaces: 2,
  })
  assert.equal(readiness.status, 'collecting_data')
  assert.equal(readiness.gates.ragReuse.ready, true)
  assert.equal(readiness.gates.promptCandidate.ready, false)
  assert.equal(readiness.gates.modelDistillation.ready, false)
})
