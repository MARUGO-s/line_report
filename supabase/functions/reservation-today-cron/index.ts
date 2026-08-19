import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { resolveStorePartitionKeyForRoom } from "../_shared/receipt_report_aggregate.ts"
import { recordLineWebhookDeliveryLog } from "../_shared/line_webhook_delivery_log.ts"
import { isBlockedByMarugosecondLockdown } from "../_shared/line_client.ts"
import { type ChatCard, postChatCard, resolveChatGroupId } from "../_shared/chat_bridge.ts"
import { resolveReceiptNamePartitionKey } from "../_shared/receipt_store_name_resolve.ts"
import { issueAdminDashboardLoginLinkToken } from "../_shared/admin_dashboard_link_auth.ts"
import { buildReservationCalendarPageUrl } from "../_shared/reservation_calendar_link.ts"
import {
  pilotStorePartitionKeysMatch,
  resolveReceiptSheetsStoreDisplayName,
} from "../_shared/receipt_sheets_store_catalog.ts"

type DbClient = ReturnType<typeof createClient>

const JST_OFFSET_MS = 9 * 60 * 60 * 1000
// 送信時刻が未設定(NULL)のルームは当日18:00を既定とする。
const DEFAULT_ALERT_HOUR_JST = 18
const DEFAULT_ALERT_MINUTE_JST = 0
const CANCELLATION_RE = /(キャンセル|取消|取り消し|cancel|cancelled|canceled)/i
const MAX_FLEX_ITEMS = 40

type ReservationSource = "tabelog" | "ikyu"

