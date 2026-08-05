import {
  aggregateJournalProductMonthlyRows,
  extractProductLinesFromParsedDay,
  indexRowMatchesProductFilter,
  normalizePosProductSearchText,
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
      receipts: [
        {
          items: [
            { name: "コース８品", code: "1001", unit: 5500, qty: 2, amount: 11000 },
            { name: "", code: "x", unit: 100, qty: 1, amount: 100 },
          ],
        },
        {
          items: [
            { name: "グラスワイン", code: "2001", unit: 900, qty: 1 },
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
