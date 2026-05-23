import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { LineImageReceiptAnalysis } from './receipt_types.ts'
import {
  parseCurrencyAmount,
  parseIntegerCount,
} from './receipt_parse.ts'
import {
  allocateDailyBudgetsForMonth,
  enumerateMonthDates,
  getDefaultJapaneseHolidaySet,
  getJstBusinessDateForReceiptBudget,
  mergeStoreClosedDateLists,
  shouldDeferDailyBudgetUntilJstOpen,
  type SalesBudgetAllocationWeights,
} from './sales_budget_allocation.ts'

export type ReceiptReplyContext = {
  storeDisplayName: string
  storePartitionKey: string
  receiptDateText: string
  receiptDateIso: string
  taxAmountYen: number | null
  grossSalesYen: number | null
  partyCount: number | null
  guestCount: number | null
  unitPriceYen: number | null
  monthGrossSalesYen: number | null
  monthPartyCount: number | null
  monthGuestCount: number | null
  businessDays: number | null
  monthDailyAvgGross: number | null
  monthDailyAvgParty: number | null
  monthDailyAvgGuest: number | null
  monthBudgetYen: number | null
  monthBudgetAchievementPct: number | null
  dailyBudgetYen: number | null
  dailyBudgetDiffYen: number | null
  cumulativeBudgetDiffYen: number | null
  yoyPeriodLabel: string | null
  yoySalesPct: number | null
  yoySalesDiffYen: number | null
  yoyPartyPct: number | null
  yoyPartyDiff: number | null
  yoyGuestPct: number | null
  yoyGuestDiff: number | null
  yoyBusinessDaysPct: number | null
  yoyBusinessDaysDiff: number | null
  lineMessageId: string
  targetMonth: string
}

type MonthAgg = {
  gross: number
  party: number
  guest: number
  businessDays: number
  byDate: Map<string, { gross: number; party: number; guest: number }>
}

function parsePositiveWeight(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

function pctChange(current: number, prior: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(prior) || prior === 0) return null
  return ((current - prior) / prior) * 100
}

function formatSignedPct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

