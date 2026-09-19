import test from "node:test"
import assert from "node:assert/strict"
import {
  explicitWeekWindow,
  nextWeekWindow,
  WEEK_WINDOW_DAYS,
} from "../supabase/functions/_shared/tokyo_dome_weekly_window.ts"

test("normal delivery covers the next Sunday plus 14 days", () => {
  // 土曜(dow=6)に走ると翌日の日曜起点、日曜(dow=0)に走ると翌週の日曜起点になる。
  const saturday = nextWeekWindow({ year: 2026, month: 9, day: 19, dow: 6 })
  assert.deepEqual([saturday.startStr, saturday.endStr], ["2026-09-20", "2026-10-03"])

  const sunday = nextWeekWindow({ year: 2026, month: 9, day: 20, dow: 0 })
  assert.deepEqual([sunday.startStr, sunday.endStr], ["2026-09-27", "2026-10-10"])

  const wednesday = nextWeekWindow({ year: 2026, month: 9, day: 23, dow: 3 })
  assert.deepEqual([wednesday.startStr, wednesday.endStr], ["2026-09-27", "2026-10-10"])
})

test("explicit week_start keeps the same 14-day length and crosses month and year ends", () => {
  assert.equal(WEEK_WINDOW_DAYS, 14)

  const sameWeek = explicitWeekWindow("2026-09-20")
  assert.deepEqual([sameWeek?.startStr, sameWeek?.endStr], ["2026-09-20", "2026-10-03"])

  const yearEnd = explicitWeekWindow("2026-12-27")
  assert.deepEqual([yearEnd?.startStr, yearEnd?.endStr], ["2026-12-27", "2027-01-09"])

  const leapDay = explicitWeekWindow("2028-02-27")
  assert.deepEqual([leapDay?.startStr, leapDay?.endStr], ["2028-02-27", "2028-03-11"])
})

test("explicit week_start rejects malformed and non-existent dates", () => {
  for (const bad of ["", "2026-9-20", "20260920", "2026-02-31", "2026-13-01", "yesterday", null, undefined]) {
    assert.equal(explicitWeekWindow(bad), null, `expected null for ${String(bad)}`)
  }
})

test("a resend for the current week matches what the scheduled run would have sent", () => {
  const scheduled = nextWeekWindow({ year: 2026, month: 9, day: 19, dow: 6 })
  const resend = explicitWeekWindow(scheduled.startStr)
  assert.deepEqual(
    [resend?.startStr, resend?.endStr],
    [scheduled.startStr, scheduled.endStr],
  )
})
