import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import {
  isBlockedByMarugosecondLockdown,
  pushLineTextToTarget,
  resolveChannelAccessToken,
} from "../_shared/line_client.ts"
import { constantTimeEqualSecret, extractBearerToken } from "../_shared/internal_cron_auth.ts"

// MARUGO S グルメサイト週報（HTML を GitHub Pages に公開したもの）のリンクを、
// LINE グループ「マルゴエス運営チーム」(C51a3c…f52) へ 1 通だけ送る。
// 呼び出し元: 共有の作業用コンピューターの scripts/marugo-gourmet-weekly.sh（毎週土曜 10:00 ごろ）。
//
// 安全のための固定:
// - 宛先はこのグループだけ（引数で変えられない）。
// - 本文は「見出し＋要約（3行まで）＋URL」をこの関数が組み立てる。URL は週報の公開場所だけ。
// - URL が実際に 200 を返さなければ送らない。
// - 週報の日付ごとに 1 回だけ（marugo_gourmet_weekly_line_sends）。
// - 認証: Authorization: Bearer <キー>。SHA-256 を marugo_gourmet_weekly_line_auth と固定時間比較。
// - LINE トークンは既存の店舗別シークレット（ルームの店舗キー、既定 marugos）。新しい LINE の秘密情報は無い。

export const TARGET_ROOM_ID = "C51a3c2386cb1fc4247139bed89d45f52"
export const REPORT_URL_PREFIX = "https://marugo-s.github.io/line_report/marugo-s/gourmet-report/"
const DEFAULT_STORE_KEY = "marugos"
const LOG_CONTEXT = "marugo_gourmet_weekly"

type DbClient = ReturnType<typeof createClient>

export function buildWeeklyText(reportDate: string, summaryLines: string[], url: string): string {
  const head = `【MARUGO S グルメサイト週報 ${reportDate.replaceAll("-", "/")}】`
  return [head, ...summaryLines, url].join("\n")
}

