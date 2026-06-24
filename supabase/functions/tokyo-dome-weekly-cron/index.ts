import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"

// 東京ドーム「週次イベント配信」cron。
// 毎分起動し、ルームごとの設定（dome_weekly_enabled / 曜日 / 時刻）が「今この瞬間(JST)」に一致する
// ルームへ、翌週日曜から2週間分(日〜翌々週の土)の東京ドームのイベントをまとめてLINE配信する。
// 二重送信は tokyo_dome_weekly_logs（room_id, week_start_date 一意）で防止。

type DbClient = ReturnType<typeof createClient>
const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const DEFAULT_DOW = 6     // 土
const DEFAULT_HOUR = 10   // 10時
const DEFAULT_MINUTE = 0
const WDAY_JP = ["日", "月", "火", "水", "木", "金", "土"]
const EVT_ICON: Record<string, string> = { "プロ野球": "⚾", "アマ野球": "🥎", "ライブ": "🎤", "その他": "🎫" }
const MAX_FLEX_ITEMS = 40

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  const lineAccessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? ""
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing." }, 500)
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey) as unknown as DbClient
  const url = new URL(req.url)
  const dryRun = ["1", "true", "yes", "on"].includes((url.searchParams.get("dry_run") ?? "").toLowerCase())

  const now = new Date()
  const jst = toJstDateParts(now)

  // ?test_send=1&room_id=...&key=... で1ルームへ即時プレビュー送信（ログ更新なし）。
  const testFlag = ["1", "true", "yes", "on"].includes((url.searchParams.get("test_send") ?? "").toLowerCase())
  if (testFlag) {
    const testKey = (Deno.env.get("TOKYO_DOME_WEEKLY_TEST_KEY") ?? "").trim()
    const provided = (url.searchParams.get("key") ?? req.headers.get("x-dome-weekly-test-key") ?? "").trim()
    if (!testKey || provided !== testKey) return json({ ok: false, error: "Forbidden" }, 403)
    const roomId = (url.searchParams.get("room_id") ?? "").trim()
    if (!roomId) return json({ ok: false, error: "room_id required" }, 400)
    const storeKey = (url.searchParams.get("store_partition_key") ?? "marugos").trim()
    const win = nextWeekWindow(jst)
    const events = await loadEvents(supabase, win.startStr, win.endStr)
    const flex = buildWeeklyFlex(win, events)
    const r = await sendLinePush(roomId, [flex], resolveStoreLineToken(storeKey, lineAccessToken))
    return json({ ok: r.ok, mode: "test_send", room_id: roomId, week: `${win.startStr}〜${win.endStr}`, event_count: events.length, error: r.ok ? undefined : r.error }, r.ok ? 200 : 502)
  }

  if (!dryRun && !lineAccessToken) {
    return json({ ok: true, skipped: true, reason: "missing_line_channel_access_token" }, 200)
  }

  const { data: rows, error: settingsError } = await supabase
    .from("room_summary_settings")
    .select("room_id, is_enabled, dome_weekly_enabled, dome_weekly_dow, dome_weekly_hour, dome_weekly_minute, receipt_report_store_partition_key")
  if (settingsError) {
    return json({ ok: false, error: `Failed to load room_summary_settings: ${settingsError.message}` }, 500)
  }

  // いまこの瞬間(JST)に送るべきルームを抽出（トグルON＋曜日・時刻一致＋ルーム有効）。
  const targets: Array<{ roomId: string; storeKey: string }> = []
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const roomId = String(row.room_id ?? "").trim()
    if (!roomId) continue
    if (row.dome_weekly_enabled !== true) continue
    if (row.is_enabled === false) continue
    const dow = row.dome_weekly_dow != null ? Number(row.dome_weekly_dow) : DEFAULT_DOW
    const hour = row.dome_weekly_hour != null ? Number(row.dome_weekly_hour) : DEFAULT_HOUR
    const minute = row.dome_weekly_minute != null ? Number(row.dome_weekly_minute) : DEFAULT_MINUTE
    if (jst.dow !== dow || jst.hour !== hour || jst.minute !== minute) continue
    targets.push({ roomId, storeKey: String(row.receipt_report_store_partition_key ?? "").trim() })
  }

  const win = nextWeekWindow(jst)
  const nowJst = `${jst.year}-${pad2(jst.month)}-${pad2(jst.day)}(${WDAY_JP[jst.dow]}) ${pad2(jst.hour)}:${pad2(jst.minute)}`

  if (dryRun) {
    const events = await loadEvents(supabase, win.startStr, win.endStr)
    return json({ ok: true, mode: "dry_run", now_jst: nowJst, week: `${win.startStr}〜${win.endStr}`, target_room_count: targets.length, target_rooms: targets, event_count: events.length, events }, 200)
  }
  if (targets.length === 0) {
    return json({ ok: true, skipped: true, reason: "no_rooms_scheduled_now", now_jst: nowJst }, 200)
  }

  const events = await loadEvents(supabase, win.startStr, win.endStr)
  const flex = buildWeeklyFlex(win, events)

  const sent: string[] = []
  const skipped: Array<{ room_id: string; reason: string }> = []
  const errors: string[] = []

  for (const t of targets) {
    const storeKey = t.storeKey || "marugos"
    // 二重送信防止：先にログ行を確保（同一週は1回だけ）。
    const { error: insErr } = await supabase
      .from("tokyo_dome_weekly_logs")
      .insert({ room_id: t.roomId, week_start_date: win.startStr, store_partition_key: storeKey, event_count: events.length, sent_at: now.toISOString() })
    if (insErr) {
      if (String(insErr.code ?? "") === "23505") skipped.push({ room_id: t.roomId, reason: "already_sent_this_week" })
      else errors.push(`${t.roomId}: failed to reserve log (${insErr.message})`)
      continue
    }
    const r = await sendLinePush(t.roomId, [flex], resolveStoreLineToken(storeKey, lineAccessToken))
    if (!r.ok) {
      try { await supabase.from("tokyo_dome_weekly_logs").delete().eq("room_id", t.roomId).eq("week_start_date", win.startStr) } catch (_e) { /* noop */ }
      errors.push(`${t.roomId}: ${r.error}`)
      continue
    }
    sent.push(t.roomId)
  }

  return json({ ok: true, now_jst: nowJst, week: `${win.startStr}〜${win.endStr}`, target_room_count: targets.length, sent_room_count: sent.length, skipped, errors }, 200)
})

