import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import {
  fetchAnalyticsMonthly,
  fetchManualMonthsForYearState,
  fetchReceiptSalesState,
  fetchReceiptStoreOptions,
  upsertManualMonthEntries,
  upsertReceiptSalesBudget,
} from '../_shared/admin_receipt_sales.ts'
import { fetchWeatherDailyState } from '../_shared/weather_daily.ts'
import {
  isRecord,
  json,
  normalizePath,
  parseJson,
  secureEqual,
  type AppError,
} from '../_shared/admin_utils.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
}

async function hashToken(value: string): Promise<string> {
  const input = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function getStoredAdminTokenHash(
  supabase: ReturnType<typeof createClient>,
): Promise<{ ok: true; hash: string | null } | { ok: false; status: number; message: string }> {
  const { data, error } = await supabase
    .from('summary_settings')
    .select('admin_dashboard_token_hash')
    .eq('id', 1)
    .maybeSingle()

  if (error) {
    return { ok: false, status: 500, message: `Failed to load admin token settings: ${error.message}` }
  }

  const hash = typeof data?.admin_dashboard_token_hash === 'string'
    ? data.admin_dashboard_token_hash.trim()
    : ''
  return { ok: true, hash: hash || null }
}

async function authenticate(
  req: Request,
  supabase: ReturnType<typeof createClient>,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const provided = req.headers.get('x-admin-token') ?? ''
  if (!provided) {
    return { ok: false, status: 401, message: 'Unauthorized.' }
  }

  const fallbackToken = Deno.env.get('ADMIN_DASHBOARD_TOKEN') ?? ''
  const dbHashResult = await getStoredAdminTokenHash(supabase)
  if (!dbHashResult.ok) {
    return dbHashResult
  }

  if (dbHashResult.hash) {
    const providedHash = await hashToken(provided)
    if (secureEqual(providedHash, dbHashResult.hash)) {
      return { ok: true }
    }
    if (fallbackToken && secureEqual(provided, fallbackToken)) {
      return { ok: true }
    }
    return { ok: false, status: 401, message: 'Unauthorized.' }
  }

  if (!fallbackToken) {
    return { ok: false, status: 500, message: 'ADMIN_DASHBOARD_TOKEN is not configured.' }
  }

  if (!secureEqual(provided, fallbackToken)) {
    return { ok: false, status: 401, message: 'Unauthorized.' }
  }

  return { ok: true }
}

function asAppError(error: unknown): AppError {
  if (isRecord(error) && typeof error.status === 'number' && typeof error.message === 'string') {
    return { status: error.status, message: error.message }
  }
  return { status: 500, message: error instanceof Error ? error.message : 'Internal Server Error' }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const path = normalizePath(url.pathname)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.' }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const authResult = await authenticate(req, supabase)
  if (!authResult.ok) {
    return json({ error: authResult.message }, authResult.status)
  }

  try {
    if (req.method === 'GET' && path === '/health') {
      return json({ ok: true, service: 'admin-api', store_tables: true }, 200)
    }

    if (req.method === 'GET' && path === '/receipts/store-options') {
      const options = await fetchReceiptStoreOptions(supabase)
      return json({ store_options: options }, 200)
    }

    if (req.method === 'GET' && path === '/receipts/sales') {
      const receiptSalesState = await fetchReceiptSalesState(supabase, url)
      return json(receiptSalesState, 200)
    }

    if (req.method === 'PUT' && path === '/receipts/sales-budget') {
      const body = await parseJson(req)
      if (!isRecord(body)) {
        throw { status: 400, message: 'Invalid JSON body.' } satisfies AppError
      }
      const result = await upsertReceiptSalesBudget(supabase, body)
      return json(result, 200)
    }

    if (req.method === 'GET' && path === '/receipts/sales-manual-months') {
      const result = await fetchManualMonthsForYearState(supabase, url)
      return json(result, 200)
    }

    if (req.method === 'PUT' && path === '/receipts/sales-manual-months') {
      const body = await parseJson(req)
      if (!isRecord(body)) {
        throw { status: 400, message: 'Invalid JSON body.' } satisfies AppError
      }
      const result = await upsertManualMonthEntries(supabase, body)
      return json(result, 200)
    }

    if (req.method === 'GET' && path === '/analytics/monthly') {
      const result = await fetchAnalyticsMonthly(supabase, url)
      return json(result, 200)
    }

    if (req.method === 'GET' && path === '/weather/daily') {
      const result = await fetchWeatherDailyState(supabase, url)
      return json(result, 200)
    }

    return json({ error: 'Not Found.' }, 404)
  } catch (error) {
    const appError = asAppError(error)
    console.error(`admin-api ${req.method} ${path}:`, appError.message)
    return json({ error: appError.message }, appError.status)
  }
})
