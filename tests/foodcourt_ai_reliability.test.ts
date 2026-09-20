import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import * as reliability from '../supabase/functions/_shared/foodcourt_ai_reliability.ts'
import * as loop from '../supabase/functions/_shared/foodcourt_loop_utils.ts'
import * as groq from '../supabase/functions/_shared/groq_model.ts'
import { BUSINESS_GOAL_METRICS_POLICY } from '../supabase/functions/_shared/business_goal_metrics.ts'

// Execute the real production functions, with external integrations isolated at the boundary.
const source = readFileSync(new URL('../supabase/functions/_shared/foodcourt_compare.ts', import.meta.url), 'utf8')
const executable = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '').replace(/^export /gm, ''))
function runtime() {
  const context = vm.createContext({
    ...reliability, ...loop, ...groq, BUSINESS_GOAL_METRICS_POLICY, console, AbortSignal, AbortController, Response,
    setTimeout, clearTimeout, URL, URLSearchParams, Uint8Array, TextDecoder,
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    Deno: { env: { get: (key: string) => ({ GEMINI_API_KEY: 'synthetic-key', FOODCOURT_LOOP_EVALUATOR_PROVIDER: 'claude' }[key]) } },
  })
  vm.runInContext(executable, context)
  return context
}
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])
const table = { is_tenant_table: true, tenants: Array.from({ length: 11 }, (_, i) => ({ name: `Test ${i}`, code: null, sales: 10000 + i, guests: 10, comp_sales: null, comp_guests: null })) }
function geminiResponse(value: unknown, finishReason = 'STOP') {
  return Response.json({ candidates: [{ finishReason, content: { parts: [{ thought: true, text: 'private reasoning' }, { text: JSON.stringify(value) }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30, totalTokenCount: 50 } })
}

test('critic and evaluator use independent available defaults; legacy Claude env cannot reactivate them', async () => {
  assert.equal(reliability.foodCourtRoleProvider('critic'), 'gemini')
  assert.equal(reliability.foodCourtRoleProvider('evaluator'), 'groq')
  assert.equal(reliability.foodCourtRoleProvider('critic', 'moonshot'), 'gemini')
  assert.equal(reliability.foodCourtRoleProvider('evaluator', 'claude'), 'claude')
  const app = runtime()
  assert.equal(app.resolveFoodCourtCriticProvider(), 'gemini')
  assert.equal((await app.resolveFoodCourtLoopConfig('daily_summary')).evaluatorProvider, 'groq')
})

test('Gemini 3 uses low thinking without low temperature or incompatible thinkingBudget', () => {
  assert.deepEqual(reliability.foodCourtGeminiGeneration('gemini-3.5-flash', 8192), { maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'low' } })
  assert.equal(reliability.foodCourtGeminiGeneration('gemini-3.1-pro-preview', 8192).thinkingConfig?.thinkingLevel, 'low')
  assert.equal(reliability.foodCourtGeminiGeneration('gemini-2.0-flash', 2048).temperature, 0.2)
})

test('response-body error details become safe categories, never raw private data', () => {
  assert.equal(reliability.foodCourtHttpReason(400, 'Your credit balance is too low'), 'billing_limit')
  assert.equal(reliability.foodCourtHttpReason(400, 'private business input'), 'invalid_request')
  assert.equal(reliability.foodCourtHttpReason(401), 'auth_error')
  assert.equal(reliability.foodCourtHttpReason(404), 'model_not_found')
  assert.equal(reliability.foodCourtHttpReason(429), 'rate_limited')
})

test('transient rejection retries once on the same provider within the same signal', async (t) => {
  const requests: RequestInit[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => { requests.push(init); return requests.length === 1 ? new Response('busy', { status: 503 }) : new Response('ok') })
  const signal = AbortSignal.timeout(2000)
  assert.equal((await reliability.foodCourtFetch('https://example.invalid', { signal })).status, 200)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].signal, requests[1].signal)
})

test('400, billing 429 and long Retry-After do not create retry storms', async (t) => {
  for (const [status, body, headers] of [[400, 'bad request', {}], [429, 'insufficient_quota', {}], [429, 'busy', { 'retry-after': '30' }]] as const) {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response(body, { status, headers }))
    await reliability.foodCourtFetch('https://example.invalid', {})
    assert.equal(mock.mock.callCount(), 1)
    mock.mock.restore()
  }
})

test('deadline abort cancels retry waiting', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('busy', { status: 503 }))
  await assert.rejects(reliability.foodCourtFetch('https://example.invalid', { signal: AbortSignal.timeout(20) }))
  assert.equal(mock.mock.callCount(), 1)
})

