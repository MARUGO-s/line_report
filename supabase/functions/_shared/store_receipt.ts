import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { LineImageReceiptAnalysis, MonthCumulativeTotals } from './receipt_types.ts'
import {
  buildReceiptSummaryText,
  parseCurrencyAmount,
  parseIntegerCount,
  resolveReceiptDateIsoForPersist,
} from './receipt_parse.ts'

export async function saveStoreReceiptEntry(
  supabase: SupabaseClient,
  receiptTable: string,
  params: {
    lineMessageId: string
    roomId: string
    userId: string | null
    senderDisplayName: string | null
    storeDisplayName: string
    receipt: LineImageReceiptAnalysis
    summary: string
  },
): Promise<{ ok: boolean; duplicate?: boolean; error?: string }> {
  const receiptDateIso = resolveReceiptDateIsoForPersist(params.receipt.date)
  const { error } = await supabase.from(receiptTable).insert({
    line_message_id: params.lineMessageId,
    room_id: params.roomId,
    user_id: params.userId,
    sender_display_name: params.senderDisplayName,
    store_name: params.storeDisplayName,
    receipt_date_text: params.receipt.date,
    receipt_date: receiptDateIso,
    net_sales_yen: parseCurrencyAmount(params.receipt.netSales),
    tax_amount_yen: parseCurrencyAmount(params.receipt.taxAmount),
    gross_sales_yen: parseCurrencyAmount(params.receipt.grossSales),
    party_count: parseIntegerCount(params.receipt.partyCount),
    guest_count: parseIntegerCount(params.receipt.guestCount),
    unit_price_yen: parseCurrencyAmount(params.receipt.unitPrice),
    summary_text: buildReceiptSummaryText(params.receipt, params.storeDisplayName).slice(0, 240) || null,
    raw_payload: params.receipt,
  })

  if (error) {
    if (String(error.code) === '23505') return { ok: false, duplicate: true }
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

export async function loadMonthCumulativeTotalsForStoreTable(
  supabase: SupabaseClient,
  receiptTable: string,
  receiptDateIso: string,
): Promise<MonthCumulativeTotals> {
  const empty: MonthCumulativeTotals = { grossSalesYen: null, partyCount: null, guestCount: null }
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(receiptDateIso).trim())
  if (!m) return empty
  const startDateStr = `${m[1]}-${m[2]}-01`
  const year = Number(m[1])
  const month = Number(m[2])
  const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
  const endDateStr = `${String(nextMonth.year).padStart(4, '0')}-${String(nextMonth.month).padStart(2, '0')}-01`

  const { data, error } = await supabase
    .from(receiptTable)
    .select('gross_sales_yen, party_count, guest_count')
    .gte('receipt_date', startDateStr)
    .lt('receipt_date', endDateStr)
    .limit(20000)

  if (error || !Array.isArray(data)) return empty

  let gross = 0
  let party = 0
  let guest = 0
  let hasGross = false
  let hasParty = false
  let hasGuest = false

  for (const row of data) {
    const g = Number((row as Record<string, unknown>).gross_sales_yen)
    const p = Number((row as Record<string, unknown>).party_count)
    const gu = Number((row as Record<string, unknown>).guest_count)
    if (Number.isFinite(g)) { gross += g; hasGross = true }
    if (Number.isFinite(p)) { party += p; hasParty = true }
    if (Number.isFinite(gu)) { guest += gu; hasGuest = true }
  }

  return {
    grossSalesYen: hasGross ? gross : null,
    partyCount: hasParty ? party : null,
    guestCount: hasGuest ? guest : null,
  }
}

export type StoreRegistryRow = {
  store_partition_key: string
  display_name: string
  webhook_raw_table: string
  receipt_table: string
}

export function createServiceClient(): SupabaseClient | null {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !supabaseKey) return null
  return createClient(supabaseUrl, supabaseKey)
}
