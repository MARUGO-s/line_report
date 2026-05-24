import type { LineImageReceiptAnalysis } from './receipt_types.ts'
import { RECEIPT_BUDGET_BUSINESS_DAY_START_HOUR_JST } from './receipt_types.ts'
import { extractJapanesePhoneFromText } from './store_receipt_phones.ts'

export function normalizeInlineText(raw: string): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim()
}

function decodeEscapedUnicodeSequences(raw: string): string {
  return String(raw ?? '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
}

export function normalizeReceiptFieldText(raw: unknown, maxLen: number): string | null {
  const normalized = normalizeInlineText(decodeEscapedUnicodeSequences(String(raw ?? '')))
    .replace(/\u00a5/g, '¥')
    .replace(/\u00a7/g, '¥')
  if (!normalized) return null
  return normalized.length > maxLen ? normalized.slice(0, maxLen) : normalized
}

export function parseCurrencyAmount(raw: string | null): number | null {
  if (!raw) return null
  const normalized = decodeEscapedUnicodeSequences(raw)
    .replace(/,/g, '')
    .replace(/[¥￥円]/g, '')
    .replace(/[^\d.-]/g, '')
    .trim()
  if (!normalized) return null
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

export function parseIntegerCount(raw: string | null): number | null {
  if (!raw) return null
  const match = decodeEscapedUnicodeSequences(raw).match(/-?\d+/)
  if (!match?.[0]) return null
  const value = Number(match[0])
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.round(value))
}

export function formatYenAmount(value: number): string {
  return `¥${Math.round(value).toLocaleString('ja-JP')}`
}

function extractPartyGuestCountsFromText(raw: string | null): { party: number | null; guest: number | null } {
  if (!raw) return { party: null, guest: null }
  const text = decodeEscapedUnicodeSequences(raw)
  const partyMatch = text.match(/(\d{1,3})\s*組/)
  const guestMatch = text.match(/(\d{1,4})\s*(?:名|人)/)
  const party = partyMatch?.[1] ? parseIntegerCount(partyMatch[1]) : null
  const guest = guestMatch?.[1] ? parseIntegerCount(guestMatch[1]) : null
  if (party != null || guest != null) return { party, guest }
  const numbers = text.match(/\d{1,4}/g) ?? []
  if (numbers.length >= 2) {
    return {
      party: parseIntegerCount(numbers[0] ?? null),
      guest: parseIntegerCount(numbers[1] ?? null),
    }
  }
  return { party: null, guest: null }
}

function salvageOverreadTaxAmount(rawTax: string | null, grossAmount: number): number | null {
  if (!rawTax || !Number.isFinite(grossAmount) || grossAmount <= 0) return null
  const digits = decodeEscapedUnicodeSequences(rawTax).replace(/[^\d]/g, '')
  if (!digits) return null
  const candidates: number[] = []
  if (digits.length >= 4) candidates.push(Number(digits.slice(-4)))
  if (digits.length >= 3) candidates.push(Number(digits.slice(-3)))
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate) || candidate <= 0) continue
    if (candidate <= grossAmount * 0.2) return Math.round(candidate)
  }
  return null
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function parseModelReceiptConfidence(raw: unknown): number | null {
  if (raw == null) return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'))
  if (!Number.isFinite(n)) return null
  if (n > 1 && n <= 100) return clamp01(n / 100)
  return clamp01(n)
}

export function computeReceiptHeuristicConfidence(receipt: LineImageReceiptAnalysis): number {
  let s = 0
  const gross = parseCurrencyAmount(receipt.grossSales)
  const tax = parseCurrencyAmount(receipt.taxAmount)
  const net = parseCurrencyAmount(receipt.netSales)
  const dateIso = parseReceiptDateToIso(receipt.date)
  const partyN = parseIntegerCount(receipt.partyCount)
  const guestN = parseIntegerCount(receipt.guestCount)
  if (receipt.storeName?.trim()) s += 0.2
  if (dateIso) s += 0.22
  if (gross != null && gross > 0) s += 0.26
  if (tax != null && tax >= 0 && gross != null && gross > 0 && tax <= gross * 0.22) s += 0.16
  if (net != null && net >= 0 && gross != null && gross > 0) {
    const taxOrZero = tax != null && tax >= 0 ? tax : 0
    if (Math.abs(net + taxOrZero - gross) <= Math.max(3, gross * 0.02)) s += 0.1
  }
  if (guestN != null && guestN > 0 && gross != null && gross > 0) s += 0.1
  if (partyN != null && partyN >= 0 && guestN != null && guestN > 0) s += 0.06
  return clamp01(s)
}

export function mergeReceiptConfidence(heuristic: number, model: number | null): number {
  if (model == null || !Number.isFinite(model)) return clamp01(heuristic)
  return clamp01(0.45 * heuristic + 0.55 * model)
}