type NormalizedReservation = {
  source: ReservationSource | "manual"
  storeKey: string | null
  storeName: string | null
  visitAtIso: string
  timeLabel: string | null
  customerName: string | null
  partySizeLabel: string | null
  routeLabel: string
  planLabel: string | null
  allergyLabel: string | null
}

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  const lineAccessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? ""
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing." }, 500)
  }

  const testSpec = parseTestRequest(req)
  if (testSpec) {
    return await handleTestSend(testSpec, { supabaseUrl, serviceRoleKey, lineAccessToken })
  }

  if (!lineAccessToken) {
    return json({ ok: true, skipped: true, reason: "missing_line_channel_access_token" }, 200)
  }

  const now = new Date()
  const jst = toJstDateParts(now)
  const supabase = createClient(supabaseUrl, serviceRoleKey) as unknown as DbClient

  const { data: roomSettings, error: settingsError } = await supabase
    .from("room_summary_settings")
    .select("room_id, is_enabled, today_reservation_alert_enabled, today_reservation_alert_hour, today_reservation_alert_minute, receipt_report_store_partition_key, room_name")
  if (settingsError) {
    return json({ ok: false, error: `Failed to load room_summary_settings: ${settingsError.message}` }, 500)
  }

  // いまこの瞬間(JST)に送るべきルームを抽出（時刻一致＋トグルON＋ルーム有効）。
  const targetRooms: Array<{ roomId: string; storeKey: string; roomName: string }> = []
  for (const row of (Array.isArray(roomSettings) ? roomSettings : [])) {
    const roomId = String(row.room_id ?? "").trim()
    if (!roomId) continue
    if (row.today_reservation_alert_enabled !== true) continue
    if (row.is_enabled === false) continue
    const h = row.today_reservation_alert_hour != null ? Number(row.today_reservation_alert_hour) : DEFAULT_ALERT_HOUR_JST
    const m = row.today_reservation_alert_minute != null ? Number(row.today_reservation_alert_minute) : DEFAULT_ALERT_MINUTE_JST
    if (jst.hour !== h || jst.minute !== m) continue
    targetRooms.push({
      roomId,
      storeKey: String(row.receipt_report_store_partition_key ?? "").trim(),
      roomName: String(row.room_name ?? "").trim(),
    })
  }

  const nowJst = `${toJstDateString(jst.year, jst.month, jst.day)} ${pad2(jst.hour)}:${pad2(jst.minute)}`
  if (targetRooms.length === 0) {
    return json({ ok: true, skipped: true, reason: "no_rooms_scheduled_now", now_jst: nowJst }, 200)
  }

  // 当日(JST)の予約を1度だけ取得し、各ルームの店舗で絞り込む。
  const today = { year: jst.year, month: jst.month, day: jst.day }
  const range = jstDayUtcRange(today.year, today.month, today.day)
  const targetDate = toJstDateString(today.year, today.month, today.day)
  const reservations = await loadReservationsInRange(supabase, range.startIso, range.endIso)

  const sent: string[] = []
  const skipped: Array<{ room_id: string; reason: string }> = []
  const errors: string[] = []
  const chatPosted: string[] = []
  const chatErrors: string[] = []

  for (const target of targetRooms) {
    let storeKey = target.storeKey
    if (!storeKey) {
      storeKey = String((await resolveStorePartitionKeyForRoom(supabase, target.roomId)) ?? "").trim()
    }
    if (!storeKey) {
      skipped.push({ room_id: target.roomId, reason: "store_not_resolved" })
      continue
    }

    const matched = reservations
      .filter((r) => r.storeKey && pilotStorePartitionKeysMatch(r.storeKey, storeKey))
      .sort((a, b) => a.visitAtIso.localeCompare(b.visitAtIso))

    // 同時実行での二重送信を防ぐため、先に重複防止行を確保してから送信する。
    const { error: insertError } = await supabase
      .from("reservation_today_alert_logs")
      .insert({
        room_id: target.roomId,
        target_date: targetDate,
        store_partition_key: storeKey,
        reservation_count: matched.length,
        sent_at: now.toISOString(),
      })
    if (insertError) {
      if (String(insertError.code ?? "") === "23505") {
        skipped.push({ room_id: target.roomId, reason: "already_sent_today" })
      } else {
        errors.push(`${target.roomId}: failed to reserve log (${insertError.message})`)
      }
      continue
    }

    // 予約0件の日は「本日のご予約はありません」だけのPushを送らない（グループ宛は人数分課金されるため）。
    // 重複防止ログ自体はこの分は既に確保済みなので、同日中の再実行では二重送信されない。
    if (matched.length === 0) {
      skipped.push({ room_id: target.roomId, reason: "zero_reservations" })
      continue
    }

    const storeDisplayName = resolveReceiptSheetsStoreDisplayName(storeKey)
      ?? matched.find((r) => r.storeName)?.storeName
      ?? null
    const calendarUrl = await buildTodayReservationCalendarUrl(supabase, storeKey, today)
    const flex = buildTodayReservationFlex(storeDisplayName, today, matched, calendarUrl)
    const sendResult = await sendLinePushMessages(target.roomId, [flex], resolveStoreLineToken(storeKey, lineAccessToken), storeKey)
    if (!sendResult.ok) {
      // 送信失敗時は予約行を取り消し、次回起動で再送できるようにする。
      try {
        await supabase
          .from("reservation_today_alert_logs")
          .delete()
          .eq("room_id", target.roomId)
          .eq("target_date", targetDate)
      } catch (_e) { /* noop */ }
      errors.push(`${target.roomId}: ${sendResult.error}`)
      continue
    }
    sent.push(target.roomId)

    // 同じ内容を chat.html のトークルームにもカードとして流す（対応付けがある場合のみ）。
    // LINE 送信が成功した分だけ複製するので、再送時に二重投稿にならない。
    const chatGroupId = await resolveChatGroupId(supabase, target.roomId)
    if (chatGroupId) {
      const chatResult = await postChatCard(supabase, {
        groupId: chatGroupId,
        kind: "reservation_today",
        text: buildTodayReservationChatText(storeDisplayName, today, matched),
        cards: [buildTodayReservationChatCard(storeDisplayName, today, matched, calendarUrl)],
      })
      if (!chatResult.ok) {
        console.error(`chat card post failed for ${target.roomId}:`, chatResult.error)
        chatErrors.push(`${target.roomId}: ${chatResult.error}`)
      } else {
        chatPosted.push(target.roomId)
      }
    }
  }

  return json({
    ok: true,
    now_jst: nowJst,
    target_date: targetDate,
    target_room_count: targetRooms.length,
    reservation_total: reservations.length,
    sent_room_count: sent.length,
    skipped_room_count: skipped.length,
    error_count: errors.length,
    sent_room_ids: sent,
    chat_posted_room_ids: chatPosted,
    chat_errors: chatErrors,
    skipped,
    errors,
  }, 200)
})

