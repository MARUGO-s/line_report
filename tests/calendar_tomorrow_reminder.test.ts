import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  addJstDays,
  buildMtalkSchedulePageUrl,
  buildTomorrowReminderChatText,
  CALENDAR_TOMORROW_REMINDER_DEFAULTS,
  eventTimeLabel,
  reminderClockMatches,
} from "../supabase/functions/_shared/calendar_tomorrow_reminder.ts"

const root = new URL("..", import.meta.url)
const read = (relative: string) => readFile(new URL(relative, root), "utf8")

test("tomorrow reminder clock defaults to 19:00 and matches that minute only", () => {
  assert.equal(CALENDAR_TOMORROW_REMINDER_DEFAULTS.hour, 19)
  assert.equal(CALENDAR_TOMORROW_REMINDER_DEFAULTS.minute, 0)
  assert.equal(reminderClockMatches(19, 0, null, null), true)
  assert.equal(reminderClockMatches(18, 0, null, null), false)
  assert.equal(reminderClockMatches(21, 30, 21, 30), true)
  assert.equal(reminderClockMatches(21, 31, 21, 30), false)
})

test("tomorrow reminder text lists the next day's events", () => {
  const target = { year: 2026, month: 8, day: 21 }
  const empty = buildTomorrowReminderChatText("マルゴセカンド", target, [])
  assert.match(empty, /明日の予定はありません/)
  const text = buildTomorrowReminderChatText("マルゴセカンド", target, [{
    id: 1,
    title: "仕込み",
    description: "野菜",
    startsAt: "2026-08-21T06:00:00.000Z",
    endsAt: "2026-08-21T07:00:00.000Z",
  }])
  assert.match(text, /明日の予定 1件/)
  assert.match(text, /仕込み/)
  assert.equal(eventTimeLabel("2026-08-21T06:00:00.000Z", "2026-08-21T07:00:00.000Z"), "15:00-16:00")
})

test("addJstDays rolls into the next month", () => {
  assert.deepEqual(addJstDays({ year: 2026, month: 8, day: 31 }, 1), { year: 2026, month: 9, day: 1 })
})

test("room settings can edit tomorrow reminder time like today-reservation alert", async () => {
  const html = await read("public/room_settings.html")
  const api = await read("supabase/functions/admin-api/index.ts")
  const cron = await read("supabase/functions/calendar-tomorrow-cron/index.ts")
  assert.match(html, /extra:'tomorrowReminder'/)
  assert.match(html, /reminder-slot-time/)
  assert.match(html, /calendar_tomorrow_reminder_hour/)
  assert.match(html, /calendar_tomorrow_reminder_minute/)
  assert.match(html, /calendar_reminder_slots/)
  assert.match(api, /calendar_tomorrow_reminder_hour,calendar_tomorrow_reminder_minute/)
  assert.match(api, /if \("calendar_tomorrow_reminder_hour" in body\)/)
  assert.match(api, /calendar_reminder_slots/)
  assert.match(cron, /from\("calendar_tomorrow_reminder_logs"\)/)
  assert.match(cron, /line_room_calendar_events/)
  assert.match(cron, /calendar_tomorrow/)
  assert.match(cron, /buildMtalkSchedulePageUrl\(chatGroupId, \{ tab: "events" \}\)/)
  const url = buildMtalkSchedulePageUrl(31, { tab: "events" })
  assert.match(String(url), /mtalk_schedule\.html\?/)
  assert.match(String(url), /group_id=31/)
  assert.match(String(url), /tab=events/)
  assert.doesNotMatch(String(url), /[?&]group=31(?:&|$)/)
})

test("schedule page accepts group and group_id, and chat keeps the room when opening the card", async () => {
  const html = await read("public/mtalk_schedule.html")
  const chat = await read("public/chat.html")
  assert.match(html, /params.get\('group_id'\) \|\| params.get\('group'\)/)
  assert.match(html, /params.get\('tab'\) === 'events'/)
  assert.match(chat, /openReservationSchedule\(id, url.searchParams.get\('tab'\)\)/)
  assert.match(chat, /path.endsWith\('mtalk_schedule.html'\)/)
})
