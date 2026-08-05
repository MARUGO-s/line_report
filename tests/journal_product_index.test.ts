import assert from "node:assert/strict"
import test from "node:test"
import {
  aggregateJournalProductMonthlyRows,
  extractProductLinesFromParsedDay,
  indexRowMatchesProductFilter,
  normalizePosProductSearchText,
} from "../supabase/functions/_shared/journal_product_index.ts"

test("normalizePosProductSearchText keeps search-compatible course/sp rules", () => {
  // 長音・半角長音・コース・スペシャルは検索側と同一規則で正規化する
  assert.equal(normalizePosProductSearchText("ＳＰコース"), "spコ-ス")
  assert.equal(normalizePosProductSearchText("スペシャルコース"), "spコ-ス")
  assert.equal(normalizePosProductSearchText("コース８品"), "コ-ス8品")
  assert.equal(normalizePosProductSearchText("赤ワイン　ボトル"), "赤ワインボトル")
})

test("extractProductLinesFromParsedDay reads receipts.items", () => {
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
  )
  assert.equal(lines.length, 2)
  assert.equal(lines[0].year_month, "2026-07")
  assert.equal(lines[0].qty, 2)
  assert.equal(lines[1].amount, 900)
})

test("aggregateJournalProductMonthlyRows merges same norm×unit and picks display by qty", () => {
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
  ])
  assert.equal(rows.length, 2)
  const main = rows.find((r) => r.unit_price === 5500)!
  assert.equal(main.product_name_norm, "spコ-ス")
  assert.equal(main.qty, 4)
  assert.equal(main.amount, 22000)
  assert.equal(main.day_count, 2)
  assert.equal(main.display_name, "SPコース")
  assert.equal(main.first_date, "2026-07-01")
  assert.equal(main.last_date, "2026-07-10")
})

test("indexRowMatchesProductFilter mirrors course alias loose match", () => {
  const row = {
    product_name_norm: normalizePosProductSearchText("季節の特選コース"),
    product_code: "",
    unit_price: 7000,
  }
  assert.equal(
    indexRowMatchesProductFilter(row, {
      tokens: ["季節", "コ-ス"],
      joinedQ: "季節コ-ス",
      codeNorm: "",
      unitMin: null,
      unitMax: null,
    }),
    true,
  )
  assert.equal(
    indexRowMatchesProductFilter(row, {
      tokens: ["存在しない"],
      joinedQ: "存在しない",
      codeNorm: "",
      unitMin: 10000,
      unitMax: 10000,
    }),
    false,
  )
})
