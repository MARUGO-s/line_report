import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { canonicalStorePartitionKeyForDb } from "./receipt_sheets_store_catalog.ts"

/** 日次売上の採用値。日別修正→ジャーナル→レシートの順に項目別採用。 */
export type ManualDaySalesRecord = {
  gross_sales_yen: number | null
  party_count: number | null
  guest_count: number | null
  tax_amount_yen?: number | null
  source?: string | null
  updated_at?: string | null
  journal_values?: Record<string, unknown> | null
  manual_values?: Record<string, unknown>
}

/**
 * 1日分の上書き入力。各フィールドは
 *  - undefined: 変更しない（既存値を保持）
 *  - null: 手修正を解除（保存済みジャーナル、なければレシートへ戻す）
 *  - number: その値で上書き
 */
export type ManualDaySalesUpsertEntry = {
  sales_date: string
  gross_sales_yen?: number | null
  party_count?: number | null
  guest_count?: number | null
  tax_amount_yen?: number | null
}

function parseOptionalNonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 0 ? null : Math.round(value)
  }
  const n = Number(String(value).trim())
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

function normalizeDateInput(value: unknown): string {
  const s = String(value ?? "").trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""
}

export function manualDaySalesFromRow(
  row: Record<string, unknown> | null | undefined,
): ManualDaySalesRecord | null {
  if (!row) return null
  const gross = parseOptionalNonNegativeInt(row.gross_sales_yen)
  const party = parseOptionalNonNegativeInt(row.party_count)
  const guest = parseOptionalNonNegativeInt(row.guest_count)
  if (gross == null && party == null && guest == null && parseOptionalNonNegativeInt(row.tax_amount_yen) == null) return null
  return {
    gross_sales_yen: gross,
    party_count: party,
    guest_count: guest,
    tax_amount_yen: parseOptionalNonNegativeInt(row.tax_amount_yen),
    source: row.source != null ? String(row.source) : null,
    updated_at: row.updated_at != null ? String(row.updated_at) : null,
    journal_values: row.journal_values && typeof row.journal_values === 'object' ? row.journal_values as Record<string, unknown> : null,
    manual_values: row.manual_values && typeof row.manual_values === 'object' ? row.manual_values as Record<string, unknown> : undefined,
  }
}

/** [fromInclusive, toExclusive) の日付範囲で店舗の日次手入力を取得（date文字列キー） */
export async function fetchManualDaySalesMapForStore(
  supabase: SupabaseClient,
  storePartitionKey: string,
  fromDateInclusive: string,
  toDateExclusive: string,
): Promise<Map<string, ManualDaySalesRecord>> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  const from = normalizeDateInput(fromDateInclusive)
  const to = normalizeDateInput(toDateExclusive)
  const out = new Map<string, ManualDaySalesRecord>()
  if (!key || !from || !to) return out

  for (let offset = 0; ; offset += 1000) {
  const { data, error } = await supabase
    .from("line_sales_manual_day")
    .select("sales_date, gross_sales_yen, party_count, guest_count, tax_amount_yen, source, updated_at, journal_values, manual_values")
    .eq("store_partition_key", key)
    .gte("sales_date", from)
    .lt("sales_date", to)
    .order('sales_date', { ascending: true })
    .range(offset, offset + 999)

  if (error) {
    throw new Error(`Daily sales source unavailable: ${error.message}`)
  }

  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const date = normalizeDateInput(r.sales_date)
    const parsed = manualDaySalesFromRow(r)
    if (date && parsed) out.set(date, parsed)
  }
  if (!data || data.length < 1000) break
  }
  return out
}

/**
 * 店舗単位のDBロック付きRPCで手修正だけを更新する。原本と他列の手修正を保持し、
 * 解除時もジャーナルを削除しない。原本も手修正もない場合だけ上書き行を削除する。
 */
export async function upsertManualDaySalesEntries(
  supabase: SupabaseClient,
  storePartitionKey: string,
  entries: ManualDaySalesUpsertEntry[],
): Promise<number> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  if (!key) return 0
  // Atomic patches preserve simultaneous edits and the journal underneath them.
  const { data, error } = await supabase.rpc('write_daily_sales_source', {
    p_store_key: key, p_kind: 'manual', p_rows: entries,
  })
  if (error) throw new Error(error.message)
  return Number(data?.applied ?? 0)
}

/** 日別予算の直接入力（手動上書き）を [日付→円] で取得。 */
export async function fetchManualDayBudgetMapForStore(
  supabase: SupabaseClient,
  storePartitionKey: string,
  fromDateInclusive: string,
  toDateExclusive: string,
): Promise<Map<string, number>> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  const from = normalizeDateInput(fromDateInclusive)
  const to = normalizeDateInput(toDateExclusive)
  const out = new Map<string, number>()
  if (!key || !from || !to) return out

  const { data, error } = await supabase
    .from("line_sales_manual_day_budget")
    .select("sales_date, budget_yen")
    .eq("store_partition_key", key)
    .gte("sales_date", from)
    .lt("sales_date", to)

  if (error) {
    console.error(`fetchManualDayBudgetMapForStore failed (store=${key}):`, error.message)
    return out
  }
  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const date = normalizeDateInput(r.sales_date)
    const yen = parseOptionalNonNegativeInt(r.budget_yen)
    if (date && yen != null) out.set(date, yen)
  }
  return out
}

/** 日別予算の直接入力を upsert。budget_yen が null/空/負 の日は行ごと削除（その日は自動按分へ戻す）。 */
export async function upsertManualDayBudgetEntries(
  supabase: SupabaseClient,
  storePartitionKey: string,
  entries: Array<{ sales_date: string; budget_yen?: number | null }>,
): Promise<number> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  if (!key) return 0
  let applied = 0
  for (const entry of entries) {
    const salesDate = normalizeDateInput(entry.sales_date)
    if (!salesDate) continue
    const yen = parseOptionalNonNegativeInt(entry.budget_yen)
    if (yen == null) {
      const { error } = await supabase
        .from("line_sales_manual_day_budget")
        .delete()
        .eq("store_partition_key", key)
        .eq("sales_date", salesDate)
      if (error) throw new Error(error.message)
      applied += 1
      continue
    }
    const { error } = await supabase
      .from("line_sales_manual_day_budget")
      .upsert(
        { store_partition_key: key, sales_date: salesDate, budget_yen: yen, updated_at: new Date().toISOString() },
        { onConflict: "store_partition_key,sales_date" },
      )
    if (error) throw new Error(error.message)
    applied += 1
  }
  return applied
}
