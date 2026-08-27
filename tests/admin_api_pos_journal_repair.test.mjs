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

const placeholder = sectionBetween(
  "function isPosJournalPlaceholderRow(",
  "function buildPosJournalRepairPayload(",
);
const repairHelpers = sectionBetween(
  "function buildPosJournalRepairPayload(",
  "async function uploadPosJournalFiles(",
);
const upload = sectionBetween(
  "async function uploadPosJournalFiles(",
  "async function fetchPosJournalDownloadUrl(",
);
test("placeholder rows exclude a successfully parsed zero-sales journal", () => {
  assert.match(placeholder, /parsed\.parsed_complete === true/);
  assert.match(
    placeholder,
    /!parsedComplete && \(receiptsCount <= 0 \|\| receipts\.length === 0\)/,
  );
  assert.doesNotMatch(placeholder, /grossSales <= 0 && receipts\.length === 0/);
});

test("repair payload refreshes uploaded_at so latest files sort correctly", () => {
  assert.match(repairHelpers, /uploaded_at:\s*now/);
  assert.match(repairHelpers, /updated_at:\s*now/);
});

test("repair replaces storage when hash changes or path is missing", () => {
  assert.match(repairHelpers, /ensurePosJournalStorageForRepair/);
  assert.match(repairHelpers, /existingSha === args\.hash/);
  assert.match(upload, /ensurePosJournalStorageForRepair\(supabase/);
  assert.match(upload, /stored\.previousPath/);
  assert.match(upload, /repaired_count:\s*repaired\.length/);
});

test("delete allows rows without a storage path", () => {
  const start = source.indexOf("async function deletePosJournalFile(");
  assert.notEqual(start, -1);
  const body = source.slice(start, start + 2500);
  assert.match(body, /if \(storagePath\) \{\s*\n\s*const \{ error: removeError \}/);
});
