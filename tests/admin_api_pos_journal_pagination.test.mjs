import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../supabase/functions/admin-api/index.ts", import.meta.url),
  "utf8",
);
const coverageMigration = await readFile(
  new URL(
    "../supabase/migrations/20260910080000_journal_product_detail_coverage.sql",
    import.meta.url,
  ),
  "utf8",
);
const productIndexSource = await readFile(
  new URL(
    "../supabase/functions/_shared/journal_product_index.ts",
    import.meta.url,
  ),
  "utf8",
);
const backfillSource = await readFile(
  new URL("../scripts/backfill-pos-journal-v22.mjs", import.meta.url),
  "utf8",
);
const storeLinkPolicy = source.slice(
  source.indexOf("const STORE_LINK_ALLOWED_REQUESTS"),
  source.indexOf("const CRON_ALLOWED_REQUESTS"),
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
  assert.match(productSearch, /extractNetProductItemsFromReceipt/);
  assert.doesNotMatch(productSearch, /\.from\("pos_journal_files"\)/);

  assert.match(cohortSearch, /scanPosJournalParsedRows/);
  assert.match(cohortSearch, /scanned_files: scan\.scannedRows/);
  assert.match(
    source,
    /function addReceiptToCohort[\s\S]*?extractNetProductItemsFromReceipt/,
  );
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

test("all product and cohort paths share the gross-sales reconciliation gate", () => {
  assert.match(scanner, /gross_sales, groups_count/);
  assert.match(scanner, /reconcileParsedJournalDayDetail/);
  assert.match(scanner, /summarizeJournalProductDetailCoverage/);
  assert.match(productSearch, /reconcilePosJournalParsedRow\(row\)/);
  assert.match(productSearch, /if \(!detail\.detail_complete\) continue/);
  assert.match(productSearch, /detail_coverage:/);
  assert.match(cohortSearch, /reconcilePosJournalParsedRow\(row\)/);
  assert.match(cohortSearch, /if \(!detail\.detail_complete\) continue/);
  assert.match(cohortSearch, /detail_coverage:/);
});

test("dirty or legacy derived indexes fail over to safe live scans", () => {
  assert.match(scanner, /journal_product_detail_coverage/);
  assert.match(scanner, /dryRun/);
  assert.match(source, /journal_product_index_dirty_months/);
  assert.match(source, /if \(\(dirtyCount \|\| 0\) > 0\) return false/);
  assert.match(coverageMigration, /insert into public\.journal_product_index_dirty_months/);
  assert.match(coverageMigration, /from public\.pos_journal_files/);
  const beforeAtomicSnapshotFunction = coverageMigration.slice(
    0,
    coverageMigration.indexOf("create or replace function public.apply_journal_product_index_snapshot"),
  );
  assert.doesNotMatch(beforeAtomicSnapshotFunction, /delete from public\.journal_product_monthly_index/);
});

test("coverage policy and item mismatch columns match the database contract", () => {
  const policy = "receipt_and_item_totals_match_gross_sales";
  assert.match(productIndexSource, new RegExp(policy));
  assert.match(source, new RegExp(policy));
  assert.match(coverageMigration, new RegExp(policy));
  for (const column of [
    "gross_mismatch_days",
    "item_mismatch_days",
    "item_mismatch_receipts",
  ]) {
    assert.match(productIndexSource, new RegExp(column));
    assert.match(source, new RegExp(column));
    assert.match(coverageMigration, new RegExp(column));
  }
});

test("same-file uploads are reparsed when the parser version is stale", () => {
  assert.match(source, /isPosJournalStaleParserRow/);
  assert.match(source, /POS_JOURNAL_REPORT_PARSER_VERSION/);
  assert.match(
    source,
    /isPosJournalPlaceholderRow\(existingHash as Record<string, unknown>\) \|\|\s*isPosJournalStaleParserRow/,
  );
});

test("stored originals have an admin-only bounded reparse and derived rebuild route", () => {
  assert.match(source, /POST" && path === "\/pos-journals\/reparse/);
  assert.doesNotMatch(storeLinkPolicy, /\/pos-journals\/reparse/);
  assert.match(source, /POS_JOURNAL_REPARSE_MAX_FILES = 20/);
  assert.match(source, /\.download\(storagePath\)/);
  assert.match(source, /Storage原本のハッシュがDB記録と一致しません/);
  assert.match(source, /delete payload\.uploaded_at/);
  assert.match(source, /rebuildJournalProductIndexMonth\(supabase, storeKey, month\)/);
  assert.match(source, /upsertPosJournalAutoReports/);
  assert.match(source, /next_after_id: retryRequired \? afterId : lastId/);
  assert.match(source, /has_more: retryRequired \|\| allRows\.length > limit/);
  assert.match(source, /retry_after_id: retryRequired \? afterId : null/);
  assert.match(source, /journalProductMonthHasUnsafeParserRows/);
  assert.match(source, /isPosJournalStaleParserRow\(row\)/);
  assert.match(source, /isPosJournalDetailMismatchRow\(row\)/);
  assert.match(source, /markJournalProductIndexMonthDirty/);
  assert.match(
    source,
    /if \(options\.dryRun !== true\)[\s\S]*?markJournalProductIndexMonthDirty/,
  );
  assert.match(source, /pending_reparse_months: pendingReparseMonths/);
  assert.match(source, /safe_rebuild_months: safeRebuildMonths/);
});

test("server maintenance accepts current server keys without opening store-link access", () => {
  const maintenanceBridge = sectionBetween(
    "デプロイ後の原本再解析・派生index再構築",
    "// M-talk のルーム完全削除",
  );
  assert.match(maintenanceBridge, /x-internal-key/);
  assert.match(maintenanceBridge, /isInternalSupabaseServerKey\(internalKey\)/);
  assert.match(maintenanceBridge, /reparseStoredPosJournalFiles\(supabase, body, null\)/);
  assert.match(maintenanceBridge, /rebuildJournalProductMonthlyIndex\(supabase, body, null\)/);
  assert.doesNotMatch(storeLinkPolicy, /\/pos-journals\/reparse/);

  const internalKeyVerifier = sectionBetween(
    "function isInternalSupabaseServerKey(",
    "async function parseJson(",
  );
  assert.match(internalKeyVerifier, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(internalKeyVerifier, /SUPABASE_SECRET_KEYS/);
  assert.match(internalKeyVerifier, /JSON\.parse\(secretKeysJson\)/);
  assert.match(internalKeyVerifier, /parsed\.default/);
  assert.match(internalKeyVerifier, /defaultKey\.startsWith\("sb_secret_"\)/);
  assert.doesNotMatch(internalKeyVerifier, /Object\.values\(parsed\)/);
  assert.match(internalKeyVerifier, /secureEqual\(candidate, expected\)/);
});

test("POS journal store keys are canonical lowercase", () => {
  assert.match(
    source,
    /function normalizePosJournalStoreKey[\s\S]*?trim\(\)\.toLowerCase\(\)/,
  );
});

test("product index rebuild applies only its own dirty snapshot transaction", () => {
  const rebuild = sectionBetween(
    "async function rebuildJournalProductIndexMonth(",
    "async function rebuildJournalProductMonthlyIndex(",
  );
  assert.match(
    rebuild,
    /dirtyMarker = await markJournalProductIndexMonthDirty/,
  );
  assert.match(rebuild, /\.rpc\("apply_journal_product_index_snapshot"/);
  assert.match(rebuild, /p_expected_touched_at: dirtyMarker/);
  assert.match(rebuild, /p_index_rows: aggregated/);
  assert.match(rebuild, /dirty_cleared: applied/);
  assert.match(rebuild, /stale_snapshot: !applied/);
  assert.doesNotMatch(rebuild, /\.from\("journal_product_monthly_index"\)[\s\S]*?\.delete\(\)/);
  assert.match(
    source,
    /markJournalProductIndexMonthDirty[\s\S]*?\.rpc\("touch_journal_product_index_dirty_month"[\s\S]*?return storedMarker/,
  );

  assert.match(coverageMigration, /create or replace function public\.touch_journal_product_index_dirty_month/);
  assert.match(coverageMigration, /journal_product_index_dirty_months\.touched_at \+ interval '1 microsecond'/);
  assert.match(coverageMigration, /create or replace function public\.mark_journal_product_index_dirty_month[\s\S]*?perform public\.touch_journal_product_index_dirty_month/);
  assert.match(coverageMigration, /create or replace function public\.apply_journal_product_index_snapshot/);
  assert.match(coverageMigration, /pg_advisory_xact_lock/);
  assert.match(coverageMigration, /select dirty\.touched_at[\s\S]*?for update/);
  assert.match(coverageMigration, /current_marker is distinct from p_expected_touched_at[\s\S]*?return false/);
  assert.match(coverageMigration, /delete from public\.journal_product_monthly_index/);
  assert.match(coverageMigration, /insert into public\.journal_product_monthly_index/);
  assert.match(coverageMigration, /insert into public\.journal_product_detail_coverage/);
  assert.match(coverageMigration, /delete from public\.journal_product_index_dirty_months[\s\S]*?touched_at = p_expected_touched_at/);
  assert.match(coverageMigration, /revoke execute on function public\.apply_journal_product_index_snapshot[\s\S]*?from public, anon, authenticated/);
  assert.match(coverageMigration, /grant execute on function public\.apply_journal_product_index_snapshot[\s\S]*?to service_role/);

  const rebuildMarker = "2026-08-30T10:00:00.000001Z";
  const concurrentUploadMarker = "2026-08-30T10:00:00.000002Z";
  const applySnapshot = (state, expectedMarker, snapshot) =>
    state.dirtyMarker === expectedMarker
      ? { dirtyMarker: null, index: snapshot, applied: true }
      : { ...state, applied: false };
  assert.deepEqual(
    applySnapshot({ dirtyMarker: rebuildMarker, index: "old" }, rebuildMarker, "fresh"),
    { dirtyMarker: null, index: "fresh", applied: true },
  );
  assert.deepEqual(
    applySnapshot({ dirtyMarker: concurrentUploadMarker, index: "newer" }, rebuildMarker, "stale"),
    { dirtyMarker: concurrentUploadMarker, index: "newer", applied: false },
  );
});

test("v22 backfill dry-runs only reparse before applying in the safe order", () => {
  assert.match(
    backfillSource,
    /name === "default" && row\?\.type === "secret"[\s\S]*?name === "service_role" && row\?\.type === "legacy"/,
  );
  assert.match(backfillSource, /"--reveal"/);
  assert.match(backfillSource, /\^sb_secret_\[A-Za-z0-9_-\]\+\$/);
  assert.match(backfillSource, /apikey: serviceRoleKey/);
  assert.match(backfillSource, /"x-internal-key": serviceRoleKey/);
  assert.match(
    backfillSource,
    /if \(serviceRoleKey\.startsWith\("eyJ"\)\)[\s\S]*?headers\.authorization = `Bearer \$\{serviceRoleKey\}`/,
  );
  const mainStart = backfillSource.indexOf("const serviceRoleKey = loadServiceRoleKey()");
  const applyGuard = backfillSource.indexOf("if (!apply)", mainStart);
  assert.notEqual(mainStart, -1);
  assert.notEqual(applyGuard, -1);
  const preflight = backfillSource.slice(mainStart, applyGuard);
  assert.match(preflight, /reparseStore\(serviceRoleKey, target, true\)/);
  assert.doesNotMatch(preflight, /rebuildStore\(/);

  const applyStart = backfillSource.indexOf("const applyResults = []", applyGuard);
  assert.notEqual(applyStart, -1);
  const applyFlow = backfillSource.slice(applyStart);
  const reparseApply = applyFlow.indexOf("reparseStore(serviceRoleKey, target, false)");
  const rebuildDry = applyFlow.indexOf("rebuildStore(serviceRoleKey, target, true)");
  const rebuildApply = applyFlow.indexOf("rebuildStore(serviceRoleKey, target, false)");
  const verifyProduction = applyFlow.indexOf("verifyProduction(serviceRoleKey)");
  assert.ok(
    reparseApply >= 0 &&
      reparseApply < rebuildDry &&
      rebuildDry < rebuildApply &&
      rebuildApply < verifyProduction,
    "apply must run reparse -> rebuild dry-run -> rebuild apply -> production verify",
  );

  const verifyStart = backfillSource.indexOf("async function verifyProduction(");
  const verifyEnd = backfillSource.indexOf("const serviceRoleKey =", verifyStart);
  const verify = backfillSource.slice(verifyStart, verifyEnd);
  assert.match(verify, /const coverageScannedDays = storeCoverage\.reduce/);
  assert.match(verify, /coverageScannedDays !== target\.files/);
  assert.match(verify, /storeCoverage\.every\(\(row\) =>\s*row\.status === "complete"/);
  assert.doesNotMatch(verify, /detail_incomplete_days/);
});
