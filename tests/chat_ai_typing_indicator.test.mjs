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

test('typing candidate: own recent text shows, bot reply / old / non-text hides', () => {
  const { aiTypingCandidate } = pureContext();
  const now = Date.parse('2026-10-01T03:00:00Z');
  const mine = { id: 10, user_id: ME, kind: 'text', content: '先月のPVは？', created_at: '2026-10-01T02:59:30Z' };
  assert.deepEqual({ ...aiTypingCandidate([mine], ME, now, null) }, { id: 10, remainingMs: 90000 });
  // bot reply after the question → hidden
  const reply = { id: 11, user_id: BOT, kind: 'text', content: '回答', created_at: '2026-10-01T02:59:50Z' };
  assert.equal(aiTypingCandidate([mine, reply], ME, now, null), null);
  // 120s timeout
  assert.equal(aiTypingCandidate([{ ...mine, created_at: '2026-10-01T02:57:59Z' }], ME, now, null), null);
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
  assert.equal(aiTypingCandidate([skewed], ME, now, { id: 10, at: now - 1000 }).remainingMs, 119000);
});

class FakeNode {
  constructor(className = '') { this.className = className; this.children = []; this.parent = null; this.attrs = {}; this.innerHTML = ''; }
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
    'let aiTypingTimer = null; let aiTypingMessageId = null; let aiTypingExpiredMessageId = null; let aiTypingLiveMessage = null;',
    ...['isAiAnalysisRoom', 'aiTypingCandidate', 'buildAiTypingNode', 'hideAiTyping', 'syncAiTyping']
      .map((name) => extractFunction(messagesJs, name)),
    'this.syncAiTyping = syncAiTyping; this.hideAiTyping = hideAiTyping;',
    'this.setMessages = (list) => { currentMessages = list; };',
  ].join('\n'), context);
  return { context, list, timers };
}

test('typing bubble stays last, hides on bot reply, and expires after the timeout', () => {
  const now = { value: Date.parse('2026-10-01T03:00:00Z') };
  const group = { is_direct: true, peer: { id: BOT, username: 'AI分析' } };
  const q = { id: 1, user_id: ME, kind: 'text', content: '質問', created_at: '2026-10-01T03:00:00Z' };
  const { context, list, timers } = domContext({ group, messages: [q], now });
  list.appendChild(new FakeNode('message own'));
  context.syncAiTyping();
  assert.equal(list.children.at(-1).className, 'message ai-typing');
  assert.equal(list.children.at(-1).attrs.role, 'status');
  assert.match(list.children.at(-1).innerHTML, /typing-dots/);
  assert.match(list.children.at(-1).innerHTML, /AI分析/);
  assert.equal(timers.at(-1).ms, 120000);
  // another render keeps a single bubble at the end without restarting the timer
  list.appendChild(new FakeNode('message own'));
  context.syncAiTyping();
  assert.equal(list.querySelectorAll('.ai-typing').length, 1);
  assert.equal(list.children.at(-1).className, 'message ai-typing');
  assert.equal(timers.length, 1);
  // bot reply arrives → hidden
  context.setMessages([q, { id: 2, user_id: BOT, kind: 'text', content: '回答', created_at: '2026-10-01T03:00:20Z' }]);
  context.syncAiTyping();
  assert.equal(list.querySelectorAll('.ai-typing').length, 0);
  assert.equal(timers[0].cleared, true);

  // new question, then timeout fires → hidden and not re-shown for the same question
  const q2 = { id: 3, user_id: ME, kind: 'text', content: '続き', created_at: '2026-10-01T03:01:00Z' };
  now.value = Date.parse('2026-10-01T03:01:00Z');
  context.setMessages([q, q2]);
  context.syncAiTyping();
  assert.equal(list.querySelectorAll('.ai-typing').length, 1);
  timers.at(-1).fn();
  assert.equal(list.querySelectorAll('.ai-typing').length, 0);
  context.syncAiTyping();
  assert.equal(list.querySelectorAll('.ai-typing').length, 0);
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
