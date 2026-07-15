import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFoodCourtRevisionMessages,
  compactFoodCourtEvaluationContext,
  foodCourtEvaluationPassed,
  foodCourtLoopHasBudget,
  foodCourtTextSimilarity,
} from '../supabase/functions/_shared/foodcourt_loop_utils.ts'

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
