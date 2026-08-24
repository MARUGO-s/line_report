import { normalizeInlineText } from './receipt_parse.ts'

const LINE_MESSAGING_URI_MAX_LEN = 1000
const LINE_MESSAGE_ACTION_TEXT_MAX_LEN = 300
const ANALYTICS_BASE = 'https://marugo-s.github.io/line_report/analytics.html'
const FOODCOURT_REPORT_BASE = 'https://marugo-s.github.io/line_report/foodcourt-report.html'
/**
 * 売上ページ(analytics.html)のデプロイ版数。URL に ?v= で付与してブラウザ／LINEアプリ内
 * ブラウザのキャッシュを無効化する。analytics.html の UI を更新したらこの値を更新する。
 */
const ANALYTICS_APP_VERSION = '20260530'

function normalizeForRuleParsing(raw: string): string {
  return normalizeInlineText(String(raw ?? '').normalize('NFKC'))
}

export function buildReceiptCorrectionCommandTextForLineMessageId(
  lineMessageId: string | null | undefined,
): string {
  const normalized = String(lineMessageId ?? '').trim()
  if (!normalized) return 'レシート修正'
  return `レシート修正 ID:${normalized}`
}

export function buildReceiptCorrectionCommandTextForReceiptRowId(
  receiptRowId: number | null | undefined,
): string {
  const id = typeof receiptRowId === 'number' ? receiptRowId : Number(receiptRowId)
  if (!Number.isFinite(id) || id <= 0) return 'レシート修正'
  return `レシート修正 RID:${Math.round(id)}`
}

export function buildReceiptAnalysisDeletionCommandTextForLineMessageId(
  lineMessageId: string | null | undefined,
): string {
  const normalized = String(lineMessageId ?? '').trim()
  if (!normalized) return 'レシート解析削除'
  return `レシート解析削除 ID:${normalized}`
}

export function buildReceiptAnalysisDeletionCommandTextForReceiptRowId(
  receiptRowId: number | null | undefined,
): string {
  const id = typeof receiptRowId === 'number' ? receiptRowId : Number(receiptRowId)
  if (!Number.isFinite(id) || id <= 0) return 'レシート解析削除'
  return `レシート解析削除 RID:${Math.round(id)}`
}

export function clampLineMessageActionText(text: string): string {
  const t = String(text ?? '').trim()
  if (t.length <= LINE_MESSAGE_ACTION_TEXT_MAX_LEN) return t
  return t.slice(0, LINE_MESSAGE_ACTION_TEXT_MAX_LEN)
}

export function buildReceiptAnalyticsDashboardUri(
  storePartitionKey: string,
  targetMonth: string,
  options?: { loginToken?: string | null },
): string {
  const params = new URLSearchParams({
    store_key: storePartitionKey,
    month: targetMonth,
    from: 'line',
    v: ANALYTICS_APP_VERSION,
  })
  const loginToken = String(options?.loginToken ?? '').trim()
  if (loginToken) params.set('lt', loginToken)
  const candidate = `${ANALYTICS_BASE}?${params.toString()}`
  if (candidate.length <= LINE_MESSAGING_URI_MAX_LEN) return candidate
  if (loginToken) {
    const withoutToken = `${ANALYTICS_BASE}?${new URLSearchParams({
      store_key: storePartitionKey,
      month: targetMonth,
      from: 'line',
      v: ANALYTICS_APP_VERSION,
    }).toString()}`
    if (withoutToken.length <= LINE_MESSAGING_URI_MAX_LEN) return withoutToken
  }
  return `${ANALYTICS_BASE}?store_key=${encodeURIComponent(storePartitionKey)}&v=${ANALYTICS_APP_VERSION}`.slice(0, LINE_MESSAGING_URI_MAX_LEN)
}

export function buildFoodcourtReportUri(
  options?: { loginToken?: string | null },
): string {
  const params = new URLSearchParams({ from: 'line' })
  const loginToken = String(options?.loginToken ?? '').trim()
  if (loginToken) params.set('lt', loginToken)
  const candidate = `${FOODCOURT_REPORT_BASE}?${params.toString()}`
  if (candidate.length <= LINE_MESSAGING_URI_MAX_LEN) return candidate
  return FOODCOURT_REPORT_BASE.slice(0, LINE_MESSAGING_URI_MAX_LEN)
}

export type ReceiptCorrectionStartDirective = {
  matched: boolean
  targetLineMessageId: string | null
  targetReceiptRowId: number | null
}

