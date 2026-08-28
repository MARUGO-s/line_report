import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import {
  extractBearerToken,
  isInternalCronAuthorized,
} from "../_shared/internal_cron_auth.ts"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405)

  const supabaseUrl = String(Deno.env.get("SUPABASE_URL") ?? "").trim()
  const serviceRoleKey = String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim()
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Server configuration is missing." }, 500)
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  if (!(await isInternalCronAuthorized(req, supabase))) {
    return json({ ok: false, error: "Unauthorized." }, 401)
  }
  const bearer = extractBearerToken(req)

  let body: Record<string, unknown> = {}
  try {
    const parsed = await req.json()
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>
    }
  } catch {
    // 空bodyは通常cronとして扱う。
  }

  const adminApiUrl = `${supabaseUrl}/functions/v1/admin-api/reservations/ai-cache/rebuild`
  let response: Response
  try {
    response = await fetch(adminApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        store_key: String(body.store_key ?? "").trim() || undefined,
        force_full: body.force_full === true,
      }),
    })
  } catch (error) {
    return json({
      ok: false,
      error: `admin-api request failed: ${error instanceof Error ? error.message : String(error)}`,
    }, 502)
  }
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    return json({
      ok: false,
      error: String((result as Record<string, unknown>)?.error ?? `admin-api HTTP ${response.status}`),
    }, response.status)
  }
  return json({
    ok: true,
    mode: body.force_full === true ? "full_rebuild" : "daily_incremental",
    result,
    generated_at: new Date().toISOString(),
  }, 200)
})
