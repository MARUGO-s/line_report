import { strict as assert } from "node:assert";
import { fetchAnalyticsMonthly, fetchReceiptDailyAggForRange } from "../supabase/functions/_shared/admin_receipt_sales.ts";

Deno.test("monthly analytics replaces overlapping journal day, including tax, and keeps receipt-only day", async () => {
  const month = `${new Date().getUTCFullYear() - 1}-01`;
  const rows: Record<string, Record<string, unknown>[]> = {
    store_webhook_tables: [{ store_partition_key: "marugoS", display_name: "fixture", receipt_table: "receipts_fixture" }],
    receipts_fixture: [
      { receipt_date: `${month}-01`, gross_sales_yen: 550, net_sales_yen: 500, guest_count: 1, party_count: 1 },
      { receipt_date: `${month}-02`, gross_sales_yen: 2200, net_sales_yen: 2000, guest_count: 4, party_count: 2 },
    ],
    line_sales_manual_day: [{ store_partition_key: "marugoS", sales_date: `${month}-01`,
      gross_sales_yen: 1100, tax_amount_yen: 100, guest_count: 2, party_count: 1, source: "journal" }],
    line_sales_manual_month_gross: [{ store_partition_key: "marugoS", sales_month: month,
      gross_sales_yen: 1100, net_sales_yen: 1000, guest_count: 2, party_count: 1 }],
  };
  const db = { from(table: string) {
    assert.ok(table in rows, `unexpected table: ${table}`);
    const filters: ((r: Record<string, unknown>) => boolean)[] = [];
    const q = {
      select(_s: string) { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
      eq(k: string, v: unknown) { filters.push(r => r[k] === v); return q; },
      in(k: string, v: unknown[]) { filters.push(r => v.includes(r[k])); return q; },
      gte(k: string, v: string) { filters.push(r => String(r[k]) >= v); return q; },
      lt(k: string, v: string) { filters.push(r => String(r[k]) < v); return q; },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve({ data: rows[table].filter(r => filters.every(f => f(r))), error: null }).then(resolve);
      },
    }; return q;
  } } as unknown as Parameters<typeof fetchAnalyticsMonthly>[0];
  const result = await fetchAnalyticsMonthly(db, new URL("https://example.test/analytics/monthly?store_key=marugos&months=36"));
  const actual = result.series.find(r => r.month === month)!;
  assert.equal(result.store_key, "marugoS");
  assert.equal(actual.gross_sales_yen, 3300);
  assert.equal(actual.net_sales_yen, 3000);
  assert.equal(actual.guest_count, 6);
  assert.equal(actual.party_count, 3);
  assert.equal(actual.receipt_count, 2);
  const daily = await fetchReceiptDailyAggForRange(db, "marugos", `${month}-01`, `${month}-02`);
  assert.equal(daily[0].gross_sales_yen, 1100);
  assert.equal(daily[0].net_sales_yen, 1000);
  assert.equal(daily[0].tax_amount_yen, 100);
  assert.equal(daily[1].gross_sales_yen, 2200);
  assert.equal(daily[1].net_sales_yen, 2000);
  // With no receipt input, a synced journal month still has correct net sales.
  rows.receipts_fixture = [];
  const journalOnly = await fetchAnalyticsMonthly(db, new URL("https://example.test/analytics/monthly?store_key=marugoS&months=36"));
  assert.equal(journalOnly.series.find(r => r.month === month)!.net_sales_yen, 1000);
});
