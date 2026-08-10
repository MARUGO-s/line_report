import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminApi = await readFile(
  new URL("../supabase/functions/admin-api/index.ts", import.meta.url),
  "utf8",
);
const html = await readFile(
  new URL("../public/jnm/jnl2txt.html", import.meta.url),
  "utf8",
);

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must exist after ${startMarker}`);
  return source.slice(start, end);
}

const normalize = sectionBetween(
  adminApi,
  "function normalizeStoreOperationProfile(",
  "async function fetchStoreOperationProfile(",
);
const save = sectionBetween(
  adminApi,
  "async function saveStoreOperationProfile(",
  "// ===== Journal Report 店舗ナレッジ",
);

test("store ops normalize keeps journalSalesSync boolean", () => {
  assert.match(normalize, /journalSalesSync:/);
  assert.match(
    normalize,
    /src\.journalSalesSync === true/,
  );
});

test("store ops save preserves existing journalSalesSync when key omitted", () => {
  assert.match(save, /hasOwnProperty\.call\(rawProfile, "journalSalesSync"\)/);
  assert.match(save, /existingProfile\?\.journalSalesSync === true/);
  assert.match(save, /profile\.journalSalesSync = true/);
});

test("Journal Report 店舗情報 tab has past-sales sync switch", () => {
  assert.match(html, /id="opsJournalSalesSync"/);
  assert.match(html, /過去売上への同期（ジャーナルを正とする）/);
  assert.match(html, /journalSalesSync:\s*!!document\.getElementById\('opsJournalSalesSync'\)\?\.checked/);
  assert.match(html, /keepSync/);
});