async function fetchBudgetForStoreMonth(
  supabase: SupabaseClient,
  storePartitionKey: string,
  month: string,
) {
  const { data, error } = await supabase
    .from('line_sales_month_budgets')
    .select('budget_yen, weekday_weight, pre_holiday_weight, holiday_weight, store_closed_dates')
    .eq('store_partition_key', storePartitionKey)
    .eq('target_month', month)
    .maybeSingle()
  if (error || !data) return null
  const budgetYen = Math.max(0, Math.round(Number((data as { budget_yen?: unknown }).budget_yen ?? 0)))
  if (budgetYen <= 0) return null

  const { data: closedRows } = await supabase
    .from('line_sales_month_store_closed_days')
    .select('closed_on')
    .eq('store_partition_key', storePartitionKey)
    .eq('target_month', month)
  const tableDates = (Array.isArray(closedRows) ? closedRows : [])
    .map((row) => String((row as { closed_on?: unknown }).closed_on ?? '').trim().slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  const storeClosedDates = mergeStoreClosedDateLists(
    tableDates,
    (data as { store_closed_dates?: unknown }).store_closed_dates,
    month,
  )
  return {
    budget_yen: budgetYen,
    weekday_weight: parsePositiveWeight((data as { weekday_weight?: unknown }).weekday_weight, 1),
    pre_holiday_weight: parsePositiveWeight((data as { pre_holiday_weight?: unknown }).pre_holiday_weight, 1.5),
    holiday_weight: parsePositiveWeight((data as { holiday_weight?: unknown }).holiday_weight, 2),
    store_closed_dates: storeClosedDates,
  }
}

async function loadMonthAggUpToDate(
  supabase: SupabaseClient,
  receiptTable: string,
  month: string,
  endDateIso: string,
): Promise<MonthAgg> {
  const empty: MonthAgg = { gross: 0, party: 0, guest: 0, businessDays: 0, byDate: new Map() }
  const startDateStr = `${month}-01`
  const endParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDateIso)
  if (!endParts) return empty
  const y = Number(endParts[1])
  const mo = Number(endParts[2])
  const d = Number(endParts[3])
  const next = new Date(Date.UTC(y, mo - 1, d + 1))
  const endDateStr = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`

  const { data, error } = await supabase
    .from(receiptTable)
    .select('receipt_date, gross_sales_yen, party_count, guest_count')
    .gte('receipt_date', startDateStr)
    .lt('receipt_date', endDateStr)
    .limit(20000)

  if (error || !Array.isArray(data)) return empty

  const byDate = new Map<string, { gross: number; party: number; guest: number }>()
  let gross = 0
  let party = 0
  let guest = 0

  for (const row of data) {
    const dateKey = String((row as { receipt_date?: unknown }).receipt_date ?? '').trim().slice(0, 10)
    if (!dateKey.startsWith(month)) continue
    const g = Number((row as { gross_sales_yen?: unknown }).gross_sales_yen)
    const p = Number((row as { party_count?: unknown }).party_count)
    const gu = Number((row as { guest_count?: unknown }).guest_count)
    const gVal = Number.isFinite(g) ? g : 0
    const pVal = Number.isFinite(p) ? p : 0
    const guVal = Number.isFinite(gu) ? gu : 0
    gross += gVal
    party += pVal
    guest += guVal
    const prev = byDate.get(dateKey) ?? { gross: 0, party: 0, guest: 0 }
    prev.gross += gVal
    prev.party += pVal
    prev.guest += guVal
    byDate.set(dateKey, prev)
  }

  return {
    gross,
    party,
    guest,
    businessDays: byDate.size,
    byDate,
  }
}

function computeBudgetDiffs(
  month: string,
  receiptDateIso: string,
  monthAgg: MonthAgg,
  budgetRow: NonNullable<Awaited<ReturnType<typeof fetchBudgetForStoreMonth>>>,
) {
  const weights: SalesBudgetAllocationWeights = {
    weekday: budgetRow.weekday_weight,
    pre_holiday: budgetRow.pre_holiday_weight,
    holiday: budgetRow.holiday_weight,
  }
  const holidaySet = getDefaultJapaneseHolidaySet()
  const storeClosedSet = new Set(budgetRow.store_closed_dates)
  const dailyBudgetMap = allocateDailyBudgetsForMonth(
    month,
    budgetRow.budget_yen,
    weights,
    holidaySet,
    storeClosedSet,
  )
  const progressDay = getJstBusinessDateForReceiptBudget()
  const monthDays = enumerateMonthDates(month)
  const endDay = receiptDateIso < progressDay ? receiptDateIso : progressDay

  let cumulativeDiff = 0
  let dailyBudgetYen: number | null = null
  let dailyBudgetDiffYen: number | null = null

  for (const day of monthDays) {
    if (day > endDay) break
    const budget = dailyBudgetMap.get(day) ?? 0
    const actual = monthAgg.byDate.get(day)?.gross ?? 0
    if (day === receiptDateIso) {
      dailyBudgetYen = budget
      if (shouldDeferDailyBudgetUntilJstOpen({ receiptDateIso: day, storeClosed: storeClosedSet })) {
        dailyBudgetDiffYen = 0
      } else {
        dailyBudgetDiffYen = Math.round(actual - budget)
      }
    }
    if (day <= progressDay) {
      cumulativeDiff += Math.round(actual - budget)
    }
  }

  const monthBudgetAchievementPct = budgetRow.budget_yen > 0
    ? (monthAgg.gross / budgetRow.budget_yen) * 100
    : null

  return {
    monthBudgetYen: budgetRow.budget_yen,
    monthBudgetAchievementPct,
    dailyBudgetYen,
    dailyBudgetDiffYen,
    cumulativeBudgetDiffYen: cumulativeDiff,
  }
}

export async function loadReceiptReplyContext(
  supabase: SupabaseClient,
  params: {
    storePartitionKey: string
    storeDisplayName: string
    receiptTable: string
    receipt: LineImageReceiptAnalysis
    receiptDateIso: string
    lineMessageId: string
  },
): Promise<ReceiptReplyContext> {
  const month = params.receiptDateIso.slice(0, 7)
  const monthAgg = await loadMonthAggUpToDate(
    supabase,
    params.receiptTable,
    month,
    params.receiptDateIso,
  )

  const budgetRow = await fetchBudgetForStoreMonth(supabase, params.storePartitionKey, month)
  const budget = budgetRow
    ? computeBudgetDiffs(month, params.receiptDateIso, monthAgg, budgetRow)
    : {
      monthBudgetYen: null,
      monthBudgetAchievementPct: null,
      dailyBudgetYen: null,
      dailyBudgetDiffYen: null,
      cumulativeBudgetDiffYen: null,
    }

  const priorYear = Number(month.slice(0, 4)) - 1
  const priorMonth = `${priorYear}-${month.slice(5, 7)}`
  const priorEndDate = `${priorYear}-${params.receiptDateIso.slice(5, 10)}`
  const priorAgg = await loadMonthAggUpToDate(
    supabase,
    params.receiptTable,
    priorMonth,
    priorEndDate,
  )

  const yoySalesDiffYen = monthAgg.gross - priorAgg.gross
  const yoyPartyDiff = monthAgg.party - priorAgg.party
  const yoyGuestDiff = monthAgg.guest - priorAgg.guest
  const yoyBusinessDaysDiff = monthAgg.businessDays - priorAgg.businessDays

  const businessDays = monthAgg.businessDays > 0 ? monthAgg.businessDays : null

  return {
    storeDisplayName: params.storeDisplayName,
    storePartitionKey: params.storePartitionKey,
    receiptDateText: params.receipt.date ?? params.receiptDateIso,
    receiptDateIso: params.receiptDateIso,
    taxAmountYen: parseCurrencyAmount(params.receipt.taxAmount),
    grossSalesYen: parseCurrencyAmount(params.receipt.grossSales),
    partyCount: parseIntegerCount(params.receipt.partyCount),
    guestCount: parseIntegerCount(params.receipt.guestCount),
    unitPriceYen: parseCurrencyAmount(params.receipt.unitPrice),
    monthGrossSalesYen: monthAgg.gross,
    monthPartyCount: monthAgg.party,
    monthGuestCount: monthAgg.guest,
    businessDays,
    monthDailyAvgGross: businessDays ? Math.round(monthAgg.gross / businessDays) : null,
    monthDailyAvgParty: businessDays ? Math.round((monthAgg.party / businessDays) * 10) / 10 : null,
    monthDailyAvgGuest: businessDays ? Math.round((monthAgg.guest / businessDays) * 10) / 10 : null,
    monthBudgetYen: budget.monthBudgetYen,
    monthBudgetAchievementPct: budget.monthBudgetAchievementPct,
    dailyBudgetYen: budget.dailyBudgetYen,
    dailyBudgetDiffYen: budget.dailyBudgetDiffYen,
    cumulativeBudgetDiffYen: budget.cumulativeBudgetDiffYen,
    yoyPeriodLabel: `${priorMonth}-01 ~ ${priorEndDate}`,
    yoySalesPct: pctChange(monthAgg.gross, priorAgg.gross),
    yoySalesDiffYen,
    yoyPartyPct: pctChange(monthAgg.party, priorAgg.party),
    yoyPartyDiff,
    yoyGuestPct: pctChange(monthAgg.guest, priorAgg.guest),
    yoyGuestDiff,
    yoyBusinessDaysPct: pctChange(monthAgg.businessDays, priorAgg.businessDays),
    yoyBusinessDaysDiff,
    lineMessageId: params.lineMessageId,
    targetMonth: month,
  }
}

export function formatSignedYen(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  const sign = value >= 0 ? '+' : '-'
  return `${sign}¥${Math.abs(Math.round(value)).toLocaleString('ja-JP')}`
}

export function formatSignedCount(value: number | null, unit: string): string {
  if (value == null || !Number.isFinite(value)) return '-'
  const sign = value >= 0 ? '+' : '-'
  return `${sign}${Math.abs(Math.round(value))}${unit}`
}

export function formatSignedPctWithDiff(
  pct: number | null,
  diffLabel: string,
): string {
  const pctText = formatSignedPct(pct)
  if (!pctText) return '-'
  return `${pctText} (${diffLabel})`
}
