import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { LineImageReceiptAnalysis, MonthCumulativeTotals } from './receipt_types.ts'
import {
  buildReceiptSummaryText,
  formatYenAmount,
  isPlausibleReceiptCount,
  looksLikeOcrLatinStoreLabel,
  parseCurrencyAmount,
  parseIntegerCount,
  resolveReceiptDateIsoForPersist,
} from './receipt_parse.ts'
import { indexLineRoomReceiptSearch } from './line_room_search_archive.ts'

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

function countFromRawOrDb(rawVal: unknown, dbVal: number | null, max: number): string | null {
  const fromDb = formatCountField(dbVal)
  if (rawVal == null || String(rawVal).trim() === '') return fromDb
  const parsed = parseIntegerCount(String(rawVal))
  if (parsed == null || !isPlausibleReceiptCount(parsed, max)) return fromDb
  return String(parsed)
}

function currencyFromRawOrDb(rawVal: unknown, dbVal: number | null): string | null {
  const fromDb = formatYenField(dbVal)
  if (rawVal == null || String(rawVal).trim() === '') return fromDb
  const parsed = parseCurrencyAmount(String(rawVal))
  if (parsed == null) return fromDb
  if (dbVal != null && dbVal >= 1000 && parsed <= 99) return fromDb
  return formatYenAmount(parsed)
}

