import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { looksLikeSalesSettlementReceipt, normalizeLineImageReceiptAnalysis } from "../supabase/functions/_shared/receipt_parse.ts";
import { receiptStoreNameMatchesRegistry } from "../supabase/functions/_shared/receipt_store_name_match.ts";
import { resolveBuiltinStoreReceiptPrompt } from "../supabase/functions/_shared/receipt_prompt.ts";

test("LINE petty cash page link opens the spent-on month, not a stale localStorage month", async () => {
  // Deno esm imports を Node で引かないため、ソース規約で担保する。
  const flow = await readFile(new URL("../supabase/functions/_shared/petty_cash_flow.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../public/petty_cash.html", import.meta.url), "utf8");
  assert.match(flow, /export function pettyCashMonthFromSpentOn/);
  assert.match(flow, /params\.set\('month', month\)/);
  assert.match(flow, /buildPettyCashDashboardLink\(supabase, String\(p\.store_partition_key[^)]*\), p\.spent_on\)/);
  assert.match(flow, /const isDup = \/duplicate\|unique\|line_message_id\/i/);
  assert.match(page, /params\.get\('month'\)/);
  assert.match(page, /fromLine \? currentMonth\(\)/);
  assert.match(page, /urlMonth \|\| \(fromLine \? currentMonth/);
});

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

test("matches クラウディアⅡ on the receipt with the registered クラウディア2", () => {
  // 実害: 2026-07-20。印字名「クラウディアⅡ」が登録名「クラウディア2」と一致せず、
  // 自店の日計精算レポートが「別店舗のレシート＝経費候補」として扱われ売上が登録されなかった。
  for (const printed of ["クラウディアⅡ", "クラウディアII", "Claudia2", "クラウディア2"]) {
    assert.equal(
      receiptStoreNameMatchesRegistry("クラウディア2", "claudia2", printed, null, ["0362731083"]),
      true,
      printed,
    );
  }
});

test("still rejects a different store's receipt", () => {
  assert.equal(
    receiptStoreNameMatchesRegistry("クラウディア2", "claudia2", "マルゴ 四谷", null, ["0362731083"]),
    false,
  );
  assert.equal(
    receiptStoreNameMatchesRegistry("クラウディア2", "claudia2", "シェンロン&クラウディア", null, ["0362731083"]),
    false,
  );
});

test("keeps Claudia2 daily settlement fields as printed", () => {
  const receipt = normalizeLineImageReceiptAnalysis({
    store_name: "クラウディアⅡ",
    date: "2026年7月19日",
    net_sales: "772869",
    tax_amount: "77231",
    gross_sales: "850100",
    party_count: "104組",
    guest_count: "248名",
    unit_price: "3428",
  });
  assert.deepEqual(receipt && {
    date: receipt.date,
    netSales: receipt.netSales,
    taxAmount: receipt.taxAmount,
    grossSales: receipt.grossSales,
    partyCount: receipt.partyCount,
    guestCount: receipt.guestCount,
    unitPrice: receipt.unitPrice,
  }, {
    date: "2026年7月19日",
    netSales: "¥772,869",
    taxAmount: "¥77,231",
    grossSales: "¥850,100",
    partyCount: "104組",
    guestCount: "248名",
    unitPrice: "¥3,428",
  });
});

test("includes the Claudia2 daily settlement rule in the vision prompt", () => {
  const prompt = resolveBuiltinStoreReceiptPrompt("claudia2");
  assert.match(prompt, /日計精算レポート＝売上/);
  assert.match(prompt, /純売上¥772,869/);
  assert.match(prompt, /現計.*Square.*gross_sales に使わない/);
});
