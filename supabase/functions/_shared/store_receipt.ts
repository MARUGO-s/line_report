import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { LineImageReceiptAnalysis, MonthCumulativeTotals } from './receipt_types.ts'
import {
  buildReceiptSummaryText,
  parseCurrencyAmount,
  parseIntegerCount,
  resolveReceiptDateIsoForPersist,
} from './receipt_parse.ts'

export type StoreReceiptRow = {
  id: number
  line_message_id: string
  room_id: string
  store_name: string | null
  receipt_date_text: string | null
  receipt_date: string | null
  net_sales_yen: number | null
  tax_amount_yen: number | null
  gross_sales_yen: number | null
  party_count: number | null
  guest_count: number | null
  unit_price_yen: number | null
  summary_text: string | null
  raw_payload: unknown
}

export function receiptRowToAnalysis(row: StoreReceiptRow): LineImageReceiptAnalysis {
  const raw = row.raw_payload
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const source = raw as Record<string, unknown>
    return {
      storeName: source.storeName != null ? String(source.storeName) : row.store_name,
      storePhone: source.storePhone != null ? String(source.storePhone) : null,
      date: source.date != null ? String(source.date) : row.receipt_date_text,
      netSales: source.netSales != null ? String(source.netSales) : formatYenField(row.net_sales_yen),
      taxAmount: source.taxAmount != null ? String(source.taxAmount) : formatYenField(row.tax_amount_yen),
      grossSales: source.grossSales != null ? String(source.grossSales) : formatYenField(row.gross_sales_yen),
      partyCount: source.partyCount != null ? String(source.partyCount) : formatCountField(row.party_count),
      guestCount: source.guestCount != null ? String(source.guestCount) : formatCountField(row.guest_count),
      unitPrice: source.unitPrice != null ? String(source.unitPrice) : formatYenField(row.unit_price_yen),
      items: Array.isArray(source.items) ? source.items.map(String) : [],
    }
  }
  return {
    storeName: row.store_name,
    storePhone: null,
    date: row.receipt_date_text,
    netSales: formatYenField(row.net_sales_yen),
    taxAmount: formatYenField(row.tax_amount_yen),
    grossSales: formatYenField(row.gross_sales_yen),
    partyCount: formatCountField(row.party_count),
    guestCount: formatCountField(row.guest_count),
    unitPrice: formatYenField(row.unit_price_yen),
    items: [],
  }
}

function formatYenField(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return `¥${Math.round(value).toLocaleString('ja-JP')}`
}

function formatCountField(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return String(Math.round(value))
}

function mapStoreReceiptRow(data: Record<string, unknown>): StoreReceiptRow | null {
  const id = Number(data.id)
  if (!Number.isFinite(id) || id <= 0) return null
  return {
    id,
    line_message_id: String(data.line_message_id ?? ''),
    room_id: String(data.room_id ?? ''),
    store_name: data.store_name != null ? String(data.store_name) : null,
    receipt_date_text: data.receipt_date_text != null ? String(data.receipt_date_text) : null,
    receipt_date: data.receipt_date != null ? String(data.receipt_date).slice(0, 10) : null,
    net_sales_yen: data.net_sales_yen != null ? Number(data.net_sales_yen) : null,
    tax_amount_yen: data.tax_amount_yen != null ? Number(data.tax_amount_yen) : null,
    gross_sales_yen: data.gross_sales_yen != null ? Number(data.gross_sales_yen) : null,
    party_count: data.party_count != null ? Number(data.party_count) : null,
    guest_count: data.guest_count != null ? Number(data.guest_count) : null,
    unit_price_yen: data.unit_price_yen != null ? Number(data.unit_price_yen) : null,
    summary_text: data.summary_text != null ? String(data.summary_text) : null,
    raw_payload: data.raw_payload ?? null,
  }
}

export async function loadStoreReceiptByLineMessageId(
  supabase: SupabaseClient,
  receiptTable: string,
  roomId: string,
  lineMessageId: string,
): Promise<StoreReceiptRow | null> {
  const lmid = String(lineMessageId ?? '').trim()
  if (!lmid) return null
  const { data, error } = await supabase
    .from(receiptTable)
    .select('*')
    .eq('room_id', roomId)
    .eq('line_message_id', lmid)
    .maybeSingle()
  if (error || !data) return null
  return mapStoreReceiptRow(data as Record<string, unknown>)
}

