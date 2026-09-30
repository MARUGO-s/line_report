import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readChatPageSourceSync } from './helpers/chat-page-source.mjs';

const chatSource = readChatPageSourceSync();
const messagesJs = fs.readFileSync(new URL('../public/chat/messages.js', import.meta.url), 'utf8');
const chatCss = fs.readFileSync(new URL('../public/chat/chat.css', import.meta.url), 'utf8');
const serviceWorker = fs.readFileSync(new URL('../public/chat-sw.js', import.meta.url), 'utf8');
const chatHtml = fs.readFileSync(new URL('../public/chat.html', import.meta.url), 'utf8');

const BOT = '00000000-0000-4000-8000-00000000b073';
const ME = 'user-1';

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const brace = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function constant(name) {
  const match = messagesJs.match(new RegExp(`const ${name} = [^;]+;`));
  assert.ok(match, `${name} must exist`);
  return match[0];
}

function pureContext() {
  const context = vm.createContext({});
  vm.runInContext([
    constant('AI_ANALYSIS_BOT_USER_ID'),
    constant('AI_TYPING_TIMEOUT_MS'),
    constant('AI_TYPING_NOTICE_MAX_MS'),
    extractFunction(messagesJs, 'isAiAnalysisRoom'),
    extractFunction(messagesJs, 'aiTypingCandidate'),
    'this.isAiAnalysisRoom = isAiAnalysisRoom; this.aiTypingCandidate = aiTypingCandidate;',
  ].join('\n'), context);
  return context;
}

test('AI分析 Bot room is detected only for 1-to-1 rooms with the b073 bot', () => {
  const { isAiAnalysisRoom } = pureContext();
  assert.equal(isAiAnalysisRoom({ is_direct: true, peer: { id: BOT } }), true);
  assert.equal(isAiAnalysisRoom({ is_direct: true, direct_key: `${BOT}:${ME}` }), true);
  assert.equal(isAiAnalysisRoom({ is_direct: false, peer: { id: BOT } }), false);
  assert.equal(isAiAnalysisRoom({ is_direct: true, peer: { id: '00000000-0000-4000-8000-00000000b071' } }), false);
  assert.equal(isAiAnalysisRoom(null), false);
});

test('typing candidate: own recent text shows dots, then a notice after 120s; bot reply hides', () => {
  const { aiTypingCandidate } = pureContext();
  const now = Date.parse('2026-10-01T03:00:00Z');
  const mine = { id: 10, user_id: ME, kind: 'text', content: '先月のPVは？', created_at: '2026-10-01T02:59:30Z' };
  assert.deepEqual({ ...aiTypingCandidate([mine], ME, now, null) }, { id: 10, mode: 'typing', remainingMs: 90000 });
  // bot reply after the question → nothing
  const reply = { id: 11, user_id: BOT, kind: 'text', content: '回答', created_at: '2026-10-01T02:59:50Z' };
  assert.equal(aiTypingCandidate([mine, reply], ME, now, null), null);
  // after 120s → local notice (until 30 min)
  assert.equal(aiTypingCandidate([{ ...mine, created_at: '2026-10-01T02:57:59Z' }], ME, now, null).mode, 'notice');
  assert.equal(aiTypingCandidate([{ ...mine, created_at: '2026-10-01T02:31:00Z' }], ME, now, null).mode, 'notice');
  assert.equal(aiTypingCandidate([{ ...mine, created_at: '2026-10-01T02:29:59Z' }], ME, now, null), null);
  // non-text or empty
  assert.equal(aiTypingCandidate([{ ...mine, kind: 'image' }], ME, now, null), null);
  assert.equal(aiTypingCandidate([{ ...mine, content: '  ' }], ME, now, null), null);
  // kind missing counts as text
  assert.equal(aiTypingCandidate([{ ...mine, kind: undefined }], ME, now, null).id, 10);
  // someone else's message / empty list
  assert.equal(aiTypingCandidate([{ ...mine, user_id: 'other' }], ME, now, null), null);
  assert.equal(aiTypingCandidate([], ME, now, null), null);
  // server clock ahead of device clock: never more than 120s
  assert.equal(aiTypingCandidate([{ ...mine, created_at: '2026-10-01T03:01:00Z' }], ME, now, null).remainingMs, 120000);
  // locally sent message uses the device send time even if created_at looks old (device clock ahead)
  const skewed = { ...mine, created_at: '2026-10-01T02:50:00Z' };
  assert.deepEqual({ ...aiTypingCandidate([skewed], ME, now, { id: 10, at: now - 1000 }) }, { id: 10, mode: 'typing', remainingMs: 119000 });
});

