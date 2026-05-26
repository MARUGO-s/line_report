#!/usr/bin/env node
/**
 * 指定4店舗以外の売上関連データを hocbn から削除
 *
 * 保持: bistrocavacava, marugoS, marugoyotsuya, sushikoruri
 *
 * Usage:
 *   HOCBN_SERVICE_ROLE_KEY=... node scripts/purge-sales-except-allowed-stores.mjs
 *   HOCBN_SERVICE_ROLE_KEY=... node scripts/purge-sales-except-allowed-stores.mjs --dry-run
 */
const HOCBN_URL = 'https://hocbnifuactbvmyjraxy.supabase.co'

/** 保持する store_partition_key（大文字小文字は正規化して比較） */
const KEEP_STORES = new Set([
  'bistrocavacava',
  'marugoS',
  'marugoyotsuya',
  'sushikoruri',
])

const dryRun = process.argv.includes('--dry-run')
const key = process.env.HOCBN_SERVICE_ROLE_KEY?.trim()
if (!key) {
  console.error('Set HOCBN_SERVICE_ROLE_KEY')
  process.exit(1)
}

function canonicalKey(store) {
  const s = String(store || '').trim()
  if (!s) return ''
  if (s.toLowerCase() === 'marugos') return 'marugoS'
  return s
}

function shouldKeep(store) {
  const c = canonicalKey(store)
  if (!c) return false
  if (KEEP_STORES.has(c)) return true
  if (KEEP_STORES.has(c.toLowerCase())) return true
  return false
}

async function rest(method, path, { prefer } = {}) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  }
  if (prefer) headers.Prefer = prefer
  const res = await fetch(`${HOCBN_URL}/rest/v1/${path}`, { method, headers })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`)
  return { headers: res.headers, text }
}

async function countTable(table, filter) {
  const q = filter ? `${table}?${filter}&select=id` : `${table}?select=id`
  const { headers } = await rest('GET', q, { prefer: 'count=exact' })
  const range = headers.get('content-range') || ''
  const m = range.match(/\/(\d+)/)
  return m ? Number(m[1]) : 0
}

async function del(path) {
  if (dryRun) return '(dry-run)'
  await rest('DELETE', path, { prefer: 'return=minimal' })
  return 'deleted'
}

async function fetchAllKeys(table, column) {
  const keys = new Set()
  let offset = 0
  const page = 1000
  while (true) {
    const path = `${table}?select=${column}&limit=${page}&offset=${offset}`
    const res = await fetch(`${HOCBN_URL}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`GET ${table} → ${res.status}: ${text}`)
    const data = JSON.parse(text)
    if (!Array.isArray(data) || data.length === 0) break
    for (const row of data) {
      const v = row?.[column]
      if (v != null && String(v).trim()) keys.add(String(v).trim())
    }
    if (data.length < page) break
    offset += page
  }
  return keys
}

