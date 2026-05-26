#!/usr/bin/env node
/**
 * jhpm の Gmail Edge Secrets → hocbn へコピー
 *
 * 前提: jhpm に secret-bridge をデプロイし、次を設定済み
 *   SECRET_BRIDGE_TOKEN, HOCBN_SUPABASE_URL, HOCBN_SERVICE_ROLE_KEY
 *
 * Usage:
 *   SECRET_BRIDGE_TOKEN=... node scripts/sync-gmail-secrets-jhpm-to-hocbn.mjs
 *   SECRET_BRIDGE_TOKEN=... node scripts/sync-gmail-secrets-jhpm-to-hocbn.mjs --apply-only
 */
import { execSync } from 'node:child_process'
import { spawnSync } from 'node:child_process'

const JHPM_URL = 'https://jhpmzqxqvapdkyvvhyra.supabase.co'
const HOCBN_REF = 'hocbnifuactbvmyjraxy'
const HOCBN_URL = 'https://hocbnifuactbvmyjraxy.supabase.co'

const applyOnly = process.argv.includes('--apply-only')
const bridgeToken = process.env.SECRET_BRIDGE_TOKEN?.trim()
const hocbnKey = process.env.HOCBN_SERVICE_ROLE_KEY?.trim()

if (!applyOnly && !bridgeToken) {
  console.error('Set SECRET_BRIDGE_TOKEN (jhpm secret-bridge と同じ値)')
  process.exit(1)
}

function jhpmAnonKey() {
  const json = JSON.parse(
    execSync(`npx supabase projects api-keys --project-ref jhpmzqxqvapdkyvvhyra -o json`, { encoding: 'utf8' }),
  )
  return json.find((x) => x.name === 'anon')?.api_key || ''
}

async function stageFromJhpm() {
  const anon = jhpmAnonKey()
  const res = await fetch(`${JHPM_URL}/functions/v1/secret-bridge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bridge-token': bridgeToken,
      apikey: anon,
      Authorization: `Bearer ${anon}`,
    },
    body: JSON.stringify({ scope: 'gmail' }),
  })
  const text = await res.text()
  let data = {}
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  if (!res.ok) {
    throw new Error(`secret-bridge → ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
  }
  console.log('Staged on hocbn:', data)
}

function hocbnServiceKey() {
  if (hocbnKey) return hocbnKey
  const json = JSON.parse(
    execSync(`npx supabase projects api-keys --project-ref ${HOCBN_REF} -o json`, { encoding: 'utf8' }),
  )
  const key = json.find((x) => x.name === 'service_role')?.api_key || ''
  if (!key) throw new Error('HOCBN service role key not found')
  return key
}

async function fetchStagedRows() {
  const serviceKey = hocbnServiceKey()

  const res = await fetch(
    `${HOCBN_URL}/rest/v1/migration_secret_staging?select=secret_name,secret_value&secret_name=like.GMAIL%25`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    },
  )
  const text = await res.text()
  if (!res.ok) throw new Error(`read staging → ${res.status}: ${text}`)
  return JSON.parse(text)
}

function applyToHocbn(rows) {
  const gmailRows = rows.filter((r) => {
    const name = String(r.secret_name || '')
    return name.startsWith('GMAIL_') || name === 'LINE_GMAIL_ALERT_ROOM_ID'
  })
  if (gmailRows.length === 0) {
    throw new Error('No GMAIL_* rows in migration_secret_staging. Run without --apply-only first.')
  }

  const args = ['supabase', 'secrets', 'set', '--project-ref', HOCBN_REF]
  for (const row of gmailRows) {
    args.push(`${row.secret_name}=${row.secret_value}`)
  }

  if (!rows.some((r) => r.secret_name === 'GMAIL_ALERT_ENABLED')) {
    args.push('GMAIL_ALERT_ENABLED=true')
  }

  console.log('Applying secrets:', gmailRows.map((r) => r.secret_name).join(', '), '+ GMAIL_ALERT_ENABLED if missing')
  const result = spawnSync('npx', args, { stdio: 'inherit', encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`supabase secrets set failed (exit ${result.status})`)
  }
}

async function clearStaging(rows) {
  const serviceKey = hocbnServiceKey()
  const names = rows.map((r) => encodeURIComponent(r.secret_name)).join(',')
  await fetch(`${HOCBN_URL}/rest/v1/migration_secret_staging?secret_name=in.(${names})`, {
    method: 'DELETE',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  })
}

;(async () => {
  if (!applyOnly) {
    await stageFromJhpm()
  }
  const rows = await fetchStagedRows()
  applyToHocbn(rows)
  await clearStaging(rows)
  console.log('Done. Redeploy hocbn gmail-alert-cron if needed.')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
