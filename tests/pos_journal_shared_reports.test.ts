import {
  buildPosJournalDaysFromSavedReports,
  buildPosJournalSummary,
} from "../supabase/functions/_shared/pos_journal.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`assertEquals failed\nactual: ${a}\nexpected: ${e}`);
  }
}

Deno.test("Journal Report saved sales convert to POS journal days", () => {
  const days = buildPosJournalDaysFromSavedReports([
    {
      id: "monthly-2026-01",
      created_at: "2026-08-12T10:00:00Z",
      data: {
        sourceMonths: ["2026-01"],
        weatherByDate: {
          "2026-01-29": { weather: "晴", tempC: 8 },
        },
        sales: [
          {
            no: "1001",
            date: "2026-01-29",
            time: "18:30",
            total: 12_100,
            tax: 1_100,
            groups: 1,
            customers: 2,
            method: "クレジット",
            payments: { byMethod: { クレジット: 12_100 } },
            items: [
              {
                code: "0000000000101",
                name: "コース",
                qty: 2,
                amount: 12_100,
              },
            ],
          },
        ],
      },
    },
  ], "2026-01");

  assertEquals(days.length, 1);
  assertEquals(days[0].business_date, "2026-01-29");
  assertEquals(days[0].gross_sales, 12_100);
  assertEquals(days[0].net_sales, 11_000);
  assertEquals(days[0].tax, 1_100);
  assertEquals(days[0].groups, 1);
  assertEquals(days[0].guests, 2);
  assertEquals(days[0].weather, "晴");
  assertEquals(days[0].temp_c, 8);
  assertEquals(days[0].pay_credit, { count: 1, amount: 12_100 });
  assertEquals(days[0].receipts[0].items[0], {
    code: "0000000000101",
    name: "コース",
    unit: 6_050,
    qty: 2,
    amount: 12_100,
  });
});

Deno.test("newest saved report wins per business day and other months are ignored", () => {
  const days = buildPosJournalDaysFromSavedReports([
    {
      id: "older",
      created_at: "2026-08-10T10:00:00Z",
      data: {
        sales: [
          { no: "old", date: "2026-01-30", total: 10_000, tax: 900, customers: 1, items: [] },
        ],
      },
    },
    {
      id: "newer",
      created_at: "2026-08-12T10:00:00Z",
      data: {
        sales: [
          { no: "new", date: "2026-01-30", total: 20_000, tax: 1_800, customers: 2, items: [] },
          { no: "feb", date: "2026-02-01", total: 30_000, tax: 2_700, customers: 3, items: [] },
        ],
      },
    },
  ], "2026-01");

  assertEquals(days.length, 1);
  assertEquals(days[0].gross_sales, 20_000);
  assertEquals(days[0].receipts[0].no, "new");
});

Deno.test("oversized Journal Report saves can share posJournalDays without sales", () => {
  const days = buildPosJournalDaysFromSavedReports([
    {
      id: "snapshot-only",
      data: {
        sourceMonths: ["2026-01"],
        sales: [],
        posJournalDays: [
          {
            business_date: "2026-01-31",
            source: "journal_report_saved",
            net_sales: 50_000,
            tax: 5_000,
            gross_sales: 55_000,
            groups: 3,
            guests: 5,
            pay_cash: { count: 1, amount: 10_000 },
            pay_credit: { count: 2, amount: 45_000 },
            weather: "曇",
            temp_c: 7,
            receipts: [
              {
                no: "snapshot-1",
                time: "20:00",
                pay: "クレジット",
                total: 55_000,
                guests: 5,
                items: [{ code: "W1", name: "ボトルワイン", unit: 11_000, qty: 5, amount: 55_000 }],
              },
            ],
          },
        ],
      },
    },
  ], "2026-01");

  assertEquals(days.length, 1);
  assertEquals(days[0].gross_sales, 55_000);
  assertEquals(days[0].pay_credit, { count: 2, amount: 45_000 });
  assertEquals(days[0].receipts[0].items[0].name, "ボトルワイン");
});

Deno.test("shared report days feed the existing POS monthly summary", () => {
  const days = buildPosJournalDaysFromSavedReports([
    {
      id: "monthly",
      data: {
        sales: [
          {
            no: "1",
            date: "2026-01-29",
            total: 12_100,
            tax: 1_100,
            customers: 2,
            payments: { byMethod: { 現金: 12_100 } },
            items: [{ code: "A", name: "料理", qty: 1, amount: 12_100 }],
          },
          {
            no: "2",
            date: "2026-01-30",
            total: 22_000,
            tax: 2_000,
            customers: 4,
            payments: { byMethod: { クレジット: 22_000 } },
            items: [{ code: "B", name: "ワイン", qty: 2, amount: 22_000 }],
          },
        ],
      },
    },
  ], "2026-01");
  const summary = buildPosJournalSummary({
    storeKey: "bistrocavacava",
    storeName: "Bistro CAVACAVA",
    storeCode: "1015",
    month: "2026-01",
    days,
    fileCount: 1,
  });

  assertEquals(summary.meta.day_count, 2);
  assertEquals(summary.totals.gross_sales, 34_100);
  assertEquals(summary.totals.tax, 3_100);
  assertEquals(summary.totals.guests, 6);
  assertEquals(summary.totals.cash_amount, 12_100);
  assertEquals(summary.totals.credit_amount, 22_000);
  assertEquals(summary.item_ranking.map((item) => item.name), ["ワイン", "料理"]);
});