function toIsoDateStringSafe(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const check = new Date(`${iso}T12:00:00Z`)
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return null
  }
  return iso
}

export function parseReceiptDateToIso(raw: string | null): string | null {
  if (!raw) return null
  const normalized = decodeEscapedUnicodeSequences(raw).trim()
  if (!normalized) return null

  const jaNoMonth = normalized.match(/^(\d{4})年([0-9]{3,4})日?$/)
  if (jaNoMonth) {
    const year = Number(jaNoMonth[1])
    const digits = jaNoMonth[2]
    if (digits.length === 4) {
      const iso = toIsoDateStringSafe(year, Number(digits.slice(0, 2)), Number(digits.slice(2, 4)))
      if (iso) return iso
    }
    if (digits.length === 3) {
      const mo2 = Number(digits.slice(0, 2))
      const d1 = Number(digits[2])
      const mo1 = Number(digits[0])
      const d2 = Number(digits.slice(1))
      if (mo2 >= 10 && mo2 <= 12) {
        const iso21 = toIsoDateStringSafe(year, mo2, d1)
        if (iso21) return iso21
      }
      const iso12 = toIsoDateStringSafe(year, mo1, d2)
      if (iso12) return iso12
    }
  }

  const m = normalized.match(/(\d{4})\D{0,6}(\d{1,2})\D{0,6}(\d{1,2})/)
  if (!m) return null
  return toIsoDateStringSafe(Number(m[1]), Number(m[2]), Number(m[3]))
}

export function getJstBusinessDateForReceiptBudget(
  now: Date = new Date(),
  startHourJst = RECEIPT_BUDGET_BUSINESS_DAY_START_HOUR_JST,
): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(now)
  const y = Number(parts.find((p) => p.type === 'year')?.value)
  const mo = Number(parts.find((p) => p.type === 'month')?.value)
  const d = Number(parts.find((p) => p.type === 'day')?.value)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
  }
  let iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  if (Number.isFinite(h) && h < startHourJst) {
    const t = Date.UTC(y, mo - 1, d)
    const prev = new Date(t - 86400000)
    iso = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`
  }
  return iso
}

export function resolveReceiptDateIsoForPersist(raw: string | null): string {
  return parseReceiptDateToIso(raw) ?? getJstBusinessDateForReceiptBudget(new Date())
}

function formatJapaneseReceiptDateFromIso(iso: string | null): string | null {
  if (!iso) return null
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`
}

export function normalizeLineImageReceiptAnalysis(
  raw: unknown,
  extraTextForPhone?: string | null,
): LineImageReceiptAnalysis | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>

  let storeName = normalizeReceiptFieldText(data.store_name ?? data.store ?? data.shop_name, 80)
  let storePhone = normalizeReceiptFieldText(
    data.store_phone ?? data.phone ?? data.tel ?? data.telephone,
    40,
  )
  let date = normalizeReceiptFieldText(data.date ?? data.issued_at ?? data.issued_date, 80)
  let netSales = normalizeReceiptFieldText(data.net_sales ?? data.subtotal ?? data.net_amount, 40)
  let taxAmount = normalizeReceiptFieldText(data.tax_amount ?? data.consumption_tax ?? data.tax, 40)
  let grossSales = normalizeReceiptFieldText(data.gross_sales ?? data.total_amount ?? data.total_sales, 40)
  let partyCount = normalizeReceiptFieldText(
    data.party_count ?? data.group_count ?? data.account_groups ?? data.account_count ?? data.bill_count,
    20,
  )
  let guestCount = normalizeReceiptFieldText(
    data.guest_count ?? data.customer_count ?? data.guests ?? data.people_count,
    20,
  )
  let unitPrice = normalizeReceiptFieldText(
    data.unit_price ?? data.avg_spend_per_guest ?? data.average_spend ?? data.tanka,
    40,
  )

  const combinedCounts = extractPartyGuestCountsFromText(
    normalizeReceiptFieldText(data.party_guest ?? data.party_guest_count ?? data.group_guest, 80),
  )
  if (!partyCount && combinedCounts.party != null) partyCount = String(combinedCounts.party)
  if (!guestCount && combinedCounts.guest != null) guestCount = String(combinedCounts.guest)

  const grossNum = parseCurrencyAmount(grossSales)
  let taxNum = parseCurrencyAmount(taxAmount)
  const netNum = parseCurrencyAmount(netSales)
  if (grossNum != null && taxNum != null && taxNum > grossNum) {
    taxNum = salvageOverreadTaxAmount(taxAmount, grossNum)
  }
  let normalizedGrossNum = grossNum
  let normalizedNetNum = netNum
  let normalizedTaxNum = taxNum
  if (normalizedGrossNum == null && normalizedNetNum != null && normalizedTaxNum != null) {
    normalizedGrossNum = normalizedNetNum + normalizedTaxNum
  }
  if (normalizedGrossNum != null) grossSales = formatYenAmount(normalizedGrossNum)
  if (normalizedTaxNum != null) taxAmount = formatYenAmount(normalizedTaxNum)
  if (normalizedNetNum != null) netSales = formatYenAmount(normalizedNetNum)

  const guestNum = parseIntegerCount(guestCount)
  const grossForUnitPrice = parseCurrencyAmount(grossSales) ?? normalizedGrossNum
  const unitNum = parseCurrencyAmount(unitPrice)
  if (unitNum != null) {
    unitPrice = formatYenAmount(unitNum)
  } else if (grossForUnitPrice != null && guestNum != null && guestNum > 0) {
    unitPrice = formatYenAmount(grossForUnitPrice / guestNum)
  }

  const items = (Array.isArray(data.items) ? data.items : [])
    .map((value) => normalizeReceiptFieldText(value, 80) ?? '')
    .filter((value) => value.length > 0)
    .slice(0, 5)

  const dateIso = parseReceiptDateToIso(date)
  if (dateIso) date = formatJapaneseReceiptDateFromIso(dateIso)

  if (!storePhone) {
    storePhone = extractJapanesePhoneFromText(
      storeName,
      extraTextForPhone,
      JSON.stringify(data),
    )
  } else {
    const fromFields = extractJapanesePhoneFromText(storePhone, storeName, extraTextForPhone)
    if (fromFields) storePhone = fromFields
  }

  const hasAnyField = !!(
    storeName ||
    storePhone ||
    date ||
    netSales ||
    taxAmount ||
    grossSales ||
    partyCount ||
    guestCount ||
    unitPrice ||
    items.length
  )
  if (!hasAnyField) return null

  return { storeName, storePhone, date, netSales, taxAmount, grossSales, partyCount, guestCount, unitPrice, items }
}

