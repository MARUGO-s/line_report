export type ReservationAiFactItem = {
  source?: string | null
  visit_at?: string | null
  customer_name?: string | null
  party_size?: number | null
  party_size_label?: string | null
  allergy_label?: string | null
  guest_type?: "new" | "repeat" | "unknown" | string | null
  is_cancelled?: boolean | null
  [key: string]: unknown
}

export type ReservationAiTotals = {
  reservation_count: number
  cancelled_count: number
  new_count: number
  repeat_count: number
  unknown_count: number
  by_channel: { tabelog: number; ikyu: number; manual: number }
  allergy_noted_count: number
  guest_total: number
  guest_unknown_count: number
}

export type ReservationAiFactsPayload = {
  totals?: Partial<ReservationAiTotals> | null
  by_month?: ReservationAiMonthFact[] | null
  items?: ReservationAiFactItem[] | null
  truncated?: boolean
  notes?: string[] | null
  [key: string]: unknown
}

export type ReservationAiMonthFact = ReservationAiTotals & {
  year_month: string
}

export function emptyReservationAiTotals(): ReservationAiTotals {
  return {
    reservation_count: 0,
    cancelled_count: 0,
    new_count: 0,
    repeat_count: 0,
    unknown_count: 0,
    by_channel: { tabelog: 0, ikyu: 0, manual: 0 },
    allergy_noted_count: 0,
    guest_total: 0,
    guest_unknown_count: 0,
  }
}

function nonNegativeInt(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function aggregateReservationAiItems(items: ReservationAiFactItem[]): ReservationAiTotals {
  const totals = emptyReservationAiTotals()
  for (const item of Array.isArray(items) ? items : []) {
    const source = String(item?.source ?? "")
    if (item?.is_cancelled === true) {
      totals.cancelled_count += 1
      continue
    }

    totals.reservation_count += 1
    if (source === "tabelog" || source === "ikyu" || source === "manual") {
      totals.by_channel[source] += 1
    }
    if (item?.guest_type === "new") totals.new_count += 1
    else if (item?.guest_type === "repeat") totals.repeat_count += 1
    else totals.unknown_count += 1
    if (String(item?.allergy_label ?? "").trim()) totals.allergy_noted_count += 1

    const partySize = Number(item?.party_size)
    if (Number.isFinite(partySize) && partySize > 0) {
      totals.guest_total += Math.floor(partySize)
    } else {
      totals.guest_unknown_count += 1
    }
  }
  return totals
}

export function aggregateReservationAiItemsByMonth(
  items: ReservationAiFactItem[],
): ReservationAiMonthFact[] {
  const grouped = new Map<string, ReservationAiFactItem[]>()
  for (const item of Array.isArray(items) ? items : []) {
    const dateKey = reservationJstDateKey(item?.visit_at)
    const month = dateKey?.slice(0, 7) ?? ""
    if (!/^\d{4}-\d{2}$/.test(month)) continue
    const list = grouped.get(month) ?? []
    list.push(item)
    grouped.set(month, list)
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year_month, rows]) => ({ year_month, ...aggregateReservationAiItems(rows) }))
}

