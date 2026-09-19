import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { resolveStorePartitionKeyForRoom } from "../_shared/receipt_report_aggregate.ts"
import { formatEventTimeLabel, normalizeEventTime } from "../_shared/tokyo_dome_schedule.ts"
import { explicitWeekWindow, nextWeekWindow, type WeekWindow } from "../_shared/tokyo_dome_weekly_window.ts"
import { recordLineWebhookDeliveryLog } from "../_shared/line_webhook_delivery_log.ts"
import { isBlockedByMarugosecondLockdown } from "../_shared/line_client.ts"
import { isMtalkSyntheticRoomId } from "../_shared/mtalk_room_id.ts"
import {
  constantTimeEqualSecret,
  isInternalCronAuthorized,
} from "../_shared/internal_cron_auth.ts"

// ドームシティ「週次イベント配信」cron。
// 毎分起動し、ルームごとの設定（dome_weekly_enabled / 曜日 / 時刻）が「今この瞬間(JST)」に一致する
// ルームへ、翌週日曜から2週間分(日〜翌々週の土)のイベントを会場別(東京ドーム/カナデビアホール/後楽園ホール)
// にセクション分けしてまとめてLINE配信する。二重送信は tokyo_dome_weekly_logs（room_id, week_start_date 一意）で防止。

