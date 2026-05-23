import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import {
  allocateDailyBudgetsForMonth,
  enumerateMonthDates,
  getDefaultJapaneseHolidaySet,
  mergeStoreClosedDateLists,
  parseStoreClosedDatesForMonth,
  type SalesBudgetAllocationWeights,
} from './sales_budget_allocation.ts'
import {
  fetchManualMonthSales,
  fetchManualMonthSalesMapForStore,
  upsertManualMonthSalesEntries,
} from './manual_month_sales.ts'
import { queryStoreReceiptRows, loadStoreRegistry } from './store_receipt_query.ts'
import {
  buildJstDateKeysForMonth,
  buildJstMonthRange,
  comparisonSalesMonth,
  isRecord,
  normalizeBudgetStoreKey,
  normalizeCalendarMonthParam,
  parseCompareYearQueryParam,
  resolveReceiptEntryDateKeyForMonth,
  resolveStorePartitionKey,
  roundToScale,
  toNonNegativeInteger,
  toSafeString,
  type AppError,
} from './admin_utils.ts'

function parsePositiveWeight(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

type SalesBudgetRow = {
  budget_yen: number
  weekday_weight: number
  pre_holiday_weight: number
  holiday_weight: number
  store_closed_dates: string[]
}

async function fetchStoreClosedDatesFromTable(
  supabase: SupabaseClient,
  store_partition_key: string,
  month: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('line_sales_month_store_closed_days')
    .select('closed_on')
    .eq('store_partition_key', store_partition_key)
    .eq('target_month', month)

  if (error) {
    throw { status: 500, message: `Failed to fetch store closed days: ${error.message}` } satisfies AppError
  }
  const allowed = new Set(enumerateMonthDates(month))
  const out: string[] = []
  for (const row of Array.isArray(data) ? data : []) {
    const r = row as { closed_on?: unknown }
    const s = String(r.closed_on ?? '').trim().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue
    if (!allowed.has(s)) continue
    out.push(s)
  }
  return [...new Set(out)].sort()
}

async function replaceStoreClosedDatesInTable(
  supabase: SupabaseClient,
  store_partition_key: string,
  month: string,
  dates: string[],
) {
  const { error: delErr } = await supabase
    .from('line_sales_month_store_closed_days')
    .delete()
    .eq('store_partition_key', store_partition_key)
    .eq('target_month', month)
  if (delErr) {
    throw { status: 500, message: `Failed to clear store closed days: ${delErr.message}` } satisfies AppError
  }
  if (dates.length === 0) return
  const rows = dates.map((closed_on) => ({
    store_partition_key,
    target_month: month,
    closed_on,
  }))
  const { error: insErr } = await supabase.from('line_sales_month_store_closed_days').insert(rows)
  if (insErr) {
    throw { status: 500, message: `Failed to save store closed days: ${insErr.message}` } satisfies AppError
  }
}

async function fetchSalesBudgetRow(
  supabase: SupabaseClient,
  storeKeyQueryParam: string,
  month: string,
): Promise<SalesBudgetRow | null> {
  const store_partition_key = normalizeBudgetStoreKey(storeKeyQueryParam)
  const { data, error } = await supabase
    .from('line_sales_month_budgets')
    .select('budget_yen, weekday_weight, pre_holiday_weight, holiday_weight, store_closed_dates')
    .eq('store_partition_key', store_partition_key)
    .eq('target_month', month)
    .maybeSingle()

  if (error) {
    throw { status: 500, message: `Failed to fetch sales budget: ${error.message}` } satisfies AppError
  }
  if (!data) return null
  const row = data as {
    budget_yen?: unknown
    weekday_weight?: unknown
    pre_holiday_weight?: unknown
    holiday_weight?: unknown
    store_closed_dates?: unknown
  }
  const budgetYen = toNonNegativeInteger(row.budget_yen)
  if (budgetYen <= 0) return null
  const fromTable = await fetchStoreClosedDatesFromTable(supabase, store_partition_key, month)
  const store_closed_dates = mergeStoreClosedDateLists(fromTable, row.store_closed_dates, month)
  return {
    budget_yen: budgetYen,
    weekday_weight: parsePositiveWeight(row.weekday_weight, 1),
    pre_holiday_weight: parsePositiveWeight(row.pre_holiday_weight, 1.5),
    holiday_weight: parsePositiveWeight(row.holiday_weight, 2),
    store_closed_dates,
  }
}

export async function upsertReceiptSalesBudget(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
) {
  const store_partition_key = normalizeBudgetStoreKey(toSafeString(body.store_key))
  const month = normalizeCalendarMonthParam(toSafeString(body.month))
  const rawBudget = body.budget_yen

  const clearAndReturn = async () => {
    const { error: delClosedErr } = await supabase
      .from('line_sales_month_store_closed_days')
      .delete()
      .eq('store_partition_key', store_partition_key)
      .eq('target_month', month)
    if (delClosedErr) {
      throw { status: 500, message: `Failed to clear store closed days: ${delClosedErr.message}` } satisfies AppError
    }
    const { error } = await supabase
      .from('line_sales_month_budgets')
      .delete()
      .eq('store_partition_key', store_partition_key)
      .eq('target_month', month)
    if (error) {
      throw { status: 500, message: `Failed to clear sales budget: ${error.message}` } satisfies AppError
    }
    return {
      month_budget_yen: null as number | null,
      weekday_weight: null as number | null,
      pre_holiday_weight: null as number | null,
      holiday_weight: null as number | null,
      store_closed_dates: null as string[] | null,
      store_partition_key,
      month,
    }
  }

  if (rawBudget === null || rawBudget === undefined || rawBudget === '') {
    return await clearAndReturn()
  }

  const budgetYen = toNonNegativeInteger(rawBudget)
  if (budgetYen <= 0) {
    return await clearAndReturn()
  }

  const ww = parsePositiveWeight(body.weekday_weight, 1)
  const pw = parsePositiveWeight(body.pre_holiday_weight, 1.5)
  const hw = parsePositiveWeight(body.holiday_weight, 2)
  const closedDates = parseStoreClosedDatesForMonth(body.store_closed_dates, month)

  const updatedAt = new Date().toISOString()
  const { data, error } = await supabase
    .from('line_sales_month_budgets')
    .upsert(
      {
        store_partition_key,
        target_month: month,
        budget_yen: budgetYen,
        weekday_weight: ww,
        pre_holiday_weight: pw,
        holiday_weight: hw,
        store_closed_dates: closedDates,
        updated_at: updatedAt,
      },
      { onConflict: 'store_partition_key,target_month' },
    )
    .select('budget_yen, weekday_weight, pre_holiday_weight, holiday_weight, store_closed_dates')
    .maybeSingle()

  if (error) {
    throw { status: 500, message: `Failed to save sales budget: ${error.message}` } satisfies AppError
  }

  await replaceStoreClosedDatesInTable(supabase, store_partition_key, month, closedDates)

  const row = data as {
    budget_yen?: unknown
    weekday_weight?: unknown
    pre_holiday_weight?: unknown
    holiday_weight?: unknown
    store_closed_dates?: unknown
  } | null
  let parsedClosed = await fetchStoreClosedDatesFromTable(supabase, store_partition_key, month)
  if (parsedClosed.length === 0) {
    parsedClosed = parseStoreClosedDatesForMonth(row?.store_closed_dates, month)
  }
  if (parsedClosed.length === 0 && closedDates.length > 0) {
    parsedClosed = [...closedDates]
  }
  const out = row != null ? toNonNegativeInteger(row.budget_yen) : budgetYen
  return {
    month_budget_yen: out > 0 ? out : null,
    weekday_weight: parsePositiveWeight(row?.weekday_weight, ww),
    pre_holiday_weight: parsePositiveWeight(row?.pre_holiday_weight, pw),
    holiday_weight: parsePositiveWeight(row?.holiday_weight, hw),
    store_closed_dates: parsedClosed,
    store_partition_key,
    month,
  }
}

export async function fetchManualMonthsForYearState(
  supabase: SupabaseClient,
  url: URL,
) {
  const store_partition_key = normalizeBudgetStoreKey(toSafeString(url.searchParams.get('store_key')))
  const year = Number(url.searchParams.get('year'))
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw { status: 400, message: 'year must be an integer 1900-2100.' } satisfies AppError
  }
  const start = `${year}-01`
  const endExclusive = `${year + 1}-01`
  const { data, error } = await supabase
    .from('line_sales_manual_month_gross')
    .select('sales_month, gross_sales_yen, party_count, guest_count, operating_days_count')
    .eq('store_partition_key', store_partition_key)
    .gte('sales_month', start)
    .lt('sales_month', endExclusive)

  if (error) {
    throw { status: 500, message: `Failed to list manual month gross: ${error.message}` } satisfies AppError
  }

  const months: Record<string, {
    gross_sales_yen: number
    party_count: number | null
    guest_count: number | null
    operating_days_count: number | null
  }> = {}
  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const sm = toSafeString(r.sales_month)
    if (!/^\d{4}-\d{2}$/.test(sm)) continue
    const gross = toNonNegativeInteger(r.gross_sales_yen)
    const partyRaw = r.party_count
    const guestRaw = r.guest_count
    const party = partyRaw === null || partyRaw === undefined || partyRaw === ''
      ? null
      : toNonNegativeInteger(partyRaw)
    const guest = guestRaw === null || guestRaw === undefined || guestRaw === ''
      ? null
      : toNonNegativeInteger(guestRaw)
    const opRaw = r.operating_days_count
    const operating_days_count = opRaw === null || opRaw === undefined || opRaw === ''
      ? null
      : toNonNegativeInteger(opRaw)
    months[sm] = {
      gross_sales_yen: gross,
      party_count: party,
      guest_count: guest,
      operating_days_count: operating_days_count > 0 ? operating_days_count : null,
    }
  }

  return {
    year,
    store_partition_key,
    months,
    generated_at: new Date().toISOString(),
  }
}

