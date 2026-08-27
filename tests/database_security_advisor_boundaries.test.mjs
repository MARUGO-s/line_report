import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(
  new URL('../supabase/migrations/20260909050000_harden_security_advisor_boundaries.sql', import.meta.url),
  'utf8',
);

test('foodcourt feature view cannot bypass caller RLS or public grants', () => {
  assert.match(
    migration,
    /alter view public\.foodcourt_daily_features\s+set \(security_invoker = true\)/i,
  );
  assert.match(
    migration,
    /revoke all privileges on table public\.foodcourt_daily_features\s+from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant select on table public\.foodcourt_daily_features\s+to service_role/i,
  );
});

test('reservation parser and PV cron pin search_path and reject browser roles', () => {
  for (const signature of [
    'reservation_visit_extract_reservation_no\\(text\\)',
    'invoke_pv_japan_alert_cron\\(\\)',
  ]) {
    assert.match(
      migration,
      new RegExp(`alter function public\\.${signature}\\s+set search_path = pg_catalog`, 'i'),
    );
    assert.match(
      migration,
      new RegExp(`revoke execute on function public\\.${signature}\\s+from public, anon, authenticated`, 'i'),
    );
    assert.match(
      migration,
      new RegExp(`grant execute on function public\\.${signature}\\s+to postgres, service_role`, 'i'),
    );
  }
});
