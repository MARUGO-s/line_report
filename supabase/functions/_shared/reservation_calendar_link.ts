const LINE_MESSAGING_URI_MAX_LEN = 1000
const RESERVATION_CALENDAR_BASE = "https://marugo-s.github.io/line_report/reservation.html"
const RESERVATION_CALENDAR_APP_VERSION = "20260702"

function normalizeMonth(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim()
  return /^\d{4}-\d{2}$/.test(raw) ? raw : null
}

export function buildReservationCalendarPageUrl(
  storePartitionKey: string,
  options?: {
    loginToken?: string | null
    targetMonth?: string | null
  },
): string {
  const storeKey = String(storePartitionKey ?? "").trim()
  const params = new URLSearchParams({
    v: RESERVATION_CALENDAR_APP_VERSION,
    from: "line",
    line_page: "reservation",
  })
  if (storeKey) params.set("store_key", storeKey)
  const targetMonth = normalizeMonth(options?.targetMonth)
  if (targetMonth) params.set("month", targetMonth)
  const loginToken = String(options?.loginToken ?? "").trim()
  if (loginToken) params.set("lt", loginToken)
  const candidate = `${RESERVATION_CALENDAR_BASE}?${params.toString()}`
  if (candidate.length <= LINE_MESSAGING_URI_MAX_LEN) return candidate

  if (loginToken) {
    params.delete("lt")
    const withoutToken = `${RESERVATION_CALENDAR_BASE}?${params.toString()}`
    if (withoutToken.length <= LINE_MESSAGING_URI_MAX_LEN) return withoutToken
  }
  return `${RESERVATION_CALENDAR_BASE}?${new URLSearchParams({
    v: RESERVATION_CALENDAR_APP_VERSION,
    line_page: "reservation",
    ...(storeKey ? { store_key: storeKey } : {}),
  }).toString()}`.slice(0, LINE_MESSAGING_URI_MAX_LEN)
}
