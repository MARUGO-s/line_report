export type FoodcourtJournalRange = { from: string; to: string }

export type FoodcourtJournalCoverage = {
  requested_ranges: FoodcourtJournalRange[]
  expected_day_count: number
  covered_day_count: number
  missing_date_count: number
  missing_dates: string[]
  missing_dates_truncated: boolean
  coverage_status: "complete" | "partial"
  sales_basis: "foodcourt_tenant_report_net_tax_excluded"
}

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return iso
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function mergeRanges(ranges: FoodcourtJournalRange[]): FoodcourtJournalRange[] {
  const sorted = ranges
    .map((range) => range.from <= range.to ? range : { from: range.to, to: range.from })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  const merged: FoodcourtJournalRange[] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (!last || range.from > addDaysIso(last.to, 1)) {
      merged.push({ ...range })
      continue
    }
    if (range.to > last.to) last.to = range.to
  }
  return merged
}

function inclusiveDayCount(from: string, to: string): number {
  const lo = Date.parse(`${from}T00:00:00Z`)
  const hi = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return 0
  return Math.floor((hi - lo) / 86_400_000) + 1
}

export function buildFoodcourtJournalCoverage(
  ranges: FoodcourtJournalRange[],
  usedDateValues: string[],
  maxMissingDates = 62,
): FoodcourtJournalCoverage {
  const mergedRanges = mergeRanges(ranges)
  const expectedDayCount = mergedRanges.reduce(
    (sum, range) => sum + inclusiveDayCount(range.from, range.to),
    0,
  )
  const usedDates = new Set(
    usedDateValues.filter((date) =>
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      mergedRanges.some((range) => date >= range.from && date <= range.to)
    ),
  )
  const missingDateCount = Math.max(0, expectedDayCount - usedDates.size)
  const missingDates: string[] = []
  const boundedMissingLimit = Math.max(0, Math.min(366, Math.trunc(maxMissingDates) || 0))
  for (const range of mergedRanges) {
    for (let date = range.from; date <= range.to && missingDates.length < boundedMissingLimit; date = addDaysIso(date, 1)) {
      if (!usedDates.has(date)) missingDates.push(date)
    }
    if (missingDates.length >= boundedMissingLimit) break
  }
  return {
    requested_ranges: mergedRanges,
    expected_day_count: expectedDayCount,
    covered_day_count: usedDates.size,
    missing_date_count: missingDateCount,
    missing_dates: missingDates,
    missing_dates_truncated: missingDateCount > missingDates.length,
    coverage_status: missingDateCount === 0 ? "complete" : "partial",
    sales_basis: "foodcourt_tenant_report_net_tax_excluded",
  }
}
