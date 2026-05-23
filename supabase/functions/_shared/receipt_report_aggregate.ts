import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { findBestStoreNameInText, normalizeStoreToken } from "./receipt_store_name_resolve.ts"

export const RECEIPT_STORE_PARTITION_UNKNOWN = "unknown_store"

export type ReceiptReportAggregate = {
  receiptCount: number
  totalGrossSalesYen: number
  totalPartyCount: number
  totalGuestCount: number
  avgGrossSalesYen: number | null
  avgPartyCount: number | null
  avgGuestCount: number | null
  /** レシート日付のユニーク日数（営業日数） */
  operatingDayCount: number
  /** 総売上 / 営業日数（analytics の日次平均に近い） */
  avgDailyGrossSalesYen: number | null
}

export function toReceiptStorePartitionKey(storeName: string | null): string {
  const normalized = normalizeStoreToken(String(storeName ?? ""))
  if (!normalized) return RECEIPT_STORE_PARTITION_UNKNOWN
  return normalized.slice(0, 120)
}

/** YYYY-MM-DD を年単位でずらす（2/29 → 2/28 など暦日に合わせる） */
export function shiftIsoDateByYears(isoDate: string, deltaYears: number): string | null {
  const matched = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!matched) return null
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  const targetYear = year + deltaYears
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate()
  const clampedDay = Math.min(day, lastDay)
  return `${String(targetYear).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`
}

/** 期間が暦月 1 日〜末日（YYYY-MM）か */
export function isFullCalendarMonthPeriod(periodStartDate: string, periodEndDate: string): boolean {
  const matched = periodStartDate.match(/^(\d{4})-(\d{2})-01$/)
  if (!matched) return false
  const year = Number(matched[1])
  const month = Number(matched[2])
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return false
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const expectedEnd = `${matched[1]}-${matched[2]}-${String(lastDay).padStart(2, "0")}`
  return periodEndDate === expectedEnd
}

/** PostgREST の date 列（文字列 / ISO どちらも）を YYYY-MM-DD に正規化 */
export function receiptDateIsoFromValue(value: unknown): string | null {
  if (value == null) return null
  const raw = typeof value === "string" ? value.trim() : String(value).trim()
  const matched = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  return matched ? matched[1] : null
}

export function buildReceiptReportAggregateFromRows(
  rows: Array<Record<string, unknown>>,
): ReceiptReportAggregate | null {
  if (rows.length === 0) return null

  let totalGrossSalesYen = 0
  let totalPartyCount = 0
  let totalGuestCount = 0
  let grossCount = 0
  let partyCountRows = 0
  let guestCountRows = 0
  const operatingDates = new Set<string>()

  for (const row of rows) {
    const receiptDate = receiptDateIsoFromValue(row.receipt_date) ?? ""
    if (receiptDate) {
      operatingDates.add(receiptDate)
    }

    const gross = Number(row.gross_sales_yen)
    if (Number.isFinite(gross) && gross >= 0) {
      totalGrossSalesYen += Math.round(gross)
      grossCount += 1
    }
    const party = Number(row.party_count)
    if (Number.isFinite(party) && party >= 0) {
      totalPartyCount += Math.round(party)
      partyCountRows += 1
    }
    const guest = Number(row.guest_count)
    if (Number.isFinite(guest) && guest >= 0) {
      totalGuestCount += Math.round(guest)
      guestCountRows += 1
    }
  }

  const operatingDayCount = operatingDates.size
  return {
    receiptCount: rows.length,
    totalGrossSalesYen,
    totalPartyCount,
    totalGuestCount,
    avgGrossSalesYen: grossCount > 0 ? totalGrossSalesYen / grossCount : null,
    avgPartyCount: partyCountRows > 0 ? totalPartyCount / partyCountRows : null,
    avgGuestCount: guestCountRows > 0 ? totalGuestCount / guestCountRows : null,
    operatingDayCount,
    avgDailyGrossSalesYen: operatingDayCount > 0
      ? Math.round(totalGrossSalesYen / operatingDayCount)
      : null,
  }
}

function normalizeConfiguredStorePartitionKey(value: unknown): string | null {
  const key = String(value ?? "").trim().toLowerCase()
  if (!key || key === RECEIPT_STORE_PARTITION_UNKNOWN) return null
  if (!/^[a-z0-9]{2,120}$/.test(key)) return null
  return key
}

