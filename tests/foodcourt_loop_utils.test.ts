import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessFoodCourtEvolutionReadiness,
  buildFoodCourtRevisionMessages,
  buildFoodCourtFallbackEvent,
  auditFoodCourtAnswerNumbers,
  buildFoodCourtNumberAuditFeedback,
  compactFoodCourtEvaluationContext,
  foodCourtEvaluationPassed,
  foodCourtEvaluationScoreAnchors,
  foodCourtEvaluationSurfaceRules,
  foodCourtLoopHasBudget,
  foodCourtTextSimilarity,
  normalizeFoodCourtPassingScore,
  rankFoodCourtRagDocuments,
  resolveFoodCourtPassingThresholds,
} from '../supabase/functions/_shared/foodcourt_loop_utils.ts'

test('configured passing score keeps a five-point per-axis margin', () => {
  assert.deepEqual(resolveFoodCourtPassingThresholds('72', 75, 65), { passTotal: 72, passEach: 67 })
  assert.deepEqual(resolveFoodCourtPassingThresholds('70', 75, 65), { passTotal: 70, passEach: 65 })
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
  assert.match(messages.at(-1)?.content ?? '', /現データでは確認できない/)
  assert.match(messages.at(-1)?.content ?? '', /指摘箇所だけ/)
})

test('evaluation requires total and every axis to pass', () => {
  const base = { total_score: 90, scores: { accuracy: 80, logic: 80, expertise: 80, practicality: 80, evidence: 80 } }
  assert.equal(foodCourtEvaluationPassed(base, 90, 80), true)
  assert.equal(foodCourtEvaluationPassed({ ...base, scores: { ...base.scores, evidence: 79 } }, 90, 80), false)
  assert.equal(foodCourtEvaluationPassed({ ...base, total_score: 89 }, 90, 80), false)
})

test('daily evaluation does not demand unavailable data', () => {
  const rules = foodCourtEvaluationSurfaceRules('daily_summary').join('\n')
  assert.match(rules, /入力に実際に含まれるデータだけ/)
  assert.match(rules, /統計的有意差/)
  assert.match(rules, /日報記録を確認できない/)
  assert.deepEqual(foodCourtEvaluationSurfaceRules('period_summary'), [])
})

test('ask evaluation accepts cautious testable hypotheses without invented lift', () => {
  const rules = foodCourtEvaluationSurfaceRules('ask').join('\n')
  assert.match(rules, /ユーザーの質問に直接/)
  assert.match(rules, /検証仮説/)
  assert.match(rules, /根拠のないリフト率/)
  assert.match(rules, /主観と明記/)
})

test('evaluation score anchors define 70 as usable passing quality', () => {
  const anchors = foodCourtEvaluationScoreAnchors().join('\n')
  assert.match(anchors, /70〜79点: 実用可能な合格水準/)
  assert.match(anchors, /機械的に60点台へ寄せない/)
  assert.match(anchors, /不足データの存在だけを理由に69点以下へ落とさない/)
})

