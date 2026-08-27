import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readChatPageSourceSync } from './helpers/chat-page-source.mjs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260826040000_chat_silent_messages.sql', import.meta.url),
  'utf8',
);

const chatPush = fs.readFileSync(
  new URL('../supabase/functions/chat-push/index.ts', import.meta.url),
  'utf8',
);

const chatHtml = readChatPageSourceSync();

test('migration adds is_silent boolean to chat_messages', () => {
  assert.match(migration, /alter table if exists public\.chat_messages/i);
  assert.match(migration, /add column if not exists is_silent boolean not null default false/i);
});

test('chat-push Edge Function respects is_silent and skips Web Push', () => {
  assert.match(chatPush, /is_silent\?: boolean \| null/);
  assert.match(chatPush, /select\([^)]*is_silent[^)]*\)/);
  assert.match(chatPush, /if \(message\.is_silent === true\)/);
  assert.match(chatPush, /silent: true/);
});

test('chat.html includes is_silent in MESSAGE_COLUMNS, renders silent badge and silent toggle', () => {
  assert.match(chatHtml, /MESSAGE_COLUMNS =[^;]*is_silent/);
  assert.match(chatHtml, /msg\.is_silent \? '<span class="silent-mark"/);
  assert.match(chatHtml, /id="silentToggleBtn"/);
  assert.match(chatHtml, /function toggleSilentSend/);
  assert.match(chatHtml, /is_silent: isSilentSendActive === true/);
});

test('chat.html search button opens search launcher modal without sending chat message', () => {
  assert.match(chatHtml, /id="searchLauncherOverlay"/);
  assert.match(chatHtml, /function openSearchLauncher/);
  assert.match(chatHtml, /function triggerMessageSearchFromLauncher/);
  assert.match(chatHtml, /onclick="openSearchLauncher\(\)"/);
});
