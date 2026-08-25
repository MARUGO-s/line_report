import assert from "node:assert/strict"
import test from "node:test"
import {
  buildPosJournalAiFacts,
} from "../supabase/functions/_shared/pos_journal_ai.ts"

// 2026-05 の実績と同じ形（総売上 1,188,200 / 商品明細 1,160,200 / 差 28,000）を作る。
// 上位5品の合計は 828,800 で、商品明細合計に対して 71.4%。
// この 71.4 を 100 から引いた 28.6% を「未捕捉率」と誤って述べた実例があった。
function summaryFixture() {
  const items = [
    { code: "1", name: "コース6品", qty: 1, amount: 248000 },
    { code: "2", name: "Glass Wine", qty: 1, amount: 203800 },
    { code: "3", name: "SPコース", qty: 1, amount: 136000 },
    { code: "4", name: "コース8品", qty: 1, amount: 130000 },
    { code: "5", name: "Bottle Wine", qty: 1, amount: 111000 },
    { code: "6", name: "ペアリング", qty: 1, amount: 331400 },
  ]
  return {
    meta: { store_key: "bistrocavacava", store_name: "Bistro CAVACAVA", store_code: "1015", month: "2026-05" },
    totals: {
      gross_sales: 1188200,
      net_sales: 1080204,
      tax: 107996,
      groups: 60,
      guests: 134,
      cash_amount: 319000,
      credit_amount: 839200,
    },
    payment_breakdown: {},
    item_ranking: items,
    // grossSales は days の gross_sales 合計から出る（totals ではない）。
    // 合計が 1,188,200 になるよう2日に割る。
    days: [
      { business_date: "2026-05-19", gross_sales: 161300, guests: 14, groups: 6, receipts: [], source: "lzh", weather: "晴" },
      { business_date: "2026-05-20", gross_sales: 1026900, guests: 120, groups: 54, receipts: [], source: "lzh", weather: "曇" },
    ],
  }
}

test("未捕捉の額と率を、AIに逆算させずそのまま渡す", () => {
  const facts = buildPosJournalAiFacts(summaryFixture() as never)
  assert.equal(facts.products.capturedItemSales, 1160200)
  assert.equal(facts.products.uncapturedSales, 28000)
  assert.equal(facts.products.capturedPctOfGrossSales, 97.6)
  // 誤って提示された 28.6 ではなく 2.4 であること
  assert.equal(facts.products.uncapturedPctOfGrossSales, 2.4)
  assert.notEqual(facts.products.uncapturedPctOfGrossSales, 28.6)
})

test("上位5品の構成比は分母が商品明細合計だと分かる名前で渡す", () => {
  const facts = buildPosJournalAiFacts(summaryFixture() as never)
  assert.equal(facts.products.topFiveSharePctOfCapturedItemSales, 71.4)
  assert.match(facts.products.note, /capturedItemSales/)
  assert.match(facts.products.note, /総売上に対する割合ではない/)
})

test("注意書きに未捕捉の実額が入る", () => {
  const facts = buildPosJournalAiFacts(summaryFixture() as never)
  const note = facts.dataNotes.find((n) => n.includes("未捕捉"))
  assert.ok(note, "未捕捉の注記があること")
  assert.match(note, /28000円/)
  assert.match(note, /97\.6%/)
})
