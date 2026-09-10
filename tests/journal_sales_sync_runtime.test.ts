import { strict as assert } from "node:assert";
import {
  extractDailyTotalsFromReport,
  isJournalSalesSyncEnabled,
  syncJournalSalesFromReport,
} from "../supabase/functions/_shared/journal_sales_sync.ts";

const day = (date = "2026-01-01", gross = 1100) => ({
  business_date: date, gross_sales: gross, tax: gross / 11, guests: 2, groups: 1,
});
const totals = { gross: 1100, tax: 100, guests: 2, groups: 1 };

Deno.test("compact report with empty sales retains POS day totals", () => {
  assert.deepEqual([...extractDailyTotalsFromReport({ sales: [], posJournalDays: [day()] })],
    [["2026-01-01", totals]]);
  assert.deepEqual([...extractDailyTotalsFromReport({ posJournalDays: [day()] })],
    [["2026-01-01", totals]]);
});

Deno.test("POS totals replace overlapping sales; non-overlapping legacy days survive", () => {
  const result = extractDailyTotalsFromReport({
    sales: [
      { date: "2026-01-01", total: 550, tax: 50, customers: 1, groups: 1 },
      { date: "2026-01-02", total: 2200, tax: 200, customers: 4, groups: 2 },
    ], posJournalDays: [day(), day()],
  });
  assert.equal(result.size, 2);
  assert.deepEqual(result.get("2026-01-01"), totals);
  assert.deepEqual(result.get("2026-01-02"), { gross: 2200, tax: 200, guests: 4, groups: 2 });
});

Deno.test("legacy receipt lines still sum once by date", () => {
  const sale = { date: "2026-01-01", total: 550, tax: 50, customers: 1, groups: 1 };
  assert.deepEqual(extractDailyTotalsFromReport({ sales: [sale, sale] }).get(sale.date),
    { ...totals, groups: 2 });
});

Deno.test("unknown day totals are not silently converted into zero sales", () => {
  for (const value of [null, undefined, "", "bad", NaN, -1, Infinity, false, 1.5]) {
    assert.throws(() => extractDailyTotalsFromReport({ posJournalDays: [{ ...day(), gross_sales: value }] }),
      /Invalid POS journal daily totals/);
  }
  assert.throws(() => extractDailyTotalsFromReport({ posJournalDays: [{ ...day(), tax: 1200 }] }));
});

Deno.test("conflicting duplicate POS days reject before any sync writes", () => {
  assert.throws(() => extractDailyTotalsFromReport({ posJournalDays: [day(), day(undefined, 2200)] }),
    /Conflicting POS journal daily totals/);
});

Deno.test("explicit zero day and numeric strings are supported", () => {
  assert.deepEqual(extractDailyTotalsFromReport({ posJournalDays: [
    { business_date: "2026-01-01", gross_sales: "0", tax: "0", guests: "0", groups: "0" },
  ] }).get("2026-01-01"), { gross: 0, tax: 0, guests: 0, groups: 0 });
});

function fakeDb(enabled: unknown = true, profileError = false) {
  const rows: Record<string, Record<string, unknown>[]> = {
    store_operation_profiles: [{ store_partition_key: "marugos", profile: { journalSalesSync: enabled } }],
    line_sales_manual_day: [], line_sales_manual_month_gross: [],
  };
  const writes: string[] = [];
  const client = { from(table: string) {
    const predicates: ((r: Record<string, unknown>) => boolean)[] = [];
    const result = () => ({ data: rows[table].filter(r => predicates.every(p => p(r))), error: null });
    const q = {
      select(_fields: string) { return q; },
      eq(k: string, v: unknown) { predicates.push(r => r[k] === v); return q; },
      in(k: string, v: unknown[]) { predicates.push(r => v.includes(r[k])); return q; },
      gte(k: string, v: string) { predicates.push(r => String(r[k]) >= v); return q; },
      lte(k: string, v: string) { predicates.push(r => String(r[k]) <= v); return q; },
      maybeSingle() { return Promise.resolve({ data: result().data[0] ?? null,
        error: profileError ? { message: "unavailable" } : null }); },
      then(resolve: (v: ReturnType<typeof result>) => unknown) { return Promise.resolve(result()).then(resolve); },
      upsert(payload: Record<string, unknown> | Record<string, unknown>[], options: { onConflict: string }) {
        writes.push(table);
        const keys = options.onConflict.split(",");
        for (const row of Array.isArray(payload) ? payload : [payload]) {
          const index = rows[table].findIndex(r => keys.every(k => r[k] === row[k]));
          if (index < 0) rows[table].push(row); else rows[table][index] = { ...rows[table][index], ...row };
        }
        return Promise.resolve({ error: null });
      },
    }; return q;
  } } as unknown as Parameters<typeof syncJournalSalesFromReport>[0];
  return { rows, writes, client };
}

Deno.test("profile lookup uses journal lowercase but sales writes use canonical marugoS", async () => {
  const db = fakeDb();
  assert.equal(await isJournalSalesSyncEnabled(db.client, "marugoS"), true);
  assert.equal(await isJournalSalesSyncEnabled(db.client, "marugos"), true);
  const result = await syncJournalSalesFromReport(db.client, "marugos", { sales: [], posJournalDays: [day()] });
  assert.equal(result.daysWritten, 1);
  assert.equal(result.monthsWritten, 1);
  assert.equal(db.rows.line_sales_manual_day[0].store_partition_key, "marugoS");
  assert.equal(db.rows.line_sales_manual_month_gross[0].net_sales_yen, 1000);
});

Deno.test("sync is opt-in; no profile, false, string true and query errors do not write", async () => {
  for (const flag of [false, "true", null]) {
    const db = fakeDb(flag);
    await syncJournalSalesFromReport(db.client, "marugos", { posJournalDays: [day()] });
    assert.equal(db.writes.length, 0);
  }
  const db = fakeDb(true, true);
  assert.equal(await isJournalSalesSyncEnabled(db.client, "marugoS"), false);
  assert.equal(await isJournalSalesSyncEnabled(fakeDb().client, "sauvage"), false);
});

Deno.test("repeated sync is idempotent and partial report preserves other days and stores", async () => {
  const db = fakeDb();
  const untouched = { store_partition_key: "sauvage", sales_date: "2026-01-01", gross_sales_yen: 9900 };
  db.rows.line_sales_manual_day.push(untouched);
  await syncJournalSalesFromReport(db.client, "marugos", { posJournalDays: [day(), day("2026-01-02", 2200)] });
  for (let i = 0; i < 2; i++) await syncJournalSalesFromReport(db.client, "marugos", { posJournalDays: [day()] });
  assert.equal(db.rows.line_sales_manual_day.length, 3);
  assert.deepEqual(db.rows.line_sales_manual_day[0], untouched);
  assert.equal(db.rows.line_sales_manual_month_gross.length, 1);
  const month = db.rows.line_sales_manual_month_gross[0];
  assert.equal(month.gross_sales_yen, 3300);
  assert.equal(month.net_sales_yen, 3000);
  assert.equal(month.guest_count, 4);
  assert.equal(month.operating_days_count, 2);
});

Deno.test("malformed compact report fails before altering existing daily or monthly rows", async () => {
  const db = fakeDb();
  await assert.rejects(() => syncJournalSalesFromReport(db.client, "marugos", {
    posJournalDays: [day(), { ...day("2026-01-02"), guests: null }],
  }));
  assert.equal(db.writes.length, 0);
});
