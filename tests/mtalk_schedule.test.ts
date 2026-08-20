import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const root = new URL("..", import.meta.url)
const read = (relative: string) => readFile(new URL(relative, root), "utf8")

test("M-talk schedule page switches reservation and event tabs", async () => {
  const [html, chat, api] = await Promise.all([
    read("public/mtalk_schedule.html"),
    read("public/chat.html"),
    read("supabase/functions/admin-api/index.ts"),
  ])

  assert.match(html, /data-tab="reservations"/)
  assert.match(html, /data-tab="events"/)
  assert.match(html, />予約</)
  assert.match(html, />予定</)
  assert.match(html, /cal-grid/)
  assert.match(html, /function renderCalendar/)
  assert.match(html, /dot resv/)
  assert.match(html, /dot evt/)
  assert.match(html, /function selectDay/)
  assert.match(html, /function scrollToSelectedDay/)
  assert.match(html, /window\.scrollTo/)
  assert.match(html, /\/chat-schedule\?group_id=/)
  assert.match(html, /Authorization: 'Bearer '/)
  assert.match(html, /\?group='/)
  assert.match(chat, /function openReservationSchedule/)
  assert.match(chat, /mtalk_schedule\.html/)
  assert.match(chat, /onclick="openReservationSchedule\(\)"/)
  assert.match(api, /path === "\/chat-schedule"/)
  assert.match(api, /async function handleChatSchedule/)
  assert.match(api, /authenticateChatMember\(req, supabase, groupId\)/)
  assert.match(api, /resolveMtalkRoomStoreKey/)
  assert.match(api, /fetchReservationCalendarState/)
  assert.match(api, /line_room_calendar_events/)
  assert.match(api, /slimChatScheduleReservation/)
  const roomConfigAt = api.indexOf('path === "/chat-room-config"')
  const scheduleAt = api.indexOf('path === "/chat-schedule"')
  const adminAuthAt = api.lastIndexOf("const authResult = await authenticate(")
  assert.ok(roomConfigAt > 0 && scheduleAt > roomConfigAt)
  assert.ok(adminAuthAt > scheduleAt)
})
