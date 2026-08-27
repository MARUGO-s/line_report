import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(
  new URL('../supabase/migrations/20260909010000_chat_least_privilege_cleanup.sql', import.meta.url),
  'utf8',
);

test('anonymous visitors lose all direct chat table and sequence privileges', () => {
  assert.match(migration, /relname like 'chat\\_%' escape '\\'/i);
  assert.match(migration, /revoke all privileges on table public\.%I from anon/i);
  assert.match(migration, /revoke all privileges on sequence public\.%I from anon/i);
});

test('trigger-only security definer functions are not Data API RPCs', () => {
  for (const name of [
    'chat_prevent_direct_extra_member',
    'chat_protect_admin_notice_room',
    'chat_validate_album_item',
  ]) {
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${name}\\(\\) from public, anon, authenticated`, 'i'),
    );
  }
});

test('store bot UUID derivation has a fixed search path', () => {
  assert.match(
    migration,
    /alter function public\.chat_store_bot_id\(text\) set search_path = pg_catalog/i,
  );
});

test('stopped accounts cannot access Keep or private notes directly', () => {
  for (const policy of [
    'chat_private_notes_select_own',
    'chat_private_notes_delete_own',
    'chat_keep_items_select_own',
    'chat_keep_items_insert_own',
    'chat_keep_items_update_own',
    'chat_keep_items_delete_own',
  ]) {
    const start = migration.indexOf(`create policy ${policy}`);
    assert.ok(start >= 0, `${policy} must be recreated`);
    const end = migration.indexOf(';', start);
    assert.match(migration.slice(start, end + 1), /chat_has_active_access\(\)/i);
  }
});
