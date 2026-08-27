import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(
  new URL('../supabase/migrations/20260909030000_revoke_authenticated_internal_rpcs.sql', import.meta.url),
  'utf8',
);

const internalFunctions = [
  ['ai_usage_model_totals', 'timestamptz, timestamptz'],
  ['ai_usage_surface_model_totals', 'timestamptz, timestamptz, text, text'],
  ['ai_usage_time_series', 'timestamptz, timestamptz, text'],
  ['cleanup_cron_job_run_history', 'interval, integer'],
  ['hide_cancelled_partner_reservation_events', ''],
  ['invoke_high_frequency_dispatcher_cron', ''],
  ['invoke_tokyo_dome_events_cron', ''],
  ['invoke_weather_daily_cron', ''],
  ['rebuild_partner_reservation_summary', 'text, text, text'],
];

test('M-talk JWTs cannot execute internal admin, usage, trigger, or cron routines', () => {
  for (const [name, args] of internalFunctions) {
    const signature = `${name}\\(${args.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`;
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${signature}\\s+from public, anon, authenticated`, 'i'),
      `${name} must not be a browser RPC`,
    );
  }
});

test('internal callers retain only the execution grants they need', () => {
  for (const [name] of internalFunctions) {
    assert.match(
      migration,
      new RegExp(`grant execute on function public\\.${name}\\(`, 'i'),
      `${name} must retain an internal execution path`,
    );
  }
  assert.match(migration, /invoke_high_frequency_dispatcher_cron\(\)[\s\S]*?to postgres, service_role/i);
  assert.match(migration, /ai_usage_model_totals\([^)]+\)[\s\S]*?to service_role/i);
});
