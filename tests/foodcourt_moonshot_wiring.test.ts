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

test('ask/period/weekly critic④ use Moonshot Kimi with Claude Haiku fallback', () => {
  assert.match(
    source,
    /preferred === 'moonshot'[\s\S]{0,180}\?\s*\[preferred,\s*'claude'\]/,
  )
  // Deep-context surfaces (ask=650, period=550, weekly=500) route to Moonshot.
  const kimiCritics = source.match(
    /criticRes = await foodCourtAiChat\([^\n]*,\s*(?:650|550|500),\s*'moonshot',[^\n]*perProviderMs:\s*25000/g,
  ) ?? []
  assert.equal(kimiCritics.length, 3)
})

test('daily critic④ stays Claude Haiku (routine summary)', () => {
  const claudeCritics = source.match(
    /criticRes = await foodCourtAiChat\([^\n]*,\s*550,\s*'claude',[^\n]*perProviderMs:\s*15000[^\n]*\)/g,
  ) ?? []
  assert.equal(claudeCritics.length, 1)
})

test('quality evaluator⑥ remains Claude by default', () => {
  assert.match(source, /evaluatorProvider[\s\S]{0,250}:\s*'claude'/)
  // model_version records Claude only for daily; ask/period/weekly record Kimi->Claude.
  assert.match(source, /params\.surface === 'daily_summary'\s*\?\s*resolveFoodCourtClaudeModel\(\)\s*:\s*`\$\{resolveFoodCourtMoonshotModel\(\)\}->\$\{resolveFoodCourtClaudeModel\(\)\}`/)
})

test('Moonshot usage is recorded under its own provider and separates reasoning tokens', () => {
  assert.match(source, /provider:\s*'moonshot'/)
  assert.match(source, /completion_tokens_details/)
  assert.match(source, /reasoning_tokens/)
})

test('all four final integrators share the fixed action format rule', () => {
  // one declaration + four final-system references (ask/daily/period/weekly)
  const refs = source.match(/FOODCOURT_ACTION_FORMAT_RULE/g) ?? []
  assert.equal(refs.length, 5)
  assert.match(source, /対象客\(誰の・どの来店動機\)/)
  assert.match(source, /判定・中止ライン/)
})

test('Groq Qwen3.6 fallback disables visible reasoning', () => {
  assert.match(source, /isQwen36/)
  assert.match(source, /reasoning_effort:\s*'none'/)
  assert.match(source, /reasoning_format:\s*'hidden'/)
})
