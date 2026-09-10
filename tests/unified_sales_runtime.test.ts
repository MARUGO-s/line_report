import { strict as assert } from "node:assert";
import {
  fetchUnifiedDailySales,
  fetchUnifiedSalesSummary,
  reconcileDailySales,
  salesReconciliationNotice,
  summarizeSalesReconciliation,
} from "../supabase/functions/_shared/sales_reconciliation.ts";
import { manualDaySalesFromRow } from "../supabase/functions/_shared/manual_day_sales.ts";
import {
  buildDailySeriesForStoreMonth,
  fetchReceiptMonthlyAggregatesForStore,
} from "../supabase/functions/_shared/receipt_sheets_pilot_sync.ts";
import {
  fetchAnalyticsMonthly,
  fetchReceiptDailyAggForRange,
  fetchReceiptSalesState,
} from "../supabase/functions/_shared/admin_receipt_sales.ts";
import { loadMonthAggUpToDate } from "../supabase/functions/_shared/receipt_reply_context.ts";
import { loadReceiptReportAggregateForStoreByReceiptDate } from "../supabase/functions/_shared/receipt_report_aggregate.ts";

const receipt = {
  receipt_date: "2026-01-01",
  gross_sales_yen: 1000,
  net_sales_yen: 900,
  tax_amount_yen: 100,
  guest_count: 4,
  party_count: 2,
};
const journal = {
  gross_sales_yen: 1100,
  tax_amount_yen: 100,
  guest_count: 5,
  party_count: 2,
};
const override = {
  ...journal,
  source: "journal",
  journal_values: journal,
  manual_values: {},
};

Deno.test("journal replaces receipt per date and reports exact per-field discrepancies", () => {
  const before = JSON.stringify(receipt);
  const [d] = reconcileDailySales(
    [receipt],
    new Map([["2026-01-01", override]]),
  );
  assert.equal(d.gross_sales_yen, 1100);
  assert.equal(d.net_sales_yen, 1000);
  assert.equal(d.receipt_count, 1);
  assert.deepEqual(d.source_differences.map((f) => [f.field, f.difference]), [[
    "gross_sales_yen",
    100,
  ], ["guest_count", 1]]);
  assert.equal(JSON.stringify(receipt), before);
});
Deno.test("explicit manual fields win, preserve journal provenance and flag unadjusted tax", () => {
  const [d] = reconcileDailySales(
    [receipt],
    new Map([["2026-01-01", {
      ...override,
      manual_values: { gross_sales_yen: 1200, guest_count: 0 },
    }]]),
  );
  assert.equal(d.gross_sales_yen, 1200);
  assert.equal(d.guest_count, 0);
  assert.equal(d.party_count, 2);
  assert.equal(d.source_by_field.guest_count, "manual");
  assert.equal(d.source_by_field.party_count, "journal");
  assert.equal(d.tax_needs_review, true);
  assert.equal(d.journal_values?.gross_sales_yen, 1100);
});
Deno.test("explicit zero is not missing; receipt-only and missing days remain distinct", () => {
  const zero = {
    gross_sales_yen: 0,
    tax_amount_yen: 0,
    guest_count: 0,
    party_count: 0,
  };
  const days = reconcileDailySales([receipt, {
    ...receipt,
    receipt_date: "2026-01-02",
  }], new Map([["2026-01-01", { ...zero, source: "journal" }]]));
  assert.equal(days.length, 2);
  assert.equal(days[0].gross_sales_yen, 0);
  assert.equal(days[1].gross_sales_yen, 1000);
  assert.equal(days[0].manual_gross, true);
  assert.equal(days[1].manual_gross, false);
  assert.deepEqual(reconcileDailySales([], new Map()), []);
});
Deno.test("opposite discrepancies do not disappear in a net-zero monthly difference", () => {
  const days = reconcileDailySales(
    [receipt, {
      ...receipt,
      receipt_date: "2026-01-02",
      gross_sales_yen: 1200,
    }],
    new Map([
      ["2026-01-01", override],
      ["2026-01-02", override],
    ]),
  );
  assert.equal(summarizeSalesReconciliation(days).gross_difference_yen, 0);
  assert.equal(summarizeSalesReconciliation(days).discrepancy_days, 2);
  assert.match(salesReconciliationNotice(days)!, /2日/);
});
Deno.test("unknown receipt field is not reported as a confirmed zero discrepancy", () => {
  const [d] = reconcileDailySales(
    [{ ...receipt, tax_amount_yen: null }],
    new Map([["2026-01-01", override]]),
  );
  assert.equal(
    d.source_differences.some((f) => f.field === "tax_amount_yen"),
    false,
  );
});