test('primary keeps a useful slot and later stages keep their deadline reserve', () => {
  assert.equal(reliability.foodCourtProviderTimeout(15000, 25000, 2), 10500)
  assert.equal(reliability.foodCourtProviderTimeout(110000, 25000, 2), 25000)
  assert.equal(reliability.foodCourtStageDeadline(110000, 'specialist_ext', 0), 40000)
  assert.equal(reliability.foodCourtStageDeadline(110000, 'critic', 40000), 65000)
  assert.equal(reliability.foodCourtStageDeadline(110000, 'integrator', 65000), 98750)
  assert.equal(reliability.foodCourtStageDeadline(110000, 'evaluator', 98000), 110000)
  assert.ok(reliability.foodCourtStageDeadline(20000, 'specialist_ext', 0) > 0)
})

test('image MIME normalizes parameters and recovers missing CDN headers', () => {
  assert.equal(reliability.foodCourtImageMime(png, 'application/octet-stream'), 'image/png')
  assert.equal(reliability.foodCourtImageMime(new Uint8Array([0xff, 0xd8, 0xff]), null), 'image/jpeg')
  assert.equal(reliability.foodCourtImageMime(new Uint8Array([1]), 'image/jpeg; charset=utf-8'), 'image/jpeg')
  assert.equal(reliability.foodCourtImageMime(new Uint8Array([1]), 'text/html'), null)
})

test('production Gemini extractor returns all 11 rows, excludes thoughts and preserves unreadable values', async (t) => {
  let body: any
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = JSON.parse(init.body as string); return geminiResponse(table) })
  const diagnostics: any[] = [], usage: any[] = []
  const result = await runtime().extractFoodCourtTenants(png, null, 'synthetic-key', 'gemini-3.5-flash', 1000, (u: any) => usage.push(u), (d: any) => diagnostics.push(d))
  assert.equal(result.length, 11)
  assert.equal(result[0].compSales, null)
  assert.equal(diagnostics[0].reason, null)
  assert.equal(usage.length, 1)
  assert.equal(body.generationConfig.maxOutputTokens, 8192)
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'low')
})

test('production Azure extractor has a full-table budget and rejects incomplete output', async (t) => {
  let body: any, diagnostic: any
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = JSON.parse(init.body as string); return Response.json({ status: 'incomplete', output_text: JSON.stringify(table) }) })
  const result = await runtime().extractFoodCourtTenantsAzureFoundry(png, null, 'https://example.invalid/', 'synthetic-key', 'gpt-5.4-nano', 1000, undefined, (d: any) => { diagnostic = d })
  assert.equal(result, null)
  assert.equal(diagnostic.reason, 'output_truncated')
  assert.equal(body.max_output_tokens, 6000)
  assert.equal(body.reasoning.effort, 'low')
  assert.equal(body.store, false)
})

test('body-read timeout is still enforced after successful response headers', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Response(new ReadableStream({ start(controller) { init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true }) } })))
  let diagnostic: any
  // Keep the test process alive while the native AbortSignal timer is unrefed.
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    assert.equal(await runtime().extractFoodCourtTenants(png, null, 'synthetic-key', 'gemini-3.5-flash', 20, undefined, (d: any) => { diagnostic = d }), null)
    assert.equal(diagnostic.reason, 'timeout')
  } finally { clearTimeout(keepAlive) }
})

test('ordinary image probe does not call a second model or record all_failed', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => geminiResponse({ is_tenant_table: false, tenants: [] }))
  const inserts: any[] = []
  const db = { from: (table: string) => ({ insert: async (row: any) => { inserts.push({ table, row }); return {} } }) }
  const result = await runtime().maybeHandleFoodCourtReport(db, { storeKey: 'marugoS', detectText: 'ordinary image', forceAttempt: true, bytes: png, contentType: null, geminiApiKey: 'synthetic-key', geminiModel: 'old-receipt-model' })
  assert.equal(result.handled, false)
  assert.equal(mock.mock.callCount(), 1)
  assert.equal(inserts.filter(x => x.table === 'foodcourt_ai_fallback_events').length, 0)
  assert.equal(inserts.filter(x => x.table === 'ai_usage_events').length, 1)
})

