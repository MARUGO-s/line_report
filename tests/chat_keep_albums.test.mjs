import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
const chat = fs.readFileSync(new URL('public/chat.html', root), 'utf8');
const migration = fs.readFileSync(new URL('supabase/migrations/20260827010000_chat_keep_and_albums.sql', root), 'utf8');

test('Keepメモ is private and exposed through the chat composer', () => {
  assert.match(migration, /create table if not exists public\.chat_keep_items/);
  assert.match(migration, /chat_keep_items_select_own[\s\S]*user_id = \(select auth\.uid\(\)\)/);
  assert.match(chat, /id="keepOverlay"/);
  assert.match(chat, /function openKeepMemo\(\)/);
  assert.match(chat, /from\('chat_keep_items'\)/);
});

test('Albums are scoped to a room and can only contain same-room image messages', () => {
  assert.match(migration, /create table if not exists public\.chat_albums/);
  assert.match(migration, /create table if not exists public\.chat_album_items/);
  assert.match(migration, /chat_validate_album_item/);
  assert.match(migration, /msg_kind <> 'image'/);
  assert.match(migration, /msg_group <> new\.group_id/);
  assert.match(chat, /id="albumOverlay"/);
  assert.match(chat, /function openAlbumManager\(\)/);
  assert.match(chat, /from\('chat_album_items'\)/);
});

test('Album images use signed URLs instead of exposing the private storage path', () => {
  assert.match(chat, /createSignedUrls\(missing, 3600\)/);
  assert.match(chat, /from\('chat-images'\)/);
  assert.match(migration, /storage_path ~ '\^groups\//);
  assert.match(chat, /function downloadImage\(src\)/);
  assert.match(chat, /画像を開く/);
});
