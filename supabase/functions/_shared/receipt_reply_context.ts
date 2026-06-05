import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { LineImageReceiptAnalysis } from './receipt_types.ts'
import {
  isPlausibleReceiptCount,
  parseCurrencyAmount,
  parseIntegerCount,
  sanitizeReceiptCountFromDb,
} from './receipt_parse.ts'
import {
  allocateDailyBudgetsForMonth,
  enumerateMonthDates,
  getJstBusinessDateForReceiptBudget,
  mergeStoreClosedDateLists,
  shouldDeferDailyBudgetUntilJstOpen,
  type SalesBudgetAllocationWeights,
} from './sales_budget_allocation.ts'
import { fetchJapaneseHolidaySet } from './japanese_holidays.ts'
import { issueAdminDashboardLoginLinkToken } from './admin_dashboard_link_auth.ts'
import {
  fetchManualMonthSales,
  type ManualMonthSalesRecord,
} from './manual_month_sales.ts'
import { fetchManualDayBudgetMapForStore } from './manual_day_sales.ts'
import { buildReceiptAnalyticsDashboardUri } from './receipt_line_actions.ts'

export type ReceiptReplyContext = {
  storeDisplayName: string
  storePartitionKey: string
  analyticsDashboardUrl: string
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

function parseYearMonth(month: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) return null
  const year = Number(match[1])
  const monthNumber = Number(match[2])
  if (!Number.isFinite(year) || !Number.isFinite(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    return null
  }
  return { year, month: monthNumber }
}

function daysInMonth(month: string): number | null {
  const parsed = parseYearMonth(month)
  if (!parsed) return null
  return new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate()
}

function dayOfMonthFromIso(dateIso: string): number | null {
  const match = /^\d{4}-\d{2}-(\d{2})$/.exec(dateIso)
  if (!match) return null
  const day = Number(match[1])
  if (!Number.isFinite(day) || day < 1 || day > 31) return null
  return day
}

function buildComparableEndDateForMonth(month: string, dayOfMonth: number | null): string {
  const parsed = parseYearMonth(month)
  const totalDays = daysInMonth(month)
  if (!parsed || !totalDays) return `${month}-01`
  const safeDay = Number.isFinite(dayOfMonth) && dayOfMonth != null
    ? Math.min(Math.max(Math.round(dayOfMonth), 1), totalDays)
    : 1
  return `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`
}

function computeComparableMonthProgressRatio(month: string, endDateIso: string): number | null {
  const totalDays = daysInMonth(month)
  const dayOfMonth = dayOfMonthFromIso(endDateIso)
  if (!totalDays || !dayOfMonth) return null
  return Math.max(0, Math.min(dayOfMonth / totalDays, 1))
}

function prorateManualWholeMonthValue(
  value: number | null | undefined,
  ratio: number | null,
): number | null {
  if (value == null) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  if (ratio == null) return Math.round(n)
  return Math.round(n * ratio)
}

function mergePriorAggWithManualMonth(
  priorAgg: MonthAgg,
  manualMonth: ManualMonthSalesRecord | null,
  priorMonth: string,
  priorEndDate: string,
): MonthAgg {
  if (!manualMonth) return priorAgg
  // 前年同期間に実レシートデータ（Excel一括取込で登録した合成レシートを含む）があれば、
  // それを最優先で前年値に使う。手入力の月次合計の日割りは、前年にレシートが1円も無い場合の
  // フォールバックに限定する（レシートがある時はレシートから前年比を計算する）。
  if ((priorAgg.gross ?? 0) > 0) return priorAgg
  const ratio = computeComparableMonthProgressRatio(priorMonth, priorEndDate)
  return {
    gross: prorateManualWholeMonthValue(manualMonth.gross_sales_yen, ratio) ?? priorAgg.gross,
    party: prorateManualWholeMonthValue(manualMonth.party_count, ratio) ?? priorAgg.party,
    guest: prorateManualWholeMonthValue(manualMonth.guest_count, ratio) ?? priorAgg.guest,
    businessDays: prorateManualWholeMonthValue(manualMonth.operating_days_count, ratio) ?? priorAgg.businessDays,
    byDate: priorAgg.byDate,
  }
}

async function fetchBudgetForStoreMonth(
  supabase: SupabaseClient,
  storePartitionKey: string,
  month: string,
) {
  const { data, error } = await supabase
    .from('line_sales_month_budgets')
    .select('budget_yen, mon_weight, tue_weight, wed_weight, thu_weight, fri_weight, sat_weight, sun_weight, holiday_weight, pre_holiday_weight, store_closed_dates')
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
  const d2 = data as {
    mon_weight?: unknown; tue_weight?: unknown; wed_weight?: unknown; thu_weight?: unknown
    fri_weight?: unknown; sat_weight?: unknown; sun_weight?: unknown
    holiday_weight?: unknown; pre_holiday_weight?: unknown
  }
  const hw = Number(d2.holiday_weight)
  const phw = Number(d2.pre_holiday_weight)
  return {
    budget_yen: budgetYen,
    mon_weight: parsePositiveWeight(d2.mon_weight, 1),
    tue_weight: parsePositiveWeight(d2.tue_weight, 1),
    wed_weight: parsePositiveWeight(d2.wed_weight, 1),
    thu_weight: parsePositiveWeight(d2.thu_weight, 1),
    fri_weight: parsePositiveWeight(d2.fri_weight, 1),
    sat_weight: parsePositiveWeight(d2.sat_weight, 1.5),
    sun_weight: parsePositiveWeight(d2.sun_weight, 2),
    holiday_weight: (Number.isFinite(hw) && hw > 0) ? hw : null,
    pre_holiday_weight: (Number.isFinite(phw) && phw > 0) ? phw : null,
    store_closed_dates: storeClosedDates,
  }
}

async function buildReceiptAnalyticsDashboardUrlForLine(
  supabase: SupabaseClient,
  storePartitionKey: string,
  targetMonth: string,
): Promise<string> {
  try {
    const issued = await issueAdminDashboardLoginLinkToken(supabase, {
      source: 'line_receipt_report',
      store_partition_key: storePartitionKey,
      target_month: targetMonth,
    })
    return buildReceiptAnalyticsDashboardUri(storePartitionKey, targetMonth, {
      loginToken: issued.token,
    })
  } catch (error) {
    console.error('buildReceiptAnalyticsDashboardUrlForLine failed:', error)
    return buildReceiptAnalyticsDashboardUri(storePartitionKey, targetMonth)
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
    const gVal = Number.isFinite(g) ? g : 0
    const pVal = sanitizeReceiptCountFromDb((row as { party_count?: unknown }).party_count)
    const guVal = sanitizeReceiptCountFromDb((row as { guest_count?: unknown }).guest_count, 99_999)
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
  holidaySet: Set<string> | null,
  dailyBudgetOverrides: Map<string, number>,
) {
  const weights: SalesBudgetAllocationWeights = {
    mon: budgetRow.mon_weight,
    tue: budgetRow.tue_weight,
    wed: budgetRow.wed_weight,
    thu: budgetRow.thu_weight,
    fri: budgetRow.fri_weight,
    sat: budgetRow.sat_weight,
    sun: budgetRow.sun_weight,
    holiday: budgetRow.holiday_weight,
    pre_holiday: budgetRow.pre_holiday_weight,
  }
  const storeClosedSet = new Set(budgetRow.store_closed_dates)
  const dailyBudgetMap = allocateDailyBudgetsForMonth(
    month,
    budgetRow.budget_yen,
    weights,
    storeClosedSet,
    holidaySet,
  )
  // 日別予算の直接入力(override)がある日は、自動按分より優先する（売上分析の日次予算と整合）。
  for (const [d, v] of dailyBudgetOverrides) dailyBudgetMap.set(d, v)
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
  const analyticsDashboardUrl = await buildReceiptAnalyticsDashboardUrlForLine(
    supabase,
    params.storePartitionKey,
    month,
  )
  const monthAgg = await loadMonthAggUpToDate(
    supabase,
    params.receiptTable,
    month,
    params.receiptDateIso,
  )

  const budgetRow = await fetchBudgetForStoreMonth(supabase, params.storePartitionKey, month)
  const holidaySet = budgetRow ? await fetchJapaneseHolidaySet() : null
  // 日別予算の直接入力(override)を取得し、当日目標・日次予算差・累計に反映する。
  let dailyBudgetOverrides = new Map<string, number>()
  if (budgetRow) {
    const [oy, om] = month.split('-').map(Number)
    const nextMonth = om >= 12 ? `${oy + 1}-01` : `${oy}-${String(om + 1).padStart(2, '0')}`
    dailyBudgetOverrides = await fetchManualDayBudgetMapForStore(
      supabase,
      params.storePartitionKey,
      `${month}-01`,
      `${nextMonth}-01`,
    )
  }
  const budget = budgetRow
    ? computeBudgetDiffs(month, params.receiptDateIso, monthAgg, budgetRow, holidaySet, dailyBudgetOverrides)
    : {
      monthBudgetYen: null,
      monthBudgetAchievementPct: null,
      dailyBudgetYen: null,
      dailyBudgetDiffYen: null,
      cumulativeBudgetDiffYen: null,
    }

  const priorYear = Number(month.slice(0, 4)) - 1
  const priorMonth = `${priorYear}-${month.slice(5, 7)}`
  const priorEndDate = buildComparableEndDateForMonth(
    priorMonth,
    dayOfMonthFromIso(params.receiptDateIso),
  )
  const priorReceiptAgg = await loadMonthAggUpToDate(
    supabase,
    params.receiptTable,
    priorMonth,
    priorEndDate,
  )
  const priorManualMonth = await fetchManualMonthSales(
    supabase,
    params.storePartitionKey,
    priorMonth,
  )
  const priorAgg = mergePriorAggWithManualMonth(
    priorReceiptAgg,
    priorManualMonth,
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
    analyticsDashboardUrl,
    receiptDateText: params.receipt.date ?? params.receiptDateIso,
    receiptDateIso: params.receiptDateIso,
    taxAmountYen: parseCurrencyAmount(params.receipt.taxAmount),
    grossSalesYen: parseCurrencyAmount(params.receipt.grossSales),
    partyCount: (() => {
      const p = parseIntegerCount(params.receipt.partyCount)
      return p != null && isPlausibleReceiptCount(p) ? p : null
    })(),
    guestCount: (() => {
      const g = parseIntegerCount(params.receipt.guestCount)
      return g != null && isPlausibleReceiptCount(g, 99_999) ? g : null
    })(),
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
