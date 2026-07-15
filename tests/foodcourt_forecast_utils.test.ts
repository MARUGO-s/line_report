import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseFoodCourtGlm } from '../supabase/functions/_shared/foodcourt_forecast_utils.ts'

test('recent holdout error decides the active model', () => {
  assert.equal(chooseFoodCourtGlm(0.20, 0.15, 0.30, 0.40), true)
  assert.equal(chooseFoodCourtGlm(0.10, 0.20, 0.30, 0.25), false)
})

test('full-history error is used only when holdout is unavailable', () => {
  assert.equal(chooseFoodCourtGlm(null, null, 0.30, 0.25), true)
  assert.equal(chooseFoodCourtGlm(null, null, null, null), false)
})
