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

const normalizeHelpers = sectionBetween(
  adminApi,
  "const STORE_OPS_CALENDAR_KINDS",
  "async function fetchStoreOperationProfile(",
);
const save = sectionBetween(
  adminApi,
  "async function saveStoreOperationProfile(",
  "// ===== Journal Report 店舗ナレッジ",
);

test("store ops normalize keeps calendarEvents with start/end", () => {
  assert.match(normalizeHelpers, /function normalizeStoreOpsCalendarEvents/);
  assert.match(normalizeHelpers, /calendarEvents:\s*normalizeStoreOpsCalendarEvents/);
  assert.match(normalizeHelpers, /STORE_OPS_CALENDAR_EVENTS_MAX/);
  assert.match(normalizeHelpers, /start > end/);
});

test("store ops save preserves calendarEvents when key omitted", () => {
  assert.match(save, /omitEvents/);
  assert.match(save, /profile\.calendarEvents = normalizeStoreOpsCalendarEvents/);
});

test("Journal Report 店舗情報 has calendar event UI wired to AI preview", () => {
  assert.match(html, /施策・イベントカレンダー/);
  assert.match(html, /id="opsCalGrid"/);
  assert.match(html, /id="opsEvStart"/);
  assert.match(html, /id="opsEvEnd"/);
  assert.match(html, /function formatStoreOpsCalendarEventsForAi/);
  assert.match(html, /calendarEvents:\s*opsCalendarEvents/);
  assert.match(html, /登録カレンダー/);
});
