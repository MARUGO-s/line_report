#!/usr/bin/env node
/**
 * 一回限り: jhpm → hocbn へ bistrocavacava の売上データを丸ごと置き換え
 *
 * Usage:
 *   JHPM_SERVICE_ROLE_KEY=... HOCBN_SERVICE_ROLE_KEY=... node scripts/migrate-bistrocavacava-jhpm-to-hocbn.mjs
 */
const STORE = 'bistrocavacava'
const JHPM_URL = 'https://jhpmzqxqvapdkyvvhyra.supabase.co'
const HOCBN_URL = 'https://hocbnifuactbvmyjraxy.supabase.co'
const PAGE = 1000

const jhpmKey = process.env.JHPM_SERVICE_ROLE_KEY?.trim()
const hocbnKey = process.env.HOCBN_SERVICE_ROLE_KEY?.trim()
if (!jhpmKey || !hocbnKey) {
  console.error('Set JHPM_SERVICE_ROLE_KEY and HOCBN_SERVICE_ROLE_KEY')
  process.exit(1)
}

async function rest(base, key, method, path, { body, prefer, range } = {}) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
  if (prefer) headers.Prefer = prefer
  if (range) headers.Range = range
  const res = await fetch(`${base}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
  }
  return { data, headers: res.headers }
}

async function fetchAll(base, key, table, filterQuery) {
  const rows = []
  let offset = 0
  while (true) {
    const path = `${table}?${filterQuery}&select=*`
    const { data } = await rest(base, key, 'GET', `${path}&limit=${PAGE}&offset=${offset}`)
    if (!Array.isArray(data) || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE) break
    offset += PAGE
  }
  return rows
}

async function deleteAllHocbn(table, filter) {
  const path = filter ? `${table}?${filter}` : `${table}?id=gte.0`
  await rest(HOCBN_URL, hocbnKey, 'DELETE', path, { prefer: 'return=minimal' })
}

async function insertBatch(table, rows) {
  if (rows.length === 0) return 0
  const chunk = 100
  let n = 0
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    await rest(HOCBN_URL, hocbnKey, 'POST', table, { body: slice, prefer: 'return=minimal' })
    n += slice.length
  }
  return n
}

function parseRawPayload(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

function mapReceiptRow(row) {
  return {
    line_message_id: row.line_message_id,
    room_id: row.room_id,
    user_id: row.user_id ?? null,
    sender_display_name: row.sender_display_name ?? null,
    store_name: row.store_name ?? null,
    receipt_date_text: row.receipt_date_text ?? null,
    receipt_date: row.receipt_date ?? null,
    net_sales_yen: row.net_sales_yen ?? null,
    tax_amount_yen: row.tax_amount_yen ?? null,
    gross_sales_yen: row.gross_sales_yen ?? null,
    party_count: row.party_count ?? null,
    guest_count: row.guest_count ?? null,
    unit_price_yen: row.unit_price_yen ?? null,
    summary_text: row.summary_text ?? null,
    raw_payload: parseRawPayload(row.raw_payload),
    created_at: row.created_at ?? undefined,
  }
}

function mapBudgetRow(row) {
  const ww = Number(row.weekday_weight) > 0 ? Number(row.weekday_weight) : 1
  const phw = Number(row.pre_holiday_weight) > 0 ? Number(row.pre_holiday_weight) : 1.5
  const hw = Number(row.holiday_weight) > 0 ? Number(row.holiday_weight) : 2
  const closed = Array.isArray(row.store_closed_dates) ? row.store_closed_dates : []
  return {
    store_partition_key: STORE,
    target_month: row.target_month,
    budget_yen: row.budget_yen,
    mon_weight: row.mon_weight ?? ww,
    tue_weight: row.tue_weight ?? ww,
    wed_weight: row.wed_weight ?? ww,
    thu_weight: row.thu_weight ?? ww,
    fri_weight: row.fri_weight ?? ww,
    sat_weight: row.sat_weight ?? phw,
    sun_weight: row.sun_weight ?? hw,
    holiday_weight: row.holiday_weight ?? null,
    pre_holiday_weight: row.pre_holiday_weight ?? null,
    store_closed_dates: closed,
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
    _closed_dates: closed,
  }
}

function closedDaysFromBudget(budgetRows) {
  const out = []
  for (const b of budgetRows) {
    const month = b.target_month
    const dates = b._closed_dates || []
    for (const closed_on of dates) {
      const iso = String(closed_on).slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !iso.startsWith(`${month}-`)) continue
      out.push({ store_partition_key: STORE, target_month: month, closed_on: iso })
    }
    delete b._closed_dates
  }
  return out
}

function mapManualRow(row) {
  return {
    store_partition_key: STORE,
    sales_month: row.sales_month,
    gross_sales_yen: row.gross_sales_yen,
    party_count: row.party_count ?? null,
    guest_count: row.guest_count ?? null,
    operating_days_count: row.operating_days_count ?? null,
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
  }
}

async function main() {
  console.log('=== Fetch from jhpm ===')
  const receipts = await fetchAll(JHPM_URL, jhpmKey, 'line_receipt_entries', `store_partition_key=eq.${STORE}`)
  const budgets = await fetchAll(JHPM_URL, jhpmKey, 'line_sales_month_budgets', `store_partition_key=eq.${STORE}`)
  const manual = await fetchAll(JHPM_URL, jhpmKey, 'line_sales_manual_month_gross', `store_partition_key=eq.${STORE}`)
  let closedDays = []
  try {
    closedDays = await fetchAll(JHPM_URL, jhpmKey, 'line_sales_month_store_closed_days', `store_partition_key=eq.${STORE}`)
  } catch (e) {
    console.warn('jhpm closed_days (skip):', e.message)
  }
  console.log(`jhpm: receipts=${receipts.length} budgets=${budgets.length} manual=${manual.length} closed_days=${closedDays.length}`)

  console.log('=== Clear hocbn (bistrocavacava only) ===')
  await deleteAllHocbn('line_receipt__bistrocavacava', 'id=gte.0')
  await deleteAllHocbn('line_sales_month_store_closed_days', `store_partition_key=eq.${STORE}`)
  await deleteAllHocbn('line_sales_month_budgets', `store_partition_key=eq.${STORE}`)
  await deleteAllHocbn('line_sales_month_budgets', `store_partition_key=eq.weather:${STORE}`)
  await deleteAllHocbn('line_sales_manual_month_gross', `store_partition_key=eq.${STORE}`)
  try {
    await deleteAllHocbn('receipt_sheets_past_sales_export_snapshot', `store_partition_key=eq.${STORE}`)
  } catch (e) {
    console.warn('snapshot delete:', e.message)
  }
  for (const t of [
    'store_receipt_duplicate_pending',
    'store_receipt_correction_pending',
    'store_receipt_store_mismatch_pending',
  ]) {
    try {
      await deleteAllHocbn(t, `store_partition_key=eq.${STORE}`)
    } catch {
      /* table may be empty */
    }
  }
  console.log('hocbn cleared')

  console.log('=== Insert into hocbn ===')
  const receiptRows = receipts.map(mapReceiptRow)
  const budgetMapped = budgets.map(mapBudgetRow)
  const closedFromBudget = closedDaysFromBudget(budgetMapped)
  const budgetRows = budgetMapped.map(({ _closed_dates, ...r }) => r)
  const closedKey = (r) => `${r.target_month}|${r.closed_on}`
  const closedSeen = new Set()
  const allClosed = []
  for (const r of [
    ...closedDays.map((row) => ({
      store_partition_key: STORE,
      target_month: row.target_month,
      closed_on: String(row.closed_on).slice(0, 10),
    })),
    ...closedFromBudget,
  ]) {
    const k = closedKey(r)
    if (closedSeen.has(k)) continue
    closedSeen.add(k)
    allClosed.push(r)
  }
  const manualRows = manual.map(mapManualRow)

  const nReceipts = await insertBatch('line_receipt__bistrocavacava', receiptRows)
  const nBudgets = await insertBatch('line_sales_month_budgets', budgetRows)
  const nClosed = await insertBatch('line_sales_month_store_closed_days', allClosed)
  const nManual = await insertBatch('line_sales_manual_month_gross', manualRows)

  console.log('=== Done ===')
  console.log(`inserted: receipts=${nReceipts} budgets=${nBudgets} closed_days=${nClosed} manual=${nManual}`)

  const { headers } = await rest(HOCBN_URL, hocbnKey, 'GET', `line_receipt__bistrocavacava?select=id&limit=1`, { prefer: 'count=exact' })
  const range = headers.get('content-range') || ''
  console.log(`hocbn verify line_receipt__bistrocavacava: ${range}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
