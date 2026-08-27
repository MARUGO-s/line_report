import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(
  new URL('../supabase/migrations/20260909040000_lock_public_write_policies.sql', import.meta.url),
  'utf8',
);

test('weekly business reports are service-role only', () => {
  assert.match(
    migration,
    /create policy service_role_all on public\.foodcourt_weekly_reports\s+for all to service_role/i,
  );
  assert.match(
    migration,
    /revoke all privileges on table public\.foodcourt_weekly_reports\s+from public, anon, authenticated/i,
  );
  assert.doesNotMatch(
    migration,
    /grant\s+(?:all|select|insert|update|delete)[^;]*foodcourt_weekly_reports[^;]*\b(?:anon|authenticated)\b/i,
  );
});

test('public game facts stay readable but only the backend can write them', () => {
  assert.match(
    migration,
    /create policy "Allow public read" on public\.giants_game_results\s+for select to anon, authenticated/i,
  );
  assert.match(
    migration,
    /create policy "Allow system write" on public\.giants_game_results\s+for all to service_role/i,
  );
  assert.match(
    migration,
    /revoke all privileges on table public\.giants_game_results\s+from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant select on table public\.giants_game_results\s+to anon, authenticated/i,
  );
});