function dbFixture() {
  const rows: Record<string, Record<string, unknown>[]> = {
    store_webhook_tables: [{
      store_partition_key: "marugoS",
      display_name: "fixture",
      receipt_table: "fixture_receipts",
    }],
    fixture_receipts: [receipt, { ...receipt, receipt_date: "2026-01-02" }],
    line_sales_manual_day: [{
      store_partition_key: "marugoS",
      sales_date: "2026-01-01",
      ...override,
    }],
    line_sales_manual_month_gross: [{
      store_partition_key: "marugoS",
      sales_month: "2026-01",
      gross_sales_yen: 999999,
    }],
    line_sales_month_budgets: [],
    line_sales_manual_day_budget: [],
    line_sales_month_store_closed_days: [],
  };
  const errors = new Set<string>();
  const db = {
    from(table: string) {
      assert.ok(table in rows, `unexpected table ${table}`);
      const predicates: ((r: Record<string, unknown>) => boolean)[] = [];
      let lo = 0, hi = Infinity;
      const result = () => ({
        data: rows[table].filter((r) => predicates.every((f) => f(r))).slice(
          lo,
          hi + 1,
        ),
        error: errors.has(table) ? { message: "unavailable" } : null,
      });
      const q = {
        select() {
          return q;
        },
        order() {
          return q;
        },
        limit(n: number) {
          hi = n - 1;
          return q;
        },
        range(a: number, b: number) {
          lo = a;
          hi = b;
          return q;
        },
        eq(k: string, v: unknown) {
          predicates.push((r) => r[k] === v);
          return q;
        },
        in(k: string, v: unknown[]) {
          predicates.push((r) => v.includes(r[k]));
          return q;
        },
        gte(k: string, v: string) {
          predicates.push((r) => String(r[k]) >= v);
          return q;
        },
        lt(k: string, v: string) {
          predicates.push((r) => String(r[k]) < v);
          return q;
        },
        maybeSingle() {
          const r = result();
          return Promise.resolve({ ...r, data: r.data[0] ?? null });
        },
        then(resolve: (r: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve);
        },
      };
      return q;
    },
  } as unknown as Parameters<typeof fetchUnifiedDailySales>[0];
  return { db, rows, errors };
}

Deno.test("daily screen, monthly graph, receipt reply and scheduled report use identical totals", async () => {
  const { db } = dbFixture();
  const daily = await fetchReceiptDailyAggForRange(
    db,
    "marugos",
    "2026-01-01",
    "2026-01-31",
  );
  const screen = await fetchReceiptSalesState(
    db,
    new URL("https://test/receipts/sales?store_key=marugos&month=2026-01"),
  );
  const monthly = await fetchAnalyticsMonthly(
    db,
    new URL("https://test/analytics/monthly?store_key=marugoS&months=36"),
  );
  const reply = await loadMonthAggUpToDate(
    db,
    "marugos",
    "2026-01",
    "2026-01-31",
  );
  const report = await loadReceiptReportAggregateForStoreByReceiptDate(
    db,
    "marugos",
    "2026-01-01",
    "2026-01-31",
  );
  const sheet = await buildDailySeriesForStoreMonth(db, "marugos", "2026-01");
  const sheetMonths = await fetchReceiptMonthlyAggregatesForStore(
    db,
    "marugos",
  );
  const expected = 2100;
  assert.equal(daily.reduce((n, d) => n + d.gross_sales_yen, 0), expected);
  assert.equal(screen.totals.total_gross_sales_yen, expected);
  assert.equal(
    monthly.series.find((m) => m.month === "2026-01")!.gross_sales_yen,
    expected,
  );
  assert.equal(reply.gross, expected);
  assert.equal(report!.totalGrossSalesYen, expected);
  assert.equal(sheet.reduce((n, d) => n + d.gross_sales_yen, 0), expected);
  assert.equal(sheetMonths.get("2026-01")!.gross_sales_yen, expected);
  assert.equal(screen.reconciliation.discrepancy_days, 1);
  assert.match(report!.reconciliationNotice!, /差異 1日/);
});
Deno.test("source fetch failure fails closed instead of silently reporting receipt-only or zero", async () => {
  for (
    const table of [
      "store_webhook_tables",
      "line_sales_manual_day",
      "fixture_receipts",
    ]
  ) {
    const { db, errors } = dbFixture();
    errors.add(table);
    await assert.rejects(() =>
      fetchUnifiedDailySales(db, "marugos", "2026-01-01", "2026-01-31")
    );
  }
  await assert.rejects(() =>
    fetchUnifiedDailySales(
      dbFixture().db,
      "unknown",
      "2026-01-01",
      "2026-01-31",
    )
  );
});
Deno.test("receipt pagination retains all rows beyond the default API page size", async () => {
  const { db, rows } = dbFixture();
  rows.fixture_receipts = Array.from(
    { length: 1050 },
    () => ({ ...receipt, receipt_date: "2026-01-02" }),
  );
  const days = await fetchUnifiedDailySales(
    db,
    "marugos",
    "2026-01-01",
    "2026-01-31",
  );
  assert.equal(days[1].receipt_count, 1050);
  assert.equal(days[1].gross_sales_yen, 1050000);
});

