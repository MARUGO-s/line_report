import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Execute real Edge/browser code with a virtual clock and synthetic transport only.
// No credentials, external network, business records or real long waits are used.
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const edgeSource = stripTypeScriptTypes(read('supabase/functions/ai-analyze/index.ts')
  .replace(/^import\s[\s\S]*?;\s*$/gm, ''));
const clone = value => JSON.parse(JSON.stringify(value));
const contents = [
  { role: 'system', parts: [{ text: '合成fixture: 確定値だけを使用。' }] },
  { role: 'user', parts: [{ text: '合成売上12000円を分析。' }] },
];
const flush = () => new Promise(resolve => setImmediate(resolve));

function clock() {
  let now = 0, nextId = 0;
  const pending = new Map(), scheduled = [];
  const setTimeout = (fn, ms) => {
    const id = ++nextId;
    pending.set(id, { fn, at: now + ms });
    scheduled.push(ms);
    return id;
  };
  const clearTimeout = id => pending.delete(id);
  class ClockDate extends Date { static now() { return now; } }
  return {
    Date: ClockDate, setTimeout, clearTimeout, pending, scheduled,
    get now() { return now; },
    async tick(ms) {
      const target = now + ms;
      await flush();
      for (;;) {
        const next = [...pending].filter(([, task]) => task.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].at;
        pending.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

function transport(time, plans, calls) {
  return (url, init) => {
    const provider = url === 'https://api.openai.com/v1/chat/completions' ? 'openai'
      : url === 'https://api.anthropic.com/v1/messages' ? 'claude'
        : url === 'https://fixture.invalid/ai-analyze' ? 'client' : null;
    assert.ok(provider, `Forbidden network target: ${url}`);
    const plan = Array.isArray(plans[provider]) ? plans[provider].shift() : plans[provider];
    assert.ok(plan, `Unexpected ${provider} request`);
    const call = { provider, url, method: init.method, headers: clone(init.headers), body: JSON.parse(init.body), signal: init.signal, at: time.now };
    calls.push(call);
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        time.clearTimeout(timer);
        init.signal.removeEventListener('abort', abort);
      };
      const abort = () => { cleanup(); call.abortedAt = time.now; reject(new DOMException('Synthetic abort', 'AbortError')); };
      if (init.signal.aborted) return abort();
      init.signal.addEventListener('abort', abort, { once: true });
      if (plan.delay !== Infinity) timer = time.setTimeout(() => {
        cleanup();
        const body = plan.body ?? (provider === 'openai'
          ? { choices: [{ message: { content: 'OpenAI合成回答' } }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }
          : provider === 'claude' ? { content: [{ type: 'text', text: 'Claude合成回答' }] }
            : { text: 'クライアント合成回答' });
        resolve(Response.json(body, { status: plan.status ?? 200 }));
      }, plan.delay);
    });
  };
}

function edge(plans, time = clock()) {
  const calls = [];
  const context = vm.createContext({
    Date: time.Date, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    Response, AbortController, STORE_LOCATION_PROFILES: {},
    console: { warn() {}, error() {} },
    Deno: { env: { get: key => ({ OPENAI_API_KEY: 'synthetic-openai', JOURNAL_CLAUDE_API_KEY: 'synthetic-claude' })[key] }, serve() {} },
    fetch: transport(time, plans, calls),
  });
  vm.runInContext(edgeSource, context);
  return { time, calls, ...vm.runInContext('({ synthesizeWithFallback, providerTimeoutWithinDeadline, OPENAI_REQUEST_TIMEOUT_MS, CLAUDE_REQUEST_TIMEOUT_MS, JOURNAL_AI_REQUEST_DEADLINE_MS, SYNTH_HEDGE_DELAY_DEFAULT_MS })', context) };
}

function observe(promise) {
  const state = { settled: false };
  state.promise = promise.then(value => { state.settled = true; state.value = value; return value; }, error => { state.settled = true; state.error = error; });
  return state;
}

function client(plan = { delay: Infinity }, { authenticated = true } = {}) {
  const time = clock(), calls = [], privacyInputs = [];
  const context = vm.createContext({
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, AbortController,
    LINE_REPORT_AUTH: { getToken: () => authenticated ? 'lrst_synthetic-session' : '' },
    LINE_REPORT_PAGES: { ADMIN_SURFACE: 'journal_report' },
    JOURNAL_AI_PRIVACY: { sanitizePayload(payload) { privacyInputs.push(clone(payload)); return { ...payload, message: '合成マスク済み' }; } },
    fetch: transport(time, { client: plan }, calls),
  });
  vm.runInContext(read('public/jnm/journal-ai-client.js'), context);
  return { time, calls, privacyInputs, request: context.JOURNAL_AI_CLIENT.request };
}

test('OpenAI remains preferred after the old 100s limit even when the 45s Claude hedge has already succeeded', async () => {
  const app = edge({ openai: { delay: 135_000 }, claude: { delay: 1000 } });
  const result = observe(app.synthesizeWithFallback(contents));
  await app.time.tick(100_001);
  assert.equal(result.settled, false, 'must not abort OpenAI at the old 100-second budget or adopt faster Claude');
  assert.equal(app.calls[0].signal.aborted, false);
  assert.deepEqual(app.calls.map(call => [call.provider, call.at]), [['openai', 0], ['claude', 45_000]]);
  await app.time.tick(34_999);
  const answer = await result.promise;
  assert.equal(answer.ok, true);
  assert.equal(answer.provider, 'openai');
  assert.equal(answer.text, 'OpenAI合成回答');
  assert.equal(answer.model, 'gpt-6.2-sol');
  assert.equal(app.calls.filter(call => call.provider === 'claude').length, 1);
  assert.equal(app.time.pending.size, 0, 'provider and hedge timers are cleaned up');
  assert.deepEqual([app.OPENAI_REQUEST_TIMEOUT_MS, app.JOURNAL_AI_REQUEST_DEADLINE_MS], [140_000, 145_000]);
});

test('client waits through the old 140s boundary and aborts exactly at 148s with the local-fallback explanation', async () => {
  const app = client();
  const result = observe(app.request('https://fixture.invalid/ai-analyze', { action: 'chat' }));
  await app.time.tick(147_999);
  assert.equal(result.settled, false, 'the former 140s client timer must not fire');
  assert.equal(app.calls[0].signal.aborted, false);
  await app.time.tick(1);
  await result.promise;
  assert.equal(app.calls[0].abortedAt, 148_000);
  assert.match(result.error.message, /148秒以内/);
  assert.match(result.error.message, /ローカル集計/);
  assert.equal(app.time.pending.size, 0);
});

test('OpenAI succeeds just before 140s with unchanged authentication, model and completion payload', async () => {
  const app = edge({ openai: { delay: 139_999 }, claude: { delay: 1000 } });
  const input = clone(contents);
  const result = observe(app.synthesizeWithFallback(input));
  await app.time.tick(139_999);
  assert.equal((await result.promise).provider, 'openai');
  assert.deepEqual(input, contents, 'caller-owned contents must remain unchanged');
  assert.deepEqual(app.calls[0].headers, { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-openai' });
  assert.equal(app.calls[0].method, 'POST');
  assert.deepEqual(app.calls[0].body, {
    model: 'gpt-6.2-sol', store: false,
    messages: [{ role: 'developer', content: contents[0].parts[0].text }, { role: 'user', content: contents[1].parts[0].text }],
    max_completion_tokens: 9000, reasoning_effort: 'low',
  });
  assert.equal(app.time.pending.size, 0);
});

test('stalled providers abort at 140s/55s, do not retry timeout, and invoke Claude only once', async () => {
  const app = edge({ openai: { delay: Infinity }, claude: { delay: Infinity } });
  const result = observe(app.synthesizeWithFallback(contents));
  await app.time.tick(139_999);
  assert.equal(result.settled, false);
  assert.equal(app.calls[0].signal.aborted, false);
  assert.equal(app.calls[1].abortedAt, 100_000, '45s hedge plus unchanged 55s Claude timeout');
  await app.time.tick(1);
  const answer = await result.promise;
  assert.equal(answer.ok, false);
  assert.match(answer.openaiError, /timeout after 140000ms/);
  assert.match(answer.claudeError, /timeout after 55000ms/);
  assert.equal(app.calls[0].abortedAt, 140_000);
  assert.deepEqual(app.calls.map(call => call.provider), ['openai', 'claude']);
  assert.equal(answer.attempts.length, 2);
  assert.equal(app.time.pending.size, 0);
});

test('elapsed external-brief budget clips OpenAI to the existing absolute synthesis deadline', async () => {
  const time = clock();
  await time.tick(30_000); // synthetic time consumed after the real handler sets its deadline
  const app = edge({ openai: { delay: Infinity }, claude: { delay: 1000 } }, time);
  const result = observe(app.synthesizeWithFallback(contents, 145_000));
  assert.equal(time.scheduled[0], 115_000, 'remaining deadline wins over the new 140s provider maximum');
  await time.tick(114_999);
  assert.equal(result.settled, false);
  await time.tick(1);
  const answer = await result.promise;
  assert.equal(answer.ok, true);
  assert.equal(answer.provider, 'claude');
  assert.equal(app.calls[0].abortedAt, 145_000);
  assert.match(answer.fallbackFrom.error, /timeout after 115000ms/);
  assert.equal(app.calls.filter(call => call.provider === 'claude').length, 1);
  assert.equal(time.pending.size, 0);
});

test('late hedge clips Claude as well and never runs either request beyond an explicit shorter deadline', async () => {
  const app = edge({ openai: { delay: Infinity }, claude: { delay: Infinity } });
  const result = observe(app.synthesizeWithFallback(contents, 70_000));
  await app.time.tick(70_000);
  const answer = await result.promise;
  assert.equal(answer.ok, false);
  assert.deepEqual(app.calls.map(call => call.abortedAt), [70_000, 70_000]);
  assert.match(answer.openaiError, /timeout after 70000ms/);
  assert.match(answer.claudeError, /timeout after 25000ms/);
  assert.equal(app.time.pending.size, 0);
});

test('budget retry retains 3200 tokens and consumes the same deadline rather than resetting it', async () => {
  const app = edge({
    openai: [
      { delay: 30_000, status: 400, body: { error: { message: 'context_length_exceeded' } } },
      { delay: 114_999 },
    ],
  });
  const result = observe(app.synthesizeWithFallback(contents));
  await app.time.tick(30_000);
  assert.equal(result.settled, false);
  assert.deepEqual(app.calls.map(call => call.body.max_completion_tokens), [9000, 3200]);
  assert.deepEqual(app.calls[0].body.messages, app.calls[1].body.messages);
  assert.ok(app.time.scheduled.includes(115_000));
  await app.time.tick(114_999);
  assert.equal((await result.promise).provider, 'openai');
  assert.equal(app.calls.length, 2, 'existing sequential budget retry does not add a new hedge');
  assert.equal(app.time.pending.size, 0);
});

test('expired or sub-minimum remaining deadline refuses transport and clears the unused hedge timer', async () => {
  for (const remaining of [-1, 0, 3999]) {
    const app = edge({});
    assert.equal(app.providerTimeoutWithinDeadline(remaining, 140_000), Math.max(0, remaining));
    const answer = await app.synthesizeWithFallback(contents, remaining);
    assert.equal(answer.ok, false);
    assert.match(answer.openaiError, /deadline exceeded/);
    assert.match(answer.claudeError, /deadline exceeded/);
    assert.equal(app.calls.length, 0);
    assert.equal(app.time.pending.size, 0);
  }
});

function callerSignal() {
  const controller = new AbortController(), added = [], removed = [];
  return {
    controller, added, removed,
    signal: {
      get aborted() { return controller.signal.aborted; },
      addEventListener(type, fn, options) { added.push(fn); controller.signal.addEventListener(type, fn, options); },
      removeEventListener(type, fn) { removed.push(fn); controller.signal.removeEventListener(type, fn); },
    },
  };
}

test('148s client accepts a 147s reply with identical headers/privacy/payload contract and timer/listener cleanup', async () => {
  const app = client({ delay: 147_000 }), caller = callerSignal();
  const input = { action: 'chat', storeKey: 'synthetic_store', message: '合成元テキスト', salesData: { total: 12000 } };
  const result = observe(app.request('https://fixture.invalid/ai-analyze', input, { anonKey: 'synthetic-anon', signal: caller.signal }));
  await app.time.tick(147_000);
  assert.equal((await result.promise).body.text, 'クライアント合成回答');
  assert.equal(app.calls[0].method, 'POST');
  assert.deepEqual(app.calls[0].headers, {
    'Content-Type': 'application/json', Authorization: 'Bearer synthetic-anon',
    'x-admin-token': 'lrst_synthetic-session', 'x-admin-surface': 'journal_report',
  });
  assert.deepEqual(app.privacyInputs, [input]);
  assert.deepEqual(app.calls[0].body, { ...input, message: '合成マスク済み' });
  assert.equal(input.message, '合成元テキスト');
  assert.equal(app.time.pending.size, 0);
  assert.deepEqual(caller.removed, caller.added);
  await app.time.tick(100_000);
  caller.controller.abort();
  assert.equal(app.calls[0].signal.aborted, false, 'completed request is detached from caller cancellation');
});

test('caller cancellation stays immediate, is not mislabeled timeout, and cleans timer/listener', async () => {
  const app = client(), caller = callerSignal();
  const result = observe(app.request('https://fixture.invalid/ai-analyze', {}, { signal: caller.signal }));
  await app.time.tick(1000);
  caller.controller.abort();
  await result.promise;
  assert.equal(result.error.name, 'AbortError');
  assert.doesNotMatch(result.error.message, /148秒|ローカル集計/);
  assert.equal(app.calls[0].abortedAt, 1000);
  assert.equal(app.time.pending.size, 0);
  assert.equal(caller.added.length, 1);
  assert.deepEqual(caller.removed, caller.added);
});

test('client retains explicit timeout overrides and already-aborted caller behavior', async () => {
  const app = client();
  const result = observe(app.request('https://fixture.invalid/ai-analyze', {}, { timeoutMs: 12_345 }));
  await app.time.tick(12_345);
  await result.promise;
  assert.equal(app.calls[0].abortedAt, 12_345);
  assert.match(result.error.message, /12秒以内/);
  assert.equal(app.time.pending.size, 0);
  const preAborted = client(), caller = callerSignal();
  caller.controller.abort();
  const canceled = observe(preAborted.request('https://fixture.invalid/ai-analyze', {}, { signal: caller.signal }));
  await canceled.promise;
  assert.equal(canceled.error.name, 'AbortError');
  assert.equal(preAborted.time.pending.size, 0);
  assert.equal(caller.added.length, 0);
});

test('missing client authentication still refuses before privacy, timers or transport', async () => {
  const app = client(undefined, { authenticated: false });
  await assert.rejects(app.request('https://fixture.invalid/ai-analyze', {}), /ログインが必要/);
  assert.equal(app.calls.length, 0);
  assert.equal(app.privacyInputs.length, 0);
  assert.equal(app.time.scheduled.length, 0);
});

test('static client is cache-busted and configured budgets remain inside the 150s non-streaming boundary', () => {
  const app = edge({});
  assert.match(read('public/jnm/jnl2txt.html'), /src="journal-ai-client\.js\?v=20261117-sol-timeout-1"/);
  const appClient = client();
  const result = observe(appClient.request('https://fixture.invalid/ai-analyze', {}));
  assert.deepEqual([app.CLAUDE_REQUEST_TIMEOUT_MS, app.SYNTH_HEDGE_DELAY_DEFAULT_MS], [55_000, 45_000]);
  assert.ok(app.OPENAI_REQUEST_TIMEOUT_MS < app.JOURNAL_AI_REQUEST_DEADLINE_MS);
  assert.ok(app.JOURNAL_AI_REQUEST_DEADLINE_MS < appClient.time.scheduled[0]);
  assert.ok(appClient.time.scheduled[0] < 150_000);
  // Dispose the synthetic request rather than leaving pending test resources.
  return appClient.time.tick(148_000).then(() => result.promise);
});
