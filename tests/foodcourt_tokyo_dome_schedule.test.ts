import test from "node:test"
import assert from "node:assert/strict"
import {
  extractEventTimes,
  formatEventTimeLabel,
  normalizeEventTime,
  parseTokyoDomeSchedule,
} from "../supabase/functions/_shared/tokyo_dome_schedule.ts"

test("holiday weekday label starts a new Tokyo Dome calendar cell", () => {
  const events = parseTokyoDomeSchedule(`
2026年07月
19
(日)
野球
巨人ー中日
開場 12:00／開始 14:00
20
(月・祝)
野球
TOKYO DOME TOUR
野球
巨人ー広島
開場 16:00／開始 18:00
21
(火)
野球
巨人ー広島
`)

  assert.deepEqual(events, [
    { event_date: "2026-07-19", title: "巨人ー中日", category: "プロ野球", open_time: "12:00", start_time: "14:00" },
    { event_date: "2026-07-20", title: "巨人ー広島", category: "プロ野球", open_time: "16:00", start_time: "18:00" },
    { event_date: "2026-07-21", title: "巨人ー広島", category: "プロ野球", open_time: null, start_time: null },
  ])
})

test("holiday suffix variants are accepted without merging adjacent dates", () => {
  const events = parseTokyoDomeSchedule(`
2026年08月
10
(月)
イベント
前日のイベント
11
(火・祝)
野球
巨人ー阪神
12
(水・振休)
コンサート
振替休日ライブ
`)

  assert.deepEqual(events.map((event) => [event.event_date, event.title]), [
    ["2026-08-10", "前日のイベント"],
    ["2026-08-11", "巨人ー阪神"],
    ["2026-08-12", "振替休日ライブ"],
  ])
})

test("times are read per event even when the order or notation varies", () => {
  const events = parseTokyoDomeSchedule(`
2026年09月
5
(土)
コンサート
開場 １６：００／開演 １８：００
サンプルライブ
6
(日)
野球
巨人ー阪神
開門 11:00
13:00試合開始
7
(月)
イベント
時刻のないイベント
`)

  assert.deepEqual(events.map((event) => [event.title, event.open_time, event.start_time]), [
    ["サンプルライブ", "16:00", "18:00"],
    ["巨人ー阪神", "11:00", "13:00"],
    ["時刻のないイベント", null, null],
  ])
})

test("extractEventTimes ignores end times and durations", () => {
  assert.deepEqual(extractEventTimes("開場 12:00／開始 14:00"), { openTime: "12:00", startTime: "14:00" })
  assert.deepEqual(extractEventTimes("開演18時30分"), { openTime: null, startTime: "18:30" })
  assert.deepEqual(extractEventTimes("終演 21:00 試合時間 2:45"), { openTime: null, startTime: null })
  assert.deepEqual(extractEventTimes("チケット発売中"), { openTime: null, startTime: null })
})

test("normalizeEventTime rejects out-of-range values", () => {
  assert.equal(normalizeEventTime("9:05"), "09:05")
  assert.equal(normalizeEventTime("１８：００"), "18:00")
  assert.equal(normalizeEventTime("25:00"), null)
  assert.equal(normalizeEventTime("18:75"), null)
  assert.equal(normalizeEventTime(null), null)
})

test("formatEventTimeLabel prints only the known parts", () => {
  assert.equal(formatEventTimeLabel("16:00", "18:00"), "開場16:00 / 開始18:00")
  assert.equal(formatEventTimeLabel(null, "18:00"), "開始18:00")
  assert.equal(formatEventTimeLabel("16:00", null), "開場16:00")
  assert.equal(formatEventTimeLabel(null, null), "")
})
