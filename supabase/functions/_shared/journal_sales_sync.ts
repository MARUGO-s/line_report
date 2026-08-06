import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { canonicalStorePartitionKeyForDb } from "./receipt_sheets_store_catalog.ts"

/**
 * POS電子ジャーナル → 過去売上（line_sales_manual_day / _month_gross）の自動同期。
 *
 * 設計上の要点:
 * - 月次は「アップロードされたレポート」ではなく「日次テーブル全体」から再計算する。
 *   1日分だけ読み込んだときに完全な月が1日分へ縮む事故を構造的に防ぐため。
 * - ジャーナルを正とするが、上書きした非ジャーナル行は結果に含めて呼び出し側へ返す。
 * - 店舗ごとに store_operation_profiles.profile.journalSalesSync で有効化する。既定はOFF。
 */

export type JournalSalesSyncResult = {
  enabled: boolean
  daysWritten: number
  monthsWritten: number
  /** ジャーナル以外の出所だった行を上書きした日付（監査用） */
  overwrittenNonJournal: string[]
  months: string[]
}

type DailyTotals = {
  gross: number
  tax: number
  guests: number
  groups: number
}

const EMPTY_RESULT: JournalSalesSyncResult = {
  enabled: false,
  daysWritten: 0,
  monthsWritten: 0,
  overwrittenNonJournal: [],
  months: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function toFiniteNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 'YYYY-MM-DD' のみ受け付ける。POS側の表記ゆれは無視する（推測で日付を作らない）。 */
function normalizeDate(value: unknown): string {
  const s = String(value ?? "").trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""
}

/**
 * 保存済みレポートの data.sales（会計単位の明細）を日付で集計する。
 * 合算レポートを渡しても日付単位の値は変わらないため冪等。
 */
export function extractDailyTotalsFromReport(
  reportData: unknown,
): Map<string, DailyTotals> {
  const out = new Map<string, DailyTotals>()
  if (!isRecord(reportData)) return out
  const sales = reportData.sales
  if (!Array.isArray(sales)) return out

  for (const entry of sales) {
    if (!isRecord(entry)) continue
    const date = normalizeDate(entry.date)
    if (!date) continue
    const current = out.get(date) ?? { gross: 0, tax: 0, guests: 0, groups: 0 }
    current.gross += toFiniteNumber(entry.total)
    current.tax += toFiniteNumber(entry.tax)
    current.guests += toFiniteNumber(entry.customers)
    current.groups += toFiniteNumber(entry.groups)
    out.set(date, current)
  }
  return out
}

/** 店舗プロフィールの journalSalesSync フラグ。未設定は false。 */
export async function isJournalSalesSyncEnabled(
  supabase: SupabaseClient,
  storePartitionKey: string,
): Promise<boolean> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  if (!key) return false
  const { data, error } = await supabase
    .from("store_operation_profiles")
    .select("profile")
    .eq("store_partition_key", key)
    .maybeSingle()
  if (error || !data) return false
  const profile = (data as Record<string, unknown>).profile
  if (!isRecord(profile)) return false
  return profile.journalSalesSync === true
}

/**
 * 日次行から月次集計を作る。営業日は総売上 > 0 の日だけ。
 * 出所が混在する月は source=mixed（単一ならその値）。
 */
export function summarizeMonthFromDayRows(
  rows: Record<string, unknown>[],
): {
  gross: number
  tax: number
  guests: number
  groups: number
  operatingDays: number
  source: string
} {
  let gross = 0, tax = 0, guests = 0, groups = 0, operatingDays = 0
  const sources = new Set<string>()
  for (const row of rows) {
    const dayGross = toFiniteNumber(row.gross_sales_yen)
    gross += dayGross
    tax += toFiniteNumber(row.tax_amount_yen)
    guests += toFiniteNumber(row.guest_count)
    groups += toFiniteNumber(row.party_count)
    // 休業日（0円）や客数のみの行を営業日に数えない
    if (dayGross > 0) operatingDays += 1
    const source = row.source == null ? "" : String(row.source).trim()
    if (source) sources.add(source)
  }
  let source = "journal"
  if (sources.size === 1) source = [...sources][0]!
  else if (sources.size > 1) source = "mixed"
  return { gross, tax, guests, groups, operatingDays, source }
}