export function mergeReservationAiFactsPayloads(
  payloads: ReservationAiFactsPayload[],
  itemLimit: number,
): {
  totals: ReservationAiTotals
  by_month: ReservationAiMonthFact[]
  items: ReservationAiFactItem[]
  truncated: boolean
  notes: string[]
} {
  const totals = emptyReservationAiTotals()
  const monthPayloads = new Map<string, ReservationAiTotals>()
  const allItems: ReservationAiFactItem[] = []
  const notes = new Set<string>()
  let truncated = false

  for (const payload of Array.isArray(payloads) ? payloads : []) {
    const t = payload?.totals ?? {}
    totals.reservation_count += nonNegativeInt(t.reservation_count)
    totals.cancelled_count += nonNegativeInt(t.cancelled_count)
    totals.new_count += nonNegativeInt(t.new_count)
    totals.repeat_count += nonNegativeInt(t.repeat_count)
    totals.unknown_count += nonNegativeInt(t.unknown_count)
    totals.allergy_noted_count += nonNegativeInt(t.allergy_noted_count)
    totals.guest_total += nonNegativeInt(t.guest_total)
    totals.guest_unknown_count += nonNegativeInt(t.guest_unknown_count)
    const channels = (t.by_channel ?? {}) as Partial<ReservationAiTotals["by_channel"]>
    totals.by_channel.tabelog += nonNegativeInt(channels.tabelog)
    totals.by_channel.ikyu += nonNegativeInt(channels.ikyu)
    totals.by_channel.manual += nonNegativeInt(channels.manual)
    for (const month of Array.isArray(payload?.by_month) ? payload.by_month : []) {
      const yearMonth = String(month?.year_month ?? "")
      if (!/^\d{4}-\d{2}$/.test(yearMonth)) continue
      const prev = monthPayloads.get(yearMonth) ?? emptyReservationAiTotals()
      const monthChannels = (month?.by_channel ?? {}) as Partial<ReservationAiTotals["by_channel"]>
      prev.reservation_count += nonNegativeInt(month?.reservation_count)
      prev.cancelled_count += nonNegativeInt(month?.cancelled_count)
      prev.new_count += nonNegativeInt(month?.new_count)
      prev.repeat_count += nonNegativeInt(month?.repeat_count)
      prev.unknown_count += nonNegativeInt(month?.unknown_count)
      prev.allergy_noted_count += nonNegativeInt(month?.allergy_noted_count)
      prev.guest_total += nonNegativeInt(month?.guest_total)
      prev.guest_unknown_count += nonNegativeInt(month?.guest_unknown_count)
      prev.by_channel.tabelog += nonNegativeInt(monthChannels.tabelog)
      prev.by_channel.ikyu += nonNegativeInt(monthChannels.ikyu)
      prev.by_channel.manual += nonNegativeInt(monthChannels.manual)
      monthPayloads.set(yearMonth, prev)
    }
    if (Array.isArray(payload?.items)) allItems.push(...payload.items)
    if (payload?.truncated === true) truncated = true
    for (const note of Array.isArray(payload?.notes) ? payload.notes : []) {
      const text = String(note ?? "").trim()
      if (text) notes.add(text)
    }
  }

  allItems.sort((a, b) => String(a?.visit_at ?? "").localeCompare(String(b?.visit_at ?? "")))
  const safeLimit = Math.max(1, Math.floor(Number(itemLimit) || 1))
  if (allItems.length > safeLimit) truncated = true
  return {
    totals,
    by_month: [...monthPayloads.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([year_month, monthTotals]) => ({ year_month, ...monthTotals })),
    items: allItems.slice(0, safeLimit),
    truncated,
    notes: [...notes],
  }
}

/** UTC ISOをJST暦日へ変換する。予約キャッシュの1日単位キーに使用する。 */
export function reservationJstDateKey(value: unknown): string | null {
  const date = new Date(String(value ?? ""))
  if (Number.isNaN(date.getTime())) return null
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000)
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`
}

export function enumerateReservationDateKeys(fromDate: string, toDateExclusive: string): string[] {
  const from = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fromDate ?? ""))
  const to = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(toDateExclusive ?? ""))
  if (!from || !to) return []
  let cursor = Date.UTC(Number(from[1]), Number(from[2]) - 1, Number(from[3]))
  const end = Date.UTC(Number(to[1]), Number(to[2]) - 1, Number(to[3]))
  if (!Number.isFinite(cursor) || !Number.isFinite(end) || cursor >= end) return []
  const out: string[] = []
  while (cursor < end && out.length < 4000) {
    const date = new Date(cursor)
    out.push(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`)
    cursor += 24 * 60 * 60 * 1000
  }
  return out
}

export function buildReservationDailyRagText(
  storeKey: string,
  factDate: string,
  totals: ReservationAiTotals,
  items: ReservationAiFactItem[],
): string {
  const lines = [
    `予約確定事実（日次）`,
    `店舗キー: ${String(storeKey ?? "").trim().toLowerCase()}`,
    `予約日: ${factDate}`,
    `予約組数: ${totals.reservation_count}`,
    `予約人数: ${totals.guest_total}`,
    `キャンセル組数: ${totals.cancelled_count}`,
    `新規: ${totals.new_count}`,
    `リピート: ${totals.repeat_count}`,
    `回数不明: ${totals.unknown_count}`,
    `チャネル: 食べログ ${totals.by_channel.tabelog} / 一休 ${totals.by_channel.ikyu} / 手入力 ${totals.by_channel.manual}`,
  ]
  for (const item of Array.isArray(items) ? items : []) {
    const parts = [
      String(item?.visit_at ?? "").replace("T", " ").slice(0, 16),
      String(item?.customer_name ?? "氏名不明"),
      String(item?.party_size_label ?? "人数不明"),
      String(item?.source ?? "経路不明"),
      item?.is_cancelled === true ? "キャンセル" : String(item?.guest_type ?? "回数不明"),
    ].filter(Boolean)
    lines.push(`- ${parts.join(" / ")}`)
  }
  return lines.join("\n")
}