type DbClient = ReturnType<typeof createClient>
const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const DEFAULT_DOW = 6     // 土
const DEFAULT_HOUR = 10   // 10時
const DEFAULT_MINUTE = 0
const WDAY_JP = ["日", "月", "火", "水", "木", "金", "土"]
const EVT_ICON: Record<string, string> = { "プロ野球": "⚾", "アマ野球": "🥎", "ライブ": "🎤", "スポーツ中継": "📺", "その他": "🎫" }
const MAX_FLEX_ITEMS = 40
// 配信に載せる会場（表示順）。会場ごとにセクション分けして見やすく並べる。
// public-viewing（PV観戦＝世界スポーツ放映）は予定がある週だけ表示する（emptyOnlyIfPresent）。
const WEEKLY_VENUES: Array<{ venue: string; label: string; icon: string; accent: string; onlyIfPresent?: boolean }> = [
  { venue: "tokyo-dome", label: "東京ドーム", icon: "🏟️", accent: "#1F2D3D" },
  { venue: "kanadevia", label: "カナデビアホール", icon: "🎤", accent: "#B0007A" },
  { venue: "korakuen", label: "後楽園ホール", icon: "🥊", accent: "#1F6FB0" },
  { venue: "imm", label: "IMMシアター", icon: "🎭", accent: "#D35400", onlyIfPresent: true },
  { venue: "public-viewing", label: "PV観戦（世界スポーツ放映）", icon: "📺", accent: "#C0392B", onlyIfPresent: true },
]
const WEEKLY_PER_VENUE_MAX = 14 // 1会場あたりの最大表示件数（超過は「ほかN件」）

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

  // ?test_send=1&room_id=... で1ルームへ即時プレビュー送信（重複防止ログは更新しない＝何度でも再送可）。
  // 認証は「専用ヘッダー(TOKYO_DOME_WEEKLY_TEST_KEY)」か「内部cron認証」のどちらか。
  // 後者は SQL から public.invoke_tokyo_dome_weekly_resend() で叩く経路で、秘密値をURLへ載せずに済む。
  // ?week_start=YYYY-MM-DD を付けると、その日から14日間を対象にする（省略時は通常配信と同じ翌週日曜起点）。
  const testFlag = ["1", "true", "yes", "on"].includes((url.searchParams.get("test_send") ?? "").toLowerCase())
  if (testFlag) {
    const testKey = (Deno.env.get("TOKYO_DOME_WEEKLY_TEST_KEY") ?? "").trim()
    const provided = (req.headers.get("x-dome-weekly-test-key") ?? "").trim()
    const byTestKey = Boolean(testKey) && Boolean(provided) && constantTimeEqualSecret(provided, testKey)
    const byCronAuth = byTestKey ? false : await isInternalCronAuthorized(req, supabase)
    if (!byTestKey && !byCronAuth) {
      return json({ ok: false, error: "Forbidden" }, 403)
    }
    const roomId = (url.searchParams.get("room_id") ?? "").trim()
    if (!roomId) return json({ ok: false, error: "room_id required" }, 400)
    // cron認証経路は宛先を既知ルームに限定する（打ち間違いで無関係なルームへ送らない）。
    if (byCronAuth) {
      const { data: knownRoom, error: roomLookupError } = await supabase
        .from("room_summary_settings")
        .select("room_id")
        .eq("room_id", roomId)
        .maybeSingle()
      if (roomLookupError) return json({ ok: false, error: `room lookup failed: ${roomLookupError.message}` }, 500)
      if (!knownRoom) return json({ ok: false, error: "unknown room_id" }, 404)
    }
    const weekStartParam = (url.searchParams.get("week_start") ?? "").trim()
    const win = weekStartParam ? explicitWeekWindow(weekStartParam) : nextWeekWindow(jst)
    if (!win) return json({ ok: false, error: "week_start must be YYYY-MM-DD" }, 400)
    const storeKey = (url.searchParams.get("store_partition_key") ?? "marugos").trim()
    const events = await loadEvents(supabase, win.startStr, win.endStr)
    const flex = buildWeeklyFlex(win, events)
    const r = await sendLinePush(roomId, [flex], resolveStoreLineToken(storeKey, lineAccessToken), storeKey)
    return json({ ok: r.ok, mode: "test_send", room_id: roomId, week: `${win.startStr}〜${win.endStr}`, event_count: events.length, error: r.ok ? undefined : r.error }, r.ok ? 200 : 502)
  }

  if (!(await isInternalCronAuthorized(req, supabase))) {
    return json({ ok: false, error: "Unauthorized" }, 401)
  }

  if (!dryRun && !lineAccessToken) {
    return json({ ok: true, skipped: true, reason: "missing_line_channel_access_token" }, 200)
  }

  const { data: rows, error: settingsError } = await supabase
    .from("room_summary_settings")
    .select("room_id, is_enabled, dome_weekly_enabled, dome_weekly_dow, dome_weekly_hour, dome_weekly_minute, receipt_report_store_partition_key, room_name")
  if (settingsError) {
    return json({ ok: false, error: `Failed to load room_summary_settings: ${settingsError.message}` }, 500)
  }

  // いまこの瞬間(JST)に送るべきルームを抽出（トグルON＋曜日・時刻一致＋ルーム有効）。
  const targets: Array<{ roomId: string; storeKey: string; roomName: string }> = []
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const roomId = String(row.room_id ?? "").trim()
    if (!roomId) continue
    if (row.dome_weekly_enabled !== true) continue
    if (row.is_enabled === false) continue
    const dow = row.dome_weekly_dow != null ? Number(row.dome_weekly_dow) : DEFAULT_DOW
    const hour = row.dome_weekly_hour != null ? Number(row.dome_weekly_hour) : DEFAULT_HOUR
    const minute = row.dome_weekly_minute != null ? Number(row.dome_weekly_minute) : DEFAULT_MINUTE
    if (jst.dow !== dow || jst.hour !== hour || jst.minute !== minute) continue
    targets.push({
      roomId,
      storeKey: String(row.receipt_report_store_partition_key ?? "").trim(),
      roomName: String(row.room_name ?? "").trim(),
    })
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
    let storeKey = t.storeKey
    if (!storeKey) {
      storeKey = String((await resolveStorePartitionKeyForRoom(supabase, t.roomId)) ?? "").trim()
    }
    if (!storeKey) {
      storeKey = "marugos"
    }



    // 二重送信防止：先にログ行を確保（同一週は1回だけ）。
    const { error: insErr } = await supabase
      .from("tokyo_dome_weekly_logs")
      .insert({ room_id: t.roomId, week_start_date: win.startStr, store_partition_key: storeKey, event_count: events.length, sent_at: now.toISOString() })
    if (insErr) {
      if (String(insErr.code ?? "") === "23505") skipped.push({ room_id: t.roomId, reason: "already_sent_this_week" })
      else errors.push(`${t.roomId}: failed to reserve log (${insErr.message})`)
      continue
    }

    // 開催予定0件の週は「開催予定はありません」だけのPushを送らない（グループ宛は人数分課金されるため）。
    // 重複防止ログはこの週分を既に確保済みなので、同週中の再実行では再送されない。
    if (events.length === 0) {
      skipped.push({ room_id: t.roomId, reason: "zero_events" })
      continue
    }

    const r = await sendLinePush(t.roomId, [flex], resolveStoreLineToken(storeKey, lineAccessToken), storeKey)
    if (!r.ok) {
      try { await supabase.from("tokyo_dome_weekly_logs").delete().eq("room_id", t.roomId).eq("week_start_date", win.startStr) } catch (_e) { /* noop */ }
      errors.push(`${t.roomId}: ${r.error}`)
      continue
    }
    sent.push(t.roomId)
  }

  return json({ ok: true, now_jst: nowJst, week: `${win.startStr}〜${win.endStr}`, target_room_count: targets.length, sent_room_count: sent.length, skipped, errors }, 200)
})