export async function upsertManualMonthEntries(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
) {
  const store_partition_key = normalizeBudgetStoreKey(toSafeString(body.store_key))
  const entriesRaw = body.entries
  if (!Array.isArray(entriesRaw)) {
    throw { status: 400, message: 'entries must be an array.' } satisfies AppError
  }

  const upsertPayload: Array<{
    sales_month: string
    gross_sales_yen: number | null
    party_count?: number | null
    guest_count?: number | null
    operating_days_count?: number | null
  }> = []
  let applied = 0

  for (const entry of entriesRaw) {
    if (!isRecord(entry)) continue
    const sales_month = normalizeCalendarMonthParam(toSafeString(entry.sales_month))
    const raw = entry.gross_sales_yen

    if (raw === null || raw === undefined || raw === '') {
      upsertPayload.push({ sales_month, gross_sales_yen: null })
    } else {
      const yenVal = toNonNegativeInteger(raw)
      const partyRaw = entry.party_count
      const guestRaw = entry.guest_count
      const party = partyRaw === null || partyRaw === undefined || partyRaw === ''
        ? null
        : toNonNegativeInteger(partyRaw)
      const guest = guestRaw === null || guestRaw === undefined || guestRaw === ''
        ? null
        : toNonNegativeInteger(guestRaw)
      const opRaw = entry.operating_days_count
      const operatingDays = opRaw === null || opRaw === undefined || opRaw === ''
        ? null
        : toNonNegativeInteger(opRaw)
      upsertPayload.push({
        sales_month,
        gross_sales_yen: yenVal,
        party_count: party,
        guest_count: guest,
        operating_days_count: operatingDays > 0 ? operatingDays : null,
      })
    }
    applied += 1
  }

  try {
    await upsertManualMonthSalesEntries(supabase, store_partition_key, upsertPayload)
  } catch (e) {
    throw {
      status: 500,
      message: `Failed to save manual month sales: ${String(e)}`,
    } satisfies AppError
  }

  return {
    ok: true as const,
    store_partition_key,
    applied,
    generated_at: new Date().toISOString(),
  }
}

