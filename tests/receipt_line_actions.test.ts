import assert from "node:assert/strict"
import test from "node:test"
import {
  buildReceiptAnalyticsDashboardUri,
} from "../supabase/functions/_shared/receipt_line_actions.ts"

// test:receipt（node --test tests/receipt_*.test.ts）と test:structure（deno test）の両方で動くよう node:test で書く

test("LINE売上分析URLはOTP付きで生成される", () => {
  const url = buildReceiptAnalyticsDashboardUri("marugo", "2026-10", {
    loginToken: "lrlt_test-token",
  })
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get("from"), "line", "LINE entry marker is missing")
  assert.equal(parsed.searchParams.get("lt"), "lrlt_test-token", "one-time login token is missing")
  assert.equal(parsed.searchParams.get("v"), "20261007", "stale analytics cache version")
})

test("LINE売上分析URLはOTPなしの通常URLへフォールバックしない", () => {
  const url = buildReceiptAnalyticsDashboardUri("marugo", "2026-10")
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.has("lt"), false, "unexpected login token")
  assert.equal(parsed.searchParams.get("from"), "line", "LINE entry marker is missing")
})
