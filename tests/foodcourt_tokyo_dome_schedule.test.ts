import test from "node:test"
import assert from "node:assert/strict"
import { parseTokyoDomeSchedule } from "../supabase/functions/_shared/tokyo_dome_schedule.ts"

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
    { event_date: "2026-07-19", title: "巨人ー中日", category: "プロ野球" },
    { event_date: "2026-07-20", title: "巨人ー広島", category: "プロ野球" },
    { event_date: "2026-07-21", title: "巨人ー広島", category: "プロ野球" },
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