test('daily-like score passes with total 70 and per-axis 65', () => {
  const evaluation = {
    total_score: 72,
    scores: { accuracy: 70, logic: 70, expertise: 73, practicality: 68, evidence: 69 },
  }
  assert.equal(foodCourtEvaluationPassed(evaluation, 70, 65), true)
  assert.equal(foodCourtEvaluationPassed(evaluation, 70, 70), false)
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

test('fallback event: preferred provider succeeds first -> not recorded', () => {
  const event = buildFoodCourtFallbackEvent('moonshot', [
    { provider: 'moonshot', model: 'kimi-k3', ok: true, reason: null },
  ])
  assert.equal(event, null)
})

test('fallback event: empty attempts (deadline before any call) -> not recorded', () => {
  assert.equal(buildFoodCourtFallbackEvent('moonshot', []), null)
})

test('fallback event: preferred fails then next provider succeeds -> fallback_success', () => {
  const event = buildFoodCourtFallbackEvent('moonshot', [
    { provider: 'moonshot', model: 'kimi-k3', ok: false, reason: 'http_500' },
    { provider: 'claude', model: 'claude-haiku-4-5', ok: true, reason: null },
  ])
  assert.ok(event)
  assert.equal(event!.outcome, 'fallback_success')
  assert.equal(event!.preferredProvider, 'moonshot')
  assert.equal(event!.preferredModel, 'kimi-k3')
  assert.equal(event!.usedProvider, 'claude')
  assert.equal(event!.usedModel, 'claude-haiku-4-5')
  assert.equal(event!.attempts.length, 2)
})

test('fallback event: groq primary model fails then fallback model succeeds -> fallback_success', () => {
  const event = buildFoodCourtFallbackEvent('groq', [
    { provider: 'groq', model: 'qwen/qwen3.6-27b', ok: false, reason: 'model_not_found' },
    { provider: 'groq', model: 'openai/gpt-oss-120b', ok: true, reason: null },
  ])
  assert.ok(event)
  assert.equal(event!.outcome, 'fallback_success')
  assert.equal(event!.usedModel, 'openai/gpt-oss-120b')
})

test('fallback event: all providers fail -> all_failed with null used provider', () => {
  const event = buildFoodCourtFallbackEvent('openai', [
    { provider: 'openai', model: 'gpt-5.6-luna', ok: false, reason: 'timeout' },
    { provider: 'gemini', model: 'gemini-3.1-pro-preview', ok: false, reason: 'http_500' },
    { provider: 'groq', model: 'qwen/qwen3.6-27b', ok: false, reason: 'empty_content' },
  ])
  assert.ok(event)
  assert.equal(event!.outcome, 'all_failed')
  assert.equal(event!.usedProvider, null)
  assert.equal(event!.usedModel, null)
  assert.equal(event!.attempts.length, 3)
})

test('fallback event: single preferred failure (no alternative tried) -> all_failed', () => {
  const event = buildFoodCourtFallbackEvent('claude', [
    { provider: 'claude', model: 'claude-haiku-4-5', ok: false, reason: 'auth_error' },
  ])
  assert.ok(event)
  assert.equal(event!.outcome, 'all_failed')
  assert.equal(event!.preferredProvider, 'claude')
})

test('number audit: flags coefficients absent from facts', () => {
  const facts = '曜日係数 土日×1.31。イベント×1.32。雨×1.06。FC平均比64%。'
  const answer = '火曜係数×0.76と小ホール係数×0.60を適用。土日は×1.31で妥当。'
  const audit = auditFoodCourtAnswerNumbers(answer, facts)
  assert.deepEqual(audit.ungroundedCoefficients.sort(), ['0.6', '0.76'])
})

test('number audit: coefficient present in facts is not flagged (comma/decimal tolerant)', () => {
  const facts = 'イベント係数 1.27倍。日曜 1.50。'
  const answer = '交互作用×1.27を反映し、日曜は1.5倍で見込む。'
  const audit = auditFoodCourtAnswerNumbers(answer, facts)
  assert.equal(audit.ungroundedCoefficients.length, 0)
})

test('number audit: counts ungrounded yen/customer values as soft signal', () => {
  const facts = '売上¥173,280。客数1,981人。FC平均¥745,508。'
  const answer = 'ランチセット¥1,200を提案。目標客数は2,500人。売上¥173,280は妥当。'
  const audit = auditFoodCourtAnswerNumbers(answer, facts)
  // ¥1,200 と 2,500人 は facts に無い / ¥173,280 は facts にある
  assert.equal(audit.ungroundedValueCount, 2)
})

test('number audit feedback: empty when nothing ungrounded', () => {
  const audit = { ungroundedCoefficients: [], ungroundedValueCount: 0 }
  assert.equal(buildFoodCourtNumberAuditFeedback(audit), '')
})

test('number audit feedback: includes coefficient removal instruction', () => {
  const fb = buildFoodCourtNumberAuditFeedback({ ungroundedCoefficients: ['0.76'], ungroundedValueCount: 3 })
  assert.match(fb, /係数/)
  assert.match(fb, /0\.76/)
  assert.match(fb, /検証用の目標/)
})
