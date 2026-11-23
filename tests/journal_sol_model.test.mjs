import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Run the actual Edge source. Only credentials and HTTP transport are synthetic;
// no production environment, Supabase client or external provider is reachable.
const source = stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/ai-analyze/index.ts', import.meta.url), 'utf8')
  .replace(/^import\s[\s\S]*?;\s*$/gm, ''));
const clone = value => JSON.parse(JSON.stringify(value));
const messages = [
  { role: 'system', content: '合成fixture: 確定売上だけを根拠に回答。' },
  { role: 'user', content: '2026年8月の売上は12000円、客数は6人です。' },
  { role: 'assistant', content: '客単価は2000円です。' },
  { role: 'user', content: '次の確認点を説明してください。' },
];
const contents = messages.map(({ role, content }) => ({
  role: role === 'assistant' ? 'model' : role,
  parts: [{ text: content }],
}));
const readyPlan = { status: 'ready', resolvedQuery: '2026年8月の売上を確認', understood: '月次売上', missing: [] };
const openAiResponse = text => ({
  choices: [{ message: { content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100,
    prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 4 } },
});

function runtime({ env = {}, responses = [] } = {}) {
  const calls = [], timers = [], envReads = [];
  const syntheticEnv = { OPENAI_API_KEY: 'synthetic-openai-key', JOURNAL_CLAUDE_API_KEY: 'synthetic-claude-key', ...env };
  const ctx = vm.createContext({
    Response, AbortController,
    console: { warn() {}, error() {} },
    STORE_LOCATION_PROFILES: {},
    Deno: { env: { get(key) { envReads.push(key); return syntheticEnv[key]; } }, serve() {} },
    setTimeout(fn, ms) { timers.push(ms); return setTimeout(fn, ms); }, clearTimeout,
    async fetch(url, init) {
      assert.ok(['https://api.openai.com/v1/chat/completions', 'https://api.anthropic.com/v1/messages'].includes(url), `Unexpected transport: ${url}`);
      calls.push({ url, method: init.method, headers: clone(init.headers), body: JSON.parse(init.body), signal: init.signal });
      assert.ok(init.signal instanceof AbortSignal);
      const response = responses[calls.length - 1];
      if (response instanceof Error) throw response;
      if (response) return Response.json(response.body, { status: response.status ?? 200 });
      assert.equal(url, 'https://api.openai.com/v1/chat/completions', 'Unexpected fallback');
      return Response.json(openAiResponse('合成回答本文'));
    },
  });
  vm.runInContext(source, ctx);
  const api = vm.runInContext('({resolveOpenAiModel, callOpenAiClarifier, callOpenAiLuna, clarifyWithFallback, synthesizeWithFallback})', ctx);
  return { ...api, calls, timers, envReads };
}

test('Journal defaults to gpt-6.2-sol in both main analysis and clarification', async () => {
  const app = runtime();
  const main = await app.callOpenAiLuna(contents);
  const clarification = await app.callOpenAiClarifier(messages);
  assert.equal(main.ok, true);
  assert.equal(clarification.ok, true);
  assert.deepEqual(app.calls.map(call => call.body.model), ['gpt-6.2-sol', 'gpt-6.2-sol']);
  assert.equal(main.model, 'gpt-6.2-sol');
  assert.equal(clarification.model, 'gpt-6.2-sol');
});

test('Journal model ignores global and Foodcourt model settings but retains its own override', async () => {
  for (const env of [
    { OPENAI_MODEL: 'gpt-4.1' },
    { FOODCOURT_OPENAI_MODEL: 'gpt-5.6-luna' },
    { OPENAI_MODEL: 'gpt-4.1', FOODCOURT_OPENAI_MODEL: 'gpt-5.6-luna' },
    { JOURNAL_OPENAI_MODEL: '', OPENAI_MODEL: 'gpt-4.1' },
    { JOURNAL_OPENAI_MODEL: '   ', FOODCOURT_OPENAI_MODEL: 'gpt-5.6-luna' },
  ]) {
    const app = runtime({ env });
    assert.equal(app.resolveOpenAiModel(), 'gpt-6.2-sol', JSON.stringify(env));
    await app.callOpenAiLuna(contents);
    await app.callOpenAiClarifier(messages);
    assert.deepEqual(app.calls.map(call => call.body.model), ['gpt-6.2-sol', 'gpt-6.2-sol']);
    assert.ok(!app.envReads.includes('OPENAI_MODEL'));
    assert.ok(!app.envReads.includes('FOODCOURT_OPENAI_MODEL'));
  }
  const override = runtime({ env: { JOURNAL_OPENAI_MODEL: '  gpt-4.1  ', OPENAI_MODEL: 'gpt-5.6-luna', FOODCOURT_OPENAI_MODEL: 'other-app-model' } });
  await override.callOpenAiLuna(contents);
  await override.callOpenAiClarifier(messages);
  assert.deepEqual(override.calls.map(call => call.body.model), ['gpt-4.1', 'gpt-4.1']);
});

for (const path of ['main', 'clarifier']) {
  test(`GPT-6 and later use reasoning-compatible parameters for ${path}`, async () => {
    for (const model of ['gpt-6.1-sol', 'gpt-6.2-sol', 'gpt-6', 'gpt-6.2-synthetic', 'gpt-7-synthetic', 'gpt-10-synthetic', 'gpt-11.1-synthetic']) {
      const app = runtime({ env: { JOURNAL_OPENAI_MODEL: model } });
      const input = clone(path === 'main' ? contents : messages);
      const before = clone(input);
      const result = path === 'main' ? await app.callOpenAiLuna(input) : await app.callOpenAiClarifier(input);
      assert.equal(result.ok, true);
      const body = app.calls[0].body;
      assert.equal(body.model, model, 'explicit Journal model override must survive both request paths');
      assert.equal(result.model, model);
      assert.equal(body.max_completion_tokens, path === 'main' ? 9000 : 800, model);
      assert.equal(body.reasoning_effort, 'low', model);
      assert.ok(!Object.hasOwn(body, 'max_tokens'), model);
      assert.ok(!Object.hasOwn(body, 'temperature'), model);
      assert.deepEqual(body.messages, messages.map(item => ({ ...item, role: item.role === 'system' ? 'developer' : item.role })));
      assert.deepEqual(input, before, 'Caller-owned input must not be mutated');
      assert.deepEqual(app.timers, [path === 'main' ? 140_000 : 7000]);
    }
  });
}

test('both OpenAI paths explicitly disable provider response storage', async () => {
  const app = runtime();
  await app.callOpenAiLuna(contents);
  await app.callOpenAiClarifier(messages);
  assert.deepEqual(app.calls.map(call => call.body.store), [false, false]);
});

test('GPT-5 and o-series overrides retain their reasoning request contract', async () => {
  for (const model of ['gpt-5', 'gpt-5.6-luna', 'gpt-5-mini', 'o1', 'o3-mini', 'o4-mini']) {
    const app = runtime({ env: { JOURNAL_OPENAI_MODEL: model } });
    await app.callOpenAiLuna(contents);
    await app.callOpenAiClarifier(messages);
    for (const [index, call] of app.calls.entries()) {
      assert.deepEqual(call.body, {
        model,
        store: false,
        messages: messages.map(item => ({ ...item, role: item.role === 'system' ? 'developer' : item.role })),
        max_completion_tokens: index === 0 ? 9000 : 800,
        reasoning_effort: 'low',
      });
    }
  }
});

test('GPT-4 overrides retain legacy system roles, budgets and temperatures', async () => {
  for (const model of ['gpt-4.1', 'gpt-4o', 'gpt-4.1-mini']) {
    const app = runtime({ env: { JOURNAL_OPENAI_MODEL: model } });
    await app.callOpenAiLuna(contents);
    await app.callOpenAiClarifier(messages);
    assert.deepEqual(app.calls[0].body, { model, store: false, messages, max_tokens: 5000, temperature: 0.3 });
    assert.deepEqual(app.calls[1].body, { model, store: false, messages, max_tokens: 350, temperature: 0.2 });
  }
});

test('Sol 6.2 preserves Luna and Sol 6.1 fixture text, non-model payload fields, usage and explicit timeout overrides', async () => {
  const sent = [], results = [];
  for (const model of ['gpt-5.6-luna', 'gpt-6.1-sol', 'gpt-6.2-sol']) {
    const app = runtime({ env: { JOURNAL_OPENAI_MODEL: model }, responses: [
      { body: openAiResponse('<think>合成思考</think>\n【総評】合成回答本文') },
      { body: openAiResponse(JSON.stringify(readyPlan)) },
    ] });
    const main = await app.callOpenAiLuna(contents, 3200, 12_345);
    const clarification = await app.callOpenAiClarifier(messages);
    assert.equal(main.text, '【総評】合成回答本文');
    assert.equal(clarification.text, JSON.stringify(readyPlan));
    assert.deepEqual(clone(main.usage), {
      provider: 'openai', model, inputTokens: 80, outputTokens: 20,
      thinkingTokens: 4, cachedTokens: 30, totalTokens: 100,
    });
    assert.deepEqual(clone(clarification.usage), clone(main.usage));
    assert.deepEqual(app.timers, [12_345, 7000]);
    sent.push(app.calls.map(({ signal, body: { model: _model, ...body }, ...call }) => ({ ...call, body })));
    results.push([main, clarification].map(({ model: _model, usage: { model: _usageModel, ...usage }, ...result }) => clone({ ...result, usage })));
  }
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(sent[1], sent[2]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
});

test('main synthesis succeeds on Sol without starting fallback', async () => {
  const app = runtime();
  const result = await app.synthesizeWithFallback(contents);
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'gpt-6.2-sol');
  assert.equal(result.text, '合成回答本文');
  assert.equal(app.calls.length, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].model, 'gpt-6.2-sol');
  assert.equal(result.attempts[0].max_completion_tokens, 9000);
  assert.equal(result.fallbackFrom, undefined);
});