class FakeNode {
  constructor(className = '') { this.className = className; this.children = []; this.parent = null; this.attrs = {}; this.dataset = {}; this.innerHTML = ''; }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(node) {
    if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
    node.parent = this;
    this.children.push(node);
    return node;
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '');
    return this.children.filter((c) => c.className.split(/\s+/).includes(cls));
  }
}

function domContext({ group, messages, now }) {
  const list = new FakeNode('messages');
  const timers = [];
  const context = vm.createContext({
    document: { createElement: () => new FakeNode() },
    $: (id) => (id === 'messages' ? list : null),
    currentGroup: () => group,
    personName: (u) => (u && u.username) || '',
    escapeHtml: (s) => String(s),
    scrollMessagesToBottom: () => {},
    Date: { now: () => now.value, parse: Date.parse },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    currentUser: { id: ME },
    currentMessages: messages,
    viewHasLatest: true,
    followNewMessages: true,
  });
  vm.runInContext([
    constant('AI_ANALYSIS_BOT_USER_ID'),
    constant('AI_TYPING_TIMEOUT_MS'),
    constant('AI_TYPING_NOTICE_MAX_MS'),
    constant('AI_TYPING_TIMEOUT_TEXT'),
    "let aiTypingTimer = null; let aiTypingKey = ''; let aiTypingLiveMessage = null;",
    ...['isAiAnalysisRoom', 'aiTypingCandidate', 'buildAiTypingNode', 'hideAiTyping', 'syncAiTyping']
      .map((name) => extractFunction(messagesJs, name)),
    'this.syncAiTyping = syncAiTyping; this.hideAiTyping = hideAiTyping;',
    'this.setMessages = (list) => { currentMessages = list; };',
  ].join('\n'), context);
  return { context, list, timers };
}

test('typing bubble stays last, turns into a local notice at 120s, and hides when the bot replies', () => {
  const now = { value: Date.parse('2026-10-01T03:00:00Z') };
  const group = { is_direct: true, peer: { id: BOT, username: 'AI分析' } };
  const q = { id: 1, user_id: ME, kind: 'text', content: '質問', created_at: '2026-10-01T03:00:00Z' };
  const { context, list, timers } = domContext({ group, messages: [q], now });
  list.appendChild(new FakeNode('message own'));
  context.syncAiTyping();
  const typing = list.children.at(-1);
  assert.equal(typing.className, 'message ai-typing');
  assert.equal(typing.dataset.aiTypingMode, 'typing');
  assert.equal(typing.attrs.role, 'status');
  assert.match(typing.innerHTML, /typing-dots/);
  assert.match(typing.innerHTML, /AI分析/);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms >= 120000 && timers[0].ms < 121000);
  // another render keeps a single bubble at the end without restarting the timer
  list.appendChild(new FakeNode('message own'));
  context.syncAiTyping();
  assert.equal(list.querySelectorAll('.ai-typing').length, 1);
  assert.equal(list.children.at(-1).className, 'message ai-typing');
  assert.equal(timers.length, 1);

  // 120s pass → the timer switches the dots to the local notice (same text as the server)
  now.value += 120050;
  timers[0].fn();
  const notice = list.children.at(-1);
  assert.equal(list.querySelectorAll('.ai-typing').length, 1);
  assert.equal(notice.className, 'message ai-typing ai-typing-notice');
  assert.equal(notice.dataset.aiTypingMode, 'notice');
  assert.match(notice.innerHTML, /すみません、返事に時間がかかっています。エラーが起きた可能性があるので、もう一度送ってください。/);
  assert.doesNotMatch(notice.innerHTML, /typing-dots/);
  assert.equal(timers.length, 1, 'no further timer for the notice');
  // re-render keeps the notice
  context.syncAiTyping();
  assert.equal(list.children.at(-1), notice);

  // any bot message (e.g. the server timeout notice) → hidden
  context.setMessages([q, { id: 2, user_id: BOT, kind: 'text', content: 'すみません…', created_at: '2026-10-01T03:02:10Z' }]);
  context.syncAiTyping();
  assert.equal(list.querySelectorAll('.ai-typing').length, 0);

  // a new question shows the dots again with a fresh timer; bot reply clears the timer
  const q2 = { id: 3, user_id: ME, kind: 'text', content: '続き', created_at: '2026-10-01T03:03:00Z' };
  now.value = Date.parse('2026-10-01T03:03:00Z');
  context.setMessages([q, q2]);
  context.syncAiTyping();
  assert.equal(list.children.at(-1).dataset.aiTypingMode, 'typing');
  assert.equal(timers.length, 2);
  context.setMessages([q, q2, { id: 4, user_id: BOT, kind: 'text', content: '回答', created_at: '2026-10-01T03:03:20Z' }]);
  context.syncAiTyping();
  assert.equal(list.querySelectorAll('.ai-typing').length, 0);
  assert.equal(timers[1].cleared, true);
});

