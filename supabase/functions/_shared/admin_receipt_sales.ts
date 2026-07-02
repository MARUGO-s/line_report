import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import {
  allocateDailyBudgetsForMonth,
  enumerateMonthDates,
  mergeStoreClosedDateLists,
  parseStoreClosedDatesForMonth,
  type SalesBudgetAllocationWeights,
} from './sales_budget_allocation.ts'
import { fetchJapaneseHolidaySet } from './japanese_holidays.ts'
import {
  fetchManualMonthSales,
  fetchManualMonthSalesMapForStore,
  upsertManualMonthSalesEntries,
  type ManualMonthSalesRecord,
} from './manual_month_sales.ts'
import {
  fetchManualDayBudgetMapForStore,
  fetchManualDaySalesMapForStore,
  type ManualDaySalesRecord,
} from './manual_day_sales.ts'
import { sanitizeReceiptCountFromDb } from './receipt_parse.ts'
import { queryStoreReceiptRows, loadStoreRegistry } from './store_receipt_query.ts'
import { autoLinkDetectedRoomsForStore } from './auto_link_room.ts'
import { parseReceiptPhonesInput } from './store_receipt_phones.ts'
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

type ReceiptSalesTotals = {
  receipt_count: number
  total_gross_sales_yen: number
  total_net_sales_yen: number
  total_tax_amount_yen: number
  total_party_count: number
  total_guest_count: number
  avg_gross_sales_yen: number | null
  avg_party_count: number | null
  avg_guest_count: number | null
  avg_unit_price_yen: number | null
}

/**
 * 月間合計の算出ポリシー（レシート優先）:
 * レシートが1件でもある月は、合計（総売上・組数・客数）を必ずレシート集計＝日別の合計にする。
 * 手入力の月次上書き(line_sales_manual_month_gross)は「レシートが1件も無い月」だけ有効。
 * 旧仕様は手入力を無条件で優先していたが、シート連携が古い/部分的な月次値を自動生成すると
 * 実売上を上書きして「日別は出るのに月間合計だけ食い違う」不具合になっていたため反転した。
 */
function mergeSalesTotalsWithManualMonth(
  receiptTotals: ReceiptSalesTotals,
  manual: ManualMonthSalesRecord | null,
): ReceiptSalesTotals {
  if (!manual) return receiptTotals
  // レシートがある月はレシート集計（日別合計）を正とし、手入力上書きは無視する
  if (receiptTotals.receipt_count > 0) return receiptTotals

  const gross = manual.gross_sales_yen
  const tax = manual.tax_amount_yen ?? receiptTotals.total_tax_amount_yen
  const net = manual.net_sales_yen ?? (
    manual.tax_amount_yen != null ? Math.max(0, gross - manual.tax_amount_yen) : receiptTotals.total_net_sales_yen
  )
  const party = manual.party_count != null
    ? manual.party_count
    : receiptTotals.total_party_count
  const guest = manual.guest_count != null
    ? manual.guest_count
    : receiptTotals.total_guest_count
  const receiptCount = receiptTotals.receipt_count

  return {
    receipt_count: receiptCount,
    total_gross_sales_yen: gross,
    total_net_sales_yen: net,
    total_tax_amount_yen: tax,
    total_party_count: party,
    total_guest_count: guest,
    avg_gross_sales_yen: receiptCount > 0
      ? Math.round(gross / receiptCount)
      : null,
    avg_party_count: receiptCount > 0
      ? roundToScale(party / receiptCount, 2)
      : null,
    avg_guest_count: receiptCount > 0
      ? roundToScale(guest / receiptCount, 2)
      : null,
    avg_unit_price_yen: guest > 0 ? Math.round(gross / guest) : null,
  }
}