export async function fetchReceiptSalesState(
  supabase: SupabaseClient,
  url: URL,
) {
  const month = normalizeCalendarMonthParam(url.searchParams.get('month'))
  const selectedStoreKeyRaw = toSafeString(url.searchParams.get('store_key'))
  const range = buildJstMonthRange(month)
  const dayKeys = buildJstDateKeysForMonth(month)
  const dayKeySet = new Set(dayKeys)

  const registry = await loadStoreRegistry(supabase)
  const registryKeys = registry.map((entry) => entry.store_partition_key)
  const resolvedStoreKey = selectedStoreKeyRaw
    ? resolveStorePartitionKey(selectedStoreKeyRaw, registryKeys)
    : ''

  const rows = await queryStoreReceiptRows(supabase, {
    storeKey: resolvedStoreKey || undefined,
    createdFrom: range.startIso,
    createdTo: range.endIso,
    orderByCreatedAt: true,
    limit: 20000,
  })

  type StoreTotal = {
    store_key: string
    store_name: string
    receipt_count: number
    total_gross_sales_yen: number
    total_net_sales_yen: number
    total_tax_amount_yen: number
    total_party_count: number
    total_guest_count: number
  }

  type DailyTotal = {
    date: string
    receipt_count: number
    gross_sales_yen: number
    net_sales_yen: number
    tax_amount_yen: number
    party_count: number
    guest_count: number
  }

  const storeTotals = new Map<string, StoreTotal>()
  const byStoreByDate = new Map<string, Map<string, DailyTotal>>()

  for (const row of rows) {
    const storeKey = toSafeString(row.store_partition_key) || 'unknown_store'
    const storeNameRaw = toSafeString(row.store_name) || storeKey
    const dayKey = resolveReceiptEntryDateKeyForMonth(row.receipt_date, month)
    if (!dayKey || !dayKeySet.has(dayKey)) continue

    const grossSalesYen = toNonNegativeInteger(row.gross_sales_yen)
    const netSalesYen = toNonNegativeInteger(row.net_sales_yen)
    const taxAmountYen = toNonNegativeInteger(row.tax_amount_yen)
    const partyCount = toNonNegativeInteger(row.party_count)
    const guestCount = toNonNegativeInteger(row.guest_count)

    const existingStore = storeTotals.get(storeKey)
    if (!existingStore) {
      storeTotals.set(storeKey, {
        store_key: storeKey,
        store_name: storeNameRaw,
        receipt_count: 1,
        total_gross_sales_yen: grossSalesYen,
        total_net_sales_yen: netSalesYen,
        total_tax_amount_yen: taxAmountYen,
        total_party_count: partyCount,
        total_guest_count: guestCount,
      })
    } else {
      if (existingStore.store_name === existingStore.store_key && storeNameRaw !== storeKey) {
        existingStore.store_name = storeNameRaw
      }
      existingStore.receipt_count += 1
      existingStore.total_gross_sales_yen += grossSalesYen
      existingStore.total_net_sales_yen += netSalesYen
      existingStore.total_tax_amount_yen += taxAmountYen
      existingStore.total_party_count += partyCount
      existingStore.total_guest_count += guestCount
    }

    if (!byStoreByDate.has(storeKey)) {
      byStoreByDate.set(storeKey, new Map<string, DailyTotal>())
    }
    const dailyMap = byStoreByDate.get(storeKey)!
    const existingDaily = dailyMap.get(dayKey)
    if (!existingDaily) {
      dailyMap.set(dayKey, {
        date: dayKey,
        receipt_count: 1,
        gross_sales_yen: grossSalesYen,
        net_sales_yen: netSalesYen,
        tax_amount_yen: taxAmountYen,
        party_count: partyCount,
        guest_count: guestCount,
      })
    } else {
      existingDaily.receipt_count += 1
      existingDaily.gross_sales_yen += grossSalesYen
      existingDaily.net_sales_yen += netSalesYen
      existingDaily.tax_amount_yen += taxAmountYen
      existingDaily.party_count += partyCount
      existingDaily.guest_count += guestCount
    }
  }

  const collator = new Intl.Collator('ja-JP', { sensitivity: 'base', usage: 'sort' })
  const storeOptions = [...storeTotals.values()].sort((a, b) => {
    if (a.total_gross_sales_yen !== b.total_gross_sales_yen) {
      return b.total_gross_sales_yen - a.total_gross_sales_yen
    }
    const byName = collator.compare(a.store_name, b.store_name)
    if (byName !== 0) return byName
    return collator.compare(a.store_key, b.store_key)
  })

  const selectedStoreKey = selectedStoreKeyRaw
    ? resolvedStoreKey
    : (storeOptions[0]?.store_key ?? '')
  const selectedStore = selectedStoreKey ? storeTotals.get(selectedStoreKey) ?? null : null
  const selectedDailyMap = selectedStoreKey
    ? (byStoreByDate.get(selectedStoreKey) ?? new Map<string, DailyTotal>())
    : new Map<string, DailyTotal>()

  const series = dayKeys.map((dateKey) => {
    const daily = selectedDailyMap.get(dateKey)
    const receiptCount = daily?.receipt_count ?? 0
    const grossSalesYen = daily?.gross_sales_yen ?? 0
    const netSalesYen = daily?.net_sales_yen ?? 0
    const taxAmountYen = daily?.tax_amount_yen ?? 0
    const partyCount = daily?.party_count ?? 0
    const guestCount = daily?.guest_count ?? 0
    return {
      date: dateKey,
      receipt_count: receiptCount,
      gross_sales_yen: grossSalesYen,
      net_sales_yen: netSalesYen,
      tax_amount_yen: taxAmountYen,
      party_count: partyCount,
      guest_count: guestCount,
      avg_gross_sales_yen: receiptCount > 0 ? Math.round(grossSalesYen / receiptCount) : null,
      avg_party_count: receiptCount > 0 ? roundToScale(partyCount / receiptCount, 2) : null,
      avg_guest_count: receiptCount > 0 ? roundToScale(guestCount / receiptCount, 2) : null,
      avg_unit_price_yen: guestCount > 0 ? Math.round(grossSalesYen / guestCount) : null,
    }
  })

  const monthStartDate = dayKeys.length > 0 ? dayKeys[0] : `${month}-01`
  const monthEndDate = dayKeys.length > 0 ? dayKeys[dayKeys.length - 1] : `${month}-01`

  const budgetRow = await fetchSalesBudgetRow(
    supabase,
    selectedStoreKeyRaw || selectedStoreKey || '',
    month,
  )
  const month_budget_yen = budgetRow?.budget_yen ?? null
  const budget_weekday_weight = budgetRow?.weekday_weight ?? null
  const budget_pre_holiday_weight = budgetRow?.pre_holiday_weight ?? null
  const budget_holiday_weight = budgetRow?.holiday_weight ?? null
  const store_closed_dates = budgetRow?.store_closed_dates ?? []

  const compareYear = parseCompareYearQueryParam(url.searchParams.get('compare_year'), month)
  const comparison_sales_month = comparisonSalesMonth(month, compareYear)
  const manualComparison = await fetchManualMonthSales(
    supabase,
    normalizeBudgetStoreKey(selectedStoreKeyRaw || selectedStoreKey || ''),
    comparison_sales_month,
  )
  const manual_comparison_gross_yen = manualComparison?.gross_sales_yen ?? null
  const manual_comparison_party_count = manualComparison?.party_count ?? null
  const manual_comparison_guest_count = manualComparison?.guest_count ?? null

  let daily_budget_yen_by_date: Record<string, number> | null = null
  if (budgetRow && month_budget_yen != null && month_budget_yen > 0) {
    const weights: SalesBudgetAllocationWeights = {
      weekday: budgetRow.weekday_weight,
      pre_holiday: budgetRow.pre_holiday_weight,
      holiday: budgetRow.holiday_weight,
    }
    const holidaySet = getDefaultJapaneseHolidaySet()
    const storeClosedSet = new Set(store_closed_dates)
    const map = allocateDailyBudgetsForMonth(
      month,
      month_budget_yen,
      weights,
      holidaySet,
      storeClosedSet,
    )
    daily_budget_yen_by_date = Object.fromEntries(map)
  }

  return {
    month,
    month_budget_yen,
    budget_weekday_weight,
    budget_pre_holiday_weight,
    budget_holiday_weight,
    store_closed_dates,
    comparison_year: compareYear,
    comparison_sales_month,
    manual_comparison_gross_yen,
    manual_comparison_party_count,
    manual_comparison_guest_count,
    daily_budget_yen_by_date,
    month_start_iso: range.startIso,
    month_end_iso: range.endIso,
    month_start_date: monthStartDate,
    month_end_date: monthEndDate,
    selected_store_key: selectedStoreKey || null,
    selected_store_name: selectedStore?.store_name ?? null,
    store_options: storeOptions,
    totals: {
      receipt_count: selectedStore?.receipt_count ?? 0,
      total_gross_sales_yen: selectedStore?.total_gross_sales_yen ?? 0,
      total_net_sales_yen: selectedStore?.total_net_sales_yen ?? 0,
      total_tax_amount_yen: selectedStore?.total_tax_amount_yen ?? 0,
      total_party_count: selectedStore?.total_party_count ?? 0,
      total_guest_count: selectedStore?.total_guest_count ?? 0,
      avg_gross_sales_yen: selectedStore && selectedStore.receipt_count > 0
        ? Math.round(selectedStore.total_gross_sales_yen / selectedStore.receipt_count)
        : null,
      avg_party_count: selectedStore && selectedStore.receipt_count > 0
        ? roundToScale(selectedStore.total_party_count / selectedStore.receipt_count, 2)
        : null,
      avg_guest_count: selectedStore && selectedStore.receipt_count > 0
        ? roundToScale(selectedStore.total_guest_count / selectedStore.receipt_count, 2)
        : null,
      avg_unit_price_yen: selectedStore && selectedStore.total_guest_count > 0
        ? Math.round(selectedStore.total_gross_sales_yen / selectedStore.total_guest_count)
        : null,
    },
    series,
    available_store_count: storeOptions.length,
    source_row_count: rows.length,
    generated_at: new Date().toISOString(),
  }
}

