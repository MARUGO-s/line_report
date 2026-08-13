import { extractExpenseFromReceipt } from "../supabase/functions/_shared/petty_cash_flow.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`assertEquals failed\nactual: ${a}\nexpected: ${e}`);
}

Deno.test("Yamato horizontal collect receipt keeps its sender item and tax-inclusive amount", () => {
  const expense = extractExpenseFromReceipt({
    storeName: "木次乳業有限会社",
    date: "2026年8月13日",
    netSales: null,
    taxAmount: null,
    grossSales: "¥5,670",
    partyCount: null,
    guestCount: null,
    unitPrice: null,
    storePhone: null,
    items: ["木次パスチャライズ牛乳 1000ml"],
    lineItems: [{
      name: "木次パスチャライズ牛乳 1000ml",
      price: "¥5,670",
      rate: 8,
    }],
    taxBreakdown: [],
  });

  assertEquals(expense && {
    amount: expense.amount,
    tax: expense.tax,
    spentOn: expense.spentOn,
    supplier: expense.supplier,
    taxMode: expense.taxMode,
    item: expense.item,
    items: expense.items,
  }, {
    amount: 5_670,
    tax: 420,
    spentOn: "2026-08-13",
    supplier: "木次乳業有限会社",
    taxMode: "in",
    item: "・木次パスチャライズ牛乳 1000ml ¥5,250",
    items: [{
      n: "木次パスチャライズ牛乳 1000ml",
      p: 5_250,
      acct: "shokuzai",
      rate: 8,
    }],
  });
});
