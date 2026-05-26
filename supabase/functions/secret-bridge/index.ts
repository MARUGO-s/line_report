/**
 * 一回限り: jhpm Edge Secrets → hocbn DB ステージングへコピー（直後に削除すること）
 * 呼び出し: POST + x-bridge-token
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'

const DEFAULT_SECRET_NAMES = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
] as const

/** jhpm → hocbn コピー用（Gmail 予約） */
const GMAIL_SECRET_NAMES = [
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
  'GMAIL_ALERT_ENABLED',
  'GMAIL_ALERT_QUERY',
  'GMAIL_ALERT_MAX_MESSAGES',
  'GMAIL_ALERT_AI_ENABLED',
  'GMAIL_ALERT_AI_MAX_BODY_CHARS',
  'LINE_GMAIL_ALERT_ROOM_ID',
] as const

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const bridgeToken = String(Deno.env.get('SECRET_BRIDGE_TOKEN') || '').trim()
  const provided = String(req.headers.get('x-bridge-token') || '').trim()
  if (!bridgeToken || provided !== bridgeToken) {
    return new Response('Forbidden', { status: 403 })
  }

  const hocbnUrl = String(Deno.env.get('HOCBN_SUPABASE_URL') || '').trim()
  const hocbnServiceKey = String(Deno.env.get('HOCBN_SERVICE_ROLE_KEY') || '').trim()
  if (!hocbnUrl || !hocbnServiceKey) {
    return Response.json({ ok: false, error: 'HOCBN_SUPABASE_URL or HOCBN_SERVICE_ROLE_KEY missing' }, { status: 500 })
  }

  let secretNames: readonly string[] = DEFAULT_SECRET_NAMES
  try {
    const body = await req.json()
    if (body && typeof body === 'object' && body.scope === 'gmail') {
      secretNames = GMAIL_SECRET_NAMES
    } else if (body && Array.isArray(body.secret_names) && body.secret_names.length > 0) {
      secretNames = body.secret_names.map((n: unknown) => String(n ?? '').trim()).filter(Boolean)
    }
  } catch {
    /* default */
  }

  const rows = secretNames.map((name) => ({
    secret_name: name,
    secret_value: String(Deno.env.get(name) || '').trim(),
  }))

  const isGmailScope = secretNames.some((name) => name.startsWith('GMAIL_'))
  const requiredNames: string[] = isGmailScope
    ? ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']
    : [...secretNames]
  const missing = requiredNames.filter((name) => {
    const row = rows.find((r) => r.secret_name === name)
    return !row?.secret_value
  })
  if (missing.length > 0) {
    return Response.json({ ok: false, error: 'missing on source project', missing }, { status: 500 })
  }

  const toUpsert = rows.filter((r) => r.secret_value)
  if (toUpsert.length === 0) {
    return Response.json({ ok: false, error: 'no secrets to copy' }, { status: 500 })
  }

  const hocbn = createClient(hocbnUrl, hocbnServiceKey)
  const { error } = await hocbn
    .from('migration_secret_staging')
    .upsert(toUpsert, { onConflict: 'secret_name' })

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, copied: toUpsert.map((r) => r.secret_name) })
})