async function clearStoreSales(store) {
  const weatherKey = `weather:${store}`
  const receiptTable = `line_receipt__${store}`
  const webhookTable = `line_webhook_raw__${store}`
  const summary = { store, dryRun }

  summary.before = {
    receipts: await countTable(receiptTable, 'id=gte.0').catch(() => -1),
    webhook_raw: await countTable(webhookTable, 'id=gte.0').catch(() => -1),
    budgets: await countTable('line_sales_month_budgets', `store_partition_key=eq.${encodeURIComponent(store)}`),
    manual: await countTable('line_sales_manual_month_gross', `store_partition_key=eq.${encodeURIComponent(store)}`),
  }

  if (dryRun) {
    summary.action = 'would delete'
    return summary
  }

  summary.deleted = {
    budgets: await del(
      `line_sales_month_budgets?or=(store_partition_key.eq.${encodeURIComponent(store)},store_partition_key.eq.${encodeURIComponent(weatherKey)})`,
    ),
    closed_days: await del(`line_sales_month_store_closed_days?store_partition_key=eq.${encodeURIComponent(store)}`),
    manual_month: await del(`line_sales_manual_month_gross?store_partition_key=eq.${encodeURIComponent(store)}`),
    snapshot: await del(`receipt_sheets_past_sales_export_snapshot?store_partition_key=eq.${encodeURIComponent(store)}`).catch(
      () => 'skip',
    ),
    receipts: await del(`${receiptTable}?id=gte.0`).catch((e) => `err: ${e.message}`),
    webhook_raw: await del(`${webhookTable}?id=gte.0`).catch((e) => `err: ${e.message}`),
  }

  for (const t of [
    'store_receipt_duplicate_pending',
    'store_receipt_correction_pending',
    'store_receipt_store_mismatch_pending',
  ]) {
    try {
      summary.deleted[t] = await del(`${t}?store_partition_key=eq.${encodeURIComponent(store)}`)
    } catch {
      summary.deleted[t] = 'skip'
    }
  }

  summary.after = {
    receipts: await countTable(receiptTable, 'id=gte.0').catch(() => -1),
    budgets: await countTable('line_sales_month_budgets', `store_partition_key=eq.${encodeURIComponent(store)}`),
    manual: await countTable('line_sales_manual_month_gross', `store_partition_key=eq.${encodeURIComponent(store)}`),
  }
  return summary
}

async function main() {
  console.log('Keep stores:', [...KEEP_STORES])
  console.log('Mode:', dryRun ? 'DRY RUN' : 'DELETE')

  const registryRows = []
  let offset = 0
  while (true) {
    const path = `store_webhook_tables?select=store_partition_key,receipt_table,raw_table&limit=500&offset=${offset}`
    const res = await fetch(`${HOCBN_URL}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    const data = await res.json()
    if (!Array.isArray(data) || data.length === 0) break
    registryRows.push(...data)
    if (data.length < 500) break
    offset += 500
  }

  const storeKeys = new Set(registryRows.map((r) => r.store_partition_key).filter(Boolean))
  for (const k of await fetchAllKeys('line_sales_manual_month_gross', 'store_partition_key')) storeKeys.add(k)
  for (const k of await fetchAllKeys('line_sales_month_budgets', 'store_partition_key')) {
    const raw = String(k)
    if (raw.startsWith('weather:')) storeKeys.add(raw.slice('weather:'.length))
    else storeKeys.add(raw)
  }

  const toPurge = [...storeKeys].filter((s) => !shouldKeep(s)).sort()
  const kept = [...storeKeys].filter((s) => shouldKeep(s)).sort()

  console.log(`Registry: ${registryRows.length} rows, unique stores: ${storeKeys.size}`)
  console.log('Kept:', kept)
  console.log('Purge:', toPurge)

  const results = []
  for (const store of toPurge) {
    console.log(`\n--- ${store} ---`)
    const r = await clearStoreSales(store)
    console.log(JSON.stringify(r, null, 2))
    results.push(r)
  }

  // レガシー統合テーブル（店舗別テーブル移行前の行）
  const legacyBefore = await countTable('line_receipt_entries', 'id=gte.0').catch(() => -1)
  const notInFilter = `store_partition_key=not.in.(${[...KEEP_STORES].map((k) => encodeURIComponent(canonicalKey(k) || k)).join(',')})`
  console.log(`\n--- line_receipt_entries (legacy) before=${legacyBefore} ---`)
  if (!dryRun && legacyBefore > 0) {
    await del(`line_receipt_entries?${notInFilter}`)
    const legacyAfter = await countTable('line_receipt_entries', 'id=gte.0').catch(() => -1)
    console.log(`legacy after (total)=${legacyAfter}`)
  }

  console.log('\n=== Summary ===')
  console.log(`Purged ${toPurge.length} store(s), kept ${kept.length}`)
  for (const k of kept) {
    const rt = `line_receipt__${canonicalKey(k)}`
    const n = await countTable(rt, 'id=gte.0').catch(() => -1)
    console.log(`  ${k}: receipts=${n}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
