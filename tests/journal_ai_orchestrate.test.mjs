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
  assert.match(ai, /const OPENAI_REQUEST_TIMEOUT_MS = 70_000/);
  assert.match(ai, /const CLAUDE_REQUEST_TIMEOUT_MS = 50_000/);
  assert.match(ai, /const JOURNAL_AI_REQUEST_DEADLINE_MS = 125_000/);
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
  assert.match(client, /DEFAULT_AI_REQUEST_TIMEOUT_MS = 140000/);
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

test('Journal AI timeout budgets nest inside the Supabase gateway limit', async () => {
  const ai = await readFile(
    new URL('../supabase/functions/ai-analyze/index.ts', import.meta.url),
    'utf8',
  );
  const client = await readFile(
    new URL('../public/jnm/journal-ai-client.js', import.meta.url),
    'utf8',
  );
  const num = (source, name) => {
    const hit = source.match(new RegExp(`${name}\\s*=\\s*([\\d_]+)`));
    assert.ok(hit, `${name} not found`);
    return Number(hit[1].replace(/_/g, ''));
  };
  const openai = num(ai, 'OPENAI_REQUEST_TIMEOUT_MS');
  const claude = num(ai, 'CLAUDE_REQUEST_TIMEOUT_MS');
  const deadline = num(ai, 'JOURNAL_AI_REQUEST_DEADLINE_MS');
  const clientWait = num(client, 'DEFAULT_AI_REQUEST_TIMEOUT_MS');

  // Supabase の request idle timeout。超えると 504 になり、AI接続エラーの
  // 説明もローカル集計フォールバックも画面に出せない。
  const GATEWAY_IDLE_TIMEOUT_MS = 150_000;

  // 内側から外側へ、必ず余裕を持って収まること。
  assert.ok(
    openai + claude <= deadline,
    `providers ${openai}+${claude} must fit in deadline ${deadline}`,
  );
  assert.ok(
    deadline < clientWait,
    `server deadline ${deadline} must expire before the client gives up at ${clientWait}, ` +
      'so the server response explains the failure instead of the client aborting blind',
  );
  assert.ok(
    clientWait < GATEWAY_IDLE_TIMEOUT_MS,
    `client wait ${clientWait} must stay under the ${GATEWAY_IDLE_TIMEOUT_MS} gateway timeout`,
  );
  // 打ち切りが早すぎると、重い分析が毎回落ちる。実測で30秒では足りなかった。
  assert.ok(openai >= 60_000, `OpenAI budget ${openai} is too small for heavy analyses`);

  // ヘッジ開始は OpenAI の打ち切りより前。後ろだと併走する意味がない。
  const hedge = num(ai, 'SYNTH_HEDGE_DELAY_DEFAULT_MS');
  assert.ok(hedge < openai, `hedge ${hedge} must start before OpenAI gives up at ${openai}`);
  // ヘッジ後に Claude を走らせても全体期限に収まること。
  assert.ok(
    hedge + claude <= deadline,
    `hedged Claude ${hedge}+${claude} must finish inside the deadline ${deadline}`,
  );
});

test('Journal AI hedge keeps OpenAI as the adopted answer', async () => {
  const ai = await readFile(
    new URL('../supabase/functions/ai-analyze/index.ts', import.meta.url),
    'utf8',
  );
  const body = ai.slice(
    ai.indexOf('async function synthesizeWithFallback('),
    ai.indexOf('Deno.serve('),
  );
  // Claude は起動を1回に memo 化し、ヘッジと逐次フォールバックで二重に呼ばない。
  assert.match(body, /if \(claudeRun\) return claudeRun;/);
  assert.equal(
    (body.match(/callClaude\(/g) || []).length,
    1,
    'Claude must be invoked from exactly one place',
  );
  // 採用は OpenAI 優先。先に返った方を無条件に採ると Haiku が常用され質が変わる。
  assert.match(body, /let lunaResult = await lunaRun;/);
  assert.doesNotMatch(
    body,
    /winner\.kind === "claude"/,
    'must not adopt Claude just because it returned first',
  );
  // ヘッジ済みなら縮小枠の再試行は行わない（待ち時間だけ伸びるため）。
  assert.match(body, /shouldRetryBudget && !hedged/);
});

test('empty OpenAI responses are diagnosed, not retried with a smaller budget', async () => {
  const ai = await readFile(
    new URL('../supabase/functions/ai-analyze/index.ts', import.meta.url),
    'utf8',
  );
  // 実測: 完了枠5200では思考が枠を食い切り、51秒使って本文が空で返っていた。
  // 推論モデルは思考トークンも同じ枠を消費するため、枠は本文の想定量より
  // 十分大きく取る必要がある。
  const budget = Number(
    ai.match(/OPENAI_COMPLETION_BUDGET_PRIMARY = (\d+)/)[1],
  );
  assert.ok(
    budget >= 10000,
    `completion budget ${budget} leaves no room for output after reasoning`,
  );

  // 空応答は枠不足が原因。縮小再試行は状況を悪化させるだけなので行わない。
  const retryGuard = ai.match(/const shouldRetryBudget = !\[[\s\S]*?\]/)[0];
  assert.match(retryGuard, /"empty_content"/);

  // 空応答の理由を記録すること。finish_reason が無いと枠不足か真の空かを
  // 切り分けられず、実データを取り直す羽目になる。
  assert.match(ai, /finish_reason=\$\{finish\}/);
  assert.match(ai, /reasoning_tokens=\$\{reasoning\}/);
  assert.match(ai, /budget=\$\{completionBudget\}/);
});
