import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260902010000_chat_message_edits.sql', import.meta.url),
  'utf8',
);

const chatHtml = fs.readFileSync(
  new URL('../public/chat.html', import.meta.url),
  'utf8',
);

const helpManual = fs.readFileSync(
  new URL('../supabase/functions/_shared/mtalk_help_manual.ts', import.meta.url),
  'utf8',
);

test('migration lets the author update text, freezes protected columns, and skips trash rooms', () => {
  assert.match(migration, /add column if not exists edited_at timestamptz/i);
  assert.match(migration, /alter table public\.chat_messages replica identity full/i);
  assert.match(migration, /before insert or update on public\.chat_messages/i);
  assert.match(migration, /create policy chat_messages_update_own on public\.chat_messages/i);
  assert.match(migration, /chat_can_send_group\(group_id\)/i);
  assert.match(migration, /new\.kind := old\.kind/i);
  assert.match(migration, /new\.payload := old\.payload/i);
  assert.match(migration, /new\.user_id := old\.user_id/i);
  assert.match(migration, /new\.is_silent := old\.is_silent/i);
  assert.match(migration, /このメッセージは編集できません/);
  assert.match(migration, /new\.edited_at := now\(\)/i);
  assert.match(migration, /add column if not exists edit_history jsonb/i);
  assert.match(migration, /new\.edit_history := v_hist/i);
  assert.match(migration, /v_hist := coalesce\(old\.edit_history/i);
  assert.doesNotMatch(migration, /chat-push|enqueue_knowledge|enqueue_push/i);
});

test('chat.html can edit own text in the composer without sending a new message', () => {
  assert.match(chatHtml, /MESSAGE_COLUMNS =[^;]*edit_history/);
  assert.match(chatHtml, /function renderStruckEditHistory/);
  assert.match(chatHtml, /class="edit-original"/);
  assert.match(chatHtml, /event: 'UPDATE', schema: 'public', table: 'chat_messages'/);
  assert.match(chatHtml, /function handleUpdatedMessage/);
  assert.match(chatHtml, /function startMessageEdit/);
  assert.match(chatHtml, /function saveEditedMessage/);
  assert.match(chatHtml, /data-action="edit"/);
  assert.match(chatHtml, /msg\.edited_at \? '<span class="edited-mark">編集済み<\/span>'/);
  assert.match(chatHtml, /\.update\(\{\s*content: text,\s*mentions: collectMentions\(text\)/);
  const saveStart = chatHtml.indexOf('async function saveEditedMessage');
  const saveEnd = chatHtml.indexOf('async function openForward', saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  assert.doesNotMatch(chatHtml.slice(saveStart, saveEnd), /dispatchPushForMessage/);
});

test('help text no longer says messages cannot be edited', () => {
  assert.match(helpManual, /直す前の文章は取り消し線で残し/);
  assert.match(helpManual, /自分の発言は、メニューの「編集」から本文を直せます/);
  assert.doesNotMatch(helpManual, /送信済みの内容は編集できません/);
});
