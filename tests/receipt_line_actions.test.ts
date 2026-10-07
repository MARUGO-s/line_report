import {
  buildReceiptAnalyticsDashboardUri,
} from "../supabase/functions/_shared/receipt_line_actions.ts"

Deno.test("LINE売上分析URLはOTP付きで生成される", () => {
  const url = buildReceiptAnalyticsDashboardUri("marugo", "2026-10", {
    loginToken: "lrlt_test-token",
  })
  const parsed = new URL(url)
  if (parsed.searchParams.get("from") !== "line") throw new Error("LINE entry marker is missing")
  if (parsed.searchParams.get("lt") !== "lrlt_test-token") throw new Error("one-time login token is missing")
  if (parsed.searchParams.get("v") !== "20261007") throw new Error("stale analytics cache version")
})

Deno.test("LINE売上分析URLはOTPなしの通常URLへフォールバックしない", () => {
  const url = buildReceiptAnalyticsDashboardUri("marugo", "2026-10")
  const parsed = new URL(url)
  if (parsed.searchParams.has("lt")) throw new Error("unexpected login token")
  if (parsed.searchParams.get("from") !== "line") throw new Error("LINE entry marker is missing")
})
