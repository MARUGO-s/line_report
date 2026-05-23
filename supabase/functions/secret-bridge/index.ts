/**
 * 一回限り: jhpm Edge Secrets → hocbn DB ステージングへコピー（直後に削除すること）
 * 呼び出し: POST + x-bridge-token
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'

const SECRET_NAMES = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
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

  const rows = SECRET_NAMES.map((name) => ({
    secret_name: name,
    secret_value: String(Deno.env.get(name) || '').trim(),
  }))

  const missing = rows.filter((r) => !r.secret_value).map((r) => r.secret_name)
  if (missing.length > 0) {
    return Response.json({ ok: false, error: 'missing on source project', missing }, { status: 500 })
  }

  const hocbn = createClient(hocbnUrl, hocbnServiceKey)
  const { error } = await hocbn
    .from('migration_secret_staging')
    .upsert(rows, { onConflict: 'secret_name' })

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, copied: SECRET_NAMES })
})
