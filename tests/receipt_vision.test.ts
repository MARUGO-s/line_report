import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeLineImageWithAzureFoundry,
  analyzeLineImageWithGroqScout,
  isTransientLineImageVisionFailure,
  needsGeminiProPettyCashReview,
  shouldFallbackLineImageVisionFailure,
} from "../supabase/functions/_shared/receipt_vision.ts";
import {
  EXPENSE_RECEIPT_PROMPT_ADDITION,
  resolveBuiltinStoreReceiptPrompt,
  STORE_RECEIPT_PROMPT_MAX_CHARS,
} from "../supabase/functions/_shared/receipt_prompt.ts";
import {
  normalizeLineImageReceiptAnalysis,
  isSingleDayPeriodSettlementReport,
  resolveReceiptDateIsoForPersist,
} from "../supabase/functions/_shared/receipt_parse.ts";
import { resolveReceiptReplyDayValues } from "../supabase/functions/_shared/receipt_reply_context.ts";

test("expense prompt keeps the SEIYU supplier rule within the configured limit", () => {
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /SEIYU（西友）/);
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /T8011503002037/);
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /税抜金額対象/);
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /購入した\*\*個数\*\*であり、line_items の件数ではない/);
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /総額¥4,288を「パプリカ」等の単一商品 price にしてはいけない/);
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /商品コードの数字（例「49」「94」）と軽減税率印「※」は税率判定だけに使い、name には絶対に含めない/);
  assert.ok(EXPENSE_RECEIPT_PROMPT_ADDITION.length <= STORE_RECEIPT_PROMPT_MAX_CHARS);
});

test("expense prompt reads the horizontal Yamato Collect sender item and top-right amount", () => {
  assert.match(
    EXPENSE_RECEIPT_PROMPT_ADDITION,
    /横長領収証・発送元欄＋品名欄＋右上金額/,
  );
  assert.match(
    EXPENSE_RECEIPT_PROMPT_ADDITION,
    /後続の一般ヤマトブロックの「品名＝発送元」規則は適用しない/,
  );
  assert.match(
    EXPENSE_RECEIPT_PROMPT_ADDITION,
    /store_name="木次乳業有限会社"/,
  );
  assert.match(
    EXPENSE_RECEIPT_PROMPT_ADDITION,
    /木次パスチャライズ牛乳 1000ml/,
  );
  assert.match(
    EXPENSE_RECEIPT_PROMPT_ADDITION,
    /右上の「代金引換額（税込）」枠内の金額/,
  );
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /5,670円→"¥5,670"/);
  assert.match(
    EXPENSE_RECEIPT_PROMPT_ADDITION,
    /下部のヤマト運輸株式会社.*store_name にしない/,
  );
  assert.match(
    EXPENSE_RECEIPT_PROMPT_ADDITION,
    /横長形式は直前の専用ブロックだけを適用し、本ブロックは適用しない/,
  );
  assert.ok(
    EXPENSE_RECEIPT_PROMPT_ADDITION.length <= STORE_RECEIPT_PROMPT_MAX_CHARS,
  );
});

test("classifies provider failures that should use a fallback", () => {
  assert.equal(
    isTransientLineImageVisionFailure({
      stage: "groq_http_error",
      message: "rate limited",
      httpStatus: 429,
    }),
    true,
  );
  assert.equal(
    isTransientLineImageVisionFailure({
      stage: "groq_http_error",
      message: "invalid key",
      httpStatus: 401,
    }),
    false,
  );
  assert.equal(
    isTransientLineImageVisionFailure({
      stage: "groq_timeout",
      message: "timed out",
    }),
    true,
  );
});

test("falls back for retired models but not invalid image input", () => {
  assert.equal(
    shouldFallbackLineImageVisionFailure({
      stage: "groq_http_error",
      message: "model_not_found",
      httpStatus: 404,
    }),
    true,
  );
  assert.equal(
    shouldFallbackLineImageVisionFailure({
      stage: "invalid_image_size",
      message: "image too large",
    }),
    false,
  );
});

test("upgrades incomplete petty cash analyses to Gemini Pro", () => {
  assert.equal(needsGeminiProPettyCashReview(null), true);
  assert.equal(needsGeminiProPettyCashReview({
    summary: "receipt",
    receipt: { storeName: "SEIYU 練馬Part1", grossSales: "¥4,288", lineItems: [{ name: "パプリカ", price: "¥3,960", rate: 8 }] },
    receiptModelConfidence: 0.9,
  }), true);
  assert.equal(needsGeminiProPettyCashReview({
    summary: "receipt",
    receipt: {
      storeName: "SEIYU 練馬Part1",
      grossSales: "¥4,288",
      lineItems: [
        { name: "レジ袋", price: "¥12", rate: 10 },
        { name: "パプリカ", price: "¥3,960", rate: 8 },
      ],
      taxBreakdown: [{ rate: 8, total: "¥4,276", tax: "¥316" }, { rate: 10, total: "¥12", tax: "¥1" }],
    },
    receiptModelConfidence: 0.9,
  }), false);
});

