import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFoodCourtSalesContext,
  discoverFoodCourtSalesRange,
} from "../supabase/functions/_shared/foodcourt_sales_context.ts";
import {
  allocateFoodCourtHourlyTargets,
  buildFoodCourtJournalDetail,
} from "../supabase/functions/_shared/foodcourt_journal_detail.ts";
import { prepareFoodCourtKpiScenario } from "../supabase/functions/_shared/foodcourt_kpi.ts";

const ranges = [{ from: "2025-12-09", to: "2026-06-02" }];
const item = (name: string, amount: number, qty = 1) => ({
  code: name,
  name,
  unit: amount / qty,
  qty,
  amount,
});
const day = (date: string) => ({
  business_date: date,
  gross_sales: 1500,
  guests: 3,
  groups: 2,
  receipts: [
    {
      no: "PRIVATE-RECEIPT",
      table_no: "PRIVATE-TABLE",
      time: "11:30",
      total: 1000,
      guests: 2,
      items: [item("クロワッサン", 400, 2), item("ワイン", 600)],
    },
    {
      no: "PRIVATE-RECEIPT2",
      time: "18:40",
      total: 500,
      guests: 1,
      items: [item("カレー", 500)],
    },
  ],
});
function summary(store: string, from: string, to: string): any {
  return {
    store_key: store,
    from,
    to,
    series: [{
      date: from,
      gross_sales_yen: 1500,
      guest_count: 3,
      party_count: 2,
      tax_amount_yen: 100,
      net_sales_yen: 1400,
      net_sales_known: true,
      source_by_field: {
        gross_sales_yen: "journal",
        guest_count: "journal",
        party_count: "journal",
        tax_amount_yen: "journal",
      },
      journal_values: { gross_sales_yen: 1500 },
    }],
    monthly_fallbacks: [],
    totals: {
      gross_sales_yen: 1500,
      guest_count: 3,
      party_count: 2,
      tax_amount_yen: 100,
      net_sales_yen: 1400,
      net_sales_known: true,
    },
    reconciliation: {},
  };
}