/** 影響した月を日次テーブル全体から再集計して月次へ書き戻す。 */
async function rebuildMonthsFromDays(
  supabase: SupabaseClient,
  key: string,
  months: string[],
): Promise<number> {
  let written = 0
  for (const month of months) {
    const from = `${month}-01`
    // 月末は月初+1か月の前日。UTC固定で計算し、実行環境のTZに依存させない。
    const [y, m] = month.split("-").map((v) => Number(v))
    const nextMonth = new Date(Date.UTC(y, m, 1))
    const to = new Date(nextMonth.getTime() - 86400000).toISOString().slice(0, 10)

    const { data, error } = await supabase
      .from("line_sales_manual_day")
      .select("gross_sales_yen, tax_amount_yen, guest_count, party_count, source")
      .eq("store_partition_key", key)
      .gte("sales_date", from)
      .lte("sales_date", to)
    if (error) throw new Error(error.message)

    const rows = (data ?? []) as Record<string, unknown>[]
    if (!rows.length) continue

    const summary = summarizeMonthFromDayRows(rows)

    const { error: upsertError } = await supabase
      .from("line_sales_manual_month_gross")
      .upsert({
        store_partition_key: key,
        sales_month: month,
        gross_sales_yen: Math.round(summary.gross),
        net_sales_yen: Math.round(summary.gross - summary.tax),
        tax_amount_yen: Math.round(summary.tax),
        guest_count: Math.round(summary.guests),
        party_count: Math.round(summary.groups),
        operating_days_count: summary.operatingDays,
        source: summary.source,
        updated_at: new Date().toISOString(),
      }, { onConflict: "store_partition_key,sales_month" })
    if (upsertError) throw new Error(upsertError.message)
    written += 1
  }
  return written
}

/**
 * 保存済みレポート1件から日次・月次を同期する。
 * 同期がOFFの店舗、または売上明細を持たないレポートでは何もしない。
 */
export async function syncJournalSalesFromReport(
  supabase: SupabaseClient,
  storePartitionKey: string,
  reportData: unknown,
): Promise<JournalSalesSyncResult> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  if (!key) return EMPTY_RESULT
  if (!(await isJournalSalesSyncEnabled(supabase, key))) return EMPTY_RESULT

  const daily = extractDailyTotalsFromReport(reportData)
  if (!daily.size) {
    return { ...EMPTY_RESULT, enabled: true }
  }

  const dates = [...daily.keys()].sort()

  // 上書き対象の既存行を先に読み、ジャーナル以外の出所だったものを記録する。
  const { data: existingRows, error: existingError } = await supabase
    .from("line_sales_manual_day")
    .select("sales_date, source")
    .eq("store_partition_key", key)
    .in("sales_date", dates)
  if (existingError) throw new Error(existingError.message)

  const overwrittenNonJournal: string[] = []
  for (const row of (existingRows ?? []) as Record<string, unknown>[]) {
    const source = row.source == null ? "" : String(row.source)
    if (source !== "journal") {
      overwrittenNonJournal.push(String(row.sales_date).slice(0, 10))
    }
  }

  const now = new Date().toISOString()
  const payload = dates.map((date) => {
    const totals = daily.get(date)!
    return {
      store_partition_key: key,
      sales_date: date,
      gross_sales_yen: Math.round(totals.gross),
      tax_amount_yen: Math.round(totals.tax),
      guest_count: Math.round(totals.guests),
      party_count: Math.round(totals.groups),
      source: "journal",
      updated_at: now,
    }
  })

  const { error: dayError } = await supabase
    .from("line_sales_manual_day")
    .upsert(payload, { onConflict: "store_partition_key,sales_date" })
  if (dayError) throw new Error(dayError.message)

  const months = [...new Set(dates.map((d) => d.slice(0, 7)))].sort()
  const monthsWritten = await rebuildMonthsFromDays(supabase, key, months)

  return {
    enabled: true,
    daysWritten: payload.length,
    monthsWritten,
    overwrittenNonJournal: overwrittenNonJournal.sort(),
    months,
  }
}