type WeeklyEvent = { event_date: string; title: string; category: string; venue: string; is_japan: boolean; open_time: string | null; start_time: string | null }

async function loadEvents(supabase: DbClient, startStr: string, endStr: string): Promise<WeeklyEvent[]> {
  // 4会場（東京ドーム/カナデビア/後楽園/PV観戦）を取得し、会場ごとに分けて配信する。
  const query = (columns: string) => supabase
    .from("tokyo_dome_events")
    .select(columns)
    .gte("event_date", startStr)
    .lte("event_date", endStr)
    .order("event_date", { ascending: true })
    .order("title", { ascending: true })

  // 時刻2列は後から追加したもの。関数だけ先に出た場合でも配信を止めないよう、旧スキーマへフォールバックする。
  let { data, error } = await query("event_date, title, category, venue, is_japan, open_time, start_time")
  if (error) {
    console.error("loadEvents with times failed:", error.message)
    const legacy = await query("event_date, title, category, venue, is_japan")
    data = legacy.data
    error = legacy.error
  }
  if (error) { console.error("loadEvents failed:", error.message); return [] }
  return (Array.isArray(data) ? data : []).map((e) => ({
    event_date: String((e as { event_date?: unknown }).event_date ?? "").slice(0, 10),
    title: String((e as { title?: unknown }).title ?? ""),
    category: String((e as { category?: unknown }).category ?? "その他"),
    venue: String((e as { venue?: unknown }).venue ?? "tokyo-dome"),
    is_japan: (e as { is_japan?: unknown }).is_japan === true,
    open_time: normalizeEventTime((e as { open_time?: unknown }).open_time),
    start_time: normalizeEventTime((e as { start_time?: unknown }).start_time),
  })).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.event_date) && e.title)
}

// LINEのFlexメッセージ上限(50KB)に対する安全弁。時刻行を足した分だけ本文が太るため、
// 万一超えそうな週は時刻行を落として「イベント一覧が届かない」事態を避ける。
const FLEX_JSON_SAFE_BYTES = 45000