test("Marugo S prompt requires both party and guest counts from the daily report footer", () => {
  const prompt = resolveBuiltinStoreReceiptPrompt("marugoS");
  assert.match(prompt, /会計組数・客数/);
  assert.match(prompt, /party_count="106"/);
  assert.match(prompt, /guest_count="112"/);
});

test("Marugo daily-settlement prompt preserves both digits of the guest count", () => {
  const prompt = resolveBuiltinStoreReceiptPrompt("marugo");
  assert.match(prompt, /24組 57名/);
  assert.match(prompt, /客数の十の位を落とさない/);
});

test("treats a one-day all-term period report as a reissued daily settlement", () => {
  const oneDay = '売上点検[期間] 取引別点検 日付範囲 開始:2026年07月14日(火) 終了:2026年07月14日(火) 曜日指定:全指定（1日） 分析レベル:合計値';
  const multiDay = '売上点検[期間] 日付範囲 開始:2026年07月01日 終了:2026年07月14日 曜日指定:全指定（14日）';
  assert.equal(isSingleDayPeriodSettlementReport(oneDay), true);
  assert.equal(isSingleDayPeriodSettlementReport(multiDay), false);
  assert.match(resolveBuiltinStoreReceiptPrompt("marugoyotsuya"), /後日再発行/);
});

test("Sauvage prompt maps its handwritten footer by unit, not left-to-right position", () => {
  const prompt = resolveBuiltinStoreReceiptPrompt("sauvage");
  assert.match(prompt, /39人 27組/);
  assert.match(prompt, /guest_count="39"/);
  assert.match(prompt, /party_count="27"/);
});

test("uses the previous business date for receipts printed before 05:00 JST", () => {
  assert.equal(resolveReceiptDateIsoForPersist("2026-07-11 00:12:02"), "2026-07-10");
  assert.equal(resolveReceiptDateIsoForPersist("2026年7月11日 4時59分"), "2026-07-10");
  assert.equal(resolveReceiptDateIsoForPersist("2026-07-11 05:00:00"), "2026-07-11");

  const normalized = normalizeLineImageReceiptAnalysis({
    store_name: "BAR PELOTA",
    date: "2026-07-11 00:12:02",
    gross_sales: "¥489,050",
  });
  assert.equal(normalized?.date, "2026年7月10日");

  const separatelyTimed = normalizeLineImageReceiptAnalysis({
    store_name: "BAR PELOTA",
    date: "2026-07-11",
    receipt_time: "00:12:02",
    gross_sales: "¥489,050",
  });
  assert.equal(separatelyTimed?.date, "2026年7月10日");
  assert.equal(separatelyTimed?.printedTime, "00:12:02");
});

test("Groq image analysis stops after its bounded timeout", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (_input, init) => {
    attempts += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  };

  try {
    const result = await analyzeLineImageWithGroqScout(
      new Uint8Array([1, 2, 3]),
      "image/jpeg",
      "test.jpg",
      "test-key",
      "",
      250,
      0,
    );
    assert.equal(attempts, 2);
    assert.equal(result.analysis, null);
    assert.equal(result.failure?.stage, "groq_timeout");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Azure Foundry image analysis sends Responses API image input and parses JSON", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: "receipt",
        receipt: { store_name: "Test Store", gross_sales: 1200, items: ["item"] },
      }),
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = await analyzeLineImageWithAzureFoundry(
      new Uint8Array([1, 2, 3]),
      "image/jpeg",
      "test.jpg",
      "https://example.services.ai.azure.com/api/projects/test",
      "test-key",
      "gpt-5.4-nano",
    );
    assert.equal(requestUrl, "https://example.services.ai.azure.com/api/projects/test/openai/v1/responses");
    assert.equal(requestBody?.model, "gpt-5.4-nano");
    const input = requestBody?.input as Array<{ content?: Array<{ type?: string; text?: string }> }>;
    assert.match(String(input?.[0]?.content?.find((part) => part.type === "input_text")?.text ?? ""), /JSON/);
    assert.equal(result.failure, null);
    assert.equal(result.analysis?.receipt?.storeName, "Test Store");
    assert.equal(result.usage?.totalTokens, 30);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Azure Foundry image analysis stops after its bounded timeout", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (_input, init) => {
    attempts += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  };

  try {
    const result = await analyzeLineImageWithAzureFoundry(
      new Uint8Array([1, 2, 3]),
      "image/jpeg",
      "test.jpg",
      "https://example.services.ai.azure.com/api/projects/test",
      "test-key",
      "gpt-5.4-nano",
      "",
      250,
      0,
    );
    assert.equal(attempts, 2);
    assert.equal(result.analysis, null);
    assert.equal(result.failure?.stage, "azure_foundry_timeout");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps evening settlements on the printed day (22時 is not 2時)", () => {
  // 実害: "2026年7月19日 22:36:00" の 22 が 2 と読まれ、マルゴ四谷の日計が 07-18 に登録された。
  assert.equal(resolveReceiptDateIsoForPersist("2026年7月19日 22:36:00"), "2026-07-19");
  assert.equal(resolveReceiptDateIsoForPersist("2026年 7月19日(日)22時36分000101"), "2026-07-19");
  assert.equal(resolveReceiptDateIsoForPersist("2026-07-19 21:05:00"), "2026-07-19");
  // 深夜の精算は従来どおり前営業日へ寄せる。
  assert.equal(resolveReceiptDateIsoForPersist("2026年7月20日 01:09:01"), "2026-07-19");

  const normalized = normalizeLineImageReceiptAnalysis({
    store_name: "マルゴ 四谷",
    date: "2026年7月19日",
    receipt_time: "22:36:00",
    gross_sales: "¥353,900",
  });
  assert.equal(normalized?.date, "2026年7月19日");
});

