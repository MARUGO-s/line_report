import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(
  new URL('../supabase/migrations/20260909010000_chat_least_privilege_cleanup.sql', import.meta.url),
  'utf8',
);
const policyHelperFix = await readFile(
  new URL('../supabase/migrations/20260909020000_chat_keep_private_active_policy_helper.sql', import.meta.url),
  'utf8',
);
const internalHelperPrivileges = await readFile(
  new URL('../supabase/migrations/20260909060000_revoke_authenticated_chat_internal_helpers.sql', import.meta.url),
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
    const start = policyHelperFix.indexOf(`create policy ${policy}`);
    assert.ok(start >= 0, `${policy} must be recreated`);
    const end = policyHelperFix.indexOf(';', start);
    const statement = policyHelperFix.slice(start, end + 1);
    assert.match(statement, /chat_is_registered\(\)/i);
    assert.doesNotMatch(statement, /chat_has_active_access\(\)/i);
  }
});

test('Keep and private-note policies use the authenticated-safe access wrapper', () => {
  assert.match(
    policyHelperFix,
    /chat_has_active_access\(uuid\).*service_role-only/is,
  );
  assert.match(
    policyHelperFix,
    /chat_is_registered\(\).*auth\.uid\(\)/is,
  );
});

test('internal chat helpers cannot be called directly with a browser JWT', () => {
  for (const signature of [
    'chat_can_browse_users\\(\\)',
    'chat_is_member\\(bigint\\)',
    'chat_is_member_path\\(text\\)',
    'chat_is_signup_manager\\(uuid\\)',
    'chat_normalize_store_keys\\(text\\[\\]\\)',
    'chat_shares_affiliation\\(uuid, uuid\\)',
    'chat_store_display_names\\(text\\[\\]\\)',
    'chat_user_can_join_group_by_store\\(bigint, uuid\\)',
    'chat_user_store_keys\\(uuid\\)',
  ]) {
    assert.match(
      internalHelperPrivileges,
      new RegExp(`revoke execute on function public\\.${signature}\\s+from public, anon, authenticated`, 'i'),
    );
    assert.match(
      internalHelperPrivileges,
      new RegExp(`grant execute on function public\\.${signature}\\s+to postgres, service_role`, 'i'),
    );
  }
});

test('reviewed browser RPCs and RLS gates remain available to authenticated users', () => {
  for (const signature of [
    'chat_create_group',
    'chat_open_direct',
    'chat_can_view_group',
    'chat_can_send_group',
  ]) {
    assert.doesNotMatch(
      internalHelperPrivileges,
      new RegExp(`revoke execute on function public\\.${signature}\\(`, 'i'),
    );
  }
});
