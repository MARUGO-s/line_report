import { canonicalStorePartitionKeyForDb } from "./receipt_sheets_store_catalog.ts"

export type ManualMonthSalesRecord = {
  gross_sales_yen: number
  net_sales_yen: number | null
  tax_amount_yen: number | null
  party_count: number | null
  guest_count: number | null
  /** その月の営業日数（前年比の途中期間按分に使用。未入力時は暦日数比） */
  operating_days_count: number | null
  updated_at?: string | null
}

export type ManualMonthSalesUpsertEntry = {
  sales_month: string
  gross_sales_yen: number | null
  net_sales_yen?: number | null
  tax_amount_yen?: number | null
  party_count?: number | null
  guest_count?: number | null
  operating_days_count?: number | null
  updated_at?: string | null
}

function normalizeUpdatedAtInput(value: unknown): string | null {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

/** シート入力の数字文字列を半角・連続に正規化（全角数字・空白・カンマ混在対応） */
export function normalizeSheetIntegerInput(value: unknown): string {
  let s = String(value ?? "")
  s = s.replace(/[\uFF10-\uFF19]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30)
  )
  s = s.replace(/[\uFF0C\uFF0E，．]/g, "")
  s = s.replace(/[\s\u3000\u00a0,，、]/g, "")
  return s.trim()
}

/** シートの数値（"1 20"・"１２０"・"12０" 等）を整数に正規化 */
function parseOptionalNonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) return null
    return Math.round(value)
  }
  const s = normalizeSheetIntegerInput(value)
  if (s === "") return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

/** 営業日数（1以上）。0・空欄は null */
export function parseManualMonthOperatingDays(value: unknown): number | null {
  const n = parseOptionalNonNegativeInt(value)
  if (n == null || n <= 0) return null
  return n
}

export function parseManualMonthPartyGuestFromUnknown(
  partyRaw: unknown,
  guestRaw: unknown,
): { party_count: number | null; guest_count: number | null } {
  return {
    party_count: parseOptionalNonNegativeInt(partyRaw),
    guest_count: parseOptionalNonNegativeInt(guestRaw),
  }
}

/** 過去売上シート行（9列=店舗名あり / 8列=更新日時あり / 7列=営業日数あり / 6列=組数客数あり / 4列=旧形式） */
export function parsePastSalesSheetRow(row: unknown[]): {
  enabledCol: number
  updatedAtCol: number | null
  grossCol: number
  party_count: number | null
  guest_count: number | null
  operating_days_count: number | null
} {
  const len = row.length
  if (len >= 9) {
    const counts = parseManualMonthPartyGuestFromUnknown(row[4], row[5])
    return {
      enabledCol: 7,
      updatedAtCol: 8,
      grossCol: 3,
      party_count: counts.party_count,
      guest_count: counts.guest_count,
      operating_days_count: parseManualMonthOperatingDays(row[6]),
    }
  }
  if (len >= 8) {
    const counts = parseManualMonthPartyGuestFromUnknown(row[3], row[4])
    return {
      enabledCol: 6,
      updatedAtCol: 7,
      grossCol: 2,
      party_count: counts.party_count,
      guest_count: counts.guest_count,
      operating_days_count: parseManualMonthOperatingDays(row[5]),
    }
  }
  if (len >= 7) {
    const counts = parseManualMonthPartyGuestFromUnknown(row[3], row[4])
    return {
      enabledCol: 6,
      updatedAtCol: null,
      grossCol: 2,
      party_count: counts.party_count,
      guest_count: counts.guest_count,
      operating_days_count: parseManualMonthOperatingDays(row[5]),
    }
  }
  if (len >= 6) {
    const counts = parseManualMonthPartyGuestFromUnknown(row[3], row[4])
    return {
      enabledCol: 5,
      updatedAtCol: null,
      grossCol: 2,
      party_count: counts.party_count,
      guest_count: counts.guest_count,
      operating_days_count: null,
    }
  }
  return {
    enabledCol: 3,
    updatedAtCol: null,
    grossCol: 2,
    party_count: null,
    guest_count: null,
    operating_days_count: null,
  }
}