export async function fetchAnalyticsMonthly(
  supabase: SupabaseClient,
  url: URL,
) {
  const storeKeyRaw = toSafeString(url.searchParams.get('store_key'))
  const monthsRaw = Number(url.searchParams.get('months') ?? '12')
  const months = Number.isFinite(monthsRaw) && monthsRaw >= 1 ? Math.min(Math.floor(monthsRaw), 36) : 12

  const now = new Date()
  const jstParts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now)
  const currentYear = Number(jstParts.find((p) => p.type === 'year')?.value ?? now.getUTCFullYear())
  const currentMonth = Number(jstParts.find((p) => p.type === 'month')?.value ?? 1)

  const monthKeys: string[] = []
  for (let i = months - 1; i >= 0; i--) {
    const totalMonths = currentYear * 12 + (currentMonth - 1) - i
    const y = Math.floor(totalMonths / 12)
    const m = (totalMonths % 12) + 1
    monthKeys.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`)
  }

  const firstMonth = monthKeys[0]
  const lastMonth = monthKeys[monthKeys.length - 1]
  const startDateStr = `${firstMonth}-01`
  const lastMonthNum = Number(lastMonth.slice(5, 7))
  const lastMonthYear = Number(lastMonth.slice(0, 4))
  const nextYear = lastMonthNum === 12 ? lastMonthYear + 1 : lastMonthYear
  const nextMonth = lastMonthNum === 12 ? 1 : lastMonthNum + 1
  const endDateStr = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`

  const registry = await loadStoreRegistry(supabase)
  const registryKeys = registry.map((entry) => entry.store_partition_key)
  const resolvedStoreKey = storeKeyRaw
    ? resolveStorePartitionKey(storeKeyRaw, registryKeys)
    : ''

  const rows = await queryStoreReceiptRows(supabase, {
    storeKey: resolvedStoreKey || undefined,
    receiptFrom: startDateStr,
    receiptTo: endDateStr,
    limit: 50000,
  })

  type MonthlyRow = {
    month: string
    gross_sales_yen: number
    net_sales_yen: number
    party_count: number
    guest_count: number
    receipt_count: number
    avg_unit_price_yen: number | null
  }

  const monthMap = new Map<string, MonthlyRow>()
  for (const key of monthKeys) {
    monthMap.set(key, {
      month: key,
      gross_sales_yen: 0,
      net_sales_yen: 0,
      party_count: 0,
      guest_count: 0,
      receipt_count: 0,
      avg_unit_price_yen: null,
    })
  }

  const storeSet = new Map<string, string>()

  for (const row of rows) {
    const dateStr = toSafeString(row.receipt_date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue
    const monthKey = dateStr.slice(0, 7)
    const bucket = monthMap.get(monthKey)
    if (!bucket) continue
    bucket.gross_sales_yen += toNonNegativeInteger(row.gross_sales_yen)
    bucket.net_sales_yen += toNonNegativeInteger(row.net_sales_yen)
    bucket.party_count += toNonNegativeInteger(row.party_count)
    bucket.guest_count += toNonNegativeInteger(row.guest_count)
    bucket.receipt_count += 1
    const sk = toSafeString(row.store_partition_key)
    if (sk && !storeSet.has(sk)) storeSet.set(sk, toSafeString(row.store_name) || sk)
  }

  if (resolvedStoreKey) {
    const manualByMonth = await fetchManualMonthSalesMapForStore(supabase, resolvedStoreKey, monthKeys)
    for (const [monthKey, manual] of manualByMonth.entries()) {
      const bucket = monthMap.get(monthKey)
      if (!bucket) continue
      bucket.gross_sales_yen = manual.gross_sales_yen
      if (manual.party_count != null) bucket.party_count = manual.party_count
      if (manual.guest_count != null) bucket.guest_count = manual.guest_count
    }
  }

  for (const bucket of monthMap.values()) {
    bucket.avg_unit_price_yen = bucket.guest_count > 0
      ? Math.round(bucket.gross_sales_yen / bucket.guest_count)
      : null
  }

  return {
    months: monthKeys.length,
    store_key: resolvedStoreKey || null,
    series: [...monthMap.values()],
    available_stores: [...storeSet.entries()].map(([k, v]) => ({ store_key: k, store_name: v })),
    generated_at: new Date().toISOString(),
  }
}

export async function fetchReceiptStoreOptions(
  supabase: SupabaseClient,
): Promise<Array<{ store_key: string; store_name: string }>> {
  const registry = await loadStoreRegistry(supabase)
  return registry.map((entry) => ({
    store_key: entry.store_partition_key,
    store_name: entry.display_name,
  }))
}

export type ReceiptWebhookStatusRow = {
  store_partition_key: string
  display_name: string
  webhook_event_count: number
  last_webhook_received_at: string | null
  receipt_count: number
  last_receipt_at: string | null
  is_communicating: boolean
}

export async function fetchReceiptWebhookStatus(
  supabase: SupabaseClient,
): Promise<ReceiptWebhookStatusRow[]> {
  const registry = await loadStoreRegistry(supabase)
  const results: ReceiptWebhookStatusRow[] = []

  for (const entry of registry) {
    let webhookEventCount = 0
    let lastWebhookReceivedAt: string | null = null
    let receiptCount = 0
    let lastReceiptAt: string | null = null

    const { count: whCount, error: whCountErr } = await supabase
      .from(entry.webhook_raw_table)
      .select('*', { count: 'exact', head: true })
    if (!whCountErr && whCount != null) webhookEventCount = whCount

    const { data: whLast, error: whLastErr } = await supabase
      .from(entry.webhook_raw_table)
      .select('received_at')
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!whLastErr && whLast?.received_at) {
      lastWebhookReceivedAt = String(whLast.received_at)
    }

    const { count: rcCount, error: rcCountErr } = await supabase
      .from(entry.receipt_table)
      .select('*', { count: 'exact', head: true })
    if (!rcCountErr && rcCount != null) receiptCount = rcCount

    const { data: rcLast, error: rcLastErr } = await supabase
      .from(entry.receipt_table)
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!rcLastErr && rcLast?.created_at) {
      lastReceiptAt = String(rcLast.created_at)
    }

    results.push({
      store_partition_key: entry.store_partition_key,
      display_name: entry.display_name,
      webhook_event_count: webhookEventCount,
      last_webhook_received_at: lastWebhookReceivedAt,
      receipt_count: receiptCount,
      last_receipt_at: lastReceiptAt,
      is_communicating: webhookEventCount > 0,
    })
  }

  return results
}
