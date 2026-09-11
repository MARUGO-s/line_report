const RESERVATION_CALENDAR_BASE = "https://marugo-s.github.io/line_report/chat.html"

function normalizeMonth(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim()
  return /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(raw) ? raw : null
}

export function buildReservationCalendarPageUrl(
  storePartitionKey: string,
  options?: {
    targetMonth?: string | null
  },
): string {
  const storeKey = String(storePartitionKey ?? "").trim()
  const params = new URLSearchParams({
    calendar: "reservations",
  })
  // Navigation hint only: M-talk requires its own login and store viewing permission.
  if (/^[a-z][a-z0-9_-]{0,63}$/i.test(storeKey)) params.set("store_key", storeKey)
  const targetMonth = normalizeMonth(options?.targetMonth)
  if (targetMonth) params.set("month", targetMonth)
  return `${RESERVATION_CALENDAR_BASE}?${params.toString()}`
}