test('typing bubble is not shown in other rooms', () => {
  const now = { value: Date.parse('2026-10-01T03:00:00Z') };
  const q = { id: 1, user_id: ME, kind: 'text', content: '質問', created_at: '2026-10-01T03:00:00Z' };
  const { context, list } = domContext({ group: { is_direct: true, peer: { id: 'someone' } }, messages: [q], now });
  context.syncAiTyping();
  assert.equal(list.querySelectorAll('.ai-typing').length, 0);
});

test('chat page wires the typing indicator into render, new message, and leaving the room', () => {
  assert.match(extractFunction(messagesJs, 'resetMessageView'), /hideAiTyping\(\);/);
  assert.match(extractFunction(messagesJs, 'renderMessageList'), /syncAiTyping\(\);/);
  const add = extractFunction(messagesJs, 'addMessageToUI');
  assert.match(add, /aiTypingLiveMessage = \{ id: msg\.id, at: Date\.now\(\) \}/);
  assert.match(add, /syncAiTyping\(\);/);
  // client-side only: no inserts/updates/RPC from the typing code
  const typingCode = ['buildAiTypingNode', 'hideAiTyping', 'syncAiTyping', 'aiTypingCandidate']
    .map((name) => extractFunction(messagesJs, name)).join('\n');
  assert.doesNotMatch(typingCode, /\bsb\.|\.insert\(|\.update\(|\.rpc\(|fetch\(/);
  assert.match(chatSource, /function syncAiTyping/);
});

test('typing animation respects reduced motion and assets are cache-busted', () => {
  assert.match(chatCss, /@keyframes aiTypingBounce/);
  assert.match(chatCss, /@media \(prefers-reduced-motion: reduce\) \{\s*\.typing-dots span \{ animation: none;/);
  assert.match(chatHtml, /chat\/messages\.js\?v=20261001-ai-typing-1/);
  assert.match(chatHtml, /chat\/chat\.css\?v=20261001-ai-typing-1/);
  assert.match(serviceWorker, /'\.\/chat\/messages\.js\?v=20261001-ai-typing-1'/);
  assert.match(serviceWorker, /'\.\/chat\/chat\.css\?v=20261001-ai-typing-1'/);
});

test('client notice text matches the server timeout message exactly', () => {
  const text = 'すみません、返事に時間がかかっています。エラーが起きた可能性があるので、もう一度送ってください。';
  const shared = fs.readFileSync(new URL('../supabase/functions/_shared/mtalk_external_post.ts', import.meta.url), 'utf8');
  const sweep = fs.readFileSync(new URL('../supabase/migrations/20261001030000_chat_ai_analysis_reply_timeouts.sql', import.meta.url), 'utf8');
  assert.ok(messagesJs.includes(`const AI_TYPING_TIMEOUT_TEXT = '${text}';`));
  assert.ok(shared.includes(`export const AI_CHAT_GENERIC_ERROR = '${text}'`));
  assert.ok(sweep.includes(`v_text constant text := '${text}';`));
  assert.match(chatCss, /\.message\.ai-typing-notice \.ai-typing-notice-bubble/);
});
