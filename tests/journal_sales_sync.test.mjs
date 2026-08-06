import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../supabase/functions/_shared/journal_sales_sync.ts", import.meta.url),
  "utf8",
);

test("month rebuild counts only positive-gross operating days", () => {
  assert.match(source, /export function summarizeMonthFromDayRows/);
  assert.match(source, /if \(dayGross > 0\) operatingDays \+= 1/);
  assert.doesNotMatch(
    source,
    /if \(row\.gross_sales_yen != null\) days \+= 1/,
  );
});

test("month source becomes mixed when day provenance differs", () => {
  assert.match(source, /source = "mixed"/);
  assert.match(source, /sources\.size === 1/);
  assert.match(
    source,
    /\.select\("gross_sales_yen, tax_amount_yen, guest_count, party_count, source"\)/,
  );
});

test("daily totals are extracted from report sales lines", () => {
  assert.match(source, /export function extractDailyTotalsFromReport/);
  assert.match(source, /current\.gross \+= toFiniteNumber\(entry\.total\)/);
});