export function parseFirstJsonObject(raw: string): unknown | null {
  const trimmed = raw.replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

export function normalizeLineImageAnalysisResult(raw: Record<string, unknown>): import('./receipt_types.ts').LineImageAnalysisResult | null {
  const summary = normalizeInlineText(String(raw.summary ?? '')).slice(0, 240)
  const kind = String(raw.kind ?? '').trim().toLowerCase()
  const receipt = normalizeLineImageReceiptAnalysis(raw.receipt, summary)
  const receiptModelConfidence = parseModelReceiptConfidence(
    raw.receipt_confidence ?? raw.receiptConfidence ?? raw.confidence,
  )

  if (!summary) {
    if (!receipt) return null
    const syntheticSummary = [
      receipt.storeName ? `店舗:${receipt.storeName}` : '',
      receipt.grossSales ? `総売上:${receipt.grossSales}` : '',
    ].filter(Boolean).join(' / ')
    if (!syntheticSummary) return null
    return {
      summary: syntheticSummary.slice(0, 240),
      receipt: kind === 'general' ? null : receipt,
      receiptModelConfidence,
    }
  }

  if (kind === 'general') return { summary, receipt: null, receiptModelConfidence }
  return { summary, receipt, receiptModelConfidence }
}

export function buildReceiptSummaryText(receipt: LineImageReceiptAnalysis, storeDisplayName: string): string {
  const parts = [
    storeDisplayName ? `店舗:${storeDisplayName}` : '',
    receipt.date ? `日付:${receipt.date}` : '',
    receipt.grossSales ? `総売上:${receipt.grossSales}` : '',
    receipt.partyCount ? `組数:${receipt.partyCount}` : '',
    receipt.guestCount ? `客数:${receipt.guestCount}` : '',
  ].filter(Boolean)
  return parts.join(' / ').slice(0, 240)
}

export function buildReceiptTextReply(
  receipt: LineImageReceiptAnalysis,
  storeDisplayName: string,
  monthTotals: import('./receipt_types.ts').MonthCumulativeTotals,
): string {
  const lines = [
    '【レシート登録】',
    `店舗: ${storeDisplayName}`,
    receipt.date ? `日付: ${receipt.date}` : null,
    receipt.grossSales ? `総売上: ${receipt.grossSales}` : null,
    receipt.taxAmount ? `消費税: ${receipt.taxAmount}` : null,
    receipt.partyCount ? `会計組数: ${receipt.partyCount}組` : null,
    receipt.guestCount ? `客数: ${receipt.guestCount}名` : null,
    receipt.unitPrice ? `客単価: ${receipt.unitPrice}` : null,
    '---',
    monthTotals.grossSalesYen != null
      ? `当月累計総売上: ${formatYenAmount(monthTotals.grossSalesYen)}`
      : null,
    monthTotals.partyCount != null ? `当月累計組数: ${monthTotals.partyCount}組` : null,
    monthTotals.guestCount != null ? `当月累計客数: ${monthTotals.guestCount}名` : null,
  ].filter(Boolean)
  return lines.join('\n').slice(0, 4900)
}
