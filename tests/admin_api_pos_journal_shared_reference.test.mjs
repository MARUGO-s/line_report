import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const adminApi = await readFile(
  new URL("supabase/functions/admin-api/index.ts", root),
  "utf8",
);
const page = await readFile(new URL("public/pos-journal.html", root), "utf8");
const journalReport = await readFile(
  new URL("public/jnm/jnl2txt.html", root),
  "utf8",
);

test("POS journal state shares Journal Report saved reports without double counting dates", () => {
  assert.match(adminApi, /fetchSharedJournalReportState/);
  assert.match(adminApi, /\.from\("saved_reports"\)/);
  assert.match(adminApi, /savedReportCandidateMatchesMonth/);
  assert.match(adminApi, /buildPosJournalDaysFromSavedReports/);
  assert.match(adminApi, /const storedDateSet = new Set/);
  assert.match(adminApi, /!storedDateSet\.has\(day\.business_date\)/);
  assert.match(adminApi, /storage_mode = rows\.length && sharedOnlyDays\.length/);
});

test("POS journal AI uses the same shared report merge as the screen", () => {
  const start = adminApi.indexOf("async function resolvePosJournalAiSummary(");
  assert.notEqual(start, -1);
  const body = adminApi.slice(start, start + 2500);
  assert.match(body, /fetchSharedJournalReportState/);
  assert.match(body, /const combinedDays = \[/);
  assert.match(body, /!storedDateSet\.has\(day\.business_date\)/);
  assert.match(body, /days: combinedDays/);
});

test("POS journal page renders shared-only months and explains the source", () => {
  assert.match(page, /id="sharedRefNotice"/);
  assert.match(page, /function renderSharedReference\(state\)/);
  assert.match(page, /Journal Reportで登録した同店舗・同月の保存済みレポートを共有参照/);
  assert.match(page, /var sharedDays=state\.summary&&Array\.isArray\(state\.summary\.days\)/);
  assert.match(page, /if \(\(state\.files\|\|\[\]\)\.length \|\| sharedDays\) render/);
});

test("Journal Report preserves a shared day snapshot when large sales are omitted", () => {
  assert.match(journalReport, /function buildSharedPosJournalDays\(report\)/);
  assert.match(journalReport, /posJournalDays = buildSharedPosJournalDays\(r\)/);
  assert.match(journalReport, /if \(posJournalDays\.length\) data\.posJournalDays = posJournalDays/);
});
