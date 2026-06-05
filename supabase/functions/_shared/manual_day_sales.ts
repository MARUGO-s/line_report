import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { canonicalStorePartitionKeyForDb } from "./receipt_sheets_store_catalog.ts"

/** 日次売上の手入力上書き（売上分析画面の日次表から直接編集）。null 列はレシート集計へフォールバック。 */
export type ManualDaySalesRecord = {
  gross_sales_yen: number | null
  party_count: number | null
  guest_count: number | null
  updated_at?: string | null
}

/**
 * 1日分の上書き入力。各フィールドは
 *  - undefined: 変更しない（既存値を保持）
 *  - null: その列の上書きを解除（レシート集計へ戻す）
 *  - number: その値で上書き
 */
export type ManualDaySalesUpsertEntry = {
  sales_date: string
  gross_sales_yen?: number | null
  party_count?: number | null
  guest_count?: number | null
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
  if (gross == null && party == null && guest == null) return null
  return {
    gross_sales_yen: gross,
    party_count: party,
    guest_count: guest,
    updated_at: row.updated_at != null ? String(row.updated_at) : null,
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

  const { data, error } = await supabase
    .from("line_sales_manual_day")
    .select("sales_date, gross_sales_yen, party_count, guest_count, updated_at")
    .eq("store_partition_key", key)
    .gte("sales_date", from)
    .lt("sales_date", to)

  if (error) {
    console.error(`fetchManualDaySalesMapForStore failed (store=${key}):`, error.message)
    return out
  }

  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const date = normalizeDateInput(r.sales_date)
    const parsed = manualDaySalesFromRow(r)
    if (date && parsed) out.set(date, parsed)
  }
  return out
}

/**
 * 日次手入力を upsert。各エントリは read-modify-write で既存値とマージする
 *（単一セル編集でも他列を保持）。マージ後に3列すべて null なら行ごと削除し、その日をレシート集計へ戻す。
 */
export async function upsertManualDaySalesEntries(
  supabase: SupabaseClient,
  storePartitionKey: string,
  entries: ManualDaySalesUpsertEntry[],
): Promise<number> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  if (!key) return 0
  let applied = 0

  for (const entry of entries) {
    const salesDate = normalizeDateInput(entry.sales_date)
    if (!salesDate) continue

    const { data: existingRow, error: fetchErr } = await supabase
      .from("line_sales_manual_day")
      .select("gross_sales_yen, party_count, guest_count")
      .eq("store_partition_key", key)
      .eq("sales_date", salesDate)
      .maybeSingle()
    if (fetchErr) throw new Error(fetchErr.message)
    const existing = (existingRow as Record<string, unknown> | null) ?? null

    const resolveField = (
      provided: number | null | undefined,
      current: unknown,
    ): number | null => {
      if (provided === undefined) return parseOptionalNonNegativeInt(current)
      if (provided === null) return null
      return parseOptionalNonNegativeInt(provided)
    }

    const gross = resolveField(entry.gross_sales_yen, existing?.gross_sales_yen)
    const party = resolveField(entry.party_count, existing?.party_count)
    const guest = resolveField(entry.guest_count, existing?.guest_count)

    if (gross == null && party == null && guest == null) {
      if (existing) {
        const { error } = await supabase
          .from("line_sales_manual_day")
          .delete()
          .eq("store_partition_key", key)
          .eq("sales_date", salesDate)
        if (error) throw new Error(error.message)
      }
      applied += 1
      continue
    }

    const { error } = await supabase
      .from("line_sales_manual_day")
      .upsert(
        {
          store_partition_key: key,
          sales_date: salesDate,
          gross_sales_yen: gross,
          party_count: party,
          guest_count: guest,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "store_partition_key,sales_date" },
      )
    if (error) throw new Error(error.message)
    applied += 1
  }

  return applied
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
