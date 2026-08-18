// 動員数の実測/手入力と、会場収容からの参考推定を分ける。
// 数値集計・予測学習に使えるのは expected_attendance だけ。推定はラベル表示専用。

export type FoodCourtAttendanceEvent = {
  expected_attendance?: number | null
  venue?: string
  category?: string
}

export type ResolvedFoodCourtAttendance = {
  mid: number
  low: number
  high: number
  estimated: boolean
}

export const FOODCOURT_VENUE_CAPACITY: Record<string, number> = {
  kanadevia: 3000,
  korakuen: 2000,
  imm: 700,
  'imm-theater': 700,
  imm_theater: 700,
}

export const TOKYO_DOME_LIVE_CAPACITY = 45000

export function actualEventAttendance(e: FoodCourtAttendanceEvent): number | null {
  const n = e.expected_attendance
  if (n != null && Number.isFinite(n) && n >= 0) return Math.round(n)
  return null
}

export function capacityBaseAttendance(venue?: string, category?: string): number | null {
  const v = String(venue ?? '').trim()
  if (v in FOODCOURT_VENUE_CAPACITY) return FOODCOURT_VENUE_CAPACITY[v]
  if (v === 'tokyo-dome' && category === 'ライブ') return TOKYO_DOME_LIVE_CAPACITY
  return null
}

export function resolveEventAttendance(e: FoodCourtAttendanceEvent): ResolvedFoodCourtAttendance | null {
  const actual = actualEventAttendance(e)
  if (actual != null) return { mid: actual, low: actual, high: actual, estimated: false }
  const cap = capacityBaseAttendance(e.venue, e.category)
  if (cap == null) return null
  return { mid: Math.round(cap), low: Math.round(cap * 2 / 3), high: Math.round(cap * 4 / 3), estimated: true }
}

export function maxActualEventAttendance(events: FoodCourtAttendanceEvent[]): number | null {
  let max: number | null = null
  for (const e of events) {
    const n = actualEventAttendance(e)
    if (n == null) continue
    if (max == null || n > max) max = n
  }
  return max
}