async function loadReservationsInRange(
  supabase: DbClient,
  startIso: string,
  endIso: string,
): Promise<NormalizedReservation[]> {
  const sources: ReservationSource[] = ["tabelog", "ikyu"]
  const tables: Record<ReservationSource, string> = {
    tabelog: "tabelog_reservation_visit_events",
    ikyu: "ikyu_reservation_visit_events",
  }
  const results = await Promise.all(sources.map((source) =>
    supabase
      .from(tables[source])
      .select("gmail_message_id, customer_name, visit_at, created_at, reservation_type, reservation_detail")
      .gte("visit_at", startIso)
      .lt("visit_at", endIso)
      .order("visit_at", { ascending: true })
      .limit(2000)
      .then((res) => ({ source, res }))
  ))

  const out: NormalizedReservation[] = []
  for (const { source, res } of results) {
    if (res.error) {
      console.error(`Failed to load ${source} reservations:`, res.error.message)
      continue
    }
    for (const row of (Array.isArray(res.data) ? res.data : [])) {
      const normalized = normalizeReservationRow(source, row as Record<string, unknown>)
      if (normalized) out.push(normalized)
    }
  }

  // 手入力（管理画面で追加した）予約も本日分に含める。非表示(manual_hidden=ソフト削除)は除外。
  const manualRes = await supabase
    .from("manual_reservation_visit_events")
    .select("customer_name, visit_at, created_at, reservation_type, reservation_detail, manual_store_key, manual_hidden")
    .gte("visit_at", startIso)
    .lt("visit_at", endIso)
    .order("visit_at", { ascending: true })
    .limit(2000)
  if (manualRes.error) {
    console.error("Failed to load manual reservations:", manualRes.error.message)
  } else {
    for (const row of (Array.isArray(manualRes.data) ? manualRes.data : [])) {
      const record = row as Record<string, unknown>
      if (record.manual_hidden === true) continue
      const normalized = normalizeManualReservationRow(record)
      if (normalized) out.push(normalized)
    }
  }

  return out
}

function normalizeReservationRow(
  source: ReservationSource,
  row: Record<string, unknown>,
): NormalizedReservation | null {
  const visitAtIso = String(row.visit_at ?? row.created_at ?? "").trim()
  if (!visitAtIso) return null
  const reservationType = String(row.reservation_type ?? "")
  const rawDetail = String(row.reservation_detail ?? "")
  const detail = parseDetail(rawDetail)

  if (looksCancelled(reservationType, rawDetail, detail)) return null

  const storeName = normalizeText(detail?.storeName, 90)
  const storeKey = storeName ? resolveReceiptNamePartitionKey(storeName) : null
  const routeLabel = normalizeText(detail?.route ?? detail?.reservationSite, 80)
    ?? (source === "tabelog" ? "食べログ" : "一休.comレストラン")

  return {
    source,
    storeKey: storeKey ? String(storeKey).trim() : null,
    storeName,
    visitAtIso,
    timeLabel: reservationTimeLabel(detail?.visitDateTime, visitAtIso),
    customerName: normalizeText(detail?.customerName, 80) ?? (String(row.customer_name ?? "").trim() || null),
    partySizeLabel: partySizeLabel(detail?.partySize),
    routeLabel,
    planLabel: normalizeText(detail?.plan, 200),
    allergyLabel: allergyLabel(detail?.allergy),
  }
}

// 手入力予約の正規化。店舗振り分けは manual_store_key を最優先（無ければ詳細の店名から解決）。
function normalizeManualReservationRow(
  row: Record<string, unknown>,
): NormalizedReservation | null {
  const visitAtIso = String(row.visit_at ?? row.created_at ?? "").trim()
  if (!visitAtIso) return null
  const reservationType = String(row.reservation_type ?? "")
  const rawDetail = String(row.reservation_detail ?? "")
  const detail = parseDetail(rawDetail)

  if (looksCancelled(reservationType, rawDetail, detail)) return null

  const manualStoreKey = String(row.manual_store_key ?? "").trim()
  const storeName = normalizeText(detail?.storeName, 90)
  const storeKey = manualStoreKey || (storeName ? resolveReceiptNamePartitionKey(storeName) : null)
  const routeLabel = normalizeText(detail?.route ?? detail?.reservationSite, 80) ?? "手入力"

  return {
    source: "manual",
    storeKey: storeKey ? String(storeKey).trim() : null,
    storeName,
    visitAtIso,
    timeLabel: reservationTimeLabel(detail?.visitDateTime, visitAtIso),
    customerName: normalizeText(detail?.customerName, 80) ?? (String(row.customer_name ?? "").trim() || null),
    partySizeLabel: partySizeLabel(detail?.partySize),
    routeLabel,
    planLabel: normalizeText(detail?.plan, 200),
    allergyLabel: allergyLabel(detail?.allergy),
  }
}