Deno.test("monthly-only figures apply to full months, never invent daily amounts or replace explicit zero", async () => {
  const { db, rows } = dbFixture();
  rows.fixture_receipts = [];
  rows.line_sales_manual_day = [];
  const full = await fetchUnifiedSalesSummary(
    db,
    "marugos",
    "2026-01-01",
    "2026-01-31",
  );
  assert.equal(full.totals.gross_sales_yen, 999999);
  assert.equal(full.series.length, 0);
  assert.equal(full.monthly_fallbacks.length, 1);
  const partial = await fetchUnifiedSalesSummary(
    db,
    "marugos",
    "2026-01-01",
    "2026-01-15",
  );
  assert.equal(partial.monthly_fallbacks.length, 0);
  rows.line_sales_manual_day = [{
    store_partition_key: "marugoS",
    sales_date: "2026-01-01",
    gross_sales_yen: 0,
    guest_count: 0,
    party_count: 0,
    source: "manual",
  }];
  assert.equal(
    (await fetchUnifiedSalesSummary(db, "marugos", "2026-01-01", "2026-01-31"))
      .totals.gross_sales_yen,
    0,
  );
});
Deno.test("tax-only correction survives loading and invalid periods do not become zero sales", async () => {
  const md = manualDaySalesFromRow({
    tax_amount_yen: 50,
    source: "manual",
    manual_values: { tax_amount_yen: 50 },
  })!;
  assert.ok(md);
  const [day] = reconcileDailySales([receipt], new Map([["2026-01-01", md]]));
  assert.equal(day.gross_sales_yen, 1000);
  assert.equal(day.net_sales_yen, 950);
  await assert.rejects(() =>
    fetchUnifiedDailySales(
      dbFixture().db,
      "marugos",
      "2026-02-31",
      "2026-03-01",
    )
  );
  const { db, rows } = dbFixture();
  rows.store_webhook_tables = [];
  await assert.rejects(() =>
    fetchUnifiedDailySales(db, "marugos", "2026-01-01", "2026-01-31")
  );
});
Deno.test("partial missing receipt tax is not a confirmed day tax and override pagination is complete", async () => {
  const [day] = reconcileDailySales([receipt, {
    ...receipt,
    tax_amount_yen: null,
  }], new Map([["2026-01-01", override]]));
  assert.equal(
    day.source_differences.some((d) => d.field === "tax_amount_yen"),
    false,
  );
  const { db, rows } = dbFixture();
  rows.fixture_receipts = [];
  rows.line_sales_manual_day = Array.from(
    { length: 1050 },
    (_, i) => ({
      store_partition_key: "marugoS",
      sales_date: new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10),
      ...override,
    }),
  );
  assert.equal(
    (await fetchUnifiedDailySales(db, "marugos", "2023-01-01", "2025-12-31"))
      .length,
    1050,
  );
});
