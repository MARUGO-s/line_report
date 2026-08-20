/** 会話から予定を検知し、M-talk の予定カレンダー（line_room_calendar_events）へ登録する。 */

export type ParsedRoomSchedule = {
  title: string
  startsAt: string
  endsAt: string
}

export type ScheduleAutoRegisterResult = {
  handled: boolean
  registered: boolean
  replyText: string | null
}

const DEFAULT_DURATION_MIN = 60
const SKIP_PREFIX =
  /^(設定|権限設定|せってい|ルーム設定|検索|売上検索|予算登録|経費|#メモ|#日報|#note)/i

function jstParts(now: Date): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now)
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value || "0")
  const wd = parts.find((p) => p.type === "weekday")?.value || "Mon"
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { y: num("year"), m: num("month"), d: num("day"), weekday: weekdayMap[wd] ?? 1 }
}

function ymd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

function addDays(y: number, m: number, d: number, delta: number): string {
  const utc = Date.UTC(y, m - 1, d + delta)
  const date = new Date(utc)
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function jstDateTimeToIso(dateYmd: string, timeHm: string): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd)
  const tm = /^(\d{1,2}):(\d{2})$/.exec(timeHm)
  if (!dm || !tm) return null
  const y = Number(dm[1])
  const mo = Number(dm[2])
  const d = Number(dm[3])
  const h = Number(tm[1])
  const mi = Number(tm[2])
  if (h > 23 || mi > 59) return null
  return new Date(Date.UTC(y, mo - 1, d, h - 9, mi, 0)).toISOString()
}

function normalizeHm(hour: number, minute: number): string | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

function parseTime(text: string): { hm: string; matched: string } | null {
  const colon = text.match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?:[^\d]|$)/)
  if (colon) {
    const hm = normalizeHm(Number(colon[1]), Number(colon[2]))
    if (hm) return { hm, matched: colon[0] }
  }
  const jp = text.match(/(\d{1,2})時(?:(\d{1,2})分)?/)
  if (jp) {
    const hm = normalizeHm(Number(jp[1]), jp[2] ? Number(jp[2]) : 0)
    if (hm) return { hm, matched: jp[0] }
  }
  return null
}

function parseDate(text: string, now: Date): { ymd: string; matched: string } | null {
  const today = jstParts(now)
  if (/(今日|本日)/.test(text)) return { ymd: ymd(today.y, today.m, today.d), matched: "今日" }
  if (/明後日/.test(text)) return { ymd: addDays(today.y, today.m, today.d, 2), matched: "明後日" }
  if (/明日/.test(text)) return { ymd: addDays(today.y, today.m, today.d, 1), matched: "明日" }

  const iso = text.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/)
  if (iso) {
    return {
      ymd: ymd(Number(iso[1]), Number(iso[2]), Number(iso[3])),
      matched: iso[0],
    }
  }
  const jp = text.match(/(\d{1,2})月(\d{1,2})日/)
  if (jp) {
    let year = today.y
    const month = Number(jp[1])
    const day = Number(jp[2])
    if (month < today.m || (month === today.m && day < today.d)) year += 1
    return { ymd: ymd(year, month, day), matched: jp[0] }
  }
  return null
}

function extractTitle(text: string, matched: string[]): string {
  let title = text
  for (const part of matched) {
    if (part) title = title.replace(part, " ")
  }
  title = title
    .replace(/^予定(?:登録|追加|作成)?/, " ")
    .replace(/カレンダー(?:登録|追加)?/, " ")
    .replace(/(お願いします|お願い|してください|して下さい|して|から|まで|に|で|を|の)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return title || "予定"
}

export function parseScheduleFromText(text: string, now = new Date()): ParsedRoomSchedule | null {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim()
  if (!raw || SKIP_PREFIX.test(raw)) return null

  const explicit = raw.match(
    /^予定(?:登録|追加)(?:\s+)(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})(?:\s+(\d{1,3}))?\s+(.+)$/,
  )
  if (explicit) {
    const duration = explicit[3] ? Number(explicit[3]) : DEFAULT_DURATION_MIN
    const startsAt = jstDateTimeToIso(explicit[1], explicit[2])
    if (!startsAt || !Number.isFinite(duration) || duration <= 0) return null
    const endsAt = new Date(Date.parse(startsAt) + duration * 60 * 1000).toISOString()
    return { title: explicit[4].trim(), startsAt, endsAt }
  }

  const time = parseTime(raw)
  const date = parseDate(raw, now)
  if (!time || !date) return null

  const hasEventWord =
    /(予定|会議|打ち合わせ|打合せ|ミーティング|mtg|meeting|講習会|セミナー|試飲会|イベント|仕込み|研修|説明会)/i.test(raw)
  const hasCreatePhrase =
    /(予定登録|予定追加|予定作成|カレンダー登録|入れて|追加して|登録して)/.test(raw)
  if (!hasEventWord && !hasCreatePhrase) return null

  const startsAt = jstDateTimeToIso(date.ymd, time.hm)
  if (!startsAt) return null
  const endsAt = new Date(Date.parse(startsAt) + DEFAULT_DURATION_MIN * 60 * 1000).toISOString()
  const title = extractTitle(raw, [date.matched, time.matched])
  return { title, startsAt, endsAt }
}

export function formatScheduleReply(parsed: ParsedRoomSchedule): string {
  const start = new Date(parsed.startsAt)
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(start)
  const get = (type: string) => parts.find((p) => p.type === type)?.value || ""
  const when = `${get("month")}月${get("day")}日（${get("weekday")}） ${get("hour")}:${get("minute")}`
  return `予定をM-talkのカレンダーに登録しました。\n${when}\n${parsed.title}`
}

export async function tryAutoRegisterRoomSchedule(
  supabase: { from: (table: string) => any },
  params: {
    roomId: string
    text: string
    source?: string
    autoCreate: boolean
    silent: boolean
    replyEnabled: boolean
    hardMute?: boolean
  },
): Promise<ScheduleAutoRegisterResult> {
  const roomId = String(params.roomId || "").trim()
  if (!params.autoCreate || !roomId) {
    return { handled: false, registered: false, replyText: null }
  }
  const parsed = parseScheduleFromText(params.text)
  if (!parsed) return { handled: false, registered: false, replyText: null }

  const { data: existing } = await supabase
    .from("line_room_calendar_events")
    .select("id")
    .eq("room_id", roomId)
    .eq("event_title", parsed.title)
    .eq("starts_at", parsed.startsAt)
    .maybeSingle()
  if (existing?.id) {
    const replyText = (!params.hardMute && (params.replyEnabled || !params.silent))
      ? formatScheduleReply(parsed)
      : null
    return { handled: true, registered: false, replyText }
  }

  const { error } = await supabase.from("line_room_calendar_events").insert({
    room_id: roomId,
    event_title: parsed.title,
    event_description: String(params.text || "").slice(0, 500),
    starts_at: parsed.startsAt,
    ends_at: parsed.endsAt,
    source: params.source || "mtalk",
    updated_at: new Date().toISOString(),
  })
  if (error) {
    console.error("tryAutoRegisterRoomSchedule insert failed:", error.message)
    return { handled: true, registered: false, replyText: "予定の登録に失敗しました。" }
  }

  const shouldReply = !params.hardMute && (params.replyEnabled || !params.silent)
  return {
    handled: true,
    registered: true,
    replyText: shouldReply ? formatScheduleReply(parsed) : null,
  }
}