function looksCancelled(
  reservationType: string,
  rawDetail: string,
  detail: Record<string, unknown> | null,
): boolean {
  if (CANCELLATION_RE.test(reservationType)) return true
  if (detail) {
    for (const key of ["status", "reservationStatus", "action", "eventType", "mailType", "subject", "title", "summary", "note"]) {
      if (CANCELLATION_RE.test(String(detail[key] ?? ""))) return true
    }
  }
  return CANCELLATION_RE.test(rawDetail)
}

function buildTodayReservationFlex(
  storeDisplayName: string | null,
  today: { year: number; month: number; day: number },
  reservations: NormalizedReservation[],
  calendarUrl?: string | null,
) {
  const dateLabel = jstDateLabel(today.year, today.month, today.day)
  const count = reservations.length

  const headerContents: Array<Record<string, unknown>> = [
    { type: "text", text: "本日のご予約", color: "#FFFFFFCC", size: "sm", weight: "bold" },
  ]
  if (storeDisplayName) {
    headerContents.push({ type: "text", text: storeDisplayName, color: "#FFFFFF", size: "lg", weight: "bold", wrap: true })
  }
  headerContents.push({
    type: "text",
    text: count > 0 ? `${dateLabel} ・ ${count}件` : `${dateLabel}`,
    color: "#FFFFFFCC",
    size: "sm",
    margin: "sm",
  })

  let bodyContents: Array<Record<string, unknown>>
  if (count === 0) {
    bodyContents = [
      { type: "text", text: "本日のご予約はありません。", size: "sm", color: "#8A94A6", wrap: true, align: "center" },
    ]
  } else {
    const shown = reservations.slice(0, MAX_FLEX_ITEMS)
    bodyContents = []
    shown.forEach((r, idx) => {
      if (idx > 0) bodyContents.push({ type: "separator", margin: "md" })
      bodyContents.push(buildReservationRow(r))
    })
    if (reservations.length > MAX_FLEX_ITEMS) {
      bodyContents.push({ type: "separator", margin: "md" })
      bodyContents.push({
        type: "text",
        text: `ほか ${reservations.length - MAX_FLEX_ITEMS} 件`,
        size: "xs",
        color: "#8A94A6",
        align: "center",
        margin: "md",
      })
    }
  }

  const bubble = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#1F2D3D",
      paddingAll: "16px",
      spacing: "xs",
      contents: headerContents,
    },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "16px",
      spacing: "md",
      contents: bodyContents,
    },
  } as Record<string, unknown>

  if (calendarUrl) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        {
          type: "button",
          style: "primary",
          height: "sm",
          action: {
            type: "uri",
            label: "予約カレンダーを開く",
            uri: calendarUrl,
          },
        },
      ],
    }
  }

  const altParts = [storeDisplayName, `本日のご予約 ${count}件`].filter(Boolean)
  return {
    type: "flex",
    altText: truncate(altParts.join(" / "), 380),
    contents: bubble,
  }
}

/** Flex と同じ内容を chat.html のカード用ペイロードに組み直す。 */
function buildTodayReservationChatCard(
  storeDisplayName: string | null,
  today: { year: number; month: number; day: number },
  reservations: NormalizedReservation[],
  calendarUrl?: string | null,
): ChatCard {
  const dateLabel = jstDateLabel(today.year, today.month, today.day)
  const count = reservations.length
  const shown = reservations.slice(0, MAX_FLEX_ITEMS)

  const sections: ChatCard["sections"] = count === 0
    ? [{ type: "note", text: "本日のご予約はありません。" }]
    : [{
      type: "list",
      items: shown.map((r) => ({
        time: r.timeLabel ?? "--:--",
        name: formatReservationCustomerName(r.customerName),
        size: r.partySizeLabel ?? null,
        note: [r.routeLabel, r.planLabel].filter(Boolean).join(" ・ ") || null,
        warn: r.allergyLabel ? `⚠ アレルギー: ${r.allergyLabel}` : null,
      })),
    }]

  if (count > MAX_FLEX_ITEMS) {
    sections.push({ type: "note", text: `ほか ${count - MAX_FLEX_ITEMS} 件` })
  }

  return {
    header: {
      eyebrow: "本日のご予約",
      title: storeDisplayName ?? "本日のご予約",
      subtitle: count > 0 ? `${dateLabel} ・ ${count}件` : dateLabel,
    },
    sections,
    action: calendarUrl ? { label: "予約カレンダーを開く", url: calendarUrl } : null,
  }
}

