#!/usr/bin/env node
/**
 * ビストロ サヴァサヴァ: 同期で戻ったダミー過去売上・予算を削除し、手入力（jhpm 移行分）だけ残す
 *
 * Usage:
 *   HOCBN_SERVICE_ROLE_KEY=... node scripts/cleanup-bistrocavacava-dummy-data.mjs
 *   HOCBN_SERVICE_ROLE_KEY=... node scripts/cleanup-bistrocavacava-dummy-data.mjs --push-sheet
 */
const STORE = 'bistrocavacava'
const HOCBN_URL = 'https://hocbnifuactbvmyjraxy.supabase.co'
/** 双方向同期で DB に戻ったダミー行（手入力は 17:15 頃、ダミーは 17:43 頃） */
const DUMMY_SYNCED_AFTER = '2026-05-24T17:43:00.000Z'

const hocbnKey = process.env.HOCBN_SERVICE_ROLE_KEY?.trim()
if (!hocbnKey) {
  console.error('Set HOCBN_SERVICE_ROLE_KEY')
  process.exit(1)
}

const doPush = process.argv.includes('--push-sheet')

async function rest(method, path, { body, prefer } = {}) {
  const headers = {
    apikey: hocbnKey,
    Authorization: `Bearer ${hocbnKey}`,
    'Content-Type': 'application/json',
  }
  if (prefer) headers.Prefer = prefer
  const res = await fetch(`${HOCBN_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
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

async function countManual() {
  const { headers } = await rest(
    'GET',
    `line_sales_manual_month_gross?store_partition_key=eq.${STORE}&select=sales_month&limit=1`,
    { prefer: 'count=exact' },
  )
  const m = headers.get('content-range')?.match(/\/(\d+)$/)
  return m ? Number(m[1]) : 0
}

async function main() {
  console.log('=== Before ===')
  console.log('manual_month_gross:', await countManual())

  console.log('=== Delete dummy manual (sync re-import @ 17:43+) ===')
  await rest(
    'DELETE',
    `line_sales_manual_month_gross?store_partition_key=eq.${STORE}&updated_at=gte.${encodeURIComponent(DUMMY_SYNCED_AFTER)}`,
    { prefer: 'return=minimal' },
  )

  console.log('=== Delete all budgets (dummy from sheet pull); restore jhpm 2 months ===')
  await rest(
    'DELETE',
    `line_sales_month_budgets?store_partition_key=eq.${STORE}`,
    { prefer: 'return=minimal' },
  )
  await rest('DELETE', `line_sales_month_budgets?store_partition_key=eq.weather:${STORE}`, {
    prefer: 'return=minimal',
  })

  const budgets = [
    {
      store_partition_key: STORE,
      target_month: '2026-04',
      budget_yen: 1500000,
      mon_weight: 1,
      tue_weight: 1,
      wed_weight: 1,
      thu_weight: 1,
      fri_weight: 1,
      sat_weight: 1.5,
      sun_weight: 2,
      holiday_weight: null,
      pre_holiday_weight: null,
      store_closed_dates: [],
    },
    {
      store_partition_key: STORE,
      target_month: '2026-05',
      budget_yen: 2000000,
      mon_weight: 1,
      tue_weight: 1,
      wed_weight: 1,
      thu_weight: 1,
      fri_weight: 1,
      sat_weight: 1.5,
      sun_weight: 2,
      holiday_weight: null,
      pre_holiday_weight: null,
      store_closed_dates: [
        '2026-05-03',
        '2026-05-04',
        '2026-05-05',
        '2026-05-06',
        '2026-05-10',
        '2026-05-17',
        '2026-05-24',
        '2026-05-31',
      ],
    },
  ]
  await rest('POST', 'line_sales_month_budgets', { body: budgets })

  console.log('=== Reset closed days table ===')
  await rest(
    'DELETE',
    `line_sales_month_store_closed_days?store_partition_key=eq.${STORE}`,
    { prefer: 'return=minimal' },
  )
  const closedRows = [
    '2026-05-03',
    '2026-05-04',
    '2026-05-05',
    '2026-05-06',
    '2026-05-10',
    '2026-05-17',
    '2026-05-24',
    '2026-05-31',
  ].map((closed_on) => ({
    store_partition_key: STORE,
    target_month: '2026-05',
    closed_on,
  }))
  await rest('POST', 'line_sales_month_store_closed_days', { body: closedRows })

  console.log('=== Clear past sales export snapshot ===')
  try {
    await rest(
      'DELETE',
      `receipt_sheets_past_sales_export_snapshot?store_partition_key=eq.${STORE}`,
      { prefer: 'return=minimal' },
    )
  } catch (e) {
    console.warn('snapshot:', e.message)
  }

  console.log('=== After ===')
  console.log('manual_month_gross:', await countManual())

  if (doPush) {
    const syncSecret = process.env.RECEIPT_SHEETS_SYNC_SECRET?.trim()
    if (!syncSecret) {
      console.warn('Skip sheet push: set RECEIPT_SHEETS_SYNC_SECRET for Edge call')
      return
    }
    const fnUrl = `${HOCBN_URL}/functions/v1/receipt-sheets-sync-cron`
    const res = await fetch(fnUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${syncSecret}`,
        'Content-Type': 'application/json',
        'x-receipt-sheets-sync-key': syncSecret,
      },
      body: JSON.stringify({ bistrocavacava_cleanup_and_push: true }),
    })
    const text = await res.text()
    console.log('Edge cleanup+push:', res.status, text.slice(0, 800))
  } else {
    console.log('')
    console.log('Next: deploy Edge, then run with --push-sheet, or GAS menu「ビストロ: DB反映→シート書出」')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
