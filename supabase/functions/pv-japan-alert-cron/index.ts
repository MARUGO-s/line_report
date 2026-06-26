import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"

// PV(パブリックビューイング)の「日本戦」を“単独で”即LINE配信する cron。
//  - 毎10分起動。tokyo_dome_events の venue='public-viewing' / is_japan=true / 未来日(JST) のうち、
//    まだ通知していない(pv_japan_alert_logs に無い)ものを、dome_weekly_enabled のルームへ単独通知する。
//  - 配信対象は ① pv_confirmed=true（FOOD STADIUM 公式PV告知済み＝GS戦等）→「PV決定」と断定、
//    ② 営業時間外(深夜/早朝)の日本戦（決勝T等）→ 公式告知が直前でも深夜営業判断に間に合うよう
//    「放映は要確認」の事前通知。未確証かつ営業時間内（ボクシング17:00 等）は配信しない。
//  - 週次ダイジェスト(tokyo-dome-weekly-cron)とは別経路。二重送信は (room_id, event_date, title) 一意で防止。
//  - 送信失敗(429月間上限 等)はログをロールバックし、次回以降に再試行（枠回復後に自動送信）。
// 冪等。verify_jwt=false で pg_cron から起動。

type DbClient = ReturnType<typeof createClient>
const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const WDAY_JP = ["日", "月", "火", "水", "木", "金", "土"]
const SPORT_ICON: Record<string, string> = { soccer: "⚽", baseball: "⚾", boxing: "🥊", olympic: "🏅", other: "📺" }

type PvEvent = { event_date: string; title: string; note: string; pv_sport: string; source: string; pv_confirmed: boolean }

// FOOD STADIUM TOKYO の営業時間（competitor profile: 11:00〜23:00）。
// この外＝深夜/早朝の放映は「営業時間外」＝深夜営業/早朝営業の判断が要る日。
const OPEN_HOUR = 11
const CLOSE_HOUR = 23

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

  const todayJst = jstDateStr(new Date())

  // 1) 未来(本日以降)の「日本戦」PVを取得
  const { data: evRows, error: evErr } = await supabase
    .from("tokyo_dome_events")
    .select("event_date, title, note, pv_sport, source, pv_confirmed")
    .eq("venue", "public-viewing")
    .eq("is_japan", true)
    .gte("event_date", todayJst)
    .order("event_date", { ascending: true })
  if (evErr) return json({ ok: false, error: `events load failed: ${evErr.message}` }, 500)
  const events: PvEvent[] = (Array.isArray(evRows) ? evRows : []).map((e) => ({
    event_date: String((e as { event_date?: unknown }).event_date ?? "").slice(0, 10),
    title: String((e as { title?: unknown }).title ?? ""),
    note: String((e as { note?: unknown }).note ?? ""),
    pv_sport: String((e as { pv_sport?: unknown }).pv_sport ?? "other"),
    source: String((e as { source?: unknown }).source ?? ""),
    pv_confirmed: (e as { pv_confirmed?: unknown }).pv_confirmed === true,
  })).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.event_date) && e.title)

  // 2) 配信対象ルーム（週次ドーム配信ONと同じ層）
  const { data: roomRows, error: roomErr } = await supabase
    .from("room_summary_settings")
    .select("room_id, is_enabled, dome_weekly_enabled, receipt_report_store_partition_key")
  if (roomErr) return json({ ok: false, error: `rooms load failed: ${roomErr.message}` }, 500)
  const rooms = (Array.isArray(roomRows) ? roomRows : [])
    .filter((r) => r.dome_weekly_enabled === true && r.is_enabled !== false)
    .map((r) => ({ roomId: String(r.room_id ?? "").trim(), storeKey: String(r.receipt_report_store_partition_key ?? "").trim() }))
    .filter((r) => r.roomId)

  // 単独配信の対象は次のいずれか:
  //  ① pv_confirmed=true（FOOD STADIUM 公式PV告知済み＝グループ戦等）→「PV決定」と断定配信。
  //  ② 営業時間外(深夜/早朝)の日本戦（決勝T等）→ 公式告知が直前でも、深夜営業の判断に間に合うよう
  //     「要確認の事前通知」として配信（ユーザー指示。決勝T進出が決まり放映発表が直前になりうるため）。
  // ①でも②でもない＝未確証かつ営業時間内（両国開催・配信のみのボクシング17:00 等）は配信しない（カレンダー/週次には載る）。
  const alertEvents = events.filter((e) => e.pv_confirmed || isOutsideBusinessHours(e))
  const unconfirmedCount = events.length - alertEvents.length

  if (!alertEvents.length || !rooms.length) {
    return json({ ok: true, no_target: true, event_count: alertEvents.length, unconfirmed_count: unconfirmedCount, room_count: rooms.length }, 200)
  }

  // 3) 既通知ログ
  const { data: logRows, error: logErr } = await supabase
    .from("pv_japan_alert_logs").select("room_id, event_date, title")
  if (logErr) return json({ ok: false, error: `logs load failed: ${logErr.message}` }, 500)
  const alerted = new Set((Array.isArray(logRows) ? logRows : [])
    .map((l) => `${l.room_id}__${String(l.event_date).slice(0, 10)}__${l.title}`))

  if (dryRun) {
    const pending: Array<{ room_id: string; event_date: string; title: string }> = []
    for (const ev of alertEvents) for (const r of rooms) {
      if (!alerted.has(`${r.roomId}__${ev.event_date}__${ev.title}`)) pending.push({ room_id: r.roomId, event_date: ev.event_date, title: ev.title })
    }
    return json({ ok: true, mode: "dry_run", today_jst: todayJst, event_count: alertEvents.length, unconfirmed_count: unconfirmedCount, room_count: rooms.length, pending }, 200)
  }
  if (!lineAccessToken) return json({ ok: true, skipped: true, reason: "missing_line_channel_access_token" }, 200)

  // 4) 未通知の (event × room) を単独配信。二重送信防止のため先にログを確保→失敗時はロールバック。
  const now = new Date().toISOString()
  const sent: string[] = []
  const skipped: string[] = []
  const errors: string[] = []
  for (const ev of alertEvents) {
    for (const r of rooms) {
      const key = `${r.roomId}__${ev.event_date}__${ev.title}`
      if (alerted.has(key)) continue
      const { error: insErr } = await supabase.from("pv_japan_alert_logs")
        .insert({ room_id: r.roomId, event_date: ev.event_date, title: ev.title, store_partition_key: r.storeKey || null, sent_at: now })
      if (insErr) {
        if (String(insErr.code ?? "") === "23505") { skipped.push(key); continue }
        errors.push(`${key}: reserve failed (${insErr.message})`); continue
      }
      const r2 = await sendLinePush(r.roomId, [buildAlertMessage(ev)], resolveStoreLineToken(r.storeKey || "marugos", lineAccessToken))
      if (!r2.ok) {
        try { await supabase.from("pv_japan_alert_logs").delete().eq("room_id", r.roomId).eq("event_date", ev.event_date).eq("title", ev.title) } catch (_e) { /* noop */ }
        errors.push(`${key}: ${r2.error}`); continue
      }
      sent.push(key)
    }
  }
  return json({ ok: true, today_jst: todayJst, sent_count: sent.length, skipped_count: skipped.length, unconfirmed_count: unconfirmedCount, errors }, 200)
})

