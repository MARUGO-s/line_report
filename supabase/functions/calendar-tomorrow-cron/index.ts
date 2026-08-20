import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { recordLineWebhookDeliveryLog } from "../_shared/line_webhook_delivery_log.ts"
import { isBlockedByMarugosecondLockdown } from "../_shared/line_client.ts"
import { type ChatCard, postChatCardIndependent, resolveChatGroupId } from "../_shared/chat_bridge.ts"
import { isMtalkSyntheticRoomId } from "../_shared/mtalk_room_id.ts"
import { loadMtalkStoreBot } from "../_shared/mtalk_room_settings.ts"
import {
  addJstDays,
  buildMtalkSchedulePageUrl,
  buildTomorrowReminderChatCard,
  buildTomorrowReminderChatText,
  CALENDAR_TOMORROW_REMINDER_MAX_ITEMS,
  eventTimeLabel,
  jstDateLabel,
  jstDayUtcRange,
  normalizeEventTitle,
  reminderClockMatches,
  toJstDateParts,
  toJstDateString,
  type TomorrowCalendarEvent,
} from "../_shared/calendar_tomorrow_reminder.ts"

type DbClient = ReturnType<typeof createClient>

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  const lineAccessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? ""
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing." }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey) as unknown as DbClient
  const now = new Date()
  const jst = toJstDateParts(now)
  const tomorrow = addJstDays(jst, 1)
  const targetDate = toJstDateString(tomorrow.year, tomorrow.month, tomorrow.day)
  const nowJst = `${toJstDateString(jst.year, jst.month, jst.day)} ${pad2(jst.hour)}:${pad2(jst.minute)}`

  const { data: roomSettings, error: settingsError } = await supabase
    .from("room_summary_settings")
    .select("room_id, is_enabled, calendar_tomorrow_reminder_enabled, calendar_tomorrow_reminder_hour, calendar_tomorrow_reminder_minute, receipt_report_store_partition_key, room_name")
  if (settingsError) {
    return json({ ok: false, error: `Failed to load room_summary_settings: ${settingsError.message}` }, 500)
  }

  const targetRooms: Array<{ roomId: string; storeKey: string; roomName: string }> = []
  for (const row of (Array.isArray(roomSettings) ? roomSettings : [])) {
    const roomId = String(row.room_id ?? "").trim()
    if (!roomId) continue
    if (row.calendar_tomorrow_reminder_enabled !== true) continue
    if (row.is_enabled === false) continue
    if (!reminderClockMatches(jst.hour, jst.minute, row.calendar_tomorrow_reminder_hour, row.calendar_tomorrow_reminder_minute)) {
      continue
    }
    targetRooms.push({
      roomId,
      storeKey: String(row.receipt_report_store_partition_key ?? "").trim(),
      roomName: String(row.room_name ?? "").trim(),
    })
  }

  if (targetRooms.length === 0) {
    return json({ ok: true, skipped: true, reason: "no_rooms_scheduled_now", now_jst: nowJst }, 200)
  }

  const sent: string[] = []
  const skipped: Array<{ room_id: string; reason: string }> = []
  const errors: string[] = []
  const chatPosted: string[] = []
  const chatErrors: string[] = []

  for (const target of targetRooms) {
    const events = await loadTomorrowEvents(supabase, target.roomId, target.storeKey, tomorrow)
    const { error: insertError } = await supabase
      .from("calendar_tomorrow_reminder_logs")
      .insert({
        room_id: target.roomId,
        target_date: targetDate,
        store_partition_key: target.storeKey || null,
        event_count: events.length,
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

    const chatGroupId = await resolveChatGroupId(supabase, target.roomId)
    const mtalkRoom = isMtalkSyntheticRoomId(target.roomId)
    const scheduleUrl = chatGroupId
      ? buildMtalkSchedulePageUrl(chatGroupId, { tab: "events" })
      : null

    if (chatGroupId) {
      const asUser = mtalkRoom && target.storeKey ? await loadMtalkStoreBot(supabase, target.storeKey) : null
      const chatResult = await postChatCardIndependent(supabase, {
        groupId: chatGroupId,
        kind: "calendar_tomorrow",
        dedupeKey: targetDate,
        text: buildTomorrowReminderChatText(target.roomName || null, tomorrow, events),
        cards: [buildTomorrowReminderChatCard(target.roomName || null, tomorrow, events, scheduleUrl) as ChatCard],
        asUser,
      })
      if (!chatResult.ok) {
        console.error(`chat card post failed for ${target.roomId}:`, chatResult.error)
        chatErrors.push(`${target.roomId}: ${chatResult.error}`)
      } else if (!chatResult.skipped) {
        chatPosted.push(target.roomId)
      }
    }

    if (mtalkRoom) {
      sent.push(target.roomId)
      continue
    }

    if (events.length === 0) {
      skipped.push({ room_id: target.roomId, reason: "zero_events" })
      continue
    }

    if (!lineAccessToken) {
      skipped.push({ room_id: target.roomId, reason: "missing_line_channel_access_token" })
      continue
    }

    const flex = buildTomorrowReminderFlex(target.roomName || null, tomorrow, events, scheduleUrl)
    const sendResult = await sendLinePushMessages(
      target.roomId,
      [flex],
      resolveStoreLineToken(target.storeKey, lineAccessToken),
      target.storeKey,
    )
    if (!sendResult.ok) {
      try {
        await supabase
          .from("calendar_tomorrow_reminder_logs")
          .delete()
          .eq("room_id", target.roomId)
          .eq("target_date", targetDate)
      } catch (_e) { /* noop */ }
      errors.push(`${target.roomId}: ${sendResult.error}`)
      continue
    }
    sent.push(target.roomId)
  }

  return json({
    ok: true,
    now_jst: nowJst,
    target_date: targetDate,
    target_room_count: targetRooms.length,
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

async function loadTomorrowEvents(
  supabase: DbClient,
  roomId: string,
  storeKey: string,
  tomorrow: { year: number; month: number; day: number },
): Promise<TomorrowCalendarEvent[]> {
  const roomIds = new Set<string>([roomId])
  if (isMtalkSyntheticRoomId(roomId) && storeKey) {
    const { data, error } = await supabase
      .from("room_summary_settings")
      .select("room_id")
      .eq("receipt_report_store_partition_key", storeKey)
    if (error) {
      console.error("Failed to load linked rooms for tomorrow reminder:", error.message)
    } else {
      for (const row of (Array.isArray(data) ? data : [])) {
        const id = String((row as { room_id?: string }).room_id ?? "").trim()
        if (id) roomIds.add(id)
      }
    }
  }
  const range = jstDayUtcRange(tomorrow.year, tomorrow.month, tomorrow.day)
  const { data, error } = await supabase
    .from("line_room_calendar_events")
    .select("id, event_title, event_description, starts_at, ends_at")
    .in("room_id", [...roomIds])
    .gte("starts_at", range.startIso)
    .lt("starts_at", range.endIso)
    .order("starts_at", { ascending: true })
    .limit(500)
  if (error) {
    console.error("Failed to load calendar events:", error.message)
    return []
  }
  const seen = new Set<number>()
  const out: TomorrowCalendarEvent[] = []
  for (const row of (Array.isArray(data) ? data : [])) {
    const rec = row as Record<string, unknown>
    const id = Number(rec.id ?? 0)
    if (id && seen.has(id)) continue
    if (id) seen.add(id)
    const startsAt = String(rec.starts_at ?? "").trim()
    if (!startsAt) continue
    out.push({
      id: id || null,
      title: String(rec.event_title ?? "").trim(),
      description: String(rec.event_description ?? "").trim(),
      startsAt,
      endsAt: rec.ends_at ? String(rec.ends_at) : null,
    })
  }
  return out
}

function buildTomorrowReminderFlex(
  roomName: string | null,
  target: { year: number; month: number; day: number },
  events: TomorrowCalendarEvent[],
  scheduleUrl?: string | null,
) {
  const dateLabel = jstDateLabel(target.year, target.month, target.day)
  const count = events.length
  const headerContents: Array<Record<string, unknown>> = [
    { type: "text", text: "明日の予定", color: "#FFFFFFCC", size: "sm", weight: "bold" },
  ]
  if (roomName) {
    headerContents.push({ type: "text", text: roomName, color: "#FFFFFF", size: "lg", weight: "bold", wrap: true })
  }
  headerContents.push({
    type: "text",
    text: count > 0 ? `${dateLabel} ・ ${count}件` : dateLabel,
    color: "#FFFFFFCC",
    size: "sm",
    margin: "sm",
  })

  const shown = events.slice(0, CALENDAR_TOMORROW_REMINDER_MAX_ITEMS)
  const bodyContents: Array<Record<string, unknown>> = []
  shown.forEach((event, idx) => {
    if (idx > 0) bodyContents.push({ type: "separator", margin: "md" })
    const contents: Array<Record<string, unknown>> = [
      {
        type: "box",
        layout: "horizontal",
        contents: [
          { type: "text", text: eventTimeLabel(event.startsAt, event.endsAt), size: "sm", weight: "bold", color: "#1F2D3D", flex: 3 },
          { type: "text", text: normalizeEventTitle(event.title), size: "sm", color: "#333333", flex: 7, wrap: true },
        ],
      },
    ]
    const note = String(event.description ?? "").trim()
    if (note) {
      contents.push({ type: "text", text: note, size: "xs", color: "#8A94A6", wrap: true })
    }
    bodyContents.push({ type: "box", layout: "vertical", spacing: "xs", margin: "md", contents })
  })
  if (events.length > CALENDAR_TOMORROW_REMINDER_MAX_ITEMS) {
    bodyContents.push({ type: "separator", margin: "md" })
    bodyContents.push({
      type: "text",
      text: `ほか ${events.length - CALENDAR_TOMORROW_REMINDER_MAX_ITEMS} 件`,
      size: "xs",
      color: "#8A94A6",
      align: "center",
      margin: "md",
    })
  }

  const bubble: Record<string, unknown> = {
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
  }
  if (scheduleUrl) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      paddingAll: "12px",
      contents: [
        {
          type: "button",
          style: "primary",
          height: "sm",
          action: { type: "uri", label: "予定カレンダーを開く", uri: scheduleUrl },
        },
      ],
    }
  }
  const altParts = [roomName, `明日の予定 ${count}件`].filter(Boolean)
  return {
    type: "flex",
    altText: truncate(altParts.join(" / "), 380),
    contents: bubble,
  }
}

function sanitizeLineToken(raw: unknown): string {
  return String(raw ?? "").replace(/[^\x21-\x7e]/g, "")
}

function resolveStoreLineToken(storeKey: string, fallbackToken: string): string {
  const key = String(storeKey ?? "").trim()
  if (key) {
    const suffix = key.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase()
    const perStore = sanitizeLineToken(Deno.env.get(`LINE_CHANNEL_ACCESS_TOKEN__${suffix}`))
    if (perStore) return perStore
  }
  return sanitizeLineToken(fallbackToken)
}

async function sendLinePushMessages(
  to: string,
  messages: unknown[],
  token: string,
  storeKey?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isMtalkSyntheticRoomId(to)) return { ok: true }
  if (isBlockedByMarugosecondLockdown(storeKey, to)) {
    if (storeKey) {
      void recordLineWebhookDeliveryLog({
        storePartitionKey: storeKey,
        method: "push",
        context: "calendar_tomorrow",
        targetRoomId: to,
        attempted: false,
        success: false,
        reason: "一時ロックダウン中のためブロック（マルゴセカンド送信元調査用）",
      })
    }
    return { ok: false, error: "blocked_by_marugosecond_lockdown" }
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
        method: "push",
        context: "calendar_tomorrow",
        targetRoomId: to,
        attempted: true,
        success: false,
        httpStatus: 0,
        reason: `LINEプッシュが例外で失敗: ${msg.slice(0, 200)}`,
      })
    }
    return { ok: false, error: `LINE push threw: ${msg}` }
  }

  const httpStatus = response.status
  const ok = response.ok
  const errText = ok ? "" : await response.text()
  if (storeKey) {
    void recordLineWebhookDeliveryLog({
      storePartitionKey: storeKey,
      method: "push",
      context: "calendar_tomorrow",
      targetRoomId: to,
      attempted: true,
      success: ok,
      httpStatus,
      reason: ok ? "「明日の予定」を配信しました。" : `LINEプッシュAPIエラー: ${errText.slice(0, 200)}`,
    })
  }
  if (!ok) return { ok: false, error: `LINE push API error (${httpStatus}): ${errText}` }
  return { ok: true }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
