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
const posJournal = await readFile(
  new URL("supabase/functions/_shared/pos_journal.ts", root),
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

test("Journal Report month recovery reuses the reconciled server report builder", () => {
  assert.match(adminApi, /mergePosJournalDaysPreferPrimary\(storedDays, shared\.days\)/);
  assert.match(adminApi, /const recoveryReport = buildJournalSavedReportsFromPosDays\(/);
  assert.match(adminApi, /recovery_report: recoveryReport/);
  assert.match(journalReport, /normalizeRecoveredMonthlyReportData/);
  assert.match(journalReport, /_itemDetailIncomplete/);
});

test("POS journal AI uses the same shared report merge as the screen", () => {
  const start = adminApi.indexOf("async function resolvePosJournalAiSummary(");
  assert.notEqual(start, -1);
  const body = adminApi.slice(start, start + 2500);
  assert.match(body, /fetchSharedJournalReportState/);
  assert.match(body, /const combinedDays = await fillPosJournalDaysWeather\(/);
  assert.match(body, /mergePosJournalDaysPreferPrimary\(storedDays, shared\.days\)/);
  assert.match(body, /days: combinedDays/);
});

test("POS journal summary shows food/drink mix and daily majority icons", () => {
  assert.match(page, /function renderFoodDrinkMix\(/);
  assert.match(page, /function dayFoodDrinkMark\(/);
  assert.match(page, /フード \/ ドリンク \/ 室料 \/ その他/);
  assert.match(page, /share\.foodPct>0\.5/);
  assert.match(page, /share\.drinkPct>0\.5/);
  assert.match(page, /class="fd-mark food"/);
  assert.match(page, /class="fd-mark drink"/);
  assert.match(page, /function dayFoodDrinkCompare\(/);
  assert.match(page, /フード\/ドリンク/);
  assert.match(page, /function renderChargeGuestMix\(/);
  assert.match(page, /function dayChargeGuestCompare\(/);
  assert.match(page, /チャージ\/客数/);
  assert.match(page, /colspan="12"/);
});

test("POS journal page shows both verified CAVACAVA store codes", () => {
  assert.match(page, /店舗コード1015・1020/);
  assert.match(page, /コード1015・1020をBistro CAVACAVAへ保存/);
  assert.match(page, /store_codes: \['1015', '1020'\]/);
});

test("POS journal store directory unions LZH originals and Journal Report saves", () => {
  assert.match(adminApi, /async function fetchPosJournalStoreDirectory\(/);
  assert.match(adminApi, /path === "\/pos-journals\/stores"/);
  // 片側だけに保存された店舗も候補へ入れる
  assert.match(adminApi, /listDistinctPosJournalStoreKeys\(supabase, table\)/);
  assert.match(adminApi, /for \(\s*const table of \["pos_journal_files", "saved_reports"\] as const\s*\)/);
  // どちらの件数も0の店舗だけを一覧から外す
  assert.match(adminApi, /if \(!journalFileCount && !savedReportCount\) continue/);
  assert.match(adminApi, /months: monthList/);
});

test("POS journal store list is scoped and never bypasses store login limits", () => {
  const start = adminApi.indexOf("async function fetchPosJournalStoreDirectory(");
  assert.notEqual(start, -1);
  const body = adminApi.slice(start, start + 3000);
  assert.match(body, /const scope = String\(storeScope \?\? ""\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(body, /if \(scope && key !== scope\) return/);
  assert.match(adminApi, /"\/pos-journals\/stores",/);
});

test("POS journal page picks its store list from the API, not a fixed store", () => {
  assert.match(page, /async function refreshStoreDirectory\(/);
  assert.match(page, /apiFetch\('\/pos-journals\/stores', \{ method: 'GET' \}\)/);
  assert.match(page, /function changeStore\(key\)/);
  assert.match(page, /el\('storeSel'\)\.addEventListener\('change'/);
  // 単一店舗の固定selectに戻っていないこと
  assert.doesNotMatch(page, /el\('storeSel'\)\.disabled = true;/);
  assert.match(page, /select\.disabled = storeDirectory\.length <= 1/);
  assert.match(page, /store_key: 'marugos'/);
});

test("POS journal page keeps the CAVACAVA static snapshot out of other stores", () => {
  assert.match(page, /var LEGACY_DATA_STORE_KEY = 'bistrocavacava'/);
  assert.match(page, /month!==LEGACY_DATA_MONTH\|\|STORE_KEY!==LEGACY_DATA_STORE_KEY/);
});

test("POS journal store name and codes resolve for stores without LZH originals", () => {
  assert.match(posJournal, /export function resolvePosJournalStoreByKey\(/);
  assert.match(adminApi, /const mappedStore = resolvePosJournalStoreByKey\(storeKey\)/);
  assert.match(adminApi, /store_codes: storeCodes/);
  assert.match(adminApi, /summary\.meta\.store_codes = storeCodes/);
  // 旧実装の「見つからなければ1015」固定を残していないこと
  assert.doesNotMatch(adminApi, /storeKey\.toLowerCase\(\) === "bistrocavacava"\s*\n?\s*\? resolvePosJournalStore\("1015"\)/);
});

test("POS journal AI accepts every store that has a register store code", () => {
  const start = adminApi.indexOf("async function resolvePosJournalAiStore(");
  assert.notEqual(start, -1);
  const body = adminApi.slice(start, start + 1800);
  assert.match(body, /resolvePosJournalStoreByKey\(storeKey\)/);
  assert.match(body, /lookupPosJournalStoreCodeByKey\(supabase, storeKey\)/);
  assert.doesNotMatch(adminApi, /電子ジャーナルAI分析はBistro CAVACAVAのみ対応/);
});

test("successfully parsed zero-sales journals are not shown as incomplete", () => {
  assert.match(adminApi, /parsed_complete:\s*parsedData\.parsed_complete === true/);
  assert.match(page, /if \(file\.parsed_complete === true\) return false/);
  assert.match(page, /正常解析済みの0円日は対象外/);
});

test("POS journal state applies Journal Report category overrides", () => {
  assert.match(adminApi, /const categoryOverrides = await fetchPosJournalCategoryOverrides/);
  assert.match(adminApi, /categoryOverrides,/);
});

test("POS journal fills missing weather from analytics cache", () => {
  assert.match(adminApi, /async function fillPosJournalDaysWeather\(/);
  assert.match(adminApi, /fetchWeatherDailyRange/);
  assert.match(adminApi, /STORE_COORDINATES/);
  assert.match(adminApi, /applyCachedWeatherToPosJournalDays/);
  assert.match(page, /function dayTempC\(/);
  assert.match(page, /n === 0 && !weather/);
});

test("POS journal uses the shared left admin menu with phone hamburger", () => {
  assert.match(page, /class="lsa-side"/);
  assert.match(page, /id="lsaNavToggle"/);
  assert.match(page, /max-width: 920px/);
  assert.match(page, /サイドバーは常にフルメニューを出す/);
  assert.doesNotMatch(page, /body\.line-locked \.ms-side/);
  assert.doesNotMatch(page, /body\.line-locked \.lsa-side/);
  assert.match(page, /接続設定/);
  assert.match(page, /売上分析/);
  assert.match(page, /フードコート分析/);
  assert.match(page, /lsa-navitem is-active" href="pos-journal.html"/);
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

test("POS upload rebuilds deterministic Journal Report daily and monthly rows", () => {
  const candidateStart = adminApi.indexOf(
    "async function fetchSavedReportCandidatesForAutoBuild(",
  );
  assert.notEqual(candidateStart, -1);
  const candidateBody = adminApi.slice(candidateStart, candidateStart + 4500);
  assert.match(candidateBody, /sourceMonths:data->sourceMonths/);
  assert.match(candidateBody, /savedReportCandidateMatchesMonth\(row, month\)/);
  assert.match(candidateBody, /\.select\("id, data"\)/);
  assert.match(candidateBody, /\.in\("id", idChunk\)/);
  assert.doesNotMatch(candidateBody, /\.contains\("data"/);

  const start = adminApi.indexOf("async function upsertPosJournalAutoReports(");
  assert.notEqual(start, -1);
  const body = adminApi.slice(start, start + 9500);
  assert.match(body, /fetchPosJournalRows\(supabase, storeKey, month\)/);
  assert.match(body, /fetchSavedReportCandidatesForAutoBuild/);
  assert.match(body, /pickBestJournalSavedReportDays/);
  assert.match(body, /mergePosJournalDaysPreferPrimary/);
  assert.match(body, /buildJournalSavedReportsFromPosDays/);
  assert.match(body, /buildJournalSavedReportHtml/);
  assert.match(body, /POS_REPORT_HTML_BUCKET/);
  assert.match(body, /\.upsert\(payloads, \{ onConflict: "id" \}\)/);
  assert.match(body, /autoGeneratedFromPosJournal:\s*true/);
  assert.match(body, /isCanonicalSavedReportForMonth/);
  assert.match(
    adminApi,
    /function legacySavedReportIsSingleMonth\([\s\S]*?periodDates\.every\([\s\S]*?合算\|〜\|～\|から\|まで/,
  );
  assert.match(
    adminApi,
    /sourceMonths\.length === 1 && sourceMonths\[0\] === month/,
  );
  assert.match(
    adminApi,
    /legacySavedReportIsSingleMonth\(row, month\)/,
  );
  assert.match(
    adminApi,
    /function isCanonicalSavedReportForMonth\([\s\S]*?if \(\/合算\/\.test\(title\)\) return false/,
  );
  assert.match(body, /id: toSafeString\(existing\?\.id\) \|\| report\.id/);
  assert.match(body, /syncJournalSalesFromReport/);

  const uploadStart = adminApi.indexOf("async function uploadPosJournalFiles(");
  assert.notEqual(uploadStart, -1);
  const upload = adminApi.slice(uploadStart, uploadStart + 20000);
  assert.match(upload, /upsertPosJournalAutoReports/);
  assert.match(upload, /saved_reports:\s*savedReports/);
  assert.match(upload, /successes, \.\.\.repaired, \.\.\.duplicates/);
});

test("POS upload UI reports automatic daily monthly creation and failures", () => {
  assert.match(page, /保存済みレポート（日別・月間）も同じ月の全原本から自動作成・更新/);
  assert.match(page, /var reportTotals=\{created:0,updated:0,failed:0\}/);
  assert.match(page, /result\.saved_reports\|\|\{\}/);
  assert.match(page, /保存済みレポート '\+reportTotals\.created\+'件を自動作成/);
  assert.match(page, /保存済みレポート '\+reportTotals\.updated\+'件を更新/);
});