test('main context-limit failure keeps the 3200-token Sol retry and identical messages', async () => {
  const app = runtime({ responses: [
    { status: 400, body: { error: { message: 'context_length_exceeded' } } },
    { body: openAiResponse('縮小枠の合成回答') },
  ] });
  const result = await app.synthesizeWithFallback(contents);
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'openai');
  assert.equal(result.text, '縮小枠の合成回答');
  assert.deepEqual(app.calls.map(call => call.body.max_completion_tokens), [9000, 3200]);
  assert.deepEqual(app.calls[0].body.messages, app.calls[1].body.messages);
  assert.deepEqual(app.calls.map(call => call.body.model), ['gpt-6.2-sol', 'gpt-6.2-sol']);
  assert.deepEqual(clone(result.attempts.map(({ ok, model }) => ({ ok, model }))), [
    { ok: false, model: 'gpt-6.2-sol' }, { ok: true, model: 'gpt-6.2-sol' },
  ]);
});

test('main non-retryable failures retain one OpenAI attempt and one Claude fallback', async () => {
  for (const response of [
    { status: 401, body: { error: { message: 'invalid_api_key' } } },
    { status: 429, body: { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } } },
    { status: 429, body: { error: { message: 'insufficient_quota' } } },
    new Error('provider request timeout after 140000ms'),
    { body: openAiResponse('') },
  ]) {
    const app = runtime({ responses: [response,
      { body: { content: [{ type: 'text', text: 'Claude合成回答' }], usage: { input_tokens: 80, output_tokens: 20 } } },
    ] });
    const result = await app.synthesizeWithFallback(contents);
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'claude');
    assert.equal(result.text, 'Claude合成回答');
    assert.equal(result.fallbackFrom.model, 'gpt-6.2-sol');
    assert.equal(app.calls.length, 2);
    assert.equal(result.attempts.length, 2);
    assert.deepEqual(clone(result.attempts.map(attempt => attempt.provider)), ['openai', 'claude']);
    assert.deepEqual(app.calls[1].body, {
      model: 'claude-haiku-4-5', max_tokens: 9000, temperature: 0.2,
      system: messages[0].content, messages: messages.slice(1),
    });
    assert.equal(app.timers.at(-1), 55_000);
  }
});

