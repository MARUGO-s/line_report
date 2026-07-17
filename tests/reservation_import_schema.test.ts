import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const webhookSource = new URL(
  "../supabase/functions/line-webhook/index.ts",
  import.meta.url,
);
const migrationSource = new URL(
  "../supabase/migrations/20260717073125_add_manual_reservation_edited_at.sql",
  import.meta.url,
);

test("manual reservation update audit column is present in the schema", async () => {
  const [webhook, migration] = await Promise.all([
    readFile(webhookSource, "utf8"),
    readFile(migrationSource, "utf8"),
  ]);

  assert.match(webhook, /manual_edited_at:\s*new Date\(\)\.toISOString\(\)/);
  assert.match(
    migration,
    /alter table public\.manual_reservation_visit_events[\s\S]*add column if not exists manual_edited_at timestamptz/,
  );
});
