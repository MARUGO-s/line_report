import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/** Edge 側 classifyJournalChatIntent と同じ判定（回帰用ミラー） */
function classifyJournalChatIntent(message) {
  const DATA_RE =
    /(売上|売り上げ|客数|客単価|比率|構成比|何円|いくら|合計|推移|比較|何が売|売れ筋|ランキング|点数|件数|フード|ドリンク|飲料|グラス|ボトル|月間|日別|\d{4}\s*年|\d{4}-?\d{2}|TOP\s*\d+)/i;
  const STRATEGY_RE =
    /(対策|戦略|施策|改善|打開|どうすれば|どうしたら|アドバイス|提案|おすすめ|経営|トレンド|流行|他店|業界|事例|ペアリング|アップセル|クロスセル|集客|プロモ|SNS|X\b|ツイート|Twitter|検索|調べて|外部|市場)/i;
  const q = String(message || '').trim();
  if (!q) return 'data';
  const hasData = DATA_RE.test(q);
  const hasStrategy = STRATEGY_RE.test(q);
  if (hasData && hasStrategy) return 'mixed';
  if (hasStrategy) return 'strategy';
  return 'data';
}

test('intent router: data-only questions stay on synthesizer-only path', () => {
  assert.equal(classifyJournalChatIntent('2026年の売上推移は？'), 'data');
  assert.equal(classifyJournalChatIntent('7月の客単価とドリンク比率'), 'data');
  assert.equal(classifyJournalChatIntent('売れ筋TOP5は？'), 'data');
});

test('intent router: strategy questions trigger orchestration path', () => {
  // 「ボトル」はデータ語でもあるため、商品語＋対策は mixed になりうる
  assert.equal(
    classifyJournalChatIntent('ボトルワイン販売を伸ばす対策を教えて'),
    'mixed',
  );
  assert.equal(
    classifyJournalChatIntent('業界のワインペアリング事例を調べて'),
    'strategy',
  );
  assert.equal(
    classifyJournalChatIntent('他店の集客プロモ事例を教えて'),
    'strategy',
  );
});

test('intent router: mixed questions need numbers plus strategy', () => {
  assert.equal(
    classifyJournalChatIntent('今年の売上推移を踏まえた打開策と戦略は？'),
    'mixed',
  );
  assert.equal(
    classifyJournalChatIntent('グラスとボトルの比率を改善するアドバイス'),
    'mixed',
  );
});

