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

Deno.test("supplier receipt discounts stay negative and reconcile the cash-out total", () => {
  const expense = extractExpenseFromReceipt({
    storeName: "業務食材店",
    date: "2026年9月11日",
    netSales: "¥2,664",
    taxAmount: "¥212",
    grossSales: "¥2,876",
    partyCount: null,
    guestCount: null,
    unitPrice: null,
    storePhone: null,
    items: [],
    lineItems: [
      { name: "ねぎ (6個 x @167)", price: "¥1,002", rate: 8 },
      { name: "きゅうり (2個 x @286)", price: "¥572", rate: 8 },
      { name: "料理酒", price: "¥199", rate: 8 },
      { name: "すりゴマ白", price: "¥219", rate: 8 },
      { name: "片栗粉", price: "¥189", rate: 8 },
      { name: "和風キムチ (2個 x @299)", price: "¥598", rate: 8 },
      { name: "割引 20%", price: "¥120", rate: 8 },
      { name: "レジ袋3L", price: "¥5", rate: 10 },
    ],
    taxBreakdown: [],
  });

  assertEquals(expense && {
    amount: expense.amount,
    tax: expense.tax,
    taxMode: expense.taxMode,
    items: expense.items,
  }, {
    amount: 2_876,
    tax: 212,
    taxMode: "ex",
    items: [
      { n: "ねぎ (6個 x @167)", p: 1_002, acct: "shokuzai", rate: 8 },
      { n: "きゅうり (2個 x @286)", p: 572, acct: "shokuzai", rate: 8 },
      { n: "料理酒", p: 199, acct: "shokuzai", rate: 8 },
      { n: "すりゴマ白", p: 219, acct: "shokuzai", rate: 8 },
      { n: "片栗粉", p: 189, acct: "shokuzai", rate: 8 },
      { n: "和風キムチ (2個 x @299)", p: 598, acct: "shokuzai", rate: 8 },
      { n: "割引 20%", p: -120, acct: "shokuzai", rate: 8 },
      { n: "レジ袋3L", p: 5, acct: "shomohin", rate: 10 },
    ],
  });
});
