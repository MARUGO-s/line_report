import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../supabase/functions/admin-api/index.ts", import.meta.url),
  "utf8",
);

function sectionBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must exist after ${startMarker}`);
  return source.slice(start, end);
}

const scanner = sectionBetween(
  "async function scanPosJournalParsedRows(",
  "/**\n * 店舗の全電子ジャーナル",
);
const productSearch = sectionBetween(
  "async function searchPosJournalProducts(",
  "type CohortBucket =",
);
const cohortSearch = sectionBetween(
  "async function comparePosJournalCohortsGeneral(",
  "/**\n * 対象商品を含む会計",
);

test("raw journal scans use an ascending id cursor until an empty page", () => {
  assert.match(source, /from "\.\.\/_shared\/paged_row_scan\.ts"/);
  assert.match(scanner, /scanRowsByAscendingId/);
  assert.match(scanner, /\.gt\("id", afterId\)/);
  assert.match(scanner, /\.order\("id", \{ ascending: true \}\)/);
  assert.match(scanner, /\.limit\(pageSize\)/);
  assert.match(scanner, /POS_JOURNAL_SCAN_MAX_ROWS/);
});

test("product timeline and every cohort comparison share the paged scanner", () => {
  assert.match(productSearch, /scanPosJournalParsedRows/);
  assert.match(productSearch, /scanned_files: scan\.scannedRows/);
  assert.doesNotMatch(productSearch, /\.from\("pos_journal_files"\)/);

  assert.match(cohortSearch, /scanPosJournalParsedRows/);
  assert.match(cohortSearch, /scanned_files: scan\.scannedRows/);
  assert.doesNotMatch(cohortSearch, /\.from\("pos_journal_files"\)/);
});

test("cohort month bounds are applied by the database before paging", () => {
  assert.match(scanner, /if \(monthFrom\) query = query\.gte\("year_month", monthFrom\)/);
  assert.match(scanner, /if \(monthTo\) query = query\.lte\("year_month", monthTo\)/);
  assert.match(cohortSearch, /monthFrom,\s*\n\s*monthTo,/);
});

test("paging failures are surfaced as errors instead of partial aggregates", () => {
  assert.match(scanner, /catch \(error\)/);
  assert.match(scanner, /status: 500/);
  assert.match(scanner, /errorLabel/);
});