// 放映が「営業時間外(深夜/早朝)」か。note 先頭の "H:MM JST" を JST時刻として解釈し、
// 営業時間 [OPEN_HOUR, CLOSE_HOUR) の外なら true（＝深夜営業/早朝営業の判断が要る日）。
// 時刻が取れない場合は note の「深夜/早朝」表記で代替判定。
function isOutsideBusinessHours(ev: PvEvent): boolean {
  const m = /(\d{1,2}):(\d{2})\s*JST/.exec(String(ev.note ?? ""))
  if (m) {
    const h = Number(m[1])
    if (Number.isFinite(h)) return h < OPEN_HOUR || h >= CLOSE_HOUR
  }
  return /深夜|早朝/.test(String(ev.note ?? ""))
}

// 単独配信メッセージ（テキスト）。
//  ・pv_confirmed=true（FOOD STADIUM 公式告知済み）→ 放映を断定。
//  ・未確証だが営業時間外 → 断定せず「放映は要確認（直前発表の可能性）」＋深夜営業の判断材料として通知。
function buildAlertMessage(ev: PvEvent): Record<string, unknown> {
  const dow = dowOf(ev.event_date)
  const dateLabel = `${Number(ev.event_date.slice(5, 7))}/${Number(ev.event_date.slice(8, 10))}(${dow})`
  const icon = SPORT_ICON[ev.pv_sport] || "📺"
  const lines = ev.pv_confirmed
    ? [
      "🇯🇵 PV日本戦が決定！",
      `📅 ${dateLabel}`,
      `${icon} ${ev.title}`,
      "📺 東京ドーム フードコートのパブリックビューイング",
    ]
    : [
      "🌙 深夜帯の日本戦に注意（放映は要確認）",
      `📅 ${dateLabel}`,
      `${icon} ${ev.title}`,
      "📺 FOOD STADIUM でのPV放映は未確定（直前に発表される可能性）。日程・対戦相手も要確認。",
    ]
  if (ev.note) lines.push(`📝 ${ev.note}`)
  lines.push(
    ev.pv_confirmed
      ? "⚠️ 集客大の見込み。深夜帯の放映は深夜営業の要注意日です。"
      : "⚠️ 営業時間外の日本戦です。放映が出れば集客大。深夜営業を行うか早めにご検討ください。",
  )
  return { type: "text", text: lines.join("\n").slice(0, 4900) }
}

// --- LINE token / send（tokyo-dome-weekly-cron と同型） ---
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

function jstDateStr(base: Date): string { const j = new Date(base.getTime() + JST_OFFSET_MS); return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, "0")}-${String(j.getUTCDate()).padStart(2, "0")}` }
function dowOf(ymd: string): string { const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return "?"; return WDAY_JP[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] }
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
}
