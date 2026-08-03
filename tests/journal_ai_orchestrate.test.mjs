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
  assert.match(ai, /journal_ai_orchestrate/);
  assert.match(ai, /gatherExternalBriefs/);
  assert.match(ai, /orchestrationMode/);
  assert.match(ai, /gpt-5\.6-luna/);
  assert.match(ai, /callOpenAiLuna/);
  assert.match(ai, /callKimi/);
  assert.match(ai, /kimi-k3/);
  assert.match(ai, /synthesizeWithFallback/);
  assert.match(ai, /api\.moonshot\.ai/);
  assert.match(ai, /authenticateAdminDashboardSessionToken/);
  assert.match(ai, /x-admin-token/);
  assert.match(ai, /consume_security_rate_limit/);
  assert.match(ai, /AI_RATE_LIMITS/);
  assert.match(ai, /他店舗のデータにはアクセスできません/);
  assert.match(ai, /const locationBlock = buildStoreLocationPromptBlock\(effectiveStoreKey, storeName\)/);
  assert.doesNotMatch(ai, /String\(storeLocationBlock \|\| ""\)/);
});

test('Journal Report sends its scoped admin session to every ai-analyze request', async () => {
  const html = await readFile(
    new URL('../public/jnm/jnl2txt.html', import.meta.url),
    'utf8',
  );
  const indexHtml = await readFile(
    new URL('../public/jnm/index.html', import.meta.url),
    'utf8',
  );
  const client = await readFile(
    new URL('../public/jnm/journal-ai-client.js', import.meta.url),
    'utf8',
  );
  for (const source of [html, indexHtml]) {
    assert.match(source, /src="journal-ai-client\.js"/);
    assert.equal(
      [...source.matchAll(/AI_CLIENT\.request\(AI_ENDPOINT,/g)].length,
      3,
      'analyze, clarify, and chat must use the shared AI client',
    );
  }
  assert.match(client, /'x-admin-token': token/);
  assert.match(client, /LINE_REPORT_AUTH/);
  assert.match(client, /ログインが必要です/);
});
