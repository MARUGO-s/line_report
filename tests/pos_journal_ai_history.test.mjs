import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const migration = await readFile(new URL('supabase/migrations/20260728115706_pos_journal_ai_analysis_history.sql', root), 'utf8');
const adminApi = await readFile(new URL('supabase/functions/admin-api/index.ts', root), 'utf8');
const page = await readFile(new URL('public/pos-journal.html', root), 'utf8');

test('POS journal AI history table is private and ordered by store/month/creation', () => {
  assert.match(migration, /create table if not exists public\.pos_journal_ai_analyses/);
  assert.match(migration, /facts_snapshot jsonb not null/);
  assert.match(migration, /alter table public\.pos_journal_ai_analyses enable row level security/);
  assert.match(migration, /revoke all on table public\.pos_journal_ai_analyses from anon, authenticated/);
  assert.match(migration, /store_partition_key, year_month, created_at desc, id desc/);
});

test('admin API exposes save-on-analysis, list, get, and confirmed delete', () => {
  assert.match(adminApi, /path === "\/pos-journals\/ai-history"/);
  assert.match(adminApi, /path === "\/pos-journals\/ai-history\/item"/);
  assert.match(adminApi, /confirmation[^\n]+!== "delete"/);
  assert.match(adminApi, /pos_journal_ai_analyses/);
});

test('POS journal page exposes PDF and history actions', () => {
  assert.match(page, /PDFで保存/);
  assert.match(page, /AI分析履歴/);
  assert.match(page, /data-analysis-pdf/);
  assert.match(page, /data-analysis-delete/);
});

test('POS journal page can export the monthly dashboard as one PDF', () => {
  assert.match(page, /id="pagePdfBtn"/);
  assert.match(page, /PDFにまとめる/);
  assert.match(page, /id="pagePrintReport"/);
  assert.match(page, /function pageReportHtml\(/);
  assert.match(page, /function savePagePdf\(/);
  assert.match(page, /print-page-report/);
  assert.match(page, /size:A4 landscape/);
  assert.match(page, /商品ランキング（金額順・上位/);
  assert.match(page, /print-page-1/);
  assert.match(page, /print-page-2/);
  assert.match(page, /margin:18mm 12mm 16mm 12mm/);
  assert.doesNotMatch(page, /pageReportHtml[\s\S]{0,400}pjPanelUpload/);
});

test('Journal Report history tables use deleted_at trash and restore instead of physical delete', async () => {
  const softDeleteMigration = await readFile(
    new URL('supabase/migrations/20260803152607_journal_history_soft_delete.sql', root),
    'utf8',
  );
  for (const table of ['saved_reports', 'sales_forecasts', 'ai_analysis_history', 'ai_chat_pdf_history']) {
    assert.match(softDeleteMigration, new RegExp(`alter table public\\.${table}[\\s\\S]*deleted_at`));
  }
  assert.match(adminApi, /async function restoreJournalHistoryItem/);
  assert.match(adminApi, /\.update\(\{ deleted_at: new Date\(\)\.toISOString\(\)/);
  assert.match(adminApi, /\.update\(\{ deleted_at: null, updated_at:/);
  assert.doesNotMatch(
    adminApi,
    /\.from\("(?:saved_reports|sales_forecasts|ai_analysis_history|ai_chat_pdf_history)"\)\s*\n\s*\.delete\(\)/,
  );
});
