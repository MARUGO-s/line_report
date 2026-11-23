import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const pages = ['public/jnm/ai-usage.html', 'public/ai-usage.html'];
function read(path) { return readFileSync(new URL('../' + path, import.meta.url), 'utf8'); }

// Evaluate the actual inline definitions, stopping before auth/network startup.
function loadPage(path, source = read(path)) {
  const nodes = new Map();
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '' });
    return nodes.get(id);
  } };
  const context = vm.createContext({
    document, window: {}, localStorage: { getItem() { return null; } },
    fetch() { throw new Error('No network allowed in display tests'); },
  });
  const script = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .find((match) => match[1].includes('function modelUsd('));
  assert.ok(script, `cost script missing: ${path}`);
  const start = script.index + '<script>'.length;
  const scriptEnd = path.includes('/jnm/')
    ? source.indexOf("document.getElementById('periodTabs').addEventListener", start)
    : source.indexOf("    dom.periodTabs.addEventListener", start);
  assert.ok(start >= '<script>'.length && scriptEnd > start, `inline startup boundary missing: ${path}`);
  vm.runInContext(source.slice(start, scriptEnd), context, { filename: path });
  return { context, nodes, run(code) { return vm.runInContext(code, context); } };
}

function usd(page, row) { return page.run(`modelUsd(${JSON.stringify(row)})`); }
function close(actual, expected, message) { assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} !== ${expected}`); }

test('global Sol 6.2 is a known active Journal model alongside preserved Sol 6.1 history', () => {
  const page = loadPage('public/ai-usage.html');
  const models = ['gpt-6.2-sol', 'gpt-6.1-sol'].map(model => ({
    provider: 'openai', model, event_count: 1, input_tokens: 100000, output_tokens: 2000, cached_tokens: 64000,
  }));
  page.run('state.rates.openai = {inUsd:7, outUsd:11}');
  page.run(`state.data = ${JSON.stringify({ models })}; renderAllAiCards(); renderModelBreakdown();`);
  const cards = page.nodes.get('allAiTotalRow').innerHTML.split('<div class="total-card ');
  const rows = [...page.nodes.get('modelBrkBody').innerHTML.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map(m => m[0]);
  for (const { model } of models) {
    assert.equal(page.run(`isActiveProductionModel('openai', '${model}')`), true, model);
    assert.match(page.run(`modelLabelFor('${model}')`), /Journal Report の分析・チャット・確認質問・深掘り統合/, model);
    const modelCards = cards.filter(s => s.includes(model));
    assert.equal(modelCards.length, 1, `${model} must have exactly one separate card`);
    const card = modelCards[0];
    const title = card.match(/<div class="tc-prov">([^<]*)<\/div>/)?.[1];
    assert.equal(title, model === 'gpt-6.2-sol' ? 'OpenAI / GPT-6.2 Sol' : 'OpenAI / GPT-6.1 Sol');
    assert.ok(!card.includes(model === 'gpt-6.2-sol' ? 'gpt-6.1-sol' : 'gpt-6.2-sol'), 'Sol versions must not share a card');
    assert.match(card, /Journal Report/);
    assert.match(card, /\$0\.10 \/ 1件/);
    assert.match(card, />¥15</);
    const row = rows.find(s => s.includes(model));
    assert.ok(row, `${model} history row must exist`);
    assert.match(row, /\$2 \/ \$10/);
    assert.match(row, />¥15</);
  }
  close(page.run("providerUsdAccurate('openai')"), 0.1968, 'both Sol versions retain measured cache and ignore Luna settings');
});

test('Journal renders Sol 6.2, Sol 6.1 history and Luna separately with preserved totals', () => {
  const page = loadPage('public/jnm/ai-usage.html');
  const models = ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-5.6-luna'].map(model => ({
    provider: 'openai', model, event_count: 1, input_tokens: 100000, output_tokens: 2000, cached_tokens: 64000,
  }));
  page.run(`render(${JSON.stringify({ journal: { models } })})`);
  const rows = [...page.nodes.get('modelBody').innerHTML.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map(m => m[0]).filter(row => row.includes('<td>'));
  assert.equal(rows.length, 3);
  for (const model of ['gpt-6.2-sol', 'gpt-6.1-sol']) {
    assert.match(rows.find(row => row.includes(model)), /\$0\.10<\/td><td>¥15/);
  }
  assert.match(rows.find(row => row.includes('gpt-5.6-luna')), /\$0\.11<\/td><td>¥17/);
  assert.equal(page.nodes.get('kpiUsd').textContent, '$0.31');
  assert.equal(page.nodes.get('kpiJpy').textContent, '¥48');
});

test('orchestration mode describes the answer role without claiming Luna, Sol or OpenAI on a Claude fallback', () => {
  const source = read('supabase/functions/_shared/journal_ai_orchestrate.ts');
  const start = source.indexOf('export function orchestrationNote(');
  assert.ok(start >= 0, 'actual orchestrationNote must exist');
  const body = stripTypeScriptTypes(source.slice(start).replace('export function', 'function'));
  const context = vm.createContext({});
  vm.runInContext(body, context);
  const cases = [
    ['data', [], 'モード: 数値検証（回答AI）'],
    ['strategy', [], 'モード: 戦略（外部AIキー未設定または取得失敗のため 回答AI のみ）'],
    ['mixed', [{provider:'grok',ok:false}], 'モード: 数値+戦略（外部AIキー未設定または取得失敗のため 回答AI のみ）'],
    ['mixed', [{provider:'grok',ok:true},{provider:'perplexity',ok:true}], 'モード: 数値+戦略（回答AI + grok + perplexity）'],
    ['strategy', [{provider:'grok',ok:false},{provider:'perplexity',ok:true}], 'モード: 戦略（回答AI + perplexity）'],
  ];
  for (const [intent, briefs, expected] of cases) {
    const note = vm.runInContext(`orchestrationNote(${JSON.stringify(intent)}, ${JSON.stringify(briefs)})`, context);
    assert.equal(note, expected);
    assert.doesNotMatch(note, /gpt-|OpenAI|Sol|Luna|luna/);
  }
});

test('global usage includes and classifies Sol without changing the Luna rate setting', () => {
  const page = loadPage('public/ai-usage.html');
  assert.equal(page.run("isActiveProductionModel('openai', 'gpt-6.1-sol')"), true);
  assert.match(page.run("modelLabelFor('gpt-6.1-sol')"), /Journal/);
  page.run('state.rates.openai = {inUsd:7, outUsd:11}');
  close(usd(page, { provider: 'openai', model: 'gpt-6.1-sol', input_tokens: 100000, output_tokens: 2000 }), 0.22, 'Sol ignores Luna setting');
  close(usd(page, { provider: 'openai', model: 'gpt-5.6-luna', input_tokens: 100000, output_tokens: 2000 }), (100000 * 7 + 2000 * 11) / 1e6, 'Luna retains edited setting');
});

test('global Sol card keeps measured cache through actual model merging and renders its own amount', () => {
  const page = loadPage('public/ai-usage.html');
  const models = [
    { provider: 'openai', model: 'gpt-6.1-sol', event_count: 1, input_tokens: 100000, output_tokens: 2000, cached_tokens: 64000 },
    { provider: 'openai', model: 'gpt-5.6-luna', event_count: 1, input_tokens: 100000, output_tokens: 2000, cached_tokens: 64000 },
  ];
  page.run(`state.data = ${JSON.stringify({ models })}; renderAllAiCards(); renderModelBreakdown();`);
  const card = page.nodes.get('allAiTotalRow').innerHTML.split('<div class="total-card ').find((s) => s.includes('gpt-6.1-sol'));
  assert.ok(card, 'Sol card must exist');
  assert.equal(card.match(/<div class="tc-prov">([^<]*)<\/div>/)?.[1], 'OpenAI / GPT-6.1 Sol');
  assert.match(card, /\$0\.10 \/ 1件/);
  assert.match(card, />¥15</);
  const rows = [...page.nodes.get('modelBrkBody').innerHTML.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
  const sol = rows.find((row) => row.includes('gpt-6.1-sol'));
  const luna = rows.find((row) => row.includes('gpt-5.6-luna'));
  assert.ok(sol && luna, 'both model rows must remain');
  assert.match(sol, /\$2 \/ \$10/);
  assert.match(sol, />¥15</);
  assert.match(luna, /\$1 \/ \$6/);
  assert.match(luna, />¥17</);
  close(page.run("providerUsdAccurate('openai')"), 0.0984 + 0.112, 'provider total includes Sol and Luna separately');
});

test('Journal usage renders separate Sol and legacy Luna rows with unchanged formatting', () => {
  const page = loadPage('public/jnm/ai-usage.html');
  const models = [
    { provider: 'openai', model: 'gpt-6.1-sol', event_count: 1, input_tokens: 100000, output_tokens: 2000, cached_tokens: 64000 },
    { provider: 'openai', model: 'gpt-5.6-luna', event_count: 1, input_tokens: 100000, output_tokens: 2000, cached_tokens: 64000 },
  ];
  page.run(`render(${JSON.stringify({ journal: { models } })})`);
  const rows = [...page.nodes.get('modelBody').innerHTML.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((m) => m[0]);
  assert.match(rows.find((row) => row.includes('gpt-6.1-sol')), /\$0\.10<\/td><td>¥15/);
  assert.match(rows.find((row) => row.includes('gpt-5.6-luna')), /\$0\.11<\/td><td>¥17/);
  assert.equal(page.nodes.get('kpiUsd').textContent, '$0.21');
  assert.equal(page.nodes.get('kpiJpy').textContent, '¥33');
});

// Frozen legacy price expectations: cache/long-context changes are Sol-only.
const legacyRates = [
  ['openai', 'gpt-5.6-luna', 1, 6],
  ['openai', 'unknown-legacy', 1, 6],
  ['claude', 'claude-haiku-4-5', 1, 5],
  ['azure_openai', 'gpt-5.4-nano', 0.2, 1.25],
  ['gemini', 'gemini-3.1-flash-lite', 0.25, 1.5],
  ['gemini', 'gemini-3-flash-preview', 0.5, 3],
  ['gemini', 'gemini-3.5-flash', 0.5, 3],
  ['gemini', 'gemini-3.1-pro-preview', 2, 12],
  ['grok', 'grok-3-mini', 0.3, 0.5],
  ['grok', 'grok-4.5 x_search*2 drop:missing_x_citations', 2, 6],
  ['groq', 'openai/gpt-oss-120b', 0.15, 0.6],
];
for (const path of pages) {
  test(`${path}: legacy costs stay unchanged, including cache, thinking and x_search`, () => {
    const page = loadPage(path);
    for (const [provider, model, inputRate, outputRate] of legacyRates) {
      for (const input_tokens of [100000, 272001, 1000000]) {
        const row = { provider, model, input_tokens, output_tokens: 2000, thinking_tokens: 1000, cached_tokens: 64000, event_count: 3 };
        const toolFee = model.includes('x_search*2') ? 2 * 3 * 0.005 : 0;
        close(usd(page, row), (input_tokens * inputRate + 2000 * outputRate) / 1e6 + toolFee, JSON.stringify(row));
      }
    }
  });
}

test('the two actual browser cost implementations agree for seeded Sol counter combinations', () => {
  const local = loadPage(pages[0]);
  const global = loadPage(pages[1]);
  let seed = 0x61;
  const rand = () => {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const cachedLongSingleRequests = { 'gpt-6.1-sol': 0, 'gpt-6.2-sol': 0 };
  for (let i = 0; i < 200; i++) {
    const input_tokens = Math.floor(rand() * 500000);
    const row = { provider:'openai', input_tokens, output_tokens:Math.floor(rand()*5000), cached_tokens:Math.floor(rand()*input_tokens), event_count:1 + Math.floor(rand()*3) };
    for (const model of Object.keys(cachedLongSingleRequests)) {
      const modelRow = { ...row, model };
      if (row.event_count === 1 && input_tokens > 272000 && row.cached_tokens > 0) cachedLongSingleRequests[model]++;
      close(usd(local, modelRow), usd(global, modelRow), JSON.stringify(modelRow));
      close(usd(local, modelRow), usd(local, { ...row, model: 'gpt-6.1-sol' }), `both Sol versions: ${JSON.stringify(modelRow)}`);
    }
  }
  for (const [model, count] of Object.entries(cachedLongSingleRequests)) {
    assert.ok(count >= 10, `${model} cached long single requests exercised: ${count}`);
  }
});

for (const path of pages) {
  for (const model of ['gpt-6.1-sol', 'gpt-6.2-sol']) {
  test(`${path}: ${model} bills measured cache once and applies long-context rates only to a known single request`, () => {
    const page = loadPage(path);
    for (const input_tokens of [271999, 272000, 272001]) {
      for (const cached_tokens of [undefined, null, 0, 64000, -1, input_tokens + 1]) {
        const row = { provider: 'openai', model, event_count: 1, input_tokens, output_tokens: 2000, thinking_tokens: 1000, cached_tokens };
        const cached = Math.min(input_tokens, Math.max(0, Number(cached_tokens || 0)));
        const long = input_tokens > 272000;
        const expected = ((input_tokens - cached) * (long ? 4 : 2) + cached * (long ? 0.2 : 0.1) + 2000 * (long ? 15 : 10)) / 1e6;
        close(usd(page, row), expected, JSON.stringify(row));
      }
    }
    // These API rows are request aggregates. Their summed input is NOT a context length.
    close(usd(page, { provider: 'openai', model, event_count: 3, input_tokens: 600000, output_tokens: 6000, cached_tokens: 300000 }),
      (300000 * 2 + 300000 * 0.1 + 6000 * 10) / 1e6, 'aggregate must not trigger a per-request surcharge');
  });
  test(`${path}: ${model} has explicit standard rates, not the legacy OpenAI fallback`, () => {
    const page = loadPage(path);
    assert.equal(page.run(`rateForModel('openai', '${model}').inUsd`), 2);
    assert.equal(page.run(`rateForModel('openai', '${model}').outUsd`), 10);
    assert.equal(page.run(`rateForModel('openai', '${model}').cachedUsd`), 0.1);
    close(usd(page, {provider:'openai', model, event_count:1, input_tokens:100000, output_tokens:2000}), (100000 * 2 + 2000 * 10) / 1e6, model);
  });
  }
}
