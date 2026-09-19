// ドームシティ週次配信の対象期間（2週間＝14日）を決める共通ロジック。
// 通常配信は「翌週の日曜から14日間」を自動計算し、再送(test_send)だけ
// week_start で任意の開始日を指定できる。日付計算はJSTの暦日で行う。

export type WeekWindowDay = { year: number; month: number; day: number; dow: number }
export type WeekWindow = { start: WeekWindowDay; end: WeekWindowDay; startStr: string; endStr: string }

export const WEEK_WINDOW_DAYS = 14

function pad2(value: number): string { return String(value).padStart(2, "0") }

function ymd(d: WeekWindowDay): string {
  return `${String(d.year).padStart(4, "0")}-${pad2(d.month)}-${pad2(d.day)}`
}

export function addDaysUtc(year: number, month: number, day: number, n: number): WeekWindowDay {
  const dt = new Date(Date.UTC(year, month - 1, day + n))
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate(), dow: dt.getUTCDay() }
}

function windowFrom(start: WeekWindowDay): WeekWindow {
  const end = addDaysUtc(start.year, start.month, start.day, WEEK_WINDOW_DAYS - 1)
  return { start, end, startStr: ymd(start), endStr: ymd(end) }
}

// 通常配信: 翌週の日曜から14日間（日〜翌々週の土）。
export function nextWeekWindow(jst: { year: number; month: number; day: number; dow: number }): WeekWindow {
  const daysToNextSunday = jst.dow === 0 ? 7 : (7 - jst.dow)
  return windowFrom(addDaysUtc(jst.year, jst.month, jst.day, daysToNextSunday))
}

// 再送用: 開始日を明示して14日間。不正な日付・存在しない日付(2026-02-31等)は null。
export function explicitWeekWindow(value: unknown): WeekWindow | null {
  const raw = String(value ?? "").trim()
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3])
  const start = addDaysUtc(year, month, day, 0)
  // 正規化後にズレる＝存在しない日付（2026-02-31 → 3/3 など）。
  if (start.year !== year || start.month !== month || start.day !== day) return null
  return windowFrom(start)
}
