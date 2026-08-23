import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../supabase/migrations/20260821160000_chat_history_since_join.sql', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../public/chat.html', import.meta.url), 'utf8');
const singleReactionMigration = readFileSync(
  new URL('../supabase/migrations/20260821235500_chat_single_reaction_per_user.sql', import.meta.url),
  'utf8'
);

test('message visibility starts at each membership joined_at', () => {
  assert.match(migration, /p_created_at >= gm\.joined_at/);
  assert.match(migration, /create policy chat_messages_select_since_join/);
  assert.match(migration, /using \(public\.chat_can_read_message\(group_id, created_at\)\)/);
});

test('reactions and unread counters exclude pre-join messages', () => {
  assert.match(migration, /m\.created_at >= gm\.joined_at/g);
  assert.match(migration, /create or replace function public\.chat_is_member_of_message/);
  assert.match(migration, /create or replace function public\.chat_unread_counts/);
  assert.match(migration, /create or replace function public\.chat_push_unread_totals/);
});

test('each user has only one reaction per message and a new emoji replaces it', () => {
  assert.match(singleReactionMigration, /primary key \(message_id, user_id\)/i);
  assert.match(singleReactionMigration, /create policy chat_reactions_update_self/i);
  assert.match(chat, /const removing = mine && mine\.emoji === emoji/);
  assert.match(chat, /list\.filter\(\(r\) => r\.user_id !== currentUser\.id\)\.concat/);
  assert.match(chat, /onConflict: 'message_id,user_id'/);
});

test('chat loads only the latest page, then paginates upward and caches room views in memory', () => {
  assert.match(chat, /const MESSAGE_PAGE_SIZE = 50/);
  assert.match(chat, /\.order\('created_at', \{ ascending: false \}\)\s*\.limit\(MESSAGE_PAGE_SIZE\)/);
  assert.match(chat, /if \(el\.scrollTop < 120\) loadOlderMessages\(\)/);
  assert.match(chat, /const ROOM_VIEW_CACHE_LIMIT = 12/);
  assert.match(chat, /const roomViewCache = new Map\(\)/);
});

test('visible last message is pulled down to remove the gap above the composer', () => {
  assert.match(chat, /function removeVisibleMessageBottomGap\(\)/);
  assert.match(chat, /querySelector\('\.message:last-of-type'\)/);
  assert.match(chat, /const gap = viewport\.bottom - last\.bottom - 16/);
  assert.match(chat, /messages\.scrollTop \+= gap/);
});
