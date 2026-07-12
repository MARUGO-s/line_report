import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { recordLineWebhookDeliveryLog } from "../_shared/line_webhook_delivery_log.ts"
import { isBlockedByMarugosecondLockdown } from "../_shared/line_client.ts"

// PV(パブリックビューイング)の「日本戦」を“単独で”即LINE配信する cron。
//  - 毎10分起動。tokyo_dome_events の venue='public-viewing' / is_japan=true / 未来日(JST) のうち、
//    まだ通知していない(pv_japan_alert_logs に無い)ものを、dome_weekly_enabled のルームへ単独通知する。
//  - 配信対象は pv_confirmed=true（FOOD STADIUM 公式PV告知済み）のみ。「PV決定」と断定して配信する。
//    未確証（営業時間外かどうかに関わらず）は配信しない（ユーザー指示。誤判定で未決定試合を送るのを防止）。
//    未確証の試合はカレンダー/週次ダイジェスト(tokyo-dome-weekly-cron)には引き続き掲載される。
//  - 週次ダイジェストとは別経路。二重送信は (room_id, event_date, title) 一意で防止。
//  - 送信失敗(429月間上限 等)はログをロールバックし、次回以降に再試行（枠回復後に自動送信）。
// 冪等。verify_jwt=false で pg_cron から起動。

type DbClient = ReturnType<typeof createClient>
const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const WDAY_JP = ["日", "月", "火", "水", "木", "金", "土"]
const SPORT_ICON: Record<string, string> = { soccer: "⚽", baseball: "⚾", boxing: "🥊", olympic: "🏅", other: "📺" }

type PvEvent = { event_date: string; title: string; note: string; pv_sport: string; source: string; pv_confirmed: boolean }

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

  // 単独配信の対象は pv_confirmed=true（FOOD STADIUM 公式PV告知済み）のみ。
  // 未確証の試合は配信しない（カレンダー/週次ダイジェストには引き続き載る）。
  const alertEvents = events.filter((e) => e.pv_confirmed)
  const unconfirmedCount = events.length - alertEvents.length

  if (!alertEvents.length || !rooms.length) {
    return json({ ok: true, no_target: true, event_count: alertEvents.length, unconfirmed_count: unconfirmedCount, room_count: rooms.length }, 200)
  }

  // 3) 既通知ログ。キーに pv_confirmed を含める＝「要確認(false)」と「PV決定(true)」を別フェーズとして扱い、
  //    未確証で事前通知済みの試合が後で確証化したら「PV決定」を1回だけ昇格通知できる。
  const alertKey = (roomId: string, date: string, title: string, confirmed: boolean) =>
    `${roomId}__${date}__${title}__${confirmed ? "1" : "0"}`
  const { data: logRows, error: logErr } = await supabase
    .from("pv_japan_alert_logs").select("room_id, event_date, title, pv_confirmed")
  if (logErr) return json({ ok: false, error: `logs load failed: ${logErr.message}` }, 500)
  const alerted = new Set((Array.isArray(logRows) ? logRows : [])
    .map((l) => alertKey(String(l.room_id), String(l.event_date).slice(0, 10), String(l.title), l.pv_confirmed === true)))

  if (dryRun) {
    const pending: Array<{ room_id: string; event_date: string; title: string; phase: string }> = []
    for (const ev of alertEvents) for (const r of rooms) {
      if (!alerted.has(alertKey(r.roomId, ev.event_date, ev.title, ev.pv_confirmed))) {
        pending.push({ room_id: r.roomId, event_date: ev.event_date, title: ev.title, phase: ev.pv_confirmed ? "決定" : "要確認" })
      }
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
      const key = alertKey(r.roomId, ev.event_date, ev.title, ev.pv_confirmed)
      if (alerted.has(key)) continue
      const { error: insErr } = await supabase.from("pv_japan_alert_logs")
        .insert({ room_id: r.roomId, event_date: ev.event_date, title: ev.title, pv_confirmed: ev.pv_confirmed, store_partition_key: r.storeKey || null, sent_at: now })
      if (insErr) {
        if (String(insErr.code ?? "") === "23505") { skipped.push(key); continue }
        errors.push(`${key}: reserve failed (${insErr.message})`); continue
      }
      const r2 = await sendLinePush(r.roomId, [buildAlertMessage(ev)], resolveStoreLineToken(r.storeKey || "marugos", lineAccessToken), r.storeKey || "marugos")
      if (!r2.ok) {
        try { await supabase.from("pv_japan_alert_logs").delete().eq("room_id", r.roomId).eq("event_date", ev.event_date).eq("title", ev.title).eq("pv_confirmed", ev.pv_confirmed) } catch (_e) { /* noop */ }
        errors.push(`${key}: ${r2.error}`); continue
      }
      sent.push(key)
    }
  }
  return json({ ok: true, today_jst: todayJst, sent_count: sent.length, skipped_count: skipped.length, unconfirmed_count: unconfirmedCount, errors }, 200)
})