export function manualMonthSalesFromRow(
  row: Record<string, unknown> | null | undefined,
): ManualMonthSalesRecord | null {
  if (!row) return null
  const gross = Number(row.gross_sales_yen)
  if (!Number.isFinite(gross) || gross < 0) return null
  return {
    gross_sales_yen: Math.round(gross),
    net_sales_yen: parseOptionalNonNegativeInt(row.net_sales_yen),
    tax_amount_yen: parseOptionalNonNegativeInt(row.tax_amount_yen),
    party_count: parseOptionalNonNegativeInt(row.party_count),
    guest_count: parseOptionalNonNegativeInt(row.guest_count),
    operating_days_count: parseManualMonthOperatingDays(row.operating_days_count),
    updated_at: row.updated_at != null ? String(row.updated_at) : null,
  }
}

export async function fetchManualMonthSales(
  supabase: any,
  storePartitionKey: string,
  salesMonthYyyyMm: string,
): Promise<ManualMonthSalesRecord | null> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  const month = String(salesMonthYyyyMm ?? "").trim().slice(0, 7)
  if (!key || !/^\d{4}-\d{2}$/.test(month)) return null

  const { data, error } = await supabase
    .from("line_sales_manual_month_gross")
    .select("gross_sales_yen, net_sales_yen, tax_amount_yen, party_count, guest_count, operating_days_count, updated_at")
    .eq("store_partition_key", key)
    .eq("sales_month", month)
    .maybeSingle()

  if (error) {
    console.error(`fetchManualMonthSales failed (store=${key}, month=${month}):`, error.message)
    return null
  }
  return manualMonthSalesFromRow(data as Record<string, unknown> | null)
}

export async function fetchManualMonthSalesMapForStore(
  supabase: any,
  storePartitionKey: string,
  salesMonths: string[],
): Promise<Map<string, ManualMonthSalesRecord>> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  const months = [...new Set(
    salesMonths.map((m) => String(m ?? "").trim().slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)),
  )]
  const out = new Map<string, ManualMonthSalesRecord>()
  if (!key || months.length === 0) return out

  const { data, error } = await supabase
    .from("line_sales_manual_month_gross")
    .select("sales_month, gross_sales_yen, net_sales_yen, tax_amount_yen, party_count, guest_count, operating_days_count, updated_at")
    .eq("store_partition_key", key)
    .in("sales_month", months)

  if (error) {
    console.error(`fetchManualMonthSalesMapForStore failed (store=${key}):`, error.message)
    return out
  }

  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const sm = String(r.sales_month ?? "").trim().slice(0, 7)
    const parsed = manualMonthSalesFromRow(r)
    if (parsed) out.set(sm, parsed)
  }
  return out
}

export async function upsertManualMonthSalesEntries(
  supabase: any,
  storePartitionKey: string,
  entries: ManualMonthSalesUpsertEntry[],
): Promise<void> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)

  for (const entry of entries) {
    const salesMonth = String(entry.sales_month ?? "").trim().slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(salesMonth)) continue

    if (entry.gross_sales_yen === null) {
      const { error } = await supabase
        .from("line_sales_manual_month_gross")
        .delete()
        .eq("store_partition_key", key)
        .eq("sales_month", salesMonth)
      if (error) throw new Error(error.message)
      continue
    }

    const party = entry.party_count === undefined
      ? null
      : parseOptionalNonNegativeInt(entry.party_count)
    const guest = entry.guest_count === undefined
      ? null
      : parseOptionalNonNegativeInt(entry.guest_count)
    const net = entry.net_sales_yen === undefined
      ? null
      : parseOptionalNonNegativeInt(entry.net_sales_yen)
    const tax = entry.tax_amount_yen === undefined
      ? null
      : parseOptionalNonNegativeInt(entry.tax_amount_yen)
    const operatingDays = entry.operating_days_count === undefined
      ? null
      : parseManualMonthOperatingDays(entry.operating_days_count)
    const updatedAt = normalizeUpdatedAtInput(entry.updated_at) ?? new Date().toISOString()

    const { error } = await supabase
      .from("line_sales_manual_month_gross")
      .upsert(
        {
          store_partition_key: key,
          sales_month: salesMonth,
          gross_sales_yen: Math.round(entry.gross_sales_yen),
          net_sales_yen: net,
          tax_amount_yen: tax,
          party_count: party,
          guest_count: guest,
          operating_days_count: operatingDays,
          updated_at: updatedAt,
        },
        { onConflict: "store_partition_key,sales_month" },
      )
    if (error) throw new Error(error.message)
  }
}
