import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeLineImageWithAzureFoundry,
  analyzeLineImageWithGroqScout,
  isTransientLineImageVisionFailure,
  shouldFallbackLineImageVisionFailure,
} from "../supabase/functions/_shared/receipt_vision.ts";
import {
  EXPENSE_RECEIPT_PROMPT_ADDITION,
  resolveBuiltinStoreReceiptPrompt,
  STORE_RECEIPT_PROMPT_MAX_CHARS,
} from "../supabase/functions/_shared/receipt_prompt.ts";
import {
  normalizeLineImageReceiptAnalysis,
  resolveReceiptDateIsoForPersist,
} from "../supabase/functions/_shared/receipt_parse.ts";

test("expense prompt keeps the SEIYU supplier rule within the configured limit", () => {
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /SEIYU（西友）/);
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /T8011503002037/);
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /税抜金額対象/);
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /購入した\*\*個数\*\*であり、line_items の件数ではない/);
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /総額¥4,288を「パプリカ」等の単一商品 price にしてはいけない/);
  assert.match(EXPENSE_RECEIPT_PROMPT_ADDITION, /商品コードの数字（例「49」「94」）と軽減税率印「※」は税率判定だけに使い、name には絶対に含めない/);
  assert.ok(EXPENSE_RECEIPT_PROMPT_ADDITION.length <= STORE_RECEIPT_PROMPT_MAX_CHARS);
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

test("Marugo S prompt requires both party and guest counts from the daily report footer", () => {
  const prompt = resolveBuiltinStoreReceiptPrompt("marugoS");
  assert.match(prompt, /会計組数・客数/);
  assert.match(prompt, /party_count="106"/);
  assert.match(prompt, /guest_count="112"/);
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
