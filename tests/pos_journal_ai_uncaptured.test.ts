import { buildPosJournalAiFacts } from "../supabase/functions/_shared/pos_journal_ai.ts";

function assertEquals(actual: unknown, expected: unknown, label = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`assertEquals failed ${label}\nactual: ${a}\nexpected: ${e}`);
  }
}
function assertIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`,
    );
  }
}

// 2026-05 の実績と同じ形。総売上 1,188,200 / 商品明細 1,160,200 / 差 28,000。
// 上位5品の合計 828,800 は商品明細合計の 71.4%。
// この 71.4 を 100 から引いた 28.6% を「未捕捉率」と誤って述べた実例があった。
function summaryFixture() {
  return {
    meta: {
      store_key: "bistrocavacava",
      store_name: "Bistro CAVACAVA",
      store_code: "1015",
      month: "2026-05",
    },
    totals: { net_sales: 1080204, tax: 107996, groups: 60, guests: 134 },
    payment_breakdown: {},
    item_ranking: [
      { code: "1", name: "コース6品", qty: 1, amount: 248000 },
      { code: "2", name: "Glass Wine", qty: 1, amount: 203800 },
      { code: "3", name: "SPコース", qty: 1, amount: 136000 },
      { code: "4", name: "コース8品", qty: 1, amount: 130000 },
      { code: "5", name: "Bottle Wine", qty: 1, amount: 111000 },
      { code: "6", name: "ペアリング", qty: 1, amount: 331400 },
    ],
    // grossSales は days の gross_sales 合計から出る（totals ではない）。
    days: [
      { business_date: "2026-05-19", gross_sales: 161300, guests: 14, groups: 6, receipts: [], source: "lzh", weather: "晴" },
      { business_date: "2026-05-20", gross_sales: 1026900, guests: 120, groups: 54, receipts: [], source: "lzh", weather: "曇" },
    ],
  };
}

Deno.test("未捕捉の額と率をAIに逆算させず実額で渡す", () => {
  // deno-lint-ignore no-explicit-any
  const facts = buildPosJournalAiFacts(summaryFixture() as any);
  assertEquals(facts.products.capturedItemSales, 1160200, "商品明細合計");
  assertEquals(facts.products.uncapturedSales, 28000, "未捕捉額");
  assertEquals(facts.products.capturedPctOfGrossSales, 97.6, "捕捉率");
  // 誤って提示された 28.6 ではなく 2.4 であること
  assertEquals(facts.products.uncapturedPctOfGrossSales, 2.4, "未捕捉率");
});

Deno.test("上位5品の構成比は分母が分かる名前で渡す", () => {
  // deno-lint-ignore no-explicit-any
  const facts = buildPosJournalAiFacts(summaryFixture() as any);
  assertEquals(facts.products.topFiveSharePctOfCapturedItemSales, 71.4);
  assertIncludes(facts.products.note, "capturedItemSales");
  assertIncludes(facts.products.note, "総売上に対する割合ではない");
});

Deno.test("注意書きに未捕捉の実額と捕捉率が入る", () => {
  // deno-lint-ignore no-explicit-any
  const facts = buildPosJournalAiFacts(summaryFixture() as any);
  const note = facts.dataNotes.find((n: string) => n.includes("未捕捉")) ?? "";
  assertIncludes(note, "28000円");
  assertIncludes(note, "97.6%");
});