test("moves a 「◯組」 misread out of guest_count and drops the derived unit price", () => {
  const receipt = normalizeLineImageReceiptAnalysis({
    store_name: "マルゴ 四谷",
    date: "2026年7月19日",
    gross_sales: "¥353,900",
    guest_count: "33組",
    unit_price: "¥10,724",
  });
  assert.equal(receipt?.partyCount, "33組");
  assert.equal(receipt?.guestCount, null);
  assert.equal(receipt?.unitPrice, null);
});

test("keeps 組数 and 客数 in their own fields", () => {
  const receipt = normalizeLineImageReceiptAnalysis({
    gross_sales: "¥913,900",
    party_count: "86組",
    guest_count: "220名",
  });
  assert.equal(receipt?.partyCount, "86組");
  assert.equal(receipt?.guestCount, "220名");
  assert.equal(receipt?.unitPrice, "¥4,154");
});

test("uses the stored daily aggregate in the reply after a duplicate receipt is added", () => {
  const values = resolveReceiptReplyDayValues({
    net: 444_018,
    tax: 44_382,
    gross: 488_400,
    party: 48,
    guest: 114,
  }, {
    storeName: "マルゴ",
    storePhone: null,
    date: "2026年7月19日",
    netSales: "¥222,009",
    taxAmount: "¥22,191",
    grossSales: "¥244,200",
    partyCount: "24組",
    guestCount: "57名",
    unitPrice: "¥4,284",
    items: [],
  });
  assert.deepEqual(values, {
    taxAmountYen: 44_382,
    grossSalesYen: 488_400,
    partyCount: 48,
    guestCount: 114,
    unitPriceYen: 4_284,
  });
});

test("swaps 組数/客数 when the model puts them in the wrong fields", () => {
  const receipt = normalizeLineImageReceiptAnalysis({
    party_count: "220名",
    guest_count: "86組",
  });
  assert.equal(receipt?.partyCount, "86組");
  assert.equal(receipt?.guestCount, "220名");
});

test("un-swaps 純売上/総売上 when net = gross + tax", () => {
  // 実害: マルゴグランデ 2026-07-19（純¥830,858 税¥83,042 総¥913,900）が逆転して登録された。
  const receipt = normalizeLineImageReceiptAnalysis({
    net_sales: "¥913,900",
    tax_amount: "¥83,042",
    gross_sales: "¥830,858",
  });
  assert.equal(receipt?.netSales, "¥830,858");
  assert.equal(receipt?.grossSales, "¥913,900");
  assert.equal(receipt?.taxAmount, "¥83,042");
});

test("leaves 純売上/総売上 alone when they are already consistent", () => {
  const receipt = normalizeLineImageReceiptAnalysis({
    net_sales: "¥830,858",
    tax_amount: "¥83,042",
    gross_sales: "¥913,900",
  });
  assert.equal(receipt?.netSales, "¥830,858");
  assert.equal(receipt?.grossSales, "¥913,900");
});

test("keeps 総売上 as printed when it is not a tax-swapped pair", () => {
  // 出前の預かり金などで net > gross でも、gross + tax と一致しなければ触らない。
  const receipt = normalizeLineImageReceiptAnalysis({
    net_sales: "¥500,000",
    tax_amount: "¥30,000",
    gross_sales: "¥400,000",
  });
  assert.equal(receipt?.netSales, "¥500,000");
  assert.equal(receipt?.grossSales, "¥400,000");
});

test("recomputes 消費税 from 総売上 − 純売上 when the model misreads a digit", () => {
  // 実害: マルゴエス 2026-07-19 で 消費税¥21,029 が ¥41,029 と読まれた。
  const receipt = normalizeLineImageReceiptAnalysis({
    net_sales: "¥211,886",
    tax_amount: "¥41,029",
    gross_sales: "¥232,915",
  });
  assert.equal(receipt?.taxAmount, "¥21,029");
});

test("leaves 消費税 alone on tax-inclusive receipts where net equals gross", () => {
  const receipt = normalizeLineImageReceiptAnalysis({
    net_sales: "¥10,000",
    tax_amount: "¥909",
    gross_sales: "¥10,000",
  });
  assert.equal(receipt?.taxAmount, "¥909");
});