export function normalizeSummary(raw: unknown): { ok: true; lines: string[] } | { ok: false; error: string } {
  const text = Array.isArray(raw) ? raw.map((v) => String(v ?? "")).join("\n") : String(raw ?? "")
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return { ok: false, error: "summary is required" }
  if (lines.length > 3) return { ok: false, error: "summary must be 3 lines or fewer" }
  if (lines.some((l) => l.length > 160)) return { ok: false, error: "each summary line must be 160 characters or fewer" }
  if (lines.some((l) => /https?:\/\//i.test(l))) return { ok: false, error: "summary must not contain URLs" }
  if (lines.some((l) => /[\w.+-]+@[\w-]+\.[\w.-]+/.test(l) || /(?<!\d)0\d{1,4}-\d{1,4}-\d{3,4}(?!\d)|(?<!\d)0\d{9,10}(?!\d)/.test(l))) {
    return { ok: false, error: "summary looks like it contains personal contact information" }
  }
  return { ok: true, lines }
}

export function validateReportUrl(url: string, reportDate: string): boolean {
  return url === `${REPORT_URL_PREFIX}${reportDate}.html` || url === `${REPORT_URL_PREFIX}latest.html`
}

export function isValidReportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function isAuthorized(req: Request, supabase: DbClient): Promise<boolean> {
  const provided = extractBearerToken(req)
  if (provided.length < 32) return false
  const { data, error } = await supabase
    .from("marugo_gourmet_weekly_line_auth")
    .select("key_sha256")
    .eq("id", 1)
    .maybeSingle()
  if (error || !data) return false
  const expected = String((data as { key_sha256?: unknown }).key_sha256 ?? "").trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) return false
  return constantTimeEqualSecret(await sha256Hex(provided), expected)
}

async function urlIsLive(url: string): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", headers: { "Cache-Control": "no-cache" } })
    await res.body?.cancel()
    return { ok: res.status === 200, status: res.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405)
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!supabaseUrl || !serviceRoleKey) return json({ ok: false, error: "server misconfigured" }, 500)
  const supabase = createClient(supabaseUrl, serviceRoleKey) as unknown as DbClient

  if (!(await isAuthorized(req, supabase))) return json({ ok: false, error: "Unauthorized" }, 401)

  let body: Record<string, unknown>
  try {
    const raw = await req.text()
    if (raw.length > 16_000) return json({ ok: false, error: "body too large" }, 413)
    body = JSON.parse(raw)
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400)
  }
  const reportDate = String(body.report_date ?? "").trim()
  const url = String(body.url ?? "").trim()
  const dryRun = body.dry_run === true
  if (!isValidReportDate(reportDate)) return json({ ok: false, error: "report_date must be YYYY-MM-DD" }, 400)
  if (!validateReportUrl(url, reportDate)) {
    return json({ ok: false, error: `url must be ${REPORT_URL_PREFIX}<report_date>.html or latest.html` }, 400)
  }
  const summary = normalizeSummary(body.summary)
  if (!summary.ok) return json({ ok: false, error: summary.error }, 400)
  const text = buildWeeklyText(reportDate, summary.lines, url)

  const { data: room, error: roomError } = await supabase
    .from("room_summary_settings")
    .select("room_id, room_name, is_enabled, receipt_report_store_partition_key")
    .eq("room_id", TARGET_ROOM_ID)
    .maybeSingle()
  if (roomError) return json({ ok: false, error: "room lookup failed" }, 500)
  const storeKey = String((room as { receipt_report_store_partition_key?: unknown } | null)?.receipt_report_store_partition_key ?? "").trim() || DEFAULT_STORE_KEY
  const roomName = String((room as { room_name?: unknown } | null)?.room_name ?? "")
  const roomEnabled = (room as { is_enabled?: unknown } | null)?.is_enabled !== false
  const tokenConfigured = Boolean(resolveChannelAccessToken(storeKey))
  const lockdownBlocked = isBlockedByMarugosecondLockdown(storeKey, TARGET_ROOM_ID)

  const { data: prior } = await supabase
    .from("marugo_gourmet_weekly_line_sends")
    .select("sent_at")
    .eq("room_id", TARGET_ROOM_ID)
    .eq("report_date", reportDate)
    .maybeSingle()
  const alreadySent = Boolean(prior)
  const live = await urlIsLive(url)

  const preview = {
    room_id: TARGET_ROOM_ID,
    room_name: roomName,
    room_enabled: roomEnabled,
    store_partition_key: storeKey,
    line_token_configured: tokenConfigured,
    lockdown_blocked: lockdownBlocked,
    already_sent: alreadySent,
    url_status: live.status,
    text,
  }
  if (dryRun) return json({ ok: true, mode: "dry_run", ...preview }, 200)

  if (alreadySent) return json({ ok: true, skipped: "already_sent", ...preview }, 200)
  if (!roomEnabled) return json({ ok: false, error: "room disabled", ...preview }, 409)
  if (!tokenConfigured) return json({ ok: false, error: "LINE token not configured for store", ...preview }, 500)
  if (lockdownBlocked) return json({ ok: false, error: "blocked_by_marugosecond_lockdown", ...preview }, 409)
  if (!live.ok) return json({ ok: false, error: `report url is not live (HTTP ${live.status})`, ...preview }, 424)

  const { error: reserveError } = await supabase
    .from("marugo_gourmet_weekly_line_sends")
    .insert({ room_id: TARGET_ROOM_ID, report_date: reportDate, report_url: url, store_partition_key: storeKey })
  if (reserveError) {
    if (String(reserveError.code ?? "") === "23505") return json({ ok: true, skipped: "already_sent", ...preview, already_sent: true }, 200)
    return json({ ok: false, error: "failed to reserve send log" }, 500)
  }

  const r = await pushLineTextToTarget(TARGET_ROOM_ID, text, resolveChannelAccessToken(storeKey), {
    storePartitionKey: storeKey,
    context: LOG_CONTEXT,
    roomId: TARGET_ROOM_ID,
  })
  if (!r.ok) {
    await supabase.from("marugo_gourmet_weekly_line_sends").delete().eq("room_id", TARGET_ROOM_ID).eq("report_date", reportDate)
    return json({ ok: false, error: `LINE push failed: ${String(r.error ?? "").slice(0, 300)}`, ...preview }, 502)
  }
  return json({ ok: true, sent: true, ...preview }, 200)
})

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
}