export async function loadLatestStoreReceiptForRoom(
  supabase: SupabaseClient,
  receiptTable: string,
  roomId: string,
): Promise<StoreReceiptRow | null> {
  const { data, error } = await supabase
    .from(receiptTable)
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  return mapStoreReceiptRow(data as Record<string, unknown>)
}

export async function deleteStoreReceiptByLineMessageId(
  supabase: SupabaseClient,
  receiptTable: string,
  roomId: string,
  lineMessageId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const lmid = String(lineMessageId ?? '').trim()
  if (!lmid) return { ok: false, message: 'LINEメッセージIDが空です。' }
  const { data, error: selectError } = await supabase
    .from(receiptTable)
    .select('id')
    .eq('room_id', roomId)
    .eq('line_message_id', lmid)
    .maybeSingle()
  if (selectError) {
    console.error('deleteStoreReceiptByLineMessageId select failed:', selectError.message)
    return { ok: false, message: '解析結果の照会に失敗しました。少し時間を置いてお試しください。' }
  }
  if (!data) {
    return { ok: false, message: 'このルームで該当のレシート解析が見つかりませんでした。' }
  }
  const { error: deleteError } = await supabase
    .from(receiptTable)
    .delete()
    .eq('id', (data as { id: number }).id)
    .eq('room_id', roomId)
  if (deleteError) {
    console.error('deleteStoreReceiptByLineMessageId delete failed:', deleteError.message)
    return { ok: false, message: '解析結果の削除に失敗しました。少し時間を置いてお試しください。' }
  }
  return { ok: true }
}

export async function updateStoreReceiptFromDraft(
  supabase: SupabaseClient,
  receiptTable: string,
  receiptRowId: number,
  roomId: string,
  storeDisplayName: string,
  draft: LineImageReceiptAnalysis,
): Promise<{ receipt: LineImageReceiptAnalysis; receiptDateIso: string } | null> {
  if (!Number.isFinite(receiptRowId) || receiptRowId <= 0) return null
  const receiptDateIso = resolveReceiptDateIsoForPersist(draft.date)
  const payload = {
    store_name: draft.storeName ?? storeDisplayName,
    receipt_date_text: draft.date,
    receipt_date: receiptDateIso,
    net_sales_yen: parseCurrencyAmount(draft.netSales),
    tax_amount_yen: parseCurrencyAmount(draft.taxAmount),
    gross_sales_yen: parseCurrencyAmount(draft.grossSales),
    party_count: parseIntegerCount(draft.partyCount),
    guest_count: parseIntegerCount(draft.guestCount),
    unit_price_yen: parseCurrencyAmount(draft.unitPrice),
    summary_text: buildReceiptSummaryText(draft, storeDisplayName).slice(0, 240) || null,
    raw_payload: draft,
  }
  const { data, error } = await supabase
    .from(receiptTable)
    .update(payload)
    .eq('id', receiptRowId)
    .eq('room_id', roomId)
    .select('*')
    .maybeSingle()
  if (error || !data) {
    console.error('updateStoreReceiptFromDraft failed:', error?.message)
    return null
  }
  const row = mapStoreReceiptRow(data as Record<string, unknown>)
  if (!row) return null
  return { receipt: receiptRowToAnalysis(row), receiptDateIso }
}

export async function hasExistingReceiptForDate(
  supabase: SupabaseClient,
  receiptTable: string,
  receiptDateIso: string,
): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(receiptDateIso ?? '').trim())) return false
  const { data, error } = await supabase
    .from(receiptTable)
    .select('id')
    .eq('receipt_date', receiptDateIso.trim())
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('hasExistingReceiptForDate failed:', error.message)
    return false
  }
  return data != null
}

export async function deleteReceiptsForDateExcludingLineMessageId(
  supabase: SupabaseClient,
  receiptTable: string,
  receiptDateIso: string,
  excludeLineMessageId: string,
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(receiptDateIso ?? '').trim())) return
  const exclude = String(excludeLineMessageId ?? '').trim()
  let query = supabase
    .from(receiptTable)
    .delete()
    .eq('receipt_date', receiptDateIso.trim())
  if (exclude) {
    query = query.neq('line_message_id', exclude)
  }
  const { error } = await query
  if (error) {
    console.error('deleteReceiptsForDateExcludingLineMessageId failed:', error.message)
  }
}

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