export function receiptRowToAnalysis(row: StoreReceiptRow): LineImageReceiptAnalysis {
  const fromColumns: LineImageReceiptAnalysis = {
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

  const raw = row.raw_payload
  if (!(raw && typeof raw === 'object' && !Array.isArray(raw))) {
    return repairReceiptAnalysisFromColumns(fromColumns, row)
  }

  const source = raw as Record<string, unknown>
  const merged: LineImageReceiptAnalysis = {
    // 店名は DB 列（登録店舗名）を優先。raw_payload はレシート OCR の略称になりがち
    storeName: fromColumns.storeName?.trim()
      ? fromColumns.storeName
      : (source.storeName != null ? String(source.storeName) : null),
    storePhone: source.storePhone != null ? String(source.storePhone) : null,
    date: source.date != null ? String(source.date) : fromColumns.date,
    netSales: currencyFromRawOrDb(source.netSales, row.net_sales_yen),
    taxAmount: currencyFromRawOrDb(source.taxAmount, row.tax_amount_yen),
    grossSales: currencyFromRawOrDb(source.grossSales, row.gross_sales_yen),
    partyCount: countFromRawOrDb(source.partyCount, row.party_count, 9999),
    guestCount: countFromRawOrDb(source.guestCount, row.guest_count, 99_999),
    unitPrice: currencyFromRawOrDb(source.unitPrice, row.unit_price_yen),
    items: Array.isArray(source.items) ? source.items.map(String) : [],
  }
  return repairReceiptAnalysisFromColumns(merged, row)
}

/** DB列の整合（純売上≪総売上、組数が日付化）を直してから修正UIに渡す */
function repairReceiptAnalysisFromColumns(
  draft: LineImageReceiptAnalysis,
  row: StoreReceiptRow,
): LineImageReceiptAnalysis {
  const next = { ...draft }
  const gross = row.gross_sales_yen
  const net = row.net_sales_yen
  const tax = row.tax_amount_yen
  if (gross != null && gross >= 1000 && (net == null || net < 1000)) {
    if (tax != null && gross > tax) {
      next.netSales = formatYenAmount(gross - tax)
    } else {
      next.netSales = formatYenField(gross)
    }
  }
  if (row.party_count != null && !isPlausibleReceiptCount(row.party_count)) {
    next.partyCount = null
  }
  if (row.guest_count != null && !isPlausibleReceiptCount(row.guest_count, 99_999)) {
    next.guestCount = null
  }
  return next
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

/** 売上検索など：同一店舗テーブル内で room を問わず line_message_id で取得 */
export async function loadStoreReceiptByLineMessageIdInStore(
  supabase: SupabaseClient,
  receiptTable: string,
  lineMessageId: string,
): Promise<StoreReceiptRow | null> {
  const lmid = String(lineMessageId ?? '').trim()
  if (!lmid) return null
  const { data, error } = await supabase
    .from(receiptTable)
    .select('*')
    .eq('line_message_id', lmid)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  return mapStoreReceiptRow(data as Record<string, unknown>)
}

export async function loadStoreReceiptById(
  supabase: SupabaseClient,
  receiptTable: string,
  receiptRowId: number,
): Promise<StoreReceiptRow | null> {
  const id = Number(receiptRowId)
  if (!Number.isFinite(id) || id <= 0) return null
  const { data, error } = await supabase
    .from(receiptTable)
    .select('*')
    .eq('id', Math.round(id))
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

export async function deleteStoreReceiptById(
  supabase: SupabaseClient,
  receiptTable: string,
  receiptRowId: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const id = Math.round(Number(receiptRowId))
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, message: 'レシート行IDが不正です。' }
  }
  const existing = await loadStoreReceiptById(supabase, receiptTable, id)
  if (!existing) {
    return { ok: false, message: 'この店舗のデータで該当のレシート解析が見つかりませんでした。' }
  }
  const { error: deleteError } = await supabase
    .from(receiptTable)
    .delete()
    .eq('id', id)
  if (deleteError) {
    console.error('deleteStoreReceiptById delete failed:', deleteError.message)
    return { ok: false, message: '解析結果の削除に失敗しました。少し時間を置いてお試しください。' }
  }
  return { ok: true }
}

export async function deleteStoreReceiptByLineMessageId(
  supabase: SupabaseClient,
  receiptTable: string,
  roomId: string,
  lineMessageId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const lmid = String(lineMessageId ?? '').trim()
  if (!lmid) return { ok: false, message: 'LINEメッセージIDが空です。' }
  let rowId: number | null = null
  const { data: roomScoped, error: selectError } = await supabase
    .from(receiptTable)
    .select('id')
    .eq('room_id', roomId)
    .eq('line_message_id', lmid)
    .maybeSingle()
  if (selectError) {
    console.error('deleteStoreReceiptByLineMessageId select failed:', selectError.message)
    return { ok: false, message: '解析結果の照会に失敗しました。少し時間を置いてお試しください。' }
  }
  if (roomScoped) {
    rowId = Number((roomScoped as { id: number }).id)
  } else {
    const storeWide = await loadStoreReceiptByLineMessageIdInStore(supabase, receiptTable, lmid)
    rowId = storeWide?.id ?? null
  }
  if (!rowId || !Number.isFinite(rowId)) {
    return { ok: false, message: 'この店舗のデータで該当のレシート解析が見つかりませんでした。' }
  }
  const { error: deleteError } = await supabase
    .from(receiptTable)
    .delete()
    .eq('id', Math.round(rowId))
  if (deleteError) {
    console.error('deleteStoreReceiptByLineMessageId delete failed:', deleteError.message)
    return { ok: false, message: '解析結果の削除に失敗しました。少し時間を置いてお試しください。' }
  }
  return { ok: true }
}

function sanitizeDraftForPersist(
  draft: LineImageReceiptAnalysis,
  storeDisplayName: string,
): LineImageReceiptAnalysis {
  const next = { ...draft, items: Array.isArray(draft.items) ? [...draft.items] : [] }
  const gross = parseCurrencyAmount(next.grossSales)
  let net = parseCurrencyAmount(next.netSales)
  const tax = parseCurrencyAmount(next.taxAmount)
  if (gross != null && gross >= 1000 && (net == null || net < 1000)) {
    net = tax != null && gross > tax ? gross - tax : gross
    next.netSales = formatYenAmount(net)
  }
  let party = parseIntegerCount(next.partyCount)
  if (party != null && !isPlausibleReceiptCount(party)) party = null
  else if (party != null) next.partyCount = String(party)

  let guest = parseIntegerCount(next.guestCount)
  if (guest != null && !isPlausibleReceiptCount(guest, 99_999)) guest = null
  else if (guest != null) next.guestCount = String(guest)

  const canonical = String(storeDisplayName ?? '').trim()
  if (canonical) {
    if (!next.storeName?.trim() || looksLikeOcrLatinStoreLabel(next.storeName)) {
      next.storeName = canonical
    }
  } else if (!next.storeName?.trim()) {
    next.storeName = storeDisplayName
  }
  return next
}

export async function updateStoreReceiptFromDraft(
  supabase: SupabaseClient,
  receiptTable: string,
  receiptRowId: number,
  roomId: string,
  storeDisplayName: string,
  draft: LineImageReceiptAnalysis,
  options?: { storePartitionKey?: string | null },
): Promise<{ receipt: LineImageReceiptAnalysis; receiptDateIso: string } | null> {
  if (!Number.isFinite(receiptRowId) || receiptRowId <= 0) return null
  const safeDraft = sanitizeDraftForPersist(draft, storeDisplayName)
  const receiptDateIso = resolveReceiptDateIsoForPersist(safeDraft.date)
  const partyCount = parseIntegerCount(safeDraft.partyCount)
  const guestCount = parseIntegerCount(safeDraft.guestCount)
  const payload = {
    store_name: storeDisplayName,
    receipt_date_text: safeDraft.date,
    receipt_date: receiptDateIso,
    net_sales_yen: parseCurrencyAmount(safeDraft.netSales),
    tax_amount_yen: parseCurrencyAmount(safeDraft.taxAmount),
    gross_sales_yen: parseCurrencyAmount(safeDraft.grossSales),
    party_count: partyCount != null && isPlausibleReceiptCount(partyCount) ? partyCount : null,
    guest_count: guestCount != null && isPlausibleReceiptCount(guestCount, 99_999) ? guestCount : null,
    unit_price_yen: parseCurrencyAmount(safeDraft.unitPrice),
    summary_text: buildReceiptSummaryText(safeDraft, storeDisplayName).slice(0, 240) || null,
    raw_payload: safeDraft,
  }
  const { data, error } = await supabase
    .from(receiptTable)
    .update(payload)
    .eq('id', receiptRowId)
    .select('*')
    .maybeSingle()
  if (error || !data) {
    console.error('updateStoreReceiptFromDraft failed:', error?.message)
    return null
  }
  const row = mapStoreReceiptRow(data as Record<string, unknown>)
  if (!row) return null

  if (row.line_message_id) {
    await indexLineRoomReceiptSearch(supabase, {
      roomId: row.room_id || roomId,
      storePartitionKey: options?.storePartitionKey ?? null,
      lineMessageId: row.line_message_id,
      receiptDate: receiptDateIso,
      receiptDateText: safeDraft.date,
      storeName: payload.store_name,
      summaryText: payload.summary_text ?? '',
      grossSalesYen: payload.gross_sales_yen,
      netSalesYen: payload.net_sales_yen,
      taxAmountYen: payload.tax_amount_yen,
      partyCount: payload.party_count,
      guestCount: payload.guest_count,
      unitPriceYen: payload.unit_price_yen,
      receiptTable,
      receiptRowId,
    }).catch((e) => console.error('indexLineRoomReceiptSearch after correction failed:', e))
  }

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
    storePartitionKey?: string | null
    receipt: LineImageReceiptAnalysis
    summary: string
  },
): Promise<{ ok: boolean; duplicate?: boolean; error?: string; receiptRowId?: number }> {
  const receiptDateIso = resolveReceiptDateIsoForPersist(params.receipt.date)
  const receiptDateText = params.receipt.date
  const summaryText = buildReceiptSummaryText(params.receipt, params.storeDisplayName).slice(0, 240) || null
  const grossSalesYen = parseCurrencyAmount(params.receipt.grossSales)
  const netSalesYen = parseCurrencyAmount(params.receipt.netSales)
  const taxAmountYen = parseCurrencyAmount(params.receipt.taxAmount)
  const partyCount = parseIntegerCount(params.receipt.partyCount)
  const guestCount = parseIntegerCount(params.receipt.guestCount)
  const unitPriceYen = parseCurrencyAmount(params.receipt.unitPrice)
  const { data, error } = await supabase.from(receiptTable).insert({
    line_message_id: params.lineMessageId,
    room_id: params.roomId,
    user_id: params.userId,
    sender_display_name: params.senderDisplayName,
    store_name: params.storeDisplayName,
    receipt_date_text: receiptDateText,
    receipt_date: receiptDateIso,
    net_sales_yen: netSalesYen,
    tax_amount_yen: taxAmountYen,
    gross_sales_yen: grossSalesYen,
    party_count: partyCount,
    guest_count: guestCount,
    unit_price_yen: unitPriceYen,
    summary_text: summaryText,
    raw_payload: params.receipt,
  }).select('id').single()

  if (error) {
    if (String(error.code) === '23505') return { ok: false, duplicate: true }
    return { ok: false, error: error.message }
  }

  const receiptRowId = Number((data as { id?: unknown } | null)?.id)
  if (Number.isFinite(receiptRowId) && receiptRowId > 0) {
    await indexLineRoomReceiptSearch(supabase, {
      roomId: params.roomId,
      storePartitionKey: params.storePartitionKey ?? null,
      lineMessageId: params.lineMessageId,
      receiptDate: receiptDateIso,
      receiptDateText,
      storeName: params.storeDisplayName,
      taxAmountYen,
      partyCount,
      guestCount,
      unitPriceYen,
      summaryText: summaryText || params.summary || '',
      grossSalesYen,
      netSalesYen,
      receiptTable,
      receiptRowId,
    })
  }

  return { ok: true, receiptRowId }
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
  /** レシート照合用（数字のみ）。未設定時はコード内フォールバック */
  receipt_phones?: string[] | null
}

export function createServiceClient(): SupabaseClient | null {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !supabaseKey) return null
  return createClient(supabaseUrl, supabaseKey)
}