type SalesBudgetRow = {
  budget_yen: number
  mon_weight: number
  tue_weight: number
  wed_weight: number
  thu_weight: number
  fri_weight: number
  sat_weight: number
  sun_weight: number
  holiday_weight: number | null
  pre_holiday_weight: number | null
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
    .select('budget_yen, mon_weight, tue_weight, wed_weight, thu_weight, fri_weight, sat_weight, sun_weight, holiday_weight, pre_holiday_weight, store_closed_dates')
    .eq('store_partition_key', store_partition_key)
    .eq('target_month', month)
    .maybeSingle()

  if (error) {
    throw { status: 500, message: `Failed to fetch sales budget: ${error.message}` } satisfies AppError
  }
  if (!data) return null
  const row = data as {
    budget_yen?: unknown
    mon_weight?: unknown
    tue_weight?: unknown
    wed_weight?: unknown
    thu_weight?: unknown
    fri_weight?: unknown
    sat_weight?: unknown
    sun_weight?: unknown
    holiday_weight?: unknown
    pre_holiday_weight?: unknown
    store_closed_dates?: unknown
  }
  const budgetYen = toNonNegativeInteger(row.budget_yen)
  if (budgetYen <= 0) return null
  const fromTable = await fetchStoreClosedDatesFromTable(supabase, store_partition_key, month)
  const store_closed_dates = mergeStoreClosedDateLists(fromTable, row.store_closed_dates, month)
  const hw = Number(row.holiday_weight)
  const phw = Number(row.pre_holiday_weight)
  return {
    budget_yen: budgetYen,
    mon_weight: parsePositiveWeight(row.mon_weight, 1),
    tue_weight: parsePositiveWeight(row.tue_weight, 1),
    wed_weight: parsePositiveWeight(row.wed_weight, 1),
    thu_weight: parsePositiveWeight(row.thu_weight, 1),
    fri_weight: parsePositiveWeight(row.fri_weight, 1),
    sat_weight: parsePositiveWeight(row.sat_weight, 1.5),
    sun_weight: parsePositiveWeight(row.sun_weight, 2),
    holiday_weight: (Number.isFinite(hw) && hw > 0) ? hw : null,
    pre_holiday_weight: (Number.isFinite(phw) && phw > 0) ? phw : null,
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
      mon_weight: null as number | null,
      tue_weight: null as number | null,
      wed_weight: null as number | null,
      thu_weight: null as number | null,
      fri_weight: null as number | null,
      sat_weight: null as number | null,
      sun_weight: null as number | null,
      holiday_weight: null as number | null,
      pre_holiday_weight: null as number | null,
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

  const monW = parsePositiveWeight(body.mon_weight, 1)
  const tueW = parsePositiveWeight(body.tue_weight, 1)
  const wedW = parsePositiveWeight(body.wed_weight, 1)
  const thuW = parsePositiveWeight(body.thu_weight, 1)
  const friW = parsePositiveWeight(body.fri_weight, 1)
  const satW = parsePositiveWeight(body.sat_weight, 1.5)
  const sunW = parsePositiveWeight(body.sun_weight, 2)
  const hwRaw = Number(body.holiday_weight)
  const phwRaw = Number(body.pre_holiday_weight)
  const holidayW = (Number.isFinite(hwRaw) && hwRaw > 0) ? hwRaw : null
  const preHolidayW = (Number.isFinite(phwRaw) && phwRaw > 0) ? phwRaw : null
  const closedDates = parseStoreClosedDatesForMonth(body.store_closed_dates, month)

  const updatedAt = new Date().toISOString()
  const { data, error } = await supabase
    .from('line_sales_month_budgets')
    .upsert(
      {
        store_partition_key,
        target_month: month,
        budget_yen: budgetYen,
        mon_weight: monW,
        tue_weight: tueW,
        wed_weight: wedW,
        thu_weight: thuW,
        fri_weight: friW,
        sat_weight: satW,
        sun_weight: sunW,
        holiday_weight: holidayW,
        pre_holiday_weight: preHolidayW,
        store_closed_dates: closedDates,
        updated_at: updatedAt,
      },
      { onConflict: 'store_partition_key,target_month' },
    )
    .select('budget_yen, mon_weight, tue_weight, wed_weight, thu_weight, fri_weight, sat_weight, sun_weight, holiday_weight, pre_holiday_weight, store_closed_dates')
    .maybeSingle()

  if (error) {
    throw { status: 500, message: `Failed to save sales budget: ${error.message}` } satisfies AppError
  }

  await replaceStoreClosedDatesInTable(supabase, store_partition_key, month, closedDates)

  const row = data as {
    budget_yen?: unknown
    mon_weight?: unknown
    tue_weight?: unknown
    wed_weight?: unknown
    thu_weight?: unknown
    fri_weight?: unknown
    sat_weight?: unknown
    sun_weight?: unknown
    holiday_weight?: unknown
    pre_holiday_weight?: unknown
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
  const retHw = Number(row?.holiday_weight)
  const retPhw = Number(row?.pre_holiday_weight)
  return {
    month_budget_yen: out > 0 ? out : null,
    mon_weight: parsePositiveWeight(row?.mon_weight, monW),
    tue_weight: parsePositiveWeight(row?.tue_weight, tueW),
    wed_weight: parsePositiveWeight(row?.wed_weight, wedW),
    thu_weight: parsePositiveWeight(row?.thu_weight, thuW),
    fri_weight: parsePositiveWeight(row?.fri_weight, friW),
    sat_weight: parsePositiveWeight(row?.sat_weight, satW),
    sun_weight: parsePositiveWeight(row?.sun_weight, sunW),
    holiday_weight: (Number.isFinite(retHw) && retHw > 0) ? retHw : (holidayW ?? null),
    pre_holiday_weight: (Number.isFinite(retPhw) && retPhw > 0) ? retPhw : (preHolidayW ?? null),
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
    .select('sales_month, gross_sales_yen, net_sales_yen, tax_amount_yen, party_count, guest_count, operating_days_count')
    .eq('store_partition_key', store_partition_key)
    .gte('sales_month', start)
    .lt('sales_month', endExclusive)

  if (error) {
    throw { status: 500, message: `Failed to list manual month gross: ${error.message}` } satisfies AppError
  }

  const months: Record<string, {
    gross_sales_yen: number
    net_sales_yen: number | null
    tax_amount_yen: number | null
    party_count: number | null
    guest_count: number | null
    operating_days_count: number | null
  }> = {}
  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const sm = toSafeString(r.sales_month)
    if (!/^\d{4}-\d{2}$/.test(sm)) continue
    const gross = toNonNegativeInteger(r.gross_sales_yen)
    const netRaw = r.net_sales_yen
    const taxRaw = r.tax_amount_yen
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
      net_sales_yen: netRaw === null || netRaw === undefined || netRaw === '' ? null : toNonNegativeInteger(netRaw),
      tax_amount_yen: taxRaw === null || taxRaw === undefined || taxRaw === '' ? null : toNonNegativeInteger(taxRaw),
      party_count: party,
      guest_count: guest,
      operating_days_count: operating_days_count != null && operating_days_count > 0 ? operating_days_count : null,
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
        operating_days_count: operatingDays != null && operatingDays > 0 ? operatingDays : null,
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

  // 売上は「レシート日付（営業日）」基準で集計する。
  // created_at（アップロード/取込時刻）で絞ると、過去日を後から取り込んだ／別経路で
  // 同期したレシートが当月の取得窓から外れ、receipt_date が当月でも表示されない不具合になる。
  // そのため receipt_date の範囲で取得する（レシート返信カードの月間集計と同じ基準）。
  const receiptFrom = dayKeys.length > 0 ? dayKeys[0] : `${month}-01`
  let receiptToExclusive: string | undefined
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(month)
  if (monthMatch) {
    const y = Number(monthMatch[1])
    const mo = Number(monthMatch[2])
    const ny = mo === 12 ? y + 1 : y
    const nmo = mo === 12 ? 1 : mo + 1
    receiptToExclusive = `${String(ny).padStart(4, '0')}-${String(nmo).padStart(2, '0')}-01`
  }
  const rows = await queryStoreReceiptRows(supabase, {
    storeKey: resolvedStoreKey || undefined,
    receiptFrom,
    receiptTo: receiptToExclusive,
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
    const partyCount = sanitizeReceiptCountFromDb(row.party_count)
    const guestCount = sanitizeReceiptCountFromDb(row.guest_count, 99_999)

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

  // 日次手入力（売上分析の日次表からの直接編集）。値のある列はその日のレシート集計より優先。
  const storeKeyForManual = normalizeBudgetStoreKey(selectedStoreKeyRaw || selectedStoreKey || '')
  const [manualMonthYear, manualMonthNum] = month.split('-').map(Number)
  const monthFirstDay = `${month}-01`
  const monthEndExclusive = `${manualMonthNum === 12 ? manualMonthYear + 1 : manualMonthYear}-${
    String(manualMonthNum === 12 ? 1 : manualMonthNum + 1).padStart(2, '0')
  }-01`
  const manualDayMap = selectedStoreKey
    ? await fetchManualDaySalesMapForStore(supabase, storeKeyForManual, monthFirstDay, monthEndExclusive)
    : new Map<string, ManualDaySalesRecord>()

  const series = dayKeys.map((dateKey) => {
    const daily = selectedDailyMap.get(dateKey)
    const receiptCount = daily?.receipt_count ?? 0
    const netSalesYen = daily?.net_sales_yen ?? 0
    const taxAmountYen = daily?.tax_amount_yen ?? 0
    const receiptGross = daily?.gross_sales_yen ?? 0
    const receiptParty = daily?.party_count ?? 0
    const receiptGuest = daily?.guest_count ?? 0
    const md = manualDayMap.get(dateKey) ?? null
    const grossSalesYen = md?.gross_sales_yen != null ? md.gross_sales_yen : receiptGross
    const partyCount = md?.party_count != null ? md.party_count : receiptParty
    const guestCount = md?.guest_count != null ? md.guest_count : receiptGuest
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
      manual_gross: md?.gross_sales_yen != null,
      manual_party: md?.party_count != null,
      manual_guest: md?.guest_count != null,
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
  const budget_mon_weight = budgetRow?.mon_weight ?? null
  const budget_tue_weight = budgetRow?.tue_weight ?? null
  const budget_wed_weight = budgetRow?.wed_weight ?? null
  const budget_thu_weight = budgetRow?.thu_weight ?? null
  const budget_fri_weight = budgetRow?.fri_weight ?? null
  const budget_sat_weight = budgetRow?.sat_weight ?? null
  const budget_sun_weight = budgetRow?.sun_weight ?? null
  const budget_holiday_weight = budgetRow?.holiday_weight ?? null
  const budget_pre_holiday_weight = budgetRow?.pre_holiday_weight ?? null
  const store_closed_dates = budgetRow?.store_closed_dates ?? []

  const compareYear = parseCompareYearQueryParam(url.searchParams.get('compare_year'), month)
  const comparison_sales_month = comparisonSalesMonth(month, compareYear)
  const manualThisMonth = selectedStoreKey
    ? await fetchManualMonthSales(supabase, storeKeyForManual, month)
    : null
  const manualComparison = await fetchManualMonthSales(
    supabase,
    storeKeyForManual,
    comparison_sales_month,
  )
  const manual_comparison_gross_yen = manualComparison?.gross_sales_yen ?? null
  const manual_comparison_party_count = manualComparison?.party_count ?? null
  const manual_comparison_guest_count = manualComparison?.guest_count ?? null
  const manual_month_gross_yen = manualThisMonth?.gross_sales_yen ?? null
  const manual_month_net_sales_yen = manualThisMonth?.net_sales_yen ?? null
  const manual_month_tax_amount_yen = manualThisMonth?.tax_amount_yen ?? null
  const manual_month_party_count = manualThisMonth?.party_count ?? null
  const manual_month_guest_count = manualThisMonth?.guest_count ?? null
  const manual_month_operating_days_count = manualThisMonth?.operating_days_count ?? null

  // 日別予算 = 自動按分（月間予算×曜日重み）。ただし「日別予算の直接入力(override)」がある日はそれを優先する。
  // 月間予算が未設定でも、直接入力された日があればその値を表示する。
  const dailyBudgetOverrides = await fetchManualDayBudgetMapForStore(
    supabase,
    storeKeyForManual,
    monthFirstDay,
    monthEndExclusive,
  )
  let daily_budget_yen_by_date: Record<string, number> | null = null
  const dailyBudgetMap = new Map<string, number>()
  if (budgetRow && month_budget_yen != null && month_budget_yen > 0) {
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
    const storeClosedSet = new Set(store_closed_dates)
    const holidaySet = await fetchJapaneseHolidaySet()
    const map = allocateDailyBudgetsForMonth(
      month,
      month_budget_yen,
      weights,
      storeClosedSet,
      holidaySet,
    )
    for (const [d, v] of map) dailyBudgetMap.set(d, v)
  }
  for (const [d, v] of dailyBudgetOverrides) dailyBudgetMap.set(d, v) // 直接入力を最優先
  if (dailyBudgetMap.size > 0) {
    daily_budget_yen_by_date = Object.fromEntries(dailyBudgetMap)
  }
  const daily_budget_overrides = Object.fromEntries(dailyBudgetOverrides)

  // 月間合計の算出: レシートまたは日次手入力がある月は「日別合計（レシート＋日次手入力）」を正本にする。
  // どちらも無い月だけ従来の月次手入力(whole-month)を適用（レシート優先＝[[option-a]]と整合）。
  const hasDayManual = manualDayMap.size > 0
  const receiptCountTotal = selectedStore?.receipt_count ?? 0
  const seriesGrossTotal = series.reduce((a, r) => a + r.gross_sales_yen, 0)
  const seriesPartyTotal = series.reduce((a, r) => a + r.party_count, 0)
  const seriesGuestTotal = series.reduce((a, r) => a + r.guest_count, 0)
  const monthOverrideApplies = receiptCountTotal === 0 && !hasDayManual && manualThisMonth != null
  const totals: ReceiptSalesTotals = (receiptCountTotal > 0 || hasDayManual)
    ? {
      receipt_count: receiptCountTotal,
      total_gross_sales_yen: seriesGrossTotal,
      total_net_sales_yen: selectedStore?.total_net_sales_yen ?? 0,
      total_tax_amount_yen: selectedStore?.total_tax_amount_yen ?? 0,
      total_party_count: seriesPartyTotal,
      total_guest_count: seriesGuestTotal,
      avg_gross_sales_yen: receiptCountTotal > 0 ? Math.round(seriesGrossTotal / receiptCountTotal) : null,
      avg_party_count: receiptCountTotal > 0 ? roundToScale(seriesPartyTotal / receiptCountTotal, 2) : null,
      avg_guest_count: receiptCountTotal > 0 ? roundToScale(seriesGuestTotal / receiptCountTotal, 2) : null,
      avg_unit_price_yen: seriesGuestTotal > 0 ? Math.round(seriesGrossTotal / seriesGuestTotal) : null,
    }
    : mergeSalesTotalsWithManualMonth(
      {
        receipt_count: 0,
        total_gross_sales_yen: 0,
        total_net_sales_yen: 0,
        total_tax_amount_yen: 0,
        total_party_count: 0,
        total_guest_count: 0,
        avg_gross_sales_yen: null,
        avg_party_count: null,
        avg_guest_count: null,
        avg_unit_price_yen: null,
      },
      manualThisMonth,
    )

  return {
    month,
    month_budget_yen,
    budget_mon_weight,
    budget_tue_weight,
    budget_wed_weight,
    budget_thu_weight,
    budget_fri_weight,
    budget_sat_weight,
    budget_sun_weight,
    budget_holiday_weight,
    budget_pre_holiday_weight,
    store_closed_dates,
    comparison_year: compareYear,
    comparison_sales_month,
    manual_comparison_gross_yen,
    manual_comparison_party_count,
    manual_comparison_guest_count,
    manual_month_gross_yen,
    manual_month_net_sales_yen,
    manual_month_tax_amount_yen,
    manual_month_party_count,
    manual_month_guest_count,
    manual_month_operating_days_count,
    // 「月計は手入力」表示は月次手入力(whole-month)が実際に合計へ反映されている時のみ。
    // レシートまたは日次手入力がある月はそちらが正本＝月次手入力は不適用＝false。
    manual_month_has_entry: monthOverrideApplies,
    daily_budget_yen_by_date,
    daily_budget_overrides,
    month_start_iso: range.startIso,
    month_end_iso: range.endIso,
    month_start_date: monthStartDate,
    month_end_date: monthEndDate,
    selected_store_key: selectedStoreKey || null,
    selected_store_name: selectedStore?.store_name ?? null,
    store_options: storeOptions,
    totals,
    series,
    available_store_count: storeOptions.length,
    source_row_count: rows.length,
    generated_at: new Date().toISOString(),
  }
}

export type ReceiptDailyAggRow = {
  date: string
  receipt_count: number
  gross_sales_yen: number
  net_sales_yen: number
  tax_amount_yen: number
  party_count: number
  guest_count: number
  manual_gross: boolean
  manual_party: boolean
  manual_guest: boolean
}

function addDaysIsoUtc(iso: string, days: number): string {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * 店舗の日次集計（受領レシート集計＋日次手入力上書き）を [fromInclusive, toInclusive] で返す。
 * 売上分析(/receipts/sales = fetchReceiptSalesState)の日次系列と同一ロジックを使う唯一の正本：
 *  - 受領レシートは receipt_date 基準で集計し、count は sanitizeReceiptCountFromDb、売上は toNonNegativeInteger。
 *  - 日次手入力(line_sales_manual_day)は値のある列（売上/組数/客数）をその日のレシート集計より優先。
 * 受領レシートも手入力も無い日（休業等）は行を出さない＝呼び出し側で「データ無し」と扱える。
 */
export async function fetchReceiptDailyAggForRange(
  supabase: SupabaseClient,
  storeKey: string,
  fromInclusive: string,
  toInclusive: string,
): Promise<ReceiptDailyAggRow[]> {
  const from = String(fromInclusive).slice(0, 10)
  const toIncl = String(toInclusive).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(toIncl)) return []

  const registry = await loadStoreRegistry(supabase)
  const registryKeys = registry.map((entry) => entry.store_partition_key)
  const resolvedStoreKey = storeKey ? resolveStorePartitionKey(storeKey, registryKeys) : ''
  if (!resolvedStoreKey) return []

  // receipt_date 基準で集計（売上分析と同じ。created_at で絞ると後追い取込が窓から外れる）。
  const rows = await queryStoreReceiptRows(supabase, {
    storeKey: resolvedStoreKey,
    receiptFrom: from,
    receiptTo: addDaysIsoUtc(toIncl, 1), // receiptTo は排他なので終端の翌日まで
    limit: 50000,
  })

  type Agg = { receipt_count: number; gross: number; net: number; tax: number; party: number; guest: number }
  const dailyMap = new Map<string, Agg>()
  for (const row of rows) {
    const d = toSafeString(row.receipt_date).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < from || d > toIncl) continue
    const gross = toNonNegativeInteger(row.gross_sales_yen)
    const net = toNonNegativeInteger(row.net_sales_yen)
    const tax = toNonNegativeInteger(row.tax_amount_yen)
    const party = sanitizeReceiptCountFromDb(row.party_count)
    const guest = sanitizeReceiptCountFromDb(row.guest_count, 99_999)
    const cur = dailyMap.get(d)
    if (!cur) {
      dailyMap.set(d, { receipt_count: 1, gross, net, tax, party, guest })
    } else {
      cur.receipt_count += 1
      cur.gross += gross
      cur.net += net
      cur.tax += tax
      cur.party += party
      cur.guest += guest
    }
  }

  // 日次手入力（売上分析の日次表からの直接編集）。値のある列はその日のレシート集計より優先（売上分析と同一規則）。
  const manualMap = await fetchManualDaySalesMapForStore(
    supabase,
    normalizeBudgetStoreKey(storeKey),
    from,
    addDaysIsoUtc(toIncl, 1),
  )

  const allDates = new Set<string>([...dailyMap.keys(), ...manualMap.keys()])
  const out: ReceiptDailyAggRow[] = []
  for (const d of allDates) {
    if (d < from || d > toIncl) continue
    const agg = dailyMap.get(d) ?? null
    const md = manualMap.get(d) ?? null
    const receiptCount = agg?.receipt_count ?? 0
    out.push({
      date: d,
      receipt_count: receiptCount,
      gross_sales_yen: md?.gross_sales_yen != null ? md.gross_sales_yen : (agg?.gross ?? 0),
      net_sales_yen: agg?.net ?? 0,
      tax_amount_yen: agg?.tax ?? 0,
      party_count: md?.party_count != null ? md.party_count : (agg?.party ?? 0),
      guest_count: md?.guest_count != null ? md.guest_count : (agg?.guest ?? 0),
      manual_gross: md?.gross_sales_yen != null,
      manual_party: md?.party_count != null,
      manual_guest: md?.guest_count != null,
    })
  }
  out.sort((a, b) => a.date.localeCompare(b.date))
  return out
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
  // 日次手入力の差分計算用に日別レシート集計を保持（store絞り込み時のみ使用）
  const perDayReceipt = new Map<string, { gross: number; party: number; guest: number }>()

  for (const row of rows) {
    const dateStr = toSafeString(row.receipt_date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue
    const monthKey = dateStr.slice(0, 7)
    const bucket = monthMap.get(monthKey)
    if (!bucket) continue
    const rowGross = toNonNegativeInteger(row.gross_sales_yen)
    const rowParty = sanitizeReceiptCountFromDb(row.party_count)
    const rowGuest = sanitizeReceiptCountFromDb(row.guest_count, 99_999)
    bucket.gross_sales_yen += rowGross
    bucket.net_sales_yen += toNonNegativeInteger(row.net_sales_yen)
    bucket.party_count += rowParty
    bucket.guest_count += rowGuest
    bucket.receipt_count += 1
    const pd = perDayReceipt.get(dateStr) ?? { gross: 0, party: 0, guest: 0 }
    pd.gross += rowGross
    pd.party += rowParty
    pd.guest += rowGuest
    perDayReceipt.set(dateStr, pd)
    const sk = toSafeString(row.store_partition_key)
    if (sk && !storeSet.has(sk)) storeSet.set(sk, toSafeString(row.store_name) || sk)
  }

  if (resolvedStoreKey) {
    // 日次手入力: その日のレシート集計を手入力で置換（差分を月バケットへ反映）
    const manualDayMap = await fetchManualDaySalesMapForStore(
      supabase,
      resolvedStoreKey,
      startDateStr,
      endDateStr,
    )
    const monthsWithDayManual = new Set<string>()
    for (const [date, md] of manualDayMap.entries()) {
      const monthKey = date.slice(0, 7)
      const bucket = monthMap.get(monthKey)
      if (!bucket) continue
      const rd = perDayReceipt.get(date)
      if (md.gross_sales_yen != null) bucket.gross_sales_yen += md.gross_sales_yen - (rd?.gross ?? 0)
      if (md.party_count != null) bucket.party_count += md.party_count - (rd?.party ?? 0)
      if (md.guest_count != null) bucket.guest_count += md.guest_count - (rd?.guest ?? 0)
      monthsWithDayManual.add(monthKey)
    }
    // 月次手入力(whole-month): レシートも日次手入力も無い月だけ適用（[[option-a]]と整合）
    const manualByMonth = await fetchManualMonthSalesMapForStore(supabase, resolvedStoreKey, monthKeys)
    for (const [monthKey, manual] of manualByMonth.entries()) {
      const bucket = monthMap.get(monthKey)
      if (!bucket) continue
      if (bucket.receipt_count > 0) continue
      if (monthsWithDayManual.has(monthKey)) continue
      bucket.gross_sales_yen = manual.gross_sales_yen
      if (manual.net_sales_yen != null) bucket.net_sales_yen = manual.net_sales_yen
      if (manual.tax_amount_yen != null) {
        bucket.net_sales_yen = manual.net_sales_yen ?? Math.max(0, manual.gross_sales_yen - manual.tax_amount_yen)
      }
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

export type ReceiptStoreOptionRow = {
  store_key: string
  store_name: string
  receipt_phones: string[]
}

export async function fetchReceiptStoreOptions(
  supabase: SupabaseClient,
): Promise<ReceiptStoreOptionRow[]> {
  const registry = await loadStoreRegistry(supabase)
  return registry.map((entry) => ({
    store_key: entry.store_partition_key,
    store_name: entry.display_name,
    receipt_phones: Array.isArray(entry.receipt_phones)
      ? entry.receipt_phones.filter((p) => String(p ?? '').trim())
      : [],
  }))
}

export async function updateStoreReceiptPhones(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{ store_key: string; receipt_phones: string[] }> {
  const registry = await loadStoreRegistry(supabase)
  const storeKey = resolveStorePartitionKey(
    body.store_partition_key ?? body.store_key ?? body.store_name,
    registry.map((entry) => String(entry.store_partition_key ?? '').trim()).filter(Boolean),
  )
  if (!storeKey) {
    throw { status: 400, message: 'store_key が必要です。' } satisfies AppError
  }
  const receipt_phones = parseReceiptPhonesInput(body.receipt_phones)
  const { data, error } = await supabase
    .from('store_webhook_tables')
    .update({ receipt_phones })
    .eq('store_partition_key', storeKey)
    .select('store_partition_key, receipt_phones')
    .maybeSingle()
  if (error) {
    console.error('updateStoreReceiptPhones failed:', error.message)
    throw { status: 500, message: error.message } satisfies AppError
  }
  if (!data) {
    throw { status: 404, message: `店舗 ${storeKey} が store_webhook_tables にありません。` } satisfies AppError
  }
  const row = data as { store_partition_key?: string; receipt_phones?: string[] }
  return {
    store_key: String(row.store_partition_key ?? storeKey),
    receipt_phones: Array.isArray(row.receipt_phones) ? row.receipt_phones : receipt_phones,
  }
}

export type ReceiptWebhookStatusRow = {
  store_partition_key: string
  display_name: string
  webhook_event_count: number
  last_webhook_received_at: string | null
  receipt_count: number
  last_receipt_at: string | null
  is_communicating: boolean
  /** Webhook 生ログに記録された room_id（管理画面未登録含む） */
  detected_room_ids: string[]
}

async function fetchDistinctRoomIdsFromRawTable(
  supabase: SupabaseClient,
  rawTable: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from(rawTable)
    .select('room_id, received_at')
    .not('room_id', 'is', null)
    .order('received_at', { ascending: false })
    .limit(1000)
  if (error || !Array.isArray(data)) return []
  const seen = new Set<string>()
  const roomIds: string[] = []
  for (const row of data) {
    const roomId = String(row?.room_id || '').trim()
    if (!roomId || seen.has(roomId)) continue
    seen.add(roomId)
    roomIds.push(roomId)
  }
  return roomIds
}

export async function fetchReceiptWebhookStatus(
  supabase: SupabaseClient,
  options: { includeDetectedRooms?: boolean; autoLinkDetected?: boolean } = {},
): Promise<{
  webhook_status: ReceiptWebhookStatusRow[]
  auto_link: { linked: number; skipped: number; errors: number }
}> {
  const includeDetectedRooms = options.includeDetectedRooms !== false
  const autoLinkDetected = options.autoLinkDetected !== false
  const registry = await loadStoreRegistry(supabase)
  const autoLinkTotal = { linked: 0, skipped: 0, errors: 0 }

  const webhook_status = await Promise.all(registry.map(async (entry) => {
    let webhookEventCount = 0
    let lastWebhookReceivedAt: string | null = null
    let receiptCount = 0
    let lastReceiptAt: string | null = null

    const [
      { count: whCount, error: whCountErr },
      { data: whLast, error: whLastErr },
      { count: rcCount, error: rcCountErr },
      { data: rcLast, error: rcLastErr },
    ] = await Promise.all([
      supabase.from(entry.webhook_raw_table).select('*', { count: 'exact', head: true }),
      supabase
        .from(entry.webhook_raw_table)
        .select('received_at')
        .order('received_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from(entry.receipt_table).select('*', { count: 'exact', head: true }),
      supabase
        .from(entry.receipt_table)
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    if (!whCountErr && whCount != null) webhookEventCount = whCount
    if (!whLastErr && whLast?.received_at) {
      lastWebhookReceivedAt = String(whLast.received_at)
    }
    if (!rcCountErr && rcCount != null) receiptCount = rcCount
    if (!rcLastErr && rcLast?.created_at) {
      lastReceiptAt = String(rcLast.created_at)
    }

    const detectedRoomIds =
      includeDetectedRooms && webhookEventCount > 0
        ? await fetchDistinctRoomIdsFromRawTable(supabase, entry.webhook_raw_table)
        : []

    if (autoLinkDetected && detectedRoomIds.length > 0) {
      const batch = await autoLinkDetectedRoomsForStore(
        supabase,
        entry.store_partition_key,
        detectedRoomIds,
      )
      autoLinkTotal.linked += batch.linked
      autoLinkTotal.skipped += batch.skipped
      autoLinkTotal.errors += batch.errors
    }

    return {
      store_partition_key: entry.store_partition_key,
      display_name: entry.display_name,
      webhook_event_count: webhookEventCount,
      last_webhook_received_at: lastWebhookReceivedAt,
      receipt_count: receiptCount,
      last_receipt_at: lastReceiptAt,
      is_communicating: webhookEventCount > 0,
      detected_room_ids: detectedRoomIds,
    }
  }))

  return { webhook_status, auto_link: autoLinkTotal }
}
