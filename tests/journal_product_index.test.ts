import {
  aggregateJournalProductMonthlyRows,
  extractNetProductItemsFromReceipt,
  extractProductLinesFromParsedDay,
  indexRowMatchesProductFilter,
  normalizePosProductSearchText,
  reconcileParsedJournalDayDetail,
  summarizeJournalProductDetailCoverage,
} from "../supabase/functions/_shared/journal_product_index.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`assertEquals failed\nactual: ${a}\nexpected: ${e}`);
  }
}

Deno.test("normalizePosProductSearchText keeps search-compatible course/sp rules", () => {
  // 長音・半角長音・コース・スペシャルは検索側と同一規則で正規化する
  assertEquals(normalizePosProductSearchText("ＳＰコース"), "spコ-ス");
  assertEquals(normalizePosProductSearchText("スペシャルコース"), "spコ-ス");
  assertEquals(normalizePosProductSearchText("コース８品"), "コ-ス8品");
  assertEquals(normalizePosProductSearchText("赤ワイン　ボトル"), "赤ワインボトル");
});

Deno.test("extractProductLinesFromParsedDay reads receipts.items", () => {
  const lines = extractProductLinesFromParsedDay(
    {
      gross_sales: 11900,
      receipts: [
        {
          total: 11000,
          items: [
            { name: "コース８品", code: "1001", unit: 5500, qty: 2, amount: 11000 },
            { name: "", code: "x", unit: 0, qty: 1, amount: 0 },
          ],
        },
        {
          total: 900,
          items: [
            { name: "グラスワイン", code: "2001", unit: 900, qty: 1, amount: 900 },
          ],
        },
      ],
    },
    "2026-07-15",
  );
  assertEquals(lines.length, 2);
  assertEquals(lines[0].year_month, "2026-07");
  assertEquals(lines[0].qty, 2);
  assertEquals(lines[1].amount, 900);
});

Deno.test("product detail excludes a day whose reconciled receipts do not equal gross sales", () => {
  const parsed = {
    gross_sales: 10000,
    receipts: [{
      total: 6000,
      guests: 2,
      items: [{ name: "コース８品", code: "1001", unit: 6000, qty: 1, amount: 6000 }],
    }],
  };
  const detail = reconcileParsedJournalDayDetail(
    parsed,
    "2026-08-10",
    "2026-08",
  )!;
  assertEquals(detail.detail_complete, false);
  assertEquals(detail.receipts, []);
  assertEquals(
    extractProductLinesFromParsedDay(parsed, "2026-08-10", "2026-08"),
    [],
  );
  assertEquals(summarizeJournalProductDetailCoverage([detail]), {
    status: "incomplete",
    policy: "receipt_and_item_totals_match_gross_sales",
    scanned_days: 1,
    detail_complete_days: 0,
    detail_incomplete_days: 1,
    gross_mismatch_days: 1,
    item_mismatch_days: 0,
    item_mismatch_receipts: 0,
    complete_gross_sales: 0,
    excluded_gross_sales: 10000,
    incomplete_dates: ["2026-08-10"],
  });
});

Deno.test("product detail rejects unexplained item totals and excludes explicit adjustments", () => {
  const stale = {
    gross_sales: 1000,
    receipts: [{
      total: 1000,
      items: [{ name: "商品", code: "1001", unit: 1100, qty: 1, amount: 1100 }],
    }],
  };
  const detail = reconcileParsedJournalDayDetail(
    stale,
    "2026-08-11",
    "2026-08",
  )!;
  assertEquals(detail.detail_complete, false);
  assertEquals(detail.reason, "item_mismatch");
  assertEquals(detail.raw_item_total, 1100);
  assertEquals(detail.reconciled_item_total, 1100);
  assertEquals(detail.item_mismatch_receipt_count, 1);
  assertEquals(summarizeJournalProductDetailCoverage([detail]), {
    status: "incomplete",
    policy: "receipt_and_item_totals_match_gross_sales",
    scanned_days: 1,
    detail_complete_days: 0,
    detail_incomplete_days: 1,
    gross_mismatch_days: 0,
    item_mismatch_days: 1,
    item_mismatch_receipts: 1,
    complete_gross_sales: 0,
    excluded_gross_sales: 1000,
    incomplete_dates: ["2026-08-11"],
  });

  const reconciled = {
    gross_sales: 900,
    receipts: [{
      total: 900,
      items: [
        { name: "商品", code: "1001", unit: 1000, qty: 1, amount: 1000 },
        {
          name: "割引",
          code: "__journal_adjustment__",
          unit: -100,
          qty: 1,
          amount: -100,
        },
      ],
    }],
  };
  const lines = extractProductLinesFromParsedDay(
    reconciled,
    "2026-08-12",
    "2026-08",
  );
  assertEquals(lines.map((line) => line.code), ["1001"]);

  const net = extractNetProductItemsFromReceipt({
    items: [
      { name: "変更前", code: "old", unit: 3200, qty: 4, amount: 12800 },
      { name: "変更前", code: "old", unit: 3200, qty: -4, amount: -12800 },
      { name: "変更後", code: "new", unit: 3000, qty: 2, amount: 6000 },
      {
        name: "割引",
        code: "__journal_adjustment__",
        unit: -600,
        qty: 1,
        amount: -600,
      },
    ],
  });
  assertEquals(net, [{
    name: "変更後",
    code: "new",
    unit: 3000,
    qty: 2,
    amount: 6000,
  }]);
});

Deno.test("aggregateJournalProductMonthlyRows merges same norm×unit and picks display by qty", () => {
  const rows = aggregateJournalProductMonthlyRows("bistrocavacava", [
    {
      name: "ＳＰコース",
      code: "1",
      unit: 5500,
      qty: 1,
      amount: 5500,
      business_date: "2026-07-01",
      year_month: "2026-07",
    },
    {
      name: "SPコース",
      code: "1",
      unit: 5500,
      qty: 3,
      amount: 16500,
      business_date: "2026-07-10",
      year_month: "2026-07",
    },
    {
      name: "SPコース",
      code: "1",
      unit: 6000,
      qty: 1,
      amount: 6000,
      business_date: "2026-07-11",
      year_month: "2026-07",
    },
  ]);
  assertEquals(rows.length, 2);
  const main = rows.find((r) => r.unit_price === 5500)!;
  assertEquals(main.product_name_norm, "spコ-ス");
  assertEquals(main.qty, 4);
  assertEquals(main.amount, 22000);
  assertEquals(main.day_count, 2);
  assertEquals(main.display_name, "SPコース");
  assertEquals(main.first_date, "2026-07-01");
  assertEquals(main.last_date, "2026-07-10");
});

Deno.test("indexRowMatchesProductFilter mirrors course alias loose match", () => {
  const row = {
    product_name_norm: normalizePosProductSearchText("季節の特選コース"),
    product_code: "",
    unit_price: 7000,
  };
  assertEquals(
    indexRowMatchesProductFilter(row, {
      tokens: ["季節", "コ-ス"],
      joinedQ: "季節コ-ス",
      codeNorm: "",
      unitMin: null,
      unitMax: null,
    }),
    true,
  );
  assertEquals(
    indexRowMatchesProductFilter(row, {
      tokens: ["存在しない"],
      joinedQ: "存在しない",
      codeNorm: "",
      unitMin: 10000,
      unitMax: 10000,
    }),
    false,
  );
});