test('real provider errors remain visible with distinct reasons, without acknowledging history', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => new Response('invalid request', { status: String(url).includes('googleapis') ? 503 : 400 }))
  const inserts: any[] = []
  const db = { from: (table: string) => ({ insert: async (row: any) => { inserts.push({ table, row }); return {} } }) }
  await runtime().maybeHandleFoodCourtReport(db, { storeKey: 'marugoS', detectText: 'テナント一覧', bytes: png, contentType: null, geminiApiKey: 'synthetic-key', azureFoundryApiKey: 'synthetic-key', azureFoundryProjectEndpoint: 'https://example.invalid' })
  const event = inserts.find(x => x.table === 'foodcourt_ai_fallback_events').row
  assert.equal(event.outcome, 'all_failed')
  assert.equal(event.attempts[0].reason, 'http_503')
  assert.equal(event.attempts[1].reason, 'invalid_request')
  assert.equal('acknowledged' in event, false)
})

test('contradictory table markers still trigger independent verification', () => {
  assert.equal(reliability.foodCourtTenantNeedsFallback({ reason: 'not_tenant_table', isTable: false }, true), true)
  assert.equal(reliability.foodCourtTenantNeedsFallback({ reason: 'not_tenant_table', isTable: false }, false), false)
  assert.equal(reliability.foodCourtExtractionDiagnostic({ is_tenant_table: false, tenants: [{}] }).reason, 'invalid_response')
})

test('invalid evaluator JSON is not accepted as a usable evaluation', () => {
  const app = runtime()
  assert.equal(app.parseLoopEvaluationJson('{}'), null)
  assert.equal(app.parseLoopEvaluationJson('{"scores":{"accuracy":95}}'), null)
  assert.notEqual(app.parseLoopEvaluationJson('{"scores":{"accuracy":90,"logic":90,"expertise":90,"practicality":90,"evidence":90}}'), null)
})

test('healthy primary evaluator succeeds with no fallback event', async (t) => {
  const answer = JSON.stringify({ scores: { accuracy: 90, logic: 90, expertise: 90, practicality: 90, evidence: 90 } })
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } }))
  const app = runtime()
  const inserts: any[] = []
  const result = await app.foodCourtAiChat([{ role: 'user', content: 'Synthetic evaluation' }], 'synthetic-key', 'openai/gpt-oss-120b', 1200, 'groq', undefined, {
    deadlineAt: Date.now() + 110000, validateContent: (s: string) => app.parseLoopEvaluationJson(s) !== null,
    fallbackLog: { supabase: { from: () => ({ insert: async (v: any) => { inserts.push(v); return {} } }) }, storeKey: 'test', surface: 'daily_summary', role: 'evaluator' },
  })
  assert.equal(result.content, answer)
  assert.equal(mock.mock.callCount(), 1)
  assert.equal(inserts.length, 0)
})

test('malformed evaluator output switches provider, records the reason and bills discarded output', async (t) => {
  const answer = { scores: { accuracy: 90, logic: 90, expertise: 90, practicality: 90, evidence: 90 } }
  t.mock.method(globalThis, 'fetch', async (url) => String(url).includes('groq.com')
    ? Response.json({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } }) : geminiResponse(answer))
  const app = runtime(), inserts: any[] = []
  const result = await app.foodCourtAiChat([{ role: 'user', content: 'Synthetic evaluation' }], 'synthetic-key', 'openai/gpt-oss-120b', 1200, 'groq', undefined, {
    deadlineAt: Date.now() + 110000, validateContent: (s: string) => app.parseLoopEvaluationJson(s) !== null,
    fallbackLog: { supabase: { from: (table: string) => ({ insert: async (row: any) => { inserts.push({ table, row }); return {} } }) }, storeKey: 'test', surface: 'daily_summary', role: 'evaluator' },
  })
  assert.equal(result.usage.provider, 'gemini')
  assert.equal(inserts.find(x => x.table === 'ai_usage_events').row.provider, 'groq')
  const event = inserts.find(x => x.table === 'foodcourt_ai_fallback_events').row
  assert.equal(event.outcome, 'fallback_success')
  assert.equal(event.attempts[0].reason, 'invalid_response')
})

test('exhausted stage is recorded truthfully and never calls a provider after its deadline', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call') })
  const inserts: any[] = []
  const result = await runtime().foodCourtAiChat([{ role: 'user', content: 'Synthetic task' }], 'synthetic-key', 'openai/gpt-oss-120b', 1200, 'groq', undefined, {
    deadlineAt: Date.now() - 1,
    fallbackLog: { supabase: { from: () => ({ insert: async (row: any) => { inserts.push(row); return {} } }) }, storeKey: 'test', surface: 'daily_summary', role: 'evaluator' },
  })
  assert.equal(result.content, null)
  assert.equal(mock.mock.callCount(), 0)
  assert.equal(inserts[0].outcome, 'all_failed')
  assert.equal(inserts[0].attempts[0].reason, 'deadline')
})
