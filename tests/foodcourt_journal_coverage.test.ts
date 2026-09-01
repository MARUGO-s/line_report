import assert from "node:assert/strict"
import test from "node:test"
import { buildFoodcourtJournalCoverage } from "../supabase/functions/_shared/foodcourt_journal_coverage.ts"

test("Journal boost reports the exact missing July foodcourt dates", () => {
  const usedDates = Array.from({ length: 31 }, (_, index) => {
    const day = String(index + 1).padStart(2, "0")
    return `2026-07-${day}`
  }).filter((date) => date !== "2026-07-17" && date !== "2026-07-22")
  const coverage = buildFoodcourtJournalCoverage(
    [{ from: "2026-07-01", to: "2026-07-31" }],
    usedDates,
  )
  assert.equal(coverage.expected_day_count, 31)
  assert.equal(coverage.covered_day_count, 29)
  assert.equal(coverage.missing_date_count, 2)
  assert.deepEqual(coverage.missing_dates, ["2026-07-17", "2026-07-22"])
  assert.equal(coverage.coverage_status, "partial")
  assert.equal(coverage.sales_basis, "foodcourt_tenant_report_net_tax_excluded")
})

test("overlapping and adjacent ranges merge without double-counting days", () => {
  const coverage = buildFoodcourtJournalCoverage(
    [
      { from: "2026-07-01", to: "2026-07-03" },
      { from: "2026-07-03", to: "2026-07-05" },
      { from: "2026-08-01", to: "2026-08-02" },
    ],
    [
      "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05",
      "2026-08-01", "2026-08-02", "2026-08-02",
    ],
  )
  assert.deepEqual(coverage.requested_ranges, [
    { from: "2026-07-01", to: "2026-07-05" },
    { from: "2026-08-01", to: "2026-08-02" },
  ])
  assert.equal(coverage.expected_day_count, 7)
  assert.equal(coverage.covered_day_count, 7)
  assert.equal(coverage.missing_date_count, 0)
  assert.equal(coverage.coverage_status, "complete")
})
