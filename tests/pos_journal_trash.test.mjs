import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const adminApi = await readFile(
  new URL('../supabase/functions/admin-api/index.ts', import.meta.url),
  'utf8',
);
const migration = await readFile(
  new URL('../supabase/migrations/20261126204000_pos_journal_trash.sql', import.meta.url),
  'utf8',
);
const ownership = JSON.parse(
  await readFile(new URL('../knowledge/supabase-ownership.json', import.meta.url), 'utf8'),
);

test('pos_journal_trash migration enables RLS, revokes browser roles, and records trashed_at', () => {
  assert.match(migration, /create table if not exists public\.pos_journal_trash/i);
  assert.match(migration, /trashed_at timestamptz not null default now\(\)/i);
  assert.match(migration, /enable row level security/i);
  assert.match(
    migration,
    /revoke all on table public\.pos_journal_trash from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant select, insert, update, delete on table public\.pos_journal_trash to service_role/i,
  );
  assert.ok(ownership.journalReportTables.includes('pos_journal_trash'));
});

test('admin-api registers /pos-journals/trash routes with store scope protection and confirmation', () => {
  assert.ok(adminApi.includes('"/pos-journals/trash"'));
  assert.ok(adminApi.includes('"/pos-journals/trash/item"'));
  assert.match(adminApi, /req\.method === "GET" && path === "\/pos-journals\/trash"/);
  assert.match(adminApi, /req\.method === "POST" && path === "\/pos-journals\/trash"/);
  assert.match(adminApi, /req\.method === "PATCH" && path === "\/pos-journals\/trash\/item"/);

  const moveStart = adminApi.indexOf('async function movePosJournalItemToTrash(');
  const handleStart = adminApi.indexOf('async function handlePosJournalTrashItemAction(');
  assert.notEqual(moveStart, -1);
  assert.notEqual(handleStart, -1);

  const moveBody = adminApi.slice(moveStart, handleStart);
  assert.match(moveBody, /他店舗のデータにはアクセスできません/);
  assert.match(moveBody, /trashed_at: trashedAt/);
  // ゴミ箱移動時に Storage を削除しないこと
  assert.doesNotMatch(moveBody, /\.storage\.from\(/);

  const handleBody = adminApi.slice(handleStart, handleStart + 9000);
  assert.match(handleBody, /他店舗のデータにはアクセスできません/);
  assert.match(handleBody, /action === "purge" && String\(body\.confirmation \?\? ""\) !== "delete"/);
  assert.match(handleBody, /storage\.from\(/);
});
