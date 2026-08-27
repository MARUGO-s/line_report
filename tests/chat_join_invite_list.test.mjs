import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chat = readFileSync(new URL('../public/chat.html', import.meta.url), 'utf8');

test('unjoined group list asks for an invite link instead of joining by id', () => {
  assert.match(chat, /未参加のグループ/);
  assert.doesNotMatch(chat, />参加できるグループ</);
  assert.match(chat, /button\.textContent = '招待で参加'/);
  assert.match(chat, /function extractInviteToken/);
  assert.match(chat, /async function joinGroup\(groupId\)/);
  assert.match(chat, /chat_join_by_invite/);
  assert.match(chat, /url\.searchParams\.get\('invite'\)/);
  assert.doesNotMatch(chat, /alert\('グループへの参加にはメンバーから届いた招待リンクを使用してください'\)/);
  assert.doesNotMatch(chat, /rpc\('chat_join_group'/);
});
