import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sourcePath = fileURLToPath(new URL('../supabase/functions/_shared/foodcourt_compare.ts', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')

test('Moonshot client remains available but is not the preferred critic', () => {
  // 旧クライアントは残すが、反証AI④の希望先には使わない（社内データの送信回避）。
  assert.match(source, /https:\/\/api\.moonshot\.ai\/v1\/chat\/completions/)
  assert.match(source, /FOODCOURT_MOONSHOT_MODEL/)
  assert.doesNotMatch(
    source,
    /criticRes = await foodCourtAiChat\([^\n]*,\s*(?:650|550|500),\s*'moonshot'/,
  )
})

test('all four surfaces use Claude Haiku for critic④', () => {
  assert.match(
    source,
    /preferred === 'claude'[\s\S]{0,80}return \['claude',\s*'gemini',\s*'groq'\]/,
  )
  const deepCritics = source.match(
    /criticRes = await foodCourtAiChat\([^\n]*,\s*(?:650|550|500),\s*'claude',[^\n]*perProviderMs:\s*25000/g,
  ) ?? []
  assert.equal(deepCritics.length, 3) // ask / period / weekly
  const dailyCritics = source.match(
    /criticRes = await foodCourtAiChat\([^\n]*,\s*550,\s*'claude',[^\n]*perProviderMs:\s*15000/g,
  ) ?? []
  assert.equal(dailyCritics.length, 1)
})

test('quality evaluator⑥ remains Claude by default', () => {
  assert.match(source, /evaluatorProvider[\s\S]{0,250}:\s*'claude'/)
  // model_version は全 surface で Claude のみを記録する。
  assert.match(source, /const criticLabel = resolveFoodCourtClaudeModel\(\)/)
  assert.doesNotMatch(source, /resolveFoodCourtMoonshotModel\(\)\}->\$\{resolveFoodCourtClaudeModel/)
})

test('Moonshot usage helpers remain for historical logs', () => {
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

test('Groq Qwen3.6 fallback disables visible reasoning when that model is used', () => {
  assert.match(source, /isQwen36/)
  assert.match(source, /reasoning_effort:\s*'none'/)
  assert.match(source, /reasoning_format:\s*'hidden'/)
})

test('Groq gpt-oss keeps reasoning low so specialist① does not empty-out', () => {
  assert.match(source, /isGptOss/)
  assert.match(source, /reasoning_effort:\s*'low'/)
  assert.match(source, /Math\.max\(maxTokens,\s*2000\)/)
  assert.match(source, /max_completion_tokens:\s*completionTokens/)
})

test('tenant extract falls back to Gemini only when Azure table is unusable', () => {
  assert.match(source, /Azure が表として成立しないときだけ Gemini/)
  assert.match(source, /ok: !!tenants/)
  assert.doesNotMatch(source, /tenants\.length >= minOk/)
})

test('specialists and integrators have production-safe timeout budgets', () => {
  // 2026-08-05: 専門AIを15秒→25秒に延長。15秒では ask のプロンプトが厚い回に
  // Gemini(specialist_ext)が毎回 timeout し、Groq へ落ちていた（実測5件すべて同一パターン）。
  // 専門AI3本はXトレンドブリーフと同じ Promise.all にあり、ブリーフが最大40秒待つため
  // 25秒に上げても Promise.all の上限は変わらず、待ち時間は増えない。
  const specialists = source.match(/perProviderMs:\s*25000,\s*fallbackLog:\s*\{[^}]*role:\s*'specialist_/g) ?? []
  assert.equal(specialists.length, 12) // 3 specialists × 4 surfaces
  // 統合AI⑤: Luna が 25秒で繰り返し timeout → 35秒へ。後続 gemini 用に foodCourtAiChat が予約する。
  const integrators = source.match(/perProviderMs:\s*35000,\s*fallbackLog:\s*\{[^}]*role:\s*'integrator'/g) ?? []
  assert.equal(integrators.length, 4)
  // 日次の反証AI(Claude Haiku)は定型処理なので15秒のまま。
  const dailyCritic = source.match(/perProviderMs:\s*15000,\s*fallbackLog:\s*\{[^}]*role:\s*'critic'/g) ?? []
  assert.equal(dailyCritic.length, 1)
})

test('evaluator keeps provider fallbacks without extending the shared request deadline', () => {
  assert.match(source, /export function buildFoodCourtProviderOrder/)
  assert.match(source, /export function foodCourtEvalDeadlineAt/)
  assert.match(source, /preferred === 'claude'[\s\S]{0,80}return \['claude',\s*'gemini',\s*'groq'\]/)
  assert.match(source, /preferred === 'groq'[\s\S]{0,80}return \['groq',\s*'gemini'\]/)
  assert.match(source, /return Math\.min\(maxBudget, sharedDeadlineAt\)/)
  assert.doesNotMatch(source, /Math\.max\(minBudget, sharedDeadlineAt\)/)
  assert.match(source, /deadlineAt:\s*foodCourtEvalDeadlineAt\(params\.deadlineAt\)/)
  assert.match(source, /perProviderMs:\s*18000/)
  assert.match(source, /FALLBACK_SLOT_MS\s*=\s*10_000/)
})
