import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFoodCourtDistillationRecords } from '../supabase/functions/_shared/foodcourt_distillation.ts'

const acceptedRows = [{ source_run_id: 'run-1', surface: 'daily_summary', source_type: 'quality_passed' }]
const runs = [{
  id: 'run-1',
  store_partition_key: 'marugos',
  surface: 'daily_summary',
  source_ref: { business_date: '2026-07-14' },
  user_input: null,
  model_version: 'loop-v1',
  best_loop_index: 2,
  final_score: 82,
  final_answer: '改善後回答',
  returned_reason: 'passed',
  created_at: '2026-07-15T00:00:00Z',
}]
const iterations = [
  {
    run_id: 'run-1',
    loop_index: 2,
    feedback_from_previous: '根拠を追加する',
    integrated_answer: '改善後回答',
    evaluation: { improvement_points: [] },
    total_score: 82,
    passed: true,
  },
  {
    run_id: 'run-1',
    loop_index: 1,
    integrated_answer: '初回回答',
    evaluation: { improvement_points: ['根拠を追加する'] },
    total_score: 62,
    passed: false,
  },
]

test('distillation record preserves the draft, evaluation, trajectory, and preferred answer', () => {
  const records = buildFoodCourtDistillationRecords(acceptedRows, runs, iterations, [])
  assert.equal(records.length, 1)
  assert.equal(records[0]?.input.task, '定型分析')
  assert.equal(records[0]?.initial_response, '初回回答')
  assert.deepEqual(records[0]?.initial_evaluation, { improvement_points: ['根拠を追加する'] })
  assert.equal(records[0]?.preferred_response, '改善後回答')
  assert.equal(records[0]?.trajectory[1]?.revision_instruction, '根拠を追加する')
})

test('not-helpful feedback excludes a stale accepted row from distillation', () => {
  const records = buildFoodCourtDistillationRecords(acceptedRows, runs, iterations, [
    { run_id: 'run-1', rating: 'not_helpful', note: '数値が不正確' },
  ])
  assert.deepEqual(records, [])
})
