/** 明日の予定配信（ルーム設定の時刻で line_room_calendar_events を1通にまとめる）。 */

export const CALENDAR_TOMORROW_REMINDER_DEFAULTS = { hour: 19, minute: 0 }
export const CALENDAR_TOMORROW_REMINDER_MAX_ITEMS = 20

export type TomorrowCalendarEvent = {
  id: number | null
  title: string
  description: string
  startsAt: string
  endsAt: string | null
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

export function toJstDateParts(base = new Date()) {
  const jst = new Date(base.getTime() + JST_OFFSET_MS)
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
  }
}

export function addJstDays(
  parts: { year: number; month: number; day: number },
  delta: number,
): { year: number; month: number; day: number } {
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day + delta)
  const date = new Date(utc)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}

export function jstDayUtcRange(year: number, month: number, day: number) {
  return {
    startIso: new Date(Date.UTC(year, month - 1, day, -9, 0, 0, 0)).toISOString(),
    endIso: new Date(Date.UTC(year, month - 1, day + 1, -9, 0, 0, 0)).toISOString(),
  }
}

export function toJstDateString(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`
}

export function jstDateLabel(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day, 3, 0, 0, 0))
  const weekday = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", weekday: "short" }).format(date)
  return `${month}月${day}日(${weekday})`
}

export function reminderClockMatches(
  nowHour: number,
  nowMinute: number,
  hour: number | null | undefined,
  minute: number | null | undefined,
): boolean {
  const h = hour != null ? Number(hour) : CALENDAR_TOMORROW_REMINDER_DEFAULTS.hour
  const m = minute != null ? Number(minute) : CALENDAR_TOMORROW_REMINDER_DEFAULTS.minute
  return nowHour === h && nowMinute === m
}

export function eventTimeLabel(startsAt: string, endsAt: string | null): string {
  const start = jstHm(startsAt)
  if (!start) return "終日"
  const end = endsAt ? jstHm(endsAt) : null
  return end && end !== start ? `${start}-${end}` : start
}

export function normalizeEventTitle(value: unknown): string {
  const title = String(value ?? "").trim()
  return title || "（無題）"
}

export function buildTomorrowReminderChatText(
  roomName: string | null,
  target: { year: number; month: number; day: number },
  events: TomorrowCalendarEvent[],
): string {
  const dateLabel = jstDateLabel(target.year, target.month, target.day)
  const header = [roomName, `明日の予定 ${events.length}件`, dateLabel].filter(Boolean).join(" / ")
  if (events.length === 0) return `${header}\n明日の予定はありません。`

  const lines = events.slice(0, CALENDAR_TOMORROW_REMINDER_MAX_ITEMS).map((event) => {
    const title = normalizeEventTitle(event.title)
    const time = eventTimeLabel(event.startsAt, event.endsAt)
    return `・${time} ${title}`
  })
  if (events.length > CALENDAR_TOMORROW_REMINDER_MAX_ITEMS) {
    lines.push(`ほか ${events.length - CALENDAR_TOMORROW_REMINDER_MAX_ITEMS} 件`)
  }
  return [header, ...lines].join("\n")
}

export function buildTomorrowReminderChatCard(
  roomName: string | null,
  target: { year: number; month: number; day: number },
  events: TomorrowCalendarEvent[],
  scheduleUrl?: string | null,
): {
  header: { eyebrow: string; title: string; subtitle: string }
  sections: Array<
    | { type: "note"; text: string }
    | { type: "list"; items: Array<{ time: string; name: string; note: string | null }> }
  >
  action: { label: string; url: string } | null
} {
  const dateLabel = jstDateLabel(target.year, target.month, target.day)
  const count = events.length
  const shown = events.slice(0, CALENDAR_TOMORROW_REMINDER_MAX_ITEMS)
  const sections = count === 0
    ? [{ type: "note" as const, text: "明日の予定はありません。" }]
    : [{
      type: "list" as const,
      items: shown.map((event) => ({
        time: eventTimeLabel(event.startsAt, event.endsAt),
        name: normalizeEventTitle(event.title),
        note: String(event.description ?? "").trim() || null,
      })),
    }]
  if (count > CALENDAR_TOMORROW_REMINDER_MAX_ITEMS) {
    sections.push({ type: "note", text: `ほか ${count - CALENDAR_TOMORROW_REMINDER_MAX_ITEMS} 件` })
  }
  return {
    header: {
      eyebrow: "明日の予定",
      title: roomName ?? "明日の予定",
      subtitle: count > 0 ? `${dateLabel} ・ ${count}件` : dateLabel,
    },
    sections,
    action: scheduleUrl ? { label: "予定カレンダーを開く", url: scheduleUrl } : null,
  }
}

function jstHm(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date)
  const hour = parts.find((p) => p.type === "hour")?.value
  const minute = parts.find((p) => p.type === "minute")?.value
  return hour && minute ? `${hour}:${minute}` : null
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}
