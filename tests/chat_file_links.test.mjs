import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
const chat = fs.readFileSync(new URL('public/chat.html', root), 'utf8');
const migration = fs.readFileSync(new URL('supabase/migrations/20260828010000_chat_file_attachments.sql', root), 'utf8');

test('M-talk accepts private office/document attachments and renders signed downloads', () => {
  assert.match(migration, /chat_messages_kind_check[\s\S]*'file'/);
  assert.match(migration, /application\/pdf/);
  assert.match(migration, /chat_set_message_author/);
  assert.match(chat, /id="chatImageInput"[\s\S]*application\/pdf/);
  assert.match(chat, /function uploadChatFile\(file, groupId\)/);
  assert.match(chat, /kind: 'file'/);
  assert.match(chat, /function hydrateMessageFiles\(\)/);
  assert.match(chat, /class="file-attachment"/);
});

test('text messages turn safe http(s) URLs into link preview cards', () => {
  assert.match(chat, /function firstMessageUrl\(content\)/);
  assert.match(chat, /function renderLinkPreview\(content\)/);
  assert.match(chat, /class="link-preview"/);
  assert.match(chat, /rel="noopener noreferrer"/);
  assert.match(chat, /safeHttpUrl\(match\[0\]/);
});