test("all period discovers journal and shared-report bounds independent of comparison dates, scoped and paginated", async () => {
  const queries: any[] = [];
  const db = {
    from(table: string) {
      let col = "", asc = true, offset = 0;
      const q: any = {
        select(c: string) {
          col = c;
          return q;
        },
        ilike(c: string, v: string) {
          queries.push([table, c, v]);
          return q;
        },
        is() {
          return q;
        },
        not() {
          return q;
        },
        order(_c: string, o: any) {
          asc = o?.ascending ?? true;
          return q;
        },
        limit() {
          return q;
        },
        range(a: number) {
          offset = a;
          return q;
        },
        then(resolve: any) {
          let data: any[] = [];
          if (table === "store_webhook_tables") {
            data = [{
              receipt_table: "fixture_receipts",
            }];
          } else if (table === "pos_journal_files") {
            data = [{
              [col]: asc ? "2025-12-09" : "2026-08-25",
            }];
          } else if (table === "fixture_receipts") {
            data = [{
              [col]: "2026-06-01",
            }];
          } else if (table === "saved_reports") {
            data = offset ? [{ sourceMonths: ["2025-11"] }] : Array.from(
              { length: 500 },
              (_, id) => ({ id, period: "2025-12-09〜2026-08-25" }),
            );
          }
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return q;
    },
  };
  assert.deepEqual(
    await discoverFoodCourtSalesRange(db, "fixture_store", [
      "2026-06-07",
      "2026-09-18",
    ]),
    [{ from: "2025-11-01", to: "2026-09-18" }],
  );
  assert.ok(
    queries.filter((q) => q[0] !== "fixture_receipts").every((q) =>
      q[2] === "fixture\\_store"
    ),
  );
  await assert.rejects(discoverFoodCourtSalesRange(db, "bad%store", []));
});

test("canonical sales include earliest month; missing counts are unknown, never zero; wrong store rejected", async () => {
  const ctx = await buildFoodCourtSalesContext(
    "fixture_store",
    ranges,
    async (s, f, t) => summary(s, f, t),
  );
  assert.equal(ctx.coverage.journal_from, "2025-12-09");
  assert.match(ctx.block, /2025-12/);
  assert.equal(ctx.hasData, true);
  const missing = await buildFoodCourtSalesContext(
    "fixture_store",
    ranges,
    async (s, f, t) => {
      const r = summary(s, f, t);
      r.series[0].source_by_field.guest_count = "receipt";
      r.series[0].receipt_values = { guest_count: null };
      return r;
    },
  );
  assert.match(missing.evaluationBlock, /"guest_count":null/);
  assert.match(missing.evaluationBlock, /"average_spend_yen":null/);
  await assert.rejects(
    buildFoodCourtSalesContext(
      "fixture_store",
      ranges,
      async (_s, f, t) => summary("other", f, t),
    ),
  );
});

test("verified product/hour/co-purchase facts deduplicate days, filter ranges, exclude mismatches and private fields", async () => {
  const loaded: string[] = [];
  const detail = await buildFoodCourtJournalDetail(
    [{ from: "2025-12-09", to: "2025-12-10" }, {
      from: "2026-06-01",
      to: "2026-06-02",
    }],
    "クロワッサン",
    async (month) => {
      loaded.push(month);
      return month === "2025-12"
        ? [day("2025-12-09"), day("2025-12-09"), {
          ...day("2025-12-10"),
          gross_sales: 9999,
        }, day("2025-12-11")]
        : [day("2026-06-01")];
    },
  );
  assert.deepEqual(loaded, ["2025-12", "2026-06"]);
  assert.equal(detail.coverage.verified_days, 2);
  assert.equal(detail.coverage.excluded_days, 1);
  assert.equal(detail.coverage.checks, 4);
  assert.equal(detail.facts.sales_yen, 3000);
  const croissant = detail.facts.products.find((p) =>
    p.name === "クロワッサン"
  )!;
  assert.equal(croissant.quantity, 4);
  assert.equal(croissant.purchase_checks, 2);
  assert.equal(croissant.purchase_check_rate_pct, 50);
  assert.deepEqual(croissant.hourly_quantity, [[11, 4]]);
  assert.equal(detail.facts.co_purchase[0].checks, 2);
  assert.doesNotMatch(detail.block, /PRIVATE-RECEIPT|PRIVATE-TABLE|table_no/);
  assert.match(detail.block, /会計数を客数と呼ばない/);
  for (const target of [0, 1, 3, 99]) {
    assert.equal(
      allocateFoodCourtHourlyTargets(target, detail).reduce(
        (n, r) => n + r.units,
        0,
      ),
      target,
    );
  }
});

test("unknown times stay unknown; KPI hourly targets are scenarios and preserve daily totals", async () => {
  const detail = await buildFoodCourtJournalDetail(
    ranges,
    "",
    async (month) => {
      if (month !== "2025-12") return [];
      const d = day("2025-12-09");
      d.receipts[1].time = "";
      return [d];
    },
  );
  assert.equal(detail.coverage.unknown_time_checks, 1);
  assert.deepEqual(detail.facts.hourly.map((h) => h.hour), [11]);
  const kpi = await prepareFoodCourtKpiScenario({
    question: "KPIを試算してください",
    authorizedStore: "fixture_store",
    salesDates: [],
    salesRanges: ranges,
    journalDetail: detail,
  }, {
    loadProfile: async (store) => ({ store_key: store, profile: null }),
    loadSales: async (s, f, t) => summary(s, f, t),
  });
  assert.ok(kpi);
  assert.match(kpi.block, /仮定\(シナリオ\)/);
  assert.match(kpi.block, /時刻不明/);
  const ref = kpi.reference as any;
  assert.equal(ref.hourly_targets.length, 3);
  for (const scenario of ref.hourly_targets) {
    assert.equal(
      scenario.hours.reduce((n: number, r: any) => n + r.units, 0),
      scenario.daily_target_units,
    );
  }
});
