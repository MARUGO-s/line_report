import { normalizeInlineText } from './receipt_parse.ts'

const LINE_MESSAGING_URI_MAX_LEN = 1000
const LINE_MESSAGE_ACTION_TEXT_MAX_LEN = 300
const ANALYTICS_BASE = 'https://marugo-s.github.io/line_report/analytics.html'

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

export function buildReceiptAnalysisDeletionCommandTextForLineMessageId(
  lineMessageId: string | null | undefined,
): string {
  const normalized = String(lineMessageId ?? '').trim()
  if (!normalized) return 'レシート解析削除'
  return `レシート解析削除 ID:${normalized}`
}

export function clampLineMessageActionText(text: string): string {
  const t = String(text ?? '').trim()
  if (t.length <= LINE_MESSAGE_ACTION_TEXT_MAX_LEN) return t
  return t.slice(0, LINE_MESSAGE_ACTION_TEXT_MAX_LEN)
}

export function buildReceiptAnalyticsDashboardUri(
  storePartitionKey: string,
  targetMonth: string,
): string {
  const params = new URLSearchParams({
    store_key: storePartitionKey,
    month: targetMonth,
  })
  const token = String(Deno.env.get('ADMIN_DASHBOARD_TOKEN') ?? '').trim()
  if (token) params.set('t', token)
  const candidate = `${ANALYTICS_BASE}?${params.toString()}`
  if (candidate.length <= LINE_MESSAGING_URI_MAX_LEN) return candidate
  if (token) {
    const withoutToken = `${ANALYTICS_BASE}?${new URLSearchParams({
      store_key: storePartitionKey,
      month: targetMonth,
    }).toString()}`
    if (withoutToken.length <= LINE_MESSAGING_URI_MAX_LEN) return withoutToken
  }
  return `${ANALYTICS_BASE}?store_key=${encodeURIComponent(storePartitionKey)}`.slice(0, LINE_MESSAGING_URI_MAX_LEN)
}

export function parseReceiptCorrectionStartDirective(
  rawText: string,
): { matched: boolean; targetLineMessageId: string | null } {
  const normalized = normalizeForRuleParsing(rawText).trim()
  if (!normalized) return { matched: false, targetLineMessageId: null }
  const idTagged = normalized.match(/^レシート(?:修正|訂正)\s*(?:id[:：]|#)\s*([A-Za-z0-9_-]{8,128})$/iu)
  if (idTagged?.[1]) return { matched: true, targetLineMessageId: String(idTagged[1]).trim() }
  const idPlain = normalized.match(/^レシート(?:修正|訂正)\s+([A-Za-z0-9_-]{8,128})$/iu)
  if (idPlain?.[1]) return { matched: true, targetLineMessageId: String(idPlain[1]).trim() }
  const compact = normalized.replace(/\s+/g, '')
  if (compact === 'レシート修正' || compact === 'レシート訂正' || compact === '修正レシート') {
    return { matched: true, targetLineMessageId: null }
  }
  if (/^レシート(?:修正|訂正)(\s|$)/u.test(normalized)) {
    return { matched: true, targetLineMessageId: null }
  }
  return { matched: false, targetLineMessageId: null }
}

export function parseReceiptAnalysisDeleteDirective(
  rawText: string,
): { matched: boolean; targetLineMessageId: string | null } {
  const normalized = normalizeForRuleParsing(rawText).trim()
  if (!normalized) return { matched: false, targetLineMessageId: null }
  const idTagged = normalized.match(
    /^レシート(?:画像)?解析削除\s*(?:id[:：]|#)\s*([A-Za-z0-9_-]{8,128})$/iu,
  )
  if (idTagged?.[1]) return { matched: true, targetLineMessageId: String(idTagged[1]).trim() }
  const idTagged2 = normalized.match(/^レシート削除\s*(?:id[:：]|#)\s*([A-Za-z0-9_-]{8,128})$/iu)
  if (idTagged2?.[1]) return { matched: true, targetLineMessageId: String(idTagged2[1]).trim() }
  const idPlain = normalized.match(/^レシート(?:画像)?解析削除\s+([A-Za-z0-9_-]{8,128})$/iu)
  if (idPlain?.[1]) return { matched: true, targetLineMessageId: String(idPlain[1]).trim() }
  const idPlain2 = normalized.match(/^レシート削除\s+([A-Za-z0-9_-]{8,128})$/iu)
  if (idPlain2?.[1]) return { matched: true, targetLineMessageId: String(idPlain2[1]).trim() }
  const compact = normalized.replace(/\s+/g, '')
  if (compact === 'レシート解析削除' || compact === 'レシート削除') {
    return { matched: true, targetLineMessageId: null }
  }
  if (/^レシート(?:画像)?解析削除(\s|$)/u.test(normalized) || /^レシート削除(\s|$)/u.test(normalized)) {
    return { matched: true, targetLineMessageId: null }
  }
  return { matched: false, targetLineMessageId: null }
}
