import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assessFoodCourtEvolutionReadiness } from '../supabase/functions/_shared/foodcourt_loop_utils.ts'

const api = readFileSync(new URL('../supabase/functions/admin-api/index.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('../public/foodcourt-evolution.html', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../supabase/migrations/20260813110747_foodcourt_prompt_candidate_evaluation.sql', import.meta.url), 'utf8')

test('prompt comparison can start only after the existing readiness gate passes', () => {
  const ready = assessFoodCourtEvolutionReadiness({
    totalRuns: 68,
    completedRuns: 68,
    acceptedExamples: 23,
    humanHelpfulExamples: 7,
    dailyAcceptedExamples: 12,
    acceptedSurfaces: 3,
  })
  assert.equal(ready.gates.promptCandidate.ready, true)
  assert.equal(ready.gates.modelDistillation.ready, false)
  assert.match(api, /if \(!readiness\.gates\.promptCandidate\.ready\)/)
})

test('evaluation-set snapshot and candidates stay private and never alter production automatically', () => {
  assert.match(migration, /create table if not exists public\.foodcourt_prompt_evaluation_sets/)
  assert.match(migration, /create table if not exists public\.foodcourt_prompt_evaluation_cases/)
  assert.match(migration, /create table if not exists public\.foodcourt_prompt_candidates/)
  assert.match(migration, /enable row level security/)
  assert.match(migration, /revoke all on public\.foodcourt_prompt_candidates from anon, authenticated/)
  assert.match(api, /本番に影響しない固定評価セットと手動候補の管理/)
  assert.match(page, /登録しても本番回答には適用されません/)
  assert.match(page, /本番プロンプト・モデル・自動昇格は変更されません/)
})

test('evaluation page wires the safe bootstrap and draft-candidate endpoints', () => {
  assert.match(api, /"\/foodcourt\/prompt-evaluation-sets"/)
  assert.match(api, /"\/foodcourt\/prompt-evaluation-sets\/bootstrap"/)
  assert.match(api, /"\/foodcourt\/prompt-candidates"/)
  assert.match(page, /\/foodcourt\/prompt-evaluation-sets\?store_key=marugoS/)
  assert.match(page, /\/foodcourt\/prompt-evaluation-sets\/bootstrap/)
  assert.match(page, /\/foodcourt\/prompt-candidates/)
})
