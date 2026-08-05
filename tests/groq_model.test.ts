import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GROQ_TEXT_FALLBACK_MODEL,
  GROQ_TEXT_FOODCOURT_MODEL,
  GROQ_TEXT_PRIMARY_MODEL,
  resolveGroqTextModel,
} from '../supabase/functions/_shared/groq_model.ts'

test('Groq text model defaults to GPT-OSS 120B', () => {
  assert.equal(resolveGroqTextModel(undefined), GROQ_TEXT_PRIMARY_MODEL)
  assert.equal(GROQ_TEXT_PRIMARY_MODEL, 'openai/gpt-oss-120b')
})

test('retired Groq model values cannot be re-enabled through environment variables', () => {
  assert.equal(resolveGroqTextModel('llama-3.3-70b-versatile'), GROQ_TEXT_PRIMARY_MODEL)
  assert.equal(resolveGroqTextModel('META-LLAMA/LLAMA-4-SCOUT-17B-16E-INSTRUCT'), GROQ_TEXT_PRIMARY_MODEL)
  assert.equal(resolveGroqTextModel('qwen/qwen3.6-27b'), GROQ_TEXT_PRIMARY_MODEL)
})

test('an explicitly configured supported model is preserved', () => {
  assert.equal(resolveGroqTextModel(GROQ_TEXT_FALLBACK_MODEL), GROQ_TEXT_FALLBACK_MODEL)
  assert.equal(resolveGroqTextModel('openai/gpt-oss-120b'), GROQ_TEXT_PRIMARY_MODEL)
})

test('Groq text fallback is pinned to a production-tier model', () => {
  assert.equal(GROQ_TEXT_FALLBACK_MODEL, 'openai/gpt-oss-120b')
})

test('foodcourt specialist① defaults to GPT-OSS 120B (not Qwen)', () => {
  assert.equal(GROQ_TEXT_FOODCOURT_MODEL, 'openai/gpt-oss-120b')
  assert.equal(resolveGroqTextModel(undefined, GROQ_TEXT_FOODCOURT_MODEL), GROQ_TEXT_FOODCOURT_MODEL)
  assert.equal(resolveGroqTextModel('', GROQ_TEXT_FOODCOURT_MODEL), GROQ_TEXT_FOODCOURT_MODEL)
  // 旧 Qwen 既定が env に残っていても GPT-OSS へ強制退避する。
  assert.equal(resolveGroqTextModel('qwen/qwen3.6-27b', GROQ_TEXT_FOODCOURT_MODEL), GROQ_TEXT_FOODCOURT_MODEL)
  assert.equal(resolveGroqTextModel('llama-3.3-70b-versatile', GROQ_TEXT_FOODCOURT_MODEL), GROQ_TEXT_FOODCOURT_MODEL)
})