function buildWeeklyFlex(win: WeekWindow, events: WeeklyEvent[]) {
  const withTimes = buildWeeklyFlexBody(win, events, true)
  if (jsonByteLength(withTimes) <= FLEX_JSON_SAFE_BYTES) return withTimes
  console.warn("weekly flex too large with times; falling back to titles only")
  return buildWeeklyFlexBody(win, events, false)
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

function buildWeeklyFlexBody(win: WeekWindow, events: WeeklyEvent[], showTimes: boolean) {
  const rangeLabel = `${win.start.month}/${win.start.day}(${WDAY_JP[win.start.dow]})〜${win.end.month}/${win.end.day}(${WDAY_JP[win.end.dow]})`
  const total = events.length
  const headerContents: Array<Record<string, unknown>> = [
    { type: "text", text: "🗓️ 今後2週間のドームシティ", color: "#FFFFFF", size: "lg", weight: "bold" },
    { type: "text", text: `${rangeLabel} ・ 全${total}件`, color: "#FFFFFFCC", size: "sm", margin: "sm" },
  ]
  const evRow = (e: WeeklyEvent): Record<string, unknown> => {
    const dow = dowOf(e.event_date)
    const dateLabel = `${Number(e.event_date.slice(5, 7))}/${Number(e.event_date.slice(8, 10))}(${dow})`
    // 開場/開始はタイトル下に小さく1行。横並びに足すとタイトルが潰れるため2行構成にする。
    // 公式に時刻の記載が無いイベント（各ホールの一部・IMM・PV観戦）は行ごと出さない。
    const timeLabel = showTimes ? formatEventTimeLabel(e.open_time, e.start_time) : ""
    const detail: Array<Record<string, unknown>> = [
      { type: "text", text: `${EVT_ICON[e.category] || "🎫"} ${e.is_japan ? "🇯🇵 " : ""}${e.title}`, size: "sm", color: "#333333", wrap: true },
    ]
    if (timeLabel) detail.push({ type: "text", text: `🕒 ${timeLabel}`, size: "xxs", color: "#8A94A6", wrap: true })
    return {
      type: "box", layout: "horizontal", margin: "sm", spacing: "sm",
      contents: [
        { type: "text", text: dateLabel, size: "sm", weight: "bold", color: "#1F2D3D", flex: 3 },
        { type: "box", layout: "vertical", flex: 8, contents: detail },
      ],
    }
  }
  const body: Array<Record<string, unknown>> = []
  if (total === 0) {
    body.push({ type: "text", text: "今後2週間(日〜土)はドームシティ3会場とも開催予定はありません。", size: "sm", color: "#8A94A6", wrap: true, align: "center" })
  } else {
    // 会場ごとにセクション分け（東京ドーム→カナデビア→後楽園）。3会場とも見出しを出す。
    for (const v of WEEKLY_VENUES) {
      const evs = events.filter((e) => (e.venue || "tokyo-dome") === v.venue)
      if (v.onlyIfPresent && !evs.length) continue // PV観戦は予定がある週だけ表示（通常週はノイズにしない）
      body.push({
        type: "box", layout: "vertical", backgroundColor: "#F2F4F7", cornerRadius: "md", paddingAll: "8px", margin: body.length ? "lg" : "none",
        contents: [{ type: "text", text: `${v.icon} ${v.label}（${evs.length}件）`, weight: "bold", size: "sm", color: v.accent }],
      })
      if (!evs.length) { body.push({ type: "text", text: "予定なし", size: "xs", color: "#8A94A6", margin: "sm" }); continue }
      evs.slice(0, WEEKLY_PER_VENUE_MAX).forEach((e) => body.push(evRow(e)))
      if (evs.length > WEEKLY_PER_VENUE_MAX) body.push({ type: "text", text: `ほか ${evs.length - WEEKLY_PER_VENUE_MAX} 件`, size: "xs", color: "#8A94A6", margin: "sm" })
    }
  }
  const countLabel = WEEKLY_VENUES
    .map((v) => ({ v, n: events.filter((e) => (e.venue || "tokyo-dome") === v.venue).length }))
    .filter((x) => !x.v.onlyIfPresent || x.n > 0)
    .map((x) => `${x.v.label.replace("ホール", "").replace("（世界スポーツ放映）", "")}${x.n}`).join("/")
  return {
    type: "flex",
    altText: truncate(`今後2週間のドームシティ ${rangeLabel}（${countLabel}）`, 380),
    contents: {
      type: "bubble", size: "mega",
      header: { type: "box", layout: "vertical", backgroundColor: "#1F2D3D", paddingAll: "16px", spacing: "xs", contents: headerContents },
      body: { type: "box", layout: "vertical", paddingAll: "16px", spacing: "sm", contents: body },
    },
  }
}

// --- date helpers (JST) ---
function dowOf(ymdStr: string): string {
  const m = ymdStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return "?"
  return WDAY_JP[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]
}
function toJstDateParts(base = new Date()) {
  const jst = new Date(base.getTime() + JST_OFFSET_MS)
  return { year: jst.getUTCFullYear(), month: jst.getUTCMonth() + 1, day: jst.getUTCDate(), hour: jst.getUTCHours(), minute: jst.getUTCMinutes(), dow: jst.getUTCDay() }
}
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
async function sendLinePush(to: string, messages: unknown[], token: string, storeKey?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!token) return { ok: false, error: "missing line token" }
  if (isMtalkSyntheticRoomId(to)) return { ok: true }
  if (isBlockedByMarugosecondLockdown(storeKey, to)) {
    if (storeKey) {
      void recordLineWebhookDeliveryLog({
        storePartitionKey: storeKey,
        method: 'push',
        context: 'tokyo_dome_weekly',
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
        context: 'tokyo_dome_weekly',
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
      context: 'tokyo_dome_weekly',
      targetRoomId: to,
      attempted: true,
      success: ok,
      httpStatus,
      reason: ok ? '「東京ドーム週次配信」を送信しました。' : `LINEプッシュAPIエラー: ${errText.slice(0, 200)}`,
      details: { message_count: Math.min(messages.length, 5) },
    })
  }

  if (!ok) return { ok: false, error: `LINE push API error (${httpStatus}): ${errText}` }
  return { ok: true }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
}
