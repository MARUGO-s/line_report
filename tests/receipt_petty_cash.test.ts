import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeSalesSettlementReceipt } from "../supabase/functions/_shared/receipt_parse.ts";

test("recognises a daily sales settlement report as sales, never as an expense", () => {
  // 実害: 2026-07-20 クラウディア2。「経費」先打ちの画像待ち中に日計精算レポートを送ったため、
  // 売上 ¥850,100 が小口現金の出金として記録されかけた。
  assert.equal(
    looksLikeSalesSettlementReceipt({
      storeName: "クラウディアII",
      date: "2026年7月19日",
      netSales: "¥772,869",
      taxAmount: "¥77,231",
      grossSales: "¥850,100",
      partyCount: null,
      guestCount: null,
      unitPrice: "¥3,428",
      storePhone: null,
      items: [],
      lineItems: [
        { name: "純売上", price: "¥772,869", rate: null },
        { name: "消費税", price: "¥77,231", rate: null },
        { name: "総売上", price: "¥850,100", rate: null },
        { name: "現計", price: "¥315,980", rate: null },
        { name: "Square", price: "¥42,170", rate: null },
      ],
      taxBreakdown: [],
    }),
    true,
  );

  // 会計組数・客数がある時点で売上精算レポート（仕入先レシートには無い項目）。
  assert.equal(
    looksLikeSalesSettlementReceipt({
      storeName: "マルゴ 四谷",
      partyCount: "33組",
      guestCount: "98名",
      date: null,
      netSales: null,
      taxAmount: null,
      grossSales: "¥353,900",
      unitPrice: null,
      storePhone: null,
      items: [],
      lineItems: [],
      taxBreakdown: [],
    }),
    true,
  );
});

test("treats an ordinary supplier receipt as an expense", () => {
  const supplier = {
    storeName: "クック-Y",
    date: "2026年7月19日",
    netSales: "¥3,960",
    taxAmount: "¥316",
    grossSales: "¥4,276",
    partyCount: null,
    guestCount: null,
    unitPrice: null,
    storePhone: "03-5367-2825",
    items: [],
    lineItems: [
      { name: "パプリカ", price: "¥3,960", rate: 8 },
      { name: "シンショクヒンヨウL", price: "¥316", rate: 10 },
    ],
    taxBreakdown: [],
  };
  assert.equal(looksLikeSalesSettlementReceipt(supplier), false);
});