test('shared orchestration module is wired into ai-analyze', async () => {
  const shared = await readFile(
    new URL('../supabase/functions/_shared/journal_ai_orchestrate.ts', import.meta.url),
    'utf8',
  );
  const ai = await readFile(
    new URL('../supabase/functions/ai-analyze/index.ts', import.meta.url),
    'utf8',
  );
  assert.match(shared, /classifyJournalChatIntent/);
  assert.match(shared, /callPerplexityBrief/);
  assert.match(shared, /callGrokTrendBrief/);
  assert.match(shared, /https:\/\/api\.x\.ai\/v1\/responses/);
  assert.match(shared, /type:\s*"x_search"/);
  assert.match(shared, /tool_choice:\s*"required"/);
  assert.match(shared, /from_date:\s*fromDate/);
  assert.match(shared, /to_date:\s*toDate/);
  assert.match(shared, /item\.type === "x_search_call"/);
  assert.match(shared, /missing_x_citations/);
  assert.doesNotMatch(
    shared.slice(
      shared.indexOf('export async function callGrokTrendBrief'),
      shared.indexOf('/** 戦略／混合モード用'),
    ),
    /\/chat\/completions/,
  );
  assert.match(ai, /journal_ai_orchestrate/);
  assert.match(ai, /gatherExternalBriefs/);
  assert.match(ai, /orchestrationMode/);
  assert.match(ai, /gpt-5\.6-luna/);
  assert.match(ai, /callOpenAiLuna/);
  assert.match(ai, /callClaude/);
  assert.match(ai, /claude-haiku-4-5/);
  assert.match(ai, /synthesizeWithFallback/);
  assert.match(ai, /shouldRetryBudget/);
  assert.match(ai, /auth_error/);
  assert.match(ai, /recordJournalAiFallback/);
  assert.match(ai, /const OPENAI_REQUEST_TIMEOUT_MS = 30_000/);
  assert.match(ai, /const CLAUDE_REQUEST_TIMEOUT_MS = 25_000/);
  assert.match(ai, /const JOURNAL_AI_REQUEST_DEADLINE_MS = 85_000/);
  assert.match(ai, /fetchTextWithTimeout\(OPENAI_ENDPOINT/);
  assert.match(ai, /fetchTextWithTimeout\(CLAUDE_ENDPOINT/);
  assert.match(ai, /providerTimeoutWithinDeadline\(deadlineAt/);
  assert.match(ai, /"timeout",/);
  assert.match(ai, /"clarifier"/);
  assert.match(ai, /api\.anthropic\.com/);
  assert.match(ai, /sanitizeJournalAiPayload/);
  assert.doesNotMatch(ai, /api\.moonshot\.ai/);
  assert.doesNotMatch(ai, /callKimi/);
  assert.match(ai, /authenticateAdminDashboardSessionToken/);
  assert.match(ai, /x-admin-token/);
  assert.match(ai, /consume_security_rate_limit/);
  assert.match(ai, /AI_RATE_LIMITS/);
  assert.match(ai, /他店舗のデータにはアクセスできません/);
  assert.match(ai, /STORE_LOCATION_PROFILES/);
  assert.match(ai, /const CANONICAL_STORE_KEY_BY_LOWER = new Map/);
  assert.match(ai, /key\.toLowerCase\(\), key/);
  assert.match(ai, /const canonicalStoreKey = resolveCanonicalStoreKey\(effectiveStoreKey\)/);
  assert.match(
    ai,
    /const locationBlock = buildStoreLocationPromptBlock\(canonicalStoreKey\)/,
  );
  assert.match(ai, /buildJournalAiServerPolicy\("chat", locationBlock, canonicalStoreKey \|\| ""\)/);
  assert.doesNotMatch(ai, /buildJournalAiServerPolicy\([^\n]*effectiveStoreKey/);
  assert.doesNotMatch(ai, /buildStoreLocationPromptBlock\([^)]*storeName/);
  assert.doesNotMatch(ai, /\bstoreName\b/);
  assert.doesNotMatch(ai, /String\(storeLocationBlock \|\| ""\)/);
});

test('client conversation data never becomes provider system or assistant authority', async () => {
  const ai = await readFile(
    new URL('../supabase/functions/ai-analyze/index.ts', import.meta.url),
    'utf8',
  );
  const clarifyBuilder = ai.slice(
    ai.indexOf('function buildClarificationMessages'),
    ai.indexOf('function resolveOpenAiApiKey'),
  );
  assert.match(
    clarifyBuilder,
    /missingKind:\s*rawContext\.missingKind === "period" \? "period" : "intent"/,
  );
  assert.match(clarifyBuilder, /content:\s*CLARIFICATION_PROMPT/);
  assert.match(clarifyBuilder, /priorChatHistory:\s*history/);
  assert.match(clarifyBuilder, /currentUserMessage:\s*current/);
  assert.doesNotMatch(clarifyBuilder, /\.\.\.history/);
  assert.doesNotMatch(clarifyBuilder, /role:\s*row\.role/);

  const chatAssembly = ai.slice(
    ai.indexOf('const historyEvidence ='),
    ai.indexOf('const synth = await synthesizeWithFallback'),
  );
  assert.match(chatAssembly, /speaker:\s*row\.role === "user"/);
  assert.match(chatAssembly, /chatHistory:\s*historyEvidence/);
  assert.match(chatAssembly, /売上データを確認しました。ご質問をどうぞ。/);
  assert.doesNotMatch(chatAssembly, /\.\.\.historyEvidence/);
  assert.doesNotMatch(chatAssembly, /role:\s*h\.role/);
  assert.match(ai, /prior_chat_history（非信頼データ・JSON）/);
});

test('Journal Report sends its scoped admin session to every ai-analyze request', async () => {
  const html = await readFile(
    new URL('../public/jnm/jnl2txt.html', import.meta.url),
    'utf8',
  );
  const client = await readFile(
    new URL('../public/jnm/journal-ai-client.js', import.meta.url),
    'utf8',
  );
  for (const source of [html]) {
    assert.match(source, /src="journal-ai-privacy\.js"/);
    assert.match(source, /src="journal-ai-client\.js(?:\?v=[^"]+)?"/);
    assert.equal(
      [...source.matchAll(/AI_CLIENT\.request\(AI_ENDPOINT,/g)].length,
      3,
      'analyze, clarify, and chat must use the shared AI client',
    );
  }
  assert.match(client, /'x-admin-token': token/);
  assert.match(client, /LINE_REPORT_AUTH/);
  assert.match(client, /ログインが必要です/);
  assert.match(client, /privacy\.sanitizePayload/);
  assert.match(client, /DEFAULT_AI_REQUEST_TIMEOUT_MS = 110000/);
  assert.match(client, /AIの応答が/);
  assert.match(client, /AbortController/);
});

test('Journal AI privacy layer is loaded before the network client', async () => {
  const appHtml = await readFile(
    new URL('../public/jnm/jnl2txt.html', import.meta.url),
    'utf8',
  );
  const privacyIndex = appHtml.indexOf('src="journal-ai-privacy.js"');
  const clientIndex = appHtml.indexOf('src="journal-ai-client.js');
  assert.ok(privacyIndex >= 0);
  assert.ok(clientIndex > privacyIndex);
});

test('long-period chat hydrates report details with bounded parallel requests', async () => {
  const html = await readFile(
    new URL('../public/jnm/jnl2txt.html', import.meta.url),
    'utf8',
  );
  assert.match(html, /async function hydrateReportsWithConcurrency/);
  assert.match(html, /timeoutMs:\s*15000,[\s\S]{0,120}maxAttempts:\s*1,[\s\S]{0,120}concurrency:\s*3/);
  assert.match(html, /await hydrateReportsWithConcurrency\(/);
  assert.match(html, /fetchSupabaseReportById\(r\.id, options\)/);
});