/** トーク一覧のプレビューと Web Push 本文に使うテキスト版。 */
function buildTodayReservationChatText(
  storeDisplayName: string | null,
  today: { year: number; month: number; day: number },
  reservations: NormalizedReservation[],
): string {
  const dateLabel = jstDateLabel(today.year, today.month, today.day)
  const header = [storeDisplayName, `本日のご予約 ${reservations.length}件`, dateLabel]
    .filter(Boolean)
    .join(" / ")
  if (reservations.length === 0) return `${header}\n本日のご予約はありません。`

  const lines = reservations.slice(0, MAX_FLEX_ITEMS).map((r) => {
    const parts = [
      r.timeLabel ?? "--:--",
      formatReservationCustomerName(r.customerName),
      r.partySizeLabel,
    ].filter(Boolean)
    return `・${parts.join(" ")}`
  })
  if (reservations.length > MAX_FLEX_ITEMS) {
    lines.push(`ほか ${reservations.length - MAX_FLEX_ITEMS} 件`)
  }
  return [header, ...lines].join("\n")
}

// お客様名に敬称「様」を付与する。空・不明は「（お名前なし）」。既存の「様」は重複させない。
function formatReservationCustomerName(name: string | null): string {
  const base = String(name ?? "").replace(/\s*様\s*$/, "").trim()
  if (!base || base === "不明" || base === "なし") return "（お名前なし）"
  return `${base} 様`
}

function buildReservationRow(r: NormalizedReservation): Record<string, unknown> {
  const contents: Array<Record<string, unknown>> = [
    {
      type: "box",
      layout: "horizontal",
      contents: [
        { type: "text", text: r.timeLabel ?? "--:--", size: "sm", weight: "bold", color: "#1F2D3D", flex: 2 },
        { type: "text", text: formatReservationCustomerName(r.customerName), size: "sm", color: "#333333", flex: 5, wrap: true },
        { type: "text", text: r.partySizeLabel ?? "", size: "sm", color: "#5B6B7B", align: "end", flex: 3 },
      ],
    },
  ]
  const detailLine = [r.routeLabel, r.planLabel].filter(Boolean).join(" ・ ")
  if (detailLine) {
    contents.push({ type: "text", text: detailLine, size: "xs", color: "#8A94A6", wrap: true })
  }
  if (r.allergyLabel) {
    contents.push({ type: "text", text: `⚠ アレルギー: ${r.allergyLabel}`, size: "xs", color: "#C0392B", wrap: true })
  }
  return { type: "box", layout: "vertical", spacing: "xs", margin: "md", contents }
}

// --- parsing / formatting helpers ---

function parseDetail(detail: string): Record<string, unknown> | null {
  const text = String(detail ?? "").trim()
  if (!text.startsWith("{")) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function normalizeText(value: unknown, maxLength = 160): string | null {
  const normalized = String(value ?? "").trim()
  if (!normalized) return null
  if (normalized === "不明" || normalized === "なし") return null
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function partySizeLabel(value: unknown): string | null {
  const t = normalizeText(value, 40)
  if (!t) return null
  const hit = t.match(/([0-9０-９]+)/)
  if (!hit) return t
  const digits = hit[1].replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  return `${digits}名`
}

function allergyLabel(value: unknown): string | null {
  const t = normalizeText(value, 120)
  if (!t) return null
  if (/^(なし|無|無し|ありません|特になし|該当なし|なしです|不要|記載なし)$/i.test(t)) return null
  return t
}

function reservationTimeLabel(visitDateTime: unknown, visitAtIso: string): string | null {
  const raw = String(visitDateTime ?? "").trim()
  if (raw) {
    const hit = raw.match(/([0-2]?\d):([0-5]\d)/)
    if (hit) return `${pad2(Number(hit[1]))}:${hit[2]}`
  }
  const iso = String(visitAtIso ?? "").trim()
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date)
  const hour = parts.find((p) => p.type === "hour")?.value
  const minute = parts.find((p) => p.type === "minute")?.value
  return hour && minute ? `${hour}:${minute}` : null
}

function jstDateLabel(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day, 3, 0, 0, 0)) // 正午JST相当で曜日を安定取得
  const weekday = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", weekday: "short" }).format(date)
  return `${month}月${day}日(${weekday})`
}

