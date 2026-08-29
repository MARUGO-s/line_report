import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readChatPageSourceSync } from './helpers/chat-page-source.mjs';

const chatSource = readChatPageSourceSync();
const reactionsMigration = fs.readFileSync(
  new URL('../supabase/migrations/20260819190000_chat_reactions_replies_mentions.sql', import.meta.url),
  'utf8',
);

test('同じルームのメンバーが互いの既読を読めるRLSが残っている', () => {
  assert.match(reactionsMigration, /create policy chat_read_states_select_member on public\.chat_read_states/);
});

test('ルームを開いたら自分の既読位置を chat_read_states へ書き込む', () => {
  assert.match(chatSource, /sb\.from\('chat_read_states'\)\s*\.upsert\(\{/);
});

test('既読数と既読メンバー一覧は同じ条件を使う', () => {
  assert.match(chatSource, /function readersFor\(msg\)/);
  assert.match(chatSource, /row\.user_id !== currentUser\.id && new Date\(row\.last_read_at\)\.getTime\(\) >= sentAt/);
  assert.match(chatSource, /function readCountFor\(msg\) \{\s*return readersFor\(msg\)\.length;\s*\}/);
  assert.match(chatSource, /const readers = readersFor\(msg\);/);
});

test('既読マークは自分の発言にだけあり、押すと内訳を開く', () => {
  assert.match(chatSource, /\$\{isOwn \? readMarkHtml\(msg\) : ''\}/);
  assert.match(chatSource, /<button type="button" class="read-mark" data-read-for="\$\{msg\.id\}"/);
  assert.match(chatSource, /onclick="openReadDetails\(this\.dataset\.readFor\)"/);
  assert.match(chatSource, /const readMark = e\.target\.closest\('\.read-mark'\);/);
  assert.match(chatSource, /openReadDetails\(Number\(readMark\.dataset\.readFor\)\)/);
});

test('既読者表示用の公開ファイルは更新時にキャッシュを回避する', () => {
  assert.match(chatSource, /chat\/messages\.js\?v=20260829-read-receipts-2/);
  assert.match(chatSource, /chat\/bootstrap\.js\?v=20260829-read-receipts-2/);
  assert.match(chatSource, /chat\/chat\.css\?v=20260829-read-receipts-2/);
});

test('既読メンバー一覧は閉じられ、名前と既読時刻を表示する', () => {
  assert.match(chatSource, /id="readDetailOverlay"/);
  assert.match(chatSource, /function closeReadDetails\(\)/);
  assert.match(chatSource, /const name = user \? personName\(user\) : '退出したユーザー';/);
  assert.match(chatSource, /class="read-detail-time">\$\{escapeHtml\(formatTalkTime\(row\.last_read_at\)\)\}/);
});

test('既読者一覧は新しく読んだ人から順に出す', () => {
  assert.match(
    chatSource,
    /\.sort\(\(a, b\) => new Date\(b\.last_read_at\)\.getTime\(\) - new Date\(a\.last_read_at\)\.getTime\(\)\)/,
  );
});
