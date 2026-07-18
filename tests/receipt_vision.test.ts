import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeLineImageWithGroqScout,
  isTransientLineImageVisionFailure,
  shouldFallbackLineImageVisionFailure,
} from "../supabase/functions/_shared/receipt_vision.ts";

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
