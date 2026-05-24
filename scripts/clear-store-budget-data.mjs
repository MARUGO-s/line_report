#!/usr/bin/env node
/**
 * 店舗の売上連携データを DB・スプレッドシートから削除
 * - 月間予算・過去売上（手入力）・日次売上シート
 * - line_receipt__{store}（日次・過去売上のレシート集計元）
 *
 * Usage:
 *   HOCBN_SERVICE_ROLE_KEY=... node scripts/clear-store-budget-data.mjs marugoyotsuya
 *   HOCBN_SERVICE_ROLE_KEY=... node scripts/clear-store-budget-data.mjs marugoyotsuya --keep-receipts
 */
const STORE = (process.argv[2] || '').trim()
const keepReceipts = process.argv.includes('--keep-receipts')
const HOCBN_URL = 'https://hocbnifuactbvmyjraxy.supabase.co'
const key = process.env.HOCBN_SERVICE_ROLE_KEY?.trim()

if (!STORE) {
  console.error('Usage: node scripts/clear-store-budget-data.mjs <store_partition_key> [--keep-receipts]')
  process.exit(1)
}
if (!key) {
  console.error('Set HOCBN_SERVICE_ROLE_KEY')
  process.exit(1)
}

async function del(path) {
  const r = await fetch(`${HOCBN_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=minimal',
    },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`DELETE ${path} → ${r.status}: ${text}`)
  const range = r.headers.get('content-range') || ''
  const m = range.match(/\/(\d+)/)
  return m ? Number(m[1]) : null
}

async function countTable(table, filter) {
  const r = await fetch(`${HOCBN_URL}/rest/v1/${table}?${filter}&select=id`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
  })
  const range = r.headers.get('content-range') || ''
  const m = range.match(/\/(\d+)/)
  return m ? Number(m[1]) : 0
}

async function clearSheets(skipPush = true) {
  const r = await fetch(`${HOCBN_URL}/functions/v1/receipt-sheets-sync-cron`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      clear_store_budget_tabs: true,
      store_partition_key: STORE,
      skip_push: skipPush,
    }),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`clear sheets → ${r.status}: ${text}`)
  return JSON.parse(text)
}

;(async () => {
  const weatherKey = `weather:${STORE}`
  const receiptTable = `line_receipt__${STORE}`
  const webhookTable = `line_webhook_raw__${STORE}`

  const before = {
    receipts: keepReceipts ? 0 : await countTable(receiptTable, 'id=gte.0').catch(() => -1),
    budgets: await countTable('line_sales_month_budgets', `store_partition_key=eq.${STORE}`),
    manual: await countTable('line_sales_manual_month_gross', `store_partition_key=eq.${STORE}`),
  }
  console.log('Before:', before)

  const deleted = {
    budgets: await del(
      `line_sales_month_budgets?or=(store_partition_key.eq.${STORE},store_partition_key.eq.${weatherKey})`,
    ),
    closed_days: await del(`line_sales_month_store_closed_days?store_partition_key=eq.${STORE}`),
    manual_month: await del(`line_sales_manual_month_gross?store_partition_key=eq.${STORE}`),
    snapshot: await del(`receipt_sheets_past_sales_export_snapshot?store_partition_key=eq.${STORE}`),
  }

  if (!keepReceipts) {
    deleted.receipts = await del(`${receiptTable}?id=gte.0`)
    try {
      deleted.webhook_raw = await del(`${webhookTable}?id=gte.0`)
    } catch (e) {
      console.warn('webhook_raw delete:', e.message)
    }
    for (const t of [
      'store_receipt_duplicate_pending',
      'store_receipt_correction_pending',
      'store_receipt_store_mismatch_pending',
    ]) {
      try {
        deleted[t] = await del(`${t}?store_partition_key=eq.${STORE}`)
      } catch {
        /* empty */
      }
    }
  }

  console.log('DB deleted:', deleted)

  const sheets = await clearSheets(true)
  console.log('Sheets:', sheets)

  const after = {
    receipts: keepReceipts ? '(kept)' : await countTable(receiptTable, 'id=gte.0').catch(() => -1),
    budgets: await countTable('line_sales_month_budgets', `store_partition_key=eq.${STORE}`),
    manual: await countTable('line_sales_manual_month_gross', `store_partition_key=eq.${STORE}`),
  }
  console.log('After:', after)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
