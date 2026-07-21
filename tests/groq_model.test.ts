import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GROQ_TEXT_FALLBACK_MODEL,
  GROQ_TEXT_PRIMARY_MODEL,
  GROQ_TEXT_KIMI_MODEL,
  resolveGroqTextModel,
} from '../supabase/functions/_shared/groq_model.ts'

test('Groq text model defaults to GPT-OSS 120B', () => {
  assert.equal(resolveGroqTextModel(undefined), GROQ_TEXT_PRIMARY_MODEL)
  assert.equal(GROQ_TEXT_PRIMARY_MODEL, 'openai/gpt-oss-120b')
})

test('retired Groq model values cannot be re-enabled through environment variables', () => {
  assert.equal(resolveGroqTextModel('llama-3.3-70b-versatile'), GROQ_TEXT_PRIMARY_MODEL)
  assert.equal(resolveGroqTextModel('META-LLAMA/LLAMA-4-SCOUT-17B-16E-INSTRUCT'), GROQ_TEXT_PRIMARY_MODEL)
})

test('an explicitly configured supported model is preserved', () => {
  assert.equal(resolveGroqTextModel(GROQ_TEXT_FALLBACK_MODEL), GROQ_TEXT_FALLBACK_MODEL)
  assert.equal(resolveGroqTextModel('openai/gpt-oss-120b'), GROQ_TEXT_PRIMARY_MODEL)
})

test('Groq text fallback is pinned to a production-tier model', () => {
  assert.equal(GROQ_TEXT_FALLBACK_MODEL, 'openai/gpt-oss-120b')
})

test('foodcourt specialist①: Kimi K2 default is used when FOODCOURT_GROQ_MODEL is unset', () => {
  assert.equal(GROQ_TEXT_KIMI_MODEL, 'moonshotai/kimi-k2-instruct-0905')
  // Empty/unset env → falls back to the provided Kimi default (provider diversity).
  assert.equal(resolveGroqTextModel(undefined, GROQ_TEXT_KIMI_MODEL), GROQ_TEXT_KIMI_MODEL)
  assert.equal(resolveGroqTextModel('', GROQ_TEXT_KIMI_MODEL), GROQ_TEXT_KIMI_MODEL)
  // Retired values also fall back to Kimi when it is the provided default.
  assert.equal(resolveGroqTextModel('llama-3.3-70b-versatile', GROQ_TEXT_KIMI_MODEL), GROQ_TEXT_KIMI_MODEL)
  // An explicit valid override still wins.
  assert.equal(resolveGroqTextModel('openai/gpt-oss-120b', GROQ_TEXT_KIMI_MODEL), 'openai/gpt-oss-120b')
})
