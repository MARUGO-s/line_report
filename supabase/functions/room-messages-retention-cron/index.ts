import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-room-messages-retention-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const DEFAULT_RETENTION_DAYS = 365

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function createServiceClient() {
  const url = String(Deno.env.get('SUPABASE_URL') || '').trim()
  const key = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim()
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

function isAuthorized(req: Request): boolean {
  const secret = String(Deno.env.get('ROOM_MESSAGES_RETENTION_SECRET') || '').trim()
  if (!secret) return false
  const headerKey = String(req.headers.get('x-room-messages-retention-key') || '').trim()
  if (headerKey && headerKey === secret) return true
  const auth = String(req.headers.get('authorization') || '').trim()
  if (auth === `Bearer ${secret}`) return true
  return false
}

async function isServiceRoleAuthorized(req: Request): Promise<boolean> {
  const serviceKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim()
  if (!serviceKey) return false
  const auth = String(req.headers.get('authorization') || '').trim()
  return auth === `Bearer ${serviceKey}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed.' }, 405)
  }

  const authorized = (await isServiceRoleAuthorized(req)) || isAuthorized(req)
  if (!authorized) {
    return json({ ok: false, error: 'Forbidden.' }, 403)
  }

  const supabase = createServiceClient()
  if (!supabase) {
    return json({ ok: false, error: 'Server misconfigured.' }, 500)
  }

  let retentionDays = DEFAULT_RETENTION_DAYS
  try {
    const body = await req.json() as Record<string, unknown>
    const raw = Number(body?.retention_days)
    if (Number.isFinite(raw) && raw > 0) retentionDays = Math.floor(raw)
  } catch {
    // empty body is fine
  }

  const { data, error } = await supabase.rpc('purge_line_room_messages_older_than', {
    p_retention_days: retentionDays,
  })

  if (error) {
    console.error('purge_line_room_messages_older_than failed:', error.message)
    return json({ ok: false, error: error.message }, 500)
  }

  return json({
    ok: true,
    result: data,
    generated_at: new Date().toISOString(),
  }, 200)
})
