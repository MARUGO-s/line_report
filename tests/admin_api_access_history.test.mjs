import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const adminApi = await readFile(
  new URL("supabase/functions/admin-api/index.ts", root),
  "utf8",
);
const migration = await readFile(
  new URL("supabase/migrations/20260817090000_admin_access_events.sql", root),
  "utf8",
);
const pruneMigration = await readFile(
  new URL("supabase/migrations/20260817120000_admin_access_events_keep_50.sql", root),
  "utf8",
);
const indexPage = await readFile(new URL("public/index.html", root), "utf8");
const journalPage = await readFile(
  new URL("public/pos-journal.html", root),
  "utf8",
);

test("access events table is service-role only", () => {
  assert.match(migration, /create table if not exists public\.admin_access_events/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.admin_access_events from anon, authenticated/);
});

test("admin-api records and lists access events", () => {
  assert.match(adminApi, /from "\.\.\/_shared\/admin_access_log\.ts"/);
  assert.match(adminApi, /path === "\/access\/events"/);
  assert.match(adminApi, /async function fetchAdminAccessEvents\(/);
  assert.match(adminApi, /void recordCurrentAdminAccess\(/);
  assert.match(adminApi, /"\/access\/events"/);
});

test("admin logs tab shows access history and pages send a view beacon", () => {
  assert.match(indexPage, /id="accessHistoryBody"/);
  assert.match(indexPage, /function loadAdminAccessHistory\(/);
  assert.match(indexPage, /access-log\.js/);
  assert.match(indexPage, /limit=50/);
  assert.match(journalPage, /access-log\.js/);
});

test("access history keeps only the newest 50 rows", () => {
  assert.match(pruneMigration, /offset 50/);
  assert.match(pruneMigration, /admin_access_events_prune/);
  assert.match(adminApi, /ADMIN_ACCESS_HISTORY_KEEP/);
});