test('main both-provider failures remain explicit rather than returning synthetic success', async () => {
  const app = runtime({ responses: [
    { status: 401, body: { error: { message: 'invalid_api_key' } } },
    { status: 503, body: { error: { message: 'synthetic_unavailable' } } },
  ] });
  const result = await app.synthesizeWithFallback(contents);
  assert.equal(result.ok, false);
  assert.match(result.openaiError, /invalid_api_key/);
  assert.match(result.claudeError, /synthetic_unavailable/);
  assert.equal(app.calls.length, 2);
});

test('clarification preserves ready plans and Claude fallback for invalid JSON or API errors', async () => {
  for (const response of [
    { body: openAiResponse(JSON.stringify(readyPlan)) },
    { body: openAiResponse('not a JSON plan') },
    { status: 401, body: { error: { message: 'invalid_api_key' } } },
  ]) {
    const app = runtime({ responses: [response,
      { body: { content: [{ type: 'text', text: JSON.stringify(readyPlan) }] } },
    ] });
    const result = await app.clarifyWithFallback(messages);
    const fallback = response.status === 401 || response.body.choices[0].message.content === 'not a JSON plan';
    assert.equal(result.ok, true);
    assert.deepEqual(clone(result.plan), readyPlan);
    assert.equal(result.provider, fallback ? 'claude' : 'openai');
    assert.equal(app.calls.length, fallback ? 2 : 1);
    assert.equal(app.calls[0].body.model, 'gpt-6.2-sol');
    if (fallback) {
      assert.equal(result.fallbackFrom.model, 'gpt-6.2-sol');
      assert.deepEqual(app.calls[1].body, {
        model: 'claude-haiku-4-5', max_tokens: 500, temperature: 0.2,
        system: messages[0].content, messages: messages.slice(1),
      });
    }
  }
});

test('missing synthetic credentials fail before transport; expired main deadline does not send', async () => {
  const app = runtime({ env: { OPENAI_API_KEY: '', FOODCOURT_OPENAI_API_KEY: '', JOURNAL_CLAUDE_API_KEY: '' } });
  assert.equal((await app.callOpenAiLuna(contents)).ok, false);
  assert.equal((await app.callOpenAiClarifier(messages)).ok, false);
  assert.equal((await app.synthesizeWithFallback(contents)).ok, false);
  assert.equal((await app.clarifyWithFallback(messages)).ok, false);
  assert.equal(app.calls.length, 0);
  const expired = runtime();
  const result = await expired.callOpenAiLuna(contents, 9000, 3999);
  assert.equal(result.ok, false);
  assert.match(result.error, /deadline exceeded/);
  assert.equal(expired.calls.length, 0);
});