async function loadEvents(supabase: DbClient, startStr: string, endStr: string): Promise<Array<{ event_date: string; title: string; category: string }>> {
  const { data, error } = await supabase
    .from("tokyo_dome_events")
    .select("event_date, title, category")
    .eq("venue", "tokyo-dome") // 週次「来週の東京ドーム」配信は本体イベントのみ（カナデビア等は分析ページ専用）
    .gte("event_date", startStr)
    .lte("event_date", endStr)
    .order("event_date", { ascending: true })
    .order("title", { ascending: true })
  if (error) { console.error("loadEvents failed:", error.message); return [] }
  return (Array.isArray(data) ? data : []).map((e) => ({
    event_date: String((e as { event_date?: unknown }).event_date ?? "").slice(0, 10),
    title: String((e as { title?: unknown }).title ?? ""),
    category: String((e as { category?: unknown }).category ?? "その他"),
  })).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.event_date) && e.title)
}

function buildWeeklyFlex(win: WeekWindow, events: Array<{ event_date: string; title: string; category: string }>) {
  const rangeLabel = `${win.start.month}/${win.start.day}(${WDAY_JP[win.start.dow]})〜${win.end.month}/${win.end.day}(${WDAY_JP[win.end.dow]})`
  const headerContents: Array<Record<string, unknown>> = [
    { type: "text", text: "🏟️ 今後2週間の東京ドーム", color: "#FFFFFF", size: "lg", weight: "bold" },
    { type: "text", text: `${rangeLabel} ・ ${events.length}件`, color: "#FFFFFFCC", size: "sm", margin: "sm" },
  ]
  let body: Array<Record<string, unknown>>
  if (events.length === 0) {
    body = [{ type: "text", text: "今後2週間(日〜土)は東京ドーム開催の予定はありません。", size: "sm", color: "#8A94A6", wrap: true, align: "center" }]
  } else {
    body = []
    events.slice(0, MAX_FLEX_ITEMS).forEach((e, idx) => {
      if (idx > 0) body.push({ type: "separator", margin: "md" })
      const dow = dowOf(e.event_date)
      const dateLabel = `${Number(e.event_date.slice(5, 7))}/${Number(e.event_date.slice(8, 10))}(${dow})`
      body.push({
        type: "box", layout: "horizontal", margin: "md", spacing: "sm",
        contents: [
          { type: "text", text: dateLabel, size: "sm", weight: "bold", color: "#1F2D3D", flex: 3 },
          { type: "text", text: `${EVT_ICON[e.category] || "🎫"} ${e.title}`, size: "sm", color: "#333333", flex: 8, wrap: true },
        ],
      })
    })
    if (events.length > MAX_FLEX_ITEMS) {
      body.push({ type: "separator", margin: "md" })
      body.push({ type: "text", text: `ほか ${events.length - MAX_FLEX_ITEMS} 件`, size: "xs", color: "#8A94A6", align: "center", margin: "md" })
    }
  }
  return {
    type: "flex",
    altText: truncate(`今後2週間の東京ドーム ${rangeLabel} ${events.length}件`, 380),
    contents: {
      type: "bubble", size: "mega",
      header: { type: "box", layout: "vertical", backgroundColor: "#1F2D3D", paddingAll: "16px", spacing: "xs", contents: headerContents },
      body: { type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm", contents: body },
    },
  }
}

// --- date helpers (JST) ---
type WeekWindow = { start: { year: number; month: number; day: number; dow: number }; end: { year: number; month: number; day: number; dow: number }; startStr: string; endStr: string }

function nextWeekWindow(jst: { year: number; month: number; day: number; dow: number }): WeekWindow {
  const daysToNextSunday = jst.dow === 0 ? 7 : (7 - jst.dow) // 翌週の日曜まで
  const s = addDaysUtc(jst.year, jst.month, jst.day, daysToNextSunday)
  const e = addDaysUtc(s.year, s.month, s.day, 13) // 翌週日曜から2週間(14日間)分: 日〜翌々週の土
  return { start: s, end: e, startStr: ymd(s), endStr: ymd(e) }
}

function addDaysUtc(year: number, month: number, day: number, n: number) {
  const dt = new Date(Date.UTC(year, month - 1, day + n))
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate(), dow: dt.getUTCDay() }
}
function dowOf(ymdStr: string): string {
  const m = ymdStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return "?"
  return WDAY_JP[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]
}
function toJstDateParts(base = new Date()) {
  const jst = new Date(base.getTime() + JST_OFFSET_MS)
  return { year: jst.getUTCFullYear(), month: jst.getUTCMonth() + 1, day: jst.getUTCDate(), hour: jst.getUTCHours(), minute: jst.getUTCMinutes(), dow: jst.getUTCDay() }
}
function ymd(d: { year: number; month: number; day: number }): string { return `${String(d.year).padStart(4, "0")}-${pad2(d.month)}-${pad2(d.day)}` }
function pad2(v: number): string { return String(v).padStart(2, "0") }
function truncate(v: string, max: number): string { return v.length > max ? `${v.slice(0, max - 1)}…` : v }

// --- LINE token / send ---
function sanitizeLineToken(raw: unknown): string { return String(raw ?? "").replace(/[^\x21-\x7e]/g, "") }
function resolveStoreLineToken(storeKey: string, fallbackToken: string): string {
  const key = String(storeKey ?? "").trim()
  if (key) {
    const suffix = key.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase()
    const override = sanitizeLineToken(Deno.env.get(`LINE_DOME_WEEKLY_TOKEN__${suffix}`))
    if (override) return override
    const perStore = sanitizeLineToken(Deno.env.get(`LINE_CHANNEL_ACCESS_TOKEN__${suffix}`))
    if (perStore) return perStore
  }
  return sanitizeLineToken(fallbackToken)
}
async function sendLinePush(to: string, messages: unknown[], token: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!token) return { ok: false, error: "missing line token" }
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ to, messages: messages.slice(0, 5) }),
  })
  if (!res.ok) return { ok: false, error: `LINE push API error (${res.status}): ${await res.text()}` }
  return { ok: true }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
}
