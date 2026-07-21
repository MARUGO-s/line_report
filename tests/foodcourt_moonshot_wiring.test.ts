import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sourcePath = fileURLToPath(new URL('../supabase/functions/_shared/foodcourt_compare.ts', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')

test('Moonshot Kimi K3 chat uses the verified API constraints', () => {
  assert.match(source, /https:\/\/api\.moonshot\.ai\/v1\/chat\/completions/)
  assert.match(source, /temperature:\s*1/)
  assert.match(source, /reasoning_effort:\s*'low'/)
  assert.match(source, /FOODCOURT_MOONSHOT_MODEL/)
  assert.match(source, /\|\|\s*'kimi-k3'/)
})

test('critic④ uses Moonshot first and Claude Haiku as its fallback', () => {
  assert.match(
    source,
    /preferred === 'moonshot'[\s\S]{0,180}\?\s*\[preferred,\s*'claude'\]/,
  )
  const criticCalls = source.match(
    /criticRes = await foodCourtAiChat\([^\n]*'moonshot'[^\n]*perProviderMs:\s*25000/g,
  ) ?? []
  assert.equal(criticCalls.length, 4)
})

test('quality evaluator⑥ remains Claude by default', () => {
  assert.match(source, /evaluatorProvider[\s\S]{0,250}:\s*'claude'/)
  assert.match(source, /critic=\$\{resolveFoodCourtMoonshotModel\(\)\}->\$\{resolveFoodCourtClaudeModel\(\)\}/)
})

test('Moonshot usage is recorded under its own provider and separates reasoning tokens', () => {
  assert.match(source, /provider:\s*'moonshot'/)
  assert.match(source, /completion_tokens_details/)
  assert.match(source, /reasoning_tokens/)
})