// 単独配信メッセージ（LINE Flex＝リッチ表示）。pv_confirmed=true（FOOD STADIUM 公式告知済み）のみ
// 呼ばれる前提で、放映を断定して案内する。非対応端末/通知プレビュー用に altText（プレーン要約）も付ける。
function buildAlertMessage(ev: PvEvent): Record<string, unknown> {
  const dow = dowOf(ev.event_date)
  const dateLabel = `${Number(ev.event_date.slice(5, 7))}/${Number(ev.event_date.slice(8, 10))}(${dow})`
  const icon = SPORT_ICON[ev.pv_sport] || "📺"
  const accent = "#C0392B"
  const warnBg = "#FBEAEA"
  const headTitle = "🇯🇵 PV日本戦が決定！"
  const headSub = "東京ドーム フードコート パブリックビューイング"
  const venueLine = "📺 東京ドーム フードコートのパブリックビューイング"
  const warn = "⚠️ 集客大の見込み。深夜帯の放映は深夜営業の要注意日です。"

  const body: Array<Record<string, unknown>> = [
    { type: "text", text: `📅 ${dateLabel}`, weight: "bold", size: "lg", color: "#1F2D3D" },
    { type: "text", text: `${icon} ${ev.title}`, weight: "bold", size: "md", color: "#1F2D3D", wrap: true, margin: "md" },
    { type: "text", text: venueLine, size: "sm", color: "#555555", wrap: true, margin: "sm" },
  ]
  if (ev.note) body.push({ type: "text", text: `📝 ${ev.note}`, size: "sm", color: "#777777", wrap: true, margin: "sm" })
  body.push({ type: "separator", margin: "lg" })
  body.push({
    type: "box", layout: "vertical", backgroundColor: warnBg, cornerRadius: "md", paddingAll: "10px", margin: "lg",
    contents: [{ type: "text", text: warn, size: "sm", weight: "bold", color: accent, wrap: true }],
  })

  const altText = [headTitle, dateLabel, `${icon} ${ev.title}`, venueLine, ev.note ? `📝 ${ev.note}` : "", warn]
    .filter(Boolean).join("\n").slice(0, 390)

  return {
    type: "flex",
    altText,
    contents: {
      type: "bubble", size: "mega",
      header: {
        type: "box", layout: "vertical", backgroundColor: accent, paddingAll: "16px", spacing: "xs",
        contents: [
          { type: "text", text: headTitle, color: "#FFFFFF", size: "lg", weight: "bold", wrap: true },
          { type: "text", text: headSub, color: "#FFFFFFCC", size: "sm", margin: "sm", wrap: true },
        ],
      },
      body: { type: "box", layout: "vertical", paddingAll: "16px", spacing: "none", contents: body },
    },
  }
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
async function sendLinePush(to: string, messages: unknown[], token: string, storeKey?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!token) return { ok: false, error: "missing line token" }
  if (isBlockedByMarugosecondLockdown(storeKey, to)) {
    if (storeKey) {
      void recordLineWebhookDeliveryLog({
        storePartitionKey: storeKey,
        method: 'push',
        context: 'pv_japan_alert',
        targetRoomId: to,
        attempted: false,
        success: false,
        reason: '一時ロックダウン中のためブロック（マルゴセカンド送信元調査用）',
      })
    }
    return { ok: false, error: 'blocked_by_marugosecond_lockdown' }
  }
  let res: Response
  try {
    res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ to, messages: messages.slice(0, 5) }),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (storeKey) {
      void recordLineWebhookDeliveryLog({
        storePartitionKey: storeKey,
        method: 'push',
        context: 'pv_japan_alert',
        targetRoomId: to,
        attempted: true,
        success: false,
        httpStatus: 0,
        reason: `LINEプッシュが例外で失敗: ${msg.slice(0, 200)}`,
        details: { message_count: Math.min(messages.length, 5) },
      })
    }
    return { ok: false, error: `LINE push threw: ${msg}` }
  }

  const httpStatus = res.status
  const ok = res.ok
  const errText = ok ? '' : await res.text()

  if (storeKey) {
    void recordLineWebhookDeliveryLog({
      storePartitionKey: storeKey,
      method: 'push',
      context: 'pv_japan_alert',
      targetRoomId: to,
      attempted: true,
      success: ok,
      httpStatus,
      reason: ok ? '「PV日本戦通知」を送信しました。' : `LINEプッシュAPIエラー: ${errText.slice(0, 200)}`,
      details: { message_count: Math.min(messages.length, 5) },
    })
  }

  if (!ok) return { ok: false, error: `LINE push API error (${httpStatus}): ${errText}` }
  return { ok: true }
}

function jstDateStr(base: Date): string { const j = new Date(base.getTime() + JST_OFFSET_MS); return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, "0")}-${String(j.getUTCDate()).padStart(2, "0")}` }
function dowOf(ymd: string): string { const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return "?"; return WDAY_JP[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] }
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
}