// --- date helpers (JST) ---

function toJstDateParts(base = new Date()) {
  const jst = new Date(base.getTime() + JST_OFFSET_MS)
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
  }
}

function jstDayUtcRange(year: number, month: number, day: number) {
  return {
    startIso: new Date(Date.UTC(year, month - 1, day, -9, 0, 0, 0)).toISOString(),
    endIso: new Date(Date.UTC(year, month - 1, day + 1, -9, 0, 0, 0)).toISOString(),
  }
}

function toJstDateString(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

// --- LINE token / send ---

// LINEアクセストークンをHTTPヘッダに安全な形へ正規化（印字可能ASCII以外を除去）。
// シークレットへ紛れ込んだ改行・空白・全角等で "not a valid ByteString" になるのを防ぐ。
function sanitizeLineToken(raw: unknown): string {
  return String(raw ?? "").replace(/[^\x21-\x7e]/g, "")
}

function resolveStoreLineToken(storeKey: string, fallbackToken: string): string {
  const key = String(storeKey ?? "").trim()
  if (key) {
    const suffix = key.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase()
    // 予約通知の一時流用（別アカウント）。gmail-alert-cron と同一仕様。月200通上限の一時回避用。
    //  (1) 生トークン指定: LINE_RESERVATION_ALERT_TOKEN__<STORE>
    const override = sanitizeLineToken(Deno.env.get(`LINE_RESERVATION_ALERT_TOKEN__${suffix}`))
    if (override) return override
    //  (2) 借りる店舗キー指定: LINE_RESERVATION_ALERT_BORROW__<STORE> = 別店舗キー
    const borrow = String(Deno.env.get(`LINE_RESERVATION_ALERT_BORROW__${suffix}`) ?? "").trim()
    if (borrow) {
      const bSuffix = borrow.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase()
      const borrowed = sanitizeLineToken(Deno.env.get(`LINE_CHANNEL_ACCESS_TOKEN__${bSuffix}`))
      if (borrowed) return borrowed
    }
    const perStore = sanitizeLineToken(Deno.env.get(`LINE_CHANNEL_ACCESS_TOKEN__${suffix}`))
    if (perStore) return perStore
  }
  return sanitizeLineToken(fallbackToken)
}

async function sendLinePushMessages(to: string, messages: unknown[], token: string, storeKey?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isBlockedByMarugosecondLockdown(storeKey, to)) {
    if (storeKey) {
      void recordLineWebhookDeliveryLog({
        storePartitionKey: storeKey,
        method: 'push',
        context: 'reservation_today',
        targetRoomId: to,
        attempted: false,
        success: false,
        reason: '一時ロックダウン中のためブロック（マルゴセカンド送信元調査用）',
      })
    }
    return { ok: false, error: 'blocked_by_marugosecond_lockdown' }
  }
  let response: Response
  try {
    response = await fetch("https://api.line.me/v2/bot/message/push", {
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
        context: 'reservation_today',
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

  const httpStatus = response.status
  const ok = response.ok
  const errText = ok ? '' : await response.text()

  if (storeKey) {
    void recordLineWebhookDeliveryLog({
      storePartitionKey: storeKey,
      method: 'push',
      context: 'reservation_today',
      targetRoomId: to,
      attempted: true,
      success: ok,
      httpStatus,
      reason: ok ? '「本日の予約」を配信しました。' : `LINEプッシュAPIエラー: ${errText.slice(0, 200)}`,
      details: { message_count: Math.min(messages.length, 5) },
    })
  }

  if (!ok) {
    return { ok: false, error: `LINE push API error (${httpStatus}): ${errText}` }
  }
  return { ok: true }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

// --- test send (preview, no dedup log) ---

type TestSpec = { roomId: string; storePartitionKey: string | null; targetDate: string | null; keyFromQuery: string; keyFromHeader: string }

function parseTestRequest(req: Request): TestSpec | null {
  const url = new URL(req.url)
  const flag = (url.searchParams.get("test_today_reservation") ?? "").trim().toLowerCase()
  if (flag !== "1" && flag !== "true" && flag !== "yes" && flag !== "on") return null
  const roomId = (url.searchParams.get("room_id") ?? "").trim()
  if (!roomId) return null
  const storeKeyRaw = (url.searchParams.get("store_partition_key") ?? "").trim()
  const dateRaw = (url.searchParams.get("date") ?? "").trim()
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null
  return {
    roomId,
    storePartitionKey: storeKeyRaw || null,
    targetDate,
    keyFromQuery: (url.searchParams.get("key") ?? "").trim(),
    keyFromHeader: (req.headers.get("x-reservation-today-test-key") ?? "").trim(),
  }
}

async function handleTestSend(
  spec: TestSpec,
  deps: { supabaseUrl: string; serviceRoleKey: string; lineAccessToken: string },
): Promise<Response> {
  const testKey = (Deno.env.get("RESERVATION_TODAY_CRON_TEST_KEY") ?? "").trim()
  if (!testKey) {
    return json({ ok: false, error: "Test send is disabled. Set Edge secret RESERVATION_TODAY_CRON_TEST_KEY." }, 503)
  }
  const provided = spec.keyFromHeader || spec.keyFromQuery
  if (!provided || provided !== testKey) {
    return json({ ok: false, error: "Forbidden" }, 403)
  }
  if (!deps.lineAccessToken) {
    return json({ ok: false, error: "LINE_CHANNEL_ACCESS_TOKEN is missing." }, 500)
  }

  const supabase = createClient(deps.supabaseUrl, deps.serviceRoleKey) as unknown as DbClient
  let storeKey = spec.storePartitionKey ?? ""
  if (!storeKey) {
    storeKey = String((await resolveStorePartitionKeyForRoom(supabase, spec.roomId)) ?? "").trim()
  }
  if (!storeKey) {
    return json({ ok: true, skipped: true, mode: "test_today_reservation", reason: "store_not_resolved_for_room", room_id: spec.roomId }, 200)
  }

  const now = new Date()
  let today: { year: number; month: number; day: number }
  if (spec.targetDate) {
    const [y, m, d] = spec.targetDate.split("-").map((n) => Number(n))
    today = { year: y, month: m, day: d }
  } else {
    const jstNow = toJstDateParts(now)
    today = { year: jstNow.year, month: jstNow.month, day: jstNow.day }
  }
  const range = jstDayUtcRange(today.year, today.month, today.day)
  const reservations = (await loadReservationsInRange(supabase, range.startIso, range.endIso))
    .filter((r) => r.storeKey && pilotStorePartitionKeysMatch(r.storeKey, storeKey))
    .sort((a, b) => a.visitAtIso.localeCompare(b.visitAtIso))

  const storeDisplayName = resolveReceiptSheetsStoreDisplayName(storeKey)
    ?? reservations.find((r) => r.storeName)?.storeName
    ?? null
  const calendarUrl = await buildTodayReservationCalendarUrl(supabase, storeKey, today)
  const flex = buildTodayReservationFlex(storeDisplayName, today, reservations, calendarUrl)
  const sendResult = await sendLinePushMessages(spec.roomId, [flex], resolveStoreLineToken(storeKey, deps.lineAccessToken), storeKey)
  if (!sendResult.ok) {
    return json({ ok: false, error: sendResult.error, mode: "test_today_reservation" }, 502)
  }
  return json({
    ok: true,
    mode: "test_today_reservation",
    note: "Preview send only. reservation_today_alert_logs was NOT updated.",
    room_id: spec.roomId,
    store_partition_key: storeKey,
    target_date: toJstDateString(today.year, today.month, today.day),
    reservation_count: reservations.length,
  }, 200)
}

function formatTargetMonth(today: { year: number; month: number }): string {
  return `${String(today.year).padStart(4, "0")}-${pad2(today.month)}`
}

async function buildTodayReservationCalendarUrl(
  supabase: DbClient,
  storeKey: string,
  today: { year: number; month: number },
): Promise<string | null> {
  const key = String(storeKey ?? "").trim()
  if (!key) return null
  const targetMonth = formatTargetMonth(today)
  try {
    const issued = await issueAdminDashboardLoginLinkToken(supabase, {
      source: "line_today_reservation",
      store_partition_key: key,
      target_month: targetMonth,
    })
    return buildReservationCalendarPageUrl(key, {
      loginToken: issued.token,
      targetMonth,
    })
  } catch (error) {
    console.error("buildTodayReservationCalendarUrl failed:", error)
    return buildReservationCalendarPageUrl(key, { targetMonth })
  }
}