/** ルーム設定の店舗指定を最優先。未設定時はルーム名・当ルームのレシート履歴から推定。 */
export async function resolveStorePartitionKeyForRoom(
  supabase: ReturnType<typeof createClient>,
  roomId: string,
): Promise<string | null> {
  const rid = String(roomId ?? "").trim()
  if (!rid) return null

  const { data: settingsRow, error: settingsError } = await supabase
    .from("room_summary_settings")
    .select("receipt_report_store_partition_key")
    .eq("room_id", rid)
    .maybeSingle()

  if (settingsError) {
    console.error(`resolveStorePartitionKeyForRoom settings lookup failed (room=${rid}):`, settingsError.message)
  } else {
    const configured = normalizeConfiguredStorePartitionKey(
      (settingsRow as Record<string, unknown> | null)?.receipt_report_store_partition_key,
    )
    if (configured) return configured
  }

  const { data: roomRow } = await supabase
    .from("line_room_names")
    .select("room_name")
    .eq("room_id", rid)
    .maybeSingle()

  const roomName = String((roomRow as Record<string, unknown> | null)?.room_name ?? "").trim()
  if (roomName) {
    const storeLabel = findBestStoreNameInText(roomName)
    if (storeLabel) {
      const key = toReceiptStorePartitionKey(storeLabel)
      if (key !== RECEIPT_STORE_PARTITION_UNKNOWN) return key
    }
    const token = normalizeStoreToken(roomName)
    if (token.length >= 4 && token !== RECEIPT_STORE_PARTITION_UNKNOWN) {
      const fromToken = findBestStoreNameInText(token)
      if (fromToken) {
        const mapped = toReceiptStorePartitionKey(fromToken)
        if (mapped !== RECEIPT_STORE_PARTITION_UNKNOWN) return mapped
      }
      return token.slice(0, 120)
    }
  }

  const lookbackIso = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString()
  const { data: receiptRows, error } = await supabase
    .from("line_receipt_entries")
    .select("store_partition_key")
    .eq("room_id", rid)
    .neq("store_partition_key", RECEIPT_STORE_PARTITION_UNKNOWN)
    .gte("created_at", lookbackIso)
    .limit(5000)

  if (error) {
    console.error(`resolveStorePartitionKeyForRoom failed (room=${rid}):`, error.message)
    return null
  }

  const counts = new Map<string, number>()
  for (const row of Array.isArray(receiptRows) ? receiptRows : []) {
    const key = String((row as Record<string, unknown>).store_partition_key ?? "").trim()
    if (!key || key === RECEIPT_STORE_PARTITION_UNKNOWN) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let bestKey: string | null = null
  let bestCount = 0
  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      bestCount = count
      bestKey = key
    }
  }
  return bestKey
}

function buildJstMonthCreatedAtRange(month: string): { startIso: string; endIso: string } | null {
  const matched = month.match(/^(\d{4})-(\d{2})$/)
  if (!matched) return null
  const year = Number(matched[1])
  const monthNumber = Number(matched[2])
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    return null
  }
  const startUtc = Date.UTC(year, monthNumber - 1, 1, -9, 0, 0)
  const endUtc = Date.UTC(year, monthNumber, 1, -9, 0, 0)
  return {
    startIso: new Date(startUtc).toISOString(),
    endIso: new Date(endUtc).toISOString(),
  }
}

function rowReceiptDateInPeriod(
  row: Record<string, unknown>,
  periodStartDate: string,
  periodEndDate: string,
): boolean {
  const receiptDate = receiptDateIsoFromValue(row.receipt_date)
  if (!receiptDate) return false
  return receiptDate >= periodStartDate && receiptDate <= periodEndDate
}

/** 売上分析 `/receipts/sales` と同系統の取り込み窓（created_at）＋レシート日付で期間内を数える */
async function loadReceiptRowsAnalyticsAligned(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  periodStartDate: string,
  periodEndDate: string,
): Promise<Array<Record<string, unknown>>> {
  const key = String(storePartitionKey ?? "").trim().toLowerCase()
  const month = periodStartDate.slice(0, 7)
  const createdRange = buildJstMonthCreatedAtRange(month)
  if (!createdRange) return []

  const { data, error } = await supabase
    .from("line_receipt_entries")
    .select("gross_sales_yen, party_count, guest_count, receipt_date, created_at")
    .eq("store_partition_key", key)
    .gte("created_at", createdRange.startIso)
    .lt("created_at", createdRange.endIso)
    .limit(20000)

  if (error) {
    console.error(
      `loadReceiptRowsAnalyticsAligned failed (store=${key}, month=${month}):`,
      error.message,
    )
    return []
  }

  const rows = Array.isArray(data) ? data as Array<Record<string, unknown>> : []
  return rows.filter((row) => rowReceiptDateInPeriod(row, periodStartDate, periodEndDate))
}

/** 店舗 × レシート日付（inclusive）で集計。売上分析と揃えるため analytics 互換取得を優先する。 */
export async function loadReceiptReportAggregateForStoreByReceiptDate(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  periodStartDate: string,
  periodEndDate: string,
): Promise<ReceiptReportAggregate | null> {
  const key = String(storePartitionKey ?? "").trim().toLowerCase()
  if (!key || key === RECEIPT_STORE_PARTITION_UNKNOWN) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStartDate) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEndDate)) {
    return null
  }

  let rows = await loadReceiptRowsAnalyticsAligned(supabase, key, periodStartDate, periodEndDate)

  if (rows.length === 0) {
    const { data, error } = await supabase
      .from("line_receipt_entries")
      .select("gross_sales_yen, party_count, guest_count, receipt_date")
      .eq("store_partition_key", key)
      .gte("receipt_date", periodStartDate)
      .lte("receipt_date", periodEndDate)
      .limit(20000)

    if (error) {
      console.error(
        `loadReceiptReportAggregateForStoreByReceiptDate failed (store=${key}, ${periodStartDate}..${periodEndDate}):`,
        error.message,
      )
      return null
    }
    rows = Array.isArray(data) ? data as Array<Record<string, unknown>> : []
  }

  return buildReceiptReportAggregateFromRows(rows)
}

export async function loadReceiptReportAggregateForRoom(
  supabase: ReturnType<typeof createClient>,
  roomId: string,
  periodStartDate: string,
  periodEndDate: string,
  storePartitionKeyOverride?: string | null,
): Promise<{ aggregate: ReceiptReportAggregate | null; storePartitionKey: string | null }> {
  const configuredOverride = normalizeConfiguredStorePartitionKey(storePartitionKeyOverride)
  const storeKey = configuredOverride ?? await resolveStorePartitionKeyForRoom(supabase, roomId)
  if (!storeKey) {
    return { aggregate: null, storePartitionKey: null }
  }
  const aggregate = await loadReceiptReportAggregateForStoreByReceiptDate(
    supabase,
    storeKey,
    periodStartDate,
    periodEndDate,
  )
  return { aggregate, storePartitionKey: storeKey }
}
