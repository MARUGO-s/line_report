export type AppError = {
  status: number
  message: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function toSafeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function toNonNegativeInteger(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.floor(parsed)
}

export function roundToScale(value: number, scale = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** Math.max(0, Math.floor(scale))
  return Math.round(value * factor) / factor
}

export function normalizeCalendarMonthParam(value: string | null): string {
  const src = String(value ?? '').trim()
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(src)) return src
  const loose = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(src)
  if (loose) {
    const y = Number(loose[1])
    const moRaw = Number(loose[2])
    if (Number.isFinite(y) && y >= 1900 && y <= 2100 && Number.isFinite(moRaw)) {
      const mo = Math.min(12, Math.max(1, Math.floor(moRaw)))
      return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}`
    }
  }
  const now = new Date()
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
  })
  const parts = formatter.formatToParts(now)
  const year = parts.find((part) => part.type === 'year')?.value ?? String(now.getUTCFullYear())
  const month = parts.find((part) => part.type === 'month')?.value ?? '01'
  return `${year}-${month}`
}

export function buildJstMonthRange(month: string): { startIso: string; endIso: string } {
  const matched = month.match(/^(\d{4})-(\d{2})$/)
  if (!matched) {
    const fallbackStart = new Date()
    const fallbackEnd = new Date(fallbackStart.getTime() + 31 * 24 * 60 * 60 * 1000)
    return {
      startIso: fallbackStart.toISOString(),
      endIso: fallbackEnd.toISOString(),
    }
  }
  const year = Number(matched[1])
  const monthNumber = Number(matched[2])
  const startUtc = Date.UTC(year, monthNumber - 1, 1, -9, 0, 0)
  const endUtc = Date.UTC(year, monthNumber, 1, -9, 0, 0)
  return {
    startIso: new Date(startUtc).toISOString(),
    endIso: new Date(endUtc).toISOString(),
  }
}

export function buildJstDateKeysForMonth(month: string): string[] {
  const matched = month.match(/^(\d{4})-(\d{2})$/)
  if (!matched) return []
  const year = Number(matched[1])
  const monthNum = Number(matched[2])
  if (!Number.isInteger(year) || !Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) return []
  const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate()
  const keys: string[] = []
  for (let day = 1; day <= lastDay; day += 1) {
    keys.push(`${String(year).padStart(4, '0')}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }
  return keys
}

export function resolveReceiptEntryDateKeyForMonth(
  receiptDateValue: unknown,
  month: string,
): string | null {
  const receiptDate = toSafeString(receiptDateValue)
  if (/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(receiptDate) && receiptDate.startsWith(`${month}-`)) {
    return receiptDate
  }
  return null
}

export function normalizeBudgetStoreKey(raw: string): string {
  const s = String(raw ?? '').trim()
  return s || '__all__'
}

export function resolveStorePartitionKey(
  rawKey: string,
  registryKeys: string[],
): string {
  const key = String(rawKey ?? '').trim()
  if (!key) return ''
  if (registryKeys.includes(key)) return key
  const lower = key.toLowerCase()
  const match = registryKeys.find((k) => k.toLowerCase() === lower)
  return match ?? key
}

export function parseCompareYearQueryParam(raw: string | null, displayMonth: string): number {
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed >= 1900 && parsed <= 2100) {
    return Math.floor(parsed)
  }
  const parts = displayMonth.split('-')
  const y = Number(parts[0])
  if (Number.isFinite(y)) return y - 1
  return new Date().getUTCFullYear() - 1
}

export function comparisonSalesMonth(displayMonth: string, compareYear: number): string {
  const mm = displayMonth.slice(5, 7)
  return `${compareYear}-${mm}`
}

export function normalizePath(pathname: string): string {
  const stripped = pathname
    .replace(/^\/functions\/v1\/admin-api/, '')
    .replace(/^\/admin-api/, '')
  return stripped || '/'
}

export function secureEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  if (aBytes.length !== bBytes.length) return false
  let result = 0
  for (let i = 0; i < aBytes.length; i += 1) {
    result |= aBytes[i] ^ bBytes[i]
  }
  return result === 0
}

export async function parseJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw { status: 400, message: 'Invalid JSON body.' } satisfies AppError
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-token',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    },
  })
}