export function parseReceiptCorrectionStartDirective(
  rawText: string,
): ReceiptCorrectionStartDirective {
  const normalized = normalizeForRuleParsing(rawText).trim()
  if (!normalized) return { matched: false, targetLineMessageId: null, targetReceiptRowId: null }
  const ridTagged = normalized.match(/^レシート(?:修正|訂正)\s*(?:rid[:：]|#)\s*(\d{1,12})$/iu)
  if (ridTagged?.[1]) {
    const rowId = Number(ridTagged[1])
    if (Number.isFinite(rowId) && rowId > 0) {
      return { matched: true, targetLineMessageId: null, targetReceiptRowId: Math.round(rowId) }
    }
  }
  const mtalkTagged = normalized.match(/^レシート(?:修正|訂正)\s*(?:id[:：]|#)\s*(mtalk-\d{1,12}(?:-\d{1,12})?)$/iu)
  if (mtalkTagged?.[1]) {
    return { matched: true, targetLineMessageId: String(mtalkTagged[1]).trim(), targetReceiptRowId: null }
  }
  const idTagged = normalized.match(/^レシート(?:修正|訂正)\s*(?:id[:：]|#)\s*([A-Za-z0-9_-]{6,128})$/iu)
  if (idTagged?.[1]) {
    return { matched: true, targetLineMessageId: String(idTagged[1]).trim(), targetReceiptRowId: null }
  }
  const idPlain = normalized.match(/^レシート(?:修正|訂正)\s+([A-Za-z0-9_-]{6,128})$/iu)
  if (idPlain?.[1]) {
    return { matched: true, targetLineMessageId: String(idPlain[1]).trim(), targetReceiptRowId: null }
  }
  const compact = normalized.replace(/\s+/g, '')
  if (compact === 'レシート修正' || compact === 'レシート訂正' || compact === '修正レシート') {
    return { matched: true, targetLineMessageId: null, targetReceiptRowId: null }
  }
  if (/^レシート(?:修正|訂正)(\s|$)/u.test(normalized)) {
    return { matched: true, targetLineMessageId: null, targetReceiptRowId: null }
  }
  return { matched: false, targetLineMessageId: null, targetReceiptRowId: null }
}

export function parseReceiptAnalysisDeleteDirective(
  rawText: string,
): { matched: boolean; targetLineMessageId: string | null; targetReceiptRowId: number | null } {
  const normalized = normalizeForRuleParsing(rawText).trim()
  if (!normalized) return { matched: false, targetLineMessageId: null, targetReceiptRowId: null }
  const ridTagged = normalized.match(/^レシート(?:画像)?解析削除\s*(?:rid[:：]|#)\s*(\d{1,12})$/iu)
  if (ridTagged?.[1]) {
    const rowId = Number(ridTagged[1])
    if (Number.isFinite(rowId) && rowId > 0) {
      return { matched: true, targetLineMessageId: null, targetReceiptRowId: Math.round(rowId) }
    }
  }
  const mtalkTagged = normalized.match(
    /^レシート(?:画像)?解析削除\s*(?:id[:：]|#)\s*(mtalk-\d{1,12}(?:-\d{1,12})?)$/iu,
  )
  if (mtalkTagged?.[1]) {
    return { matched: true, targetLineMessageId: String(mtalkTagged[1]).trim(), targetReceiptRowId: null }
  }
  const idTagged = normalized.match(
    /^レシート(?:画像)?解析削除\s*(?:id[:：]|#)\s*([A-Za-z0-9_-]{6,128})$/iu,
  )
  if (idTagged?.[1]) {
    return { matched: true, targetLineMessageId: String(idTagged[1]).trim(), targetReceiptRowId: null }
  }
  const idTagged2 = normalized.match(/^レシート削除\s*(?:id[:：]|#)\s*([A-Za-z0-9_-]{8,128})$/iu)
  if (idTagged2?.[1]) {
    return { matched: true, targetLineMessageId: String(idTagged2[1]).trim(), targetReceiptRowId: null }
  }
  const idPlain = normalized.match(/^レシート(?:画像)?解析削除\s+([A-Za-z0-9_-]{8,128})$/iu)
  if (idPlain?.[1]) {
    return { matched: true, targetLineMessageId: String(idPlain[1]).trim(), targetReceiptRowId: null }
  }
  const idPlain2 = normalized.match(/^レシート削除\s+([A-Za-z0-9_-]{8,128})$/iu)
  if (idPlain2?.[1]) {
    return { matched: true, targetLineMessageId: String(idPlain2[1]).trim(), targetReceiptRowId: null }
  }
  const compact = normalized.replace(/\s+/g, '')
  if (compact === 'レシート解析削除' || compact === 'レシート削除') {
    return { matched: true, targetLineMessageId: null, targetReceiptRowId: null }
  }
  if (/^レシート(?:画像)?解析削除(\s|$)/u.test(normalized) || /^レシート削除(\s|$)/u.test(normalized)) {
    return { matched: true, targetLineMessageId: null, targetReceiptRowId: null }
  }
  return { matched: false, targetLineMessageId: null, targetReceiptRowId: null }
}
