/**
 * mtalk-external-post の純粋ロジック（認証・入力検証・カード組み立て）。
 *
 * 外部アプリ（gourmet / Review Command Center の AI分析）が、M-talk の利用者へ
 * AI分析レポートをカード＋PDFで届けるための入口。ブラウザからは呼ばない（CORSなし）。
 *
 * 認証（すべての要求で必須、どれか1つでも欠けたら 401）:
 *   Authorization: Bearer <GOURMET_MTALK_TOKEN>   … 定数時間比較
 *   X-Mtalk-Timestamp: <UNIX秒>                   … 現在時刻±5分以内
 *   X-Mtalk-Signature: v1=<hex>                  … HMAC-SHA256(GOURMET_MTALK_TOKEN,
 *                                                   "v1:<timestamp>:<METHOD>:<path>:<raw body>")
 * 冪等性（dedupe_key）は認可の代用にしない。
 */

import { constantTimeEqualSecret } from './internal_cron_auth.ts'

export const AI_ANALYSIS_BOT_ID = '00000000-0000-4000-8000-00000000b073'
export const AI_ANALYSIS_BOT_USERNAME = 'AI分析'
export const AI_REPORT_CARD_KIND = 'ai_report_share'
export const AI_REPORT_FILE_KIND = 'ai_report_share_file'

export const EXTERNAL_POST_LIMITS = {
  clockSkewSeconds: 300,
  /** PDF本体（デコード後）。chat-images バケットの上限 25MB より小さくする。 */
  pdfMaxBytes: 8 * 1024 * 1024,
  /** JSON本体（base64のPDFを含む）。 */
  bodyMaxBytes: 12 * 1024 * 1024,
  titleMax: 120,
  subtitleMax: 120,
  senderMax: 80,
  fieldsMax: 10,
  fieldLabelMax: 24,
  fieldValueMax: 200,
  listItemsMax: 5,
  listItemMax: 200,
  noteMax: 300,
  fileNameMax: 120,
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEDUPE = /^[A-Za-z0-9:_.-]{8,120}$/

export class ExternalPostError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

export function signingMessage(timestamp: string, method: string, path: string, body: string): string {
  return `v1:${timestamp}:${method.toUpperCase()}:${path}:${body}`
}

export async function signExternalRequest(
  secret: string,
  parts: { timestamp: string; method: string; path: string; body: string },
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingMessage(parts.timestamp, parts.method, parts.path, parts.body)),
  )
  return `v1=${toHex(sig)}`
}

/** 認証の結果だけ返す。どの要素が違ったかは応答・ログに出さない。 */
export async function verifyExternalRequest(
  input: { authorization: string | null; timestamp: string | null; signature: string | null; method: string; path: string; body: string },
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const expected = String(secret ?? '').trim()
  if (expected.length < 32) return false // 未設定・弱い値では常に拒否（fail closed）
  const match = String(input.authorization ?? '').trim().match(/^Bearer\s+(.+)$/i)
  const provided = String(match?.[1] ?? '').trim()
  const tokenOk = constantTimeEqualSecret(provided, expected)
  const ts = String(input.timestamp ?? '').trim()
  if (!/^\d{9,12}$/.test(ts)) return false
  const skew = Math.abs(nowMs / 1000 - Number(ts))
  if (!(skew <= EXTERNAL_POST_LIMITS.clockSkewSeconds)) return false
  const want = await signExternalRequest(expected, { timestamp: ts, method: input.method, path: input.path, body: input.body })
  const sigOk = constantTimeEqualSecret(String(input.signature ?? '').trim().toLowerCase(), want)
  return tokenOk && sigOk
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g
export function cleanText(value: unknown, max: number, { multiline = false } = {}): string {
  let s = typeof value === 'string' ? value : value == null ? '' : String(value)
  s = s.normalize('NFC').replace(CONTROL, '')
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ')
  s = s.trim()
  return [...s].length > max ? `${[...s].slice(0, max - 1).join('')}…` : s
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/** chat_set_message_author と同じ文字だけ残す（利用者のアップロードと同じ見え方にする）。 */
export function sanitizePdfFileName(value: unknown): string {
  let base = String(value ?? '').normalize('NFKC').replace(/\.pdf$/i, '')
  base = base.replace(/[^A-Za-z0-9._() -]/g, '_').replace(/_+/g, '_').replace(/^[_. -]+|[_. -]+$/g, '')
  base = base.slice(0, EXTERNAL_POST_LIMITS.fileNameMax - 4)
  return `${base || 'ai-report'}.pdf`
}

export function decodePdfBase64(value: unknown, maxBytes: number = EXTERNAL_POST_LIMITS.pdfMaxBytes): Uint8Array<ArrayBuffer> {
  const b64 = String(value ?? '').replace(/\s+/g, '')
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new ExternalPostError('PDFの形式が不正です')
  if (Math.floor((b64.length * 3) / 4) > maxBytes + 3) throw new ExternalPostError('PDFが大きすぎます', 413)
  let bin: string
  try {
    bin = atob(b64)
  } catch {
    throw new ExternalPostError('PDFの形式が不正です')
  }
  if (bin.length > maxBytes) throw new ExternalPostError('PDFが大きすぎます', 413)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  if (bytes.length < 64 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') {
    throw new ExternalPostError('PDFの形式が不正です')
  }
  return bytes
}

export type SendInput = {
  recipientUserId: string
  reportId: string
  senderLabel: string
  title: string
  dedupeKey: string
  card: {
    subtitle: string
    fields: { label: string; value: string }[]
    highlights: string[]
    recommendations: string[]
    note: string
  }
  pdf: Uint8Array<ArrayBuffer>
  fileName: string
}

export function validateSendInput(raw: unknown): SendInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ExternalPostError('送信内容が不正です')
  const v = raw as Record<string, unknown>
  const L = EXTERNAL_POST_LIMITS
  if (!isUuid(v.recipient_user_id)) throw new ExternalPostError('送信先が不正です')
  if (!isUuid(v.report_id)) throw new ExternalPostError('レポートIDが不正です')
  const dedupeKey = String(v.dedupe_key ?? '')
  if (!DEDUPE.test(dedupeKey)) throw new ExternalPostError('dedupe_key が不正です')
  const senderLabel = cleanText(v.sender_label, L.senderMax)
  if (!senderLabel) throw new ExternalPostError('送信者名が必要です')
  const title = cleanText(v.title, L.titleMax)
  if (!title) throw new ExternalPostError('タイトルが必要です')
  const card = (v.card && typeof v.card === 'object' && !Array.isArray(v.card)) ? v.card as Record<string, unknown> : {}
  const list = (x: unknown, max: number) => (Array.isArray(x) ? x : []).slice(0, max)
  const fields = list(card.fields, L.fieldsMax)
    .map((f) => {
      const r = (f && typeof f === 'object') ? f as Record<string, unknown> : {}
      return { label: cleanText(r.label, L.fieldLabelMax), value: cleanText(r.value, L.fieldValueMax) }
    })
    .filter((f) => f.label && f.value)
  const items = (x: unknown) => list(x, L.listItemsMax).map((s) => cleanText(s, L.listItemMax)).filter(Boolean)
  return {
    recipientUserId: String(v.recipient_user_id).toLowerCase(),
    reportId: String(v.report_id).toLowerCase(),
    senderLabel,
    title,
    dedupeKey,
    card: {
      subtitle: cleanText(card.subtitle, L.subtitleMax),
      fields,
      highlights: items(card.highlights),
      recommendations: items(card.recommendations),
      note: cleanText(card.note, L.noteMax, { multiline: true }),
    },
    pdf: decodePdfBase64(v.pdf_base64),
    fileName: sanitizePdfFileName(v.filename),
  }
}

type CardSection =
  | { type: 'fields'; rows: { label: string; value: string; paragraphs?: string[]; weight?: 'bold' | null }[] }
  | { type: 'note'; text: string; size?: 'xs' | 'sm' | null }
  | { type: 'separator' }
  | { type: 'heading'; text: string }

export function buildAiReportCard(input: Pick<SendInput, 'title' | 'senderLabel' | 'card' | 'fileName'>): {
  text: string
  cards: { header: { eyebrow: string; title: string; subtitle: string | null }; sections: CardSection[]; actions: [] }[]
} {
  const sections: CardSection[] = [
    { type: 'fields', rows: [{ label: '送信者', value: input.senderLabel, weight: 'bold' }, ...input.card.fields] },
  ]
  if (input.card.highlights.length) {
    sections.push({ type: 'separator' })
    sections.push({ type: 'fields', rows: [{ label: '要点', value: '', paragraphs: input.card.highlights.map((s) => `・${s}`) }] })
  }
  if (input.card.recommendations.length) {
    sections.push({ type: 'separator' })
    sections.push({ type: 'fields', rows: [{ label: '施策', value: '', paragraphs: input.card.recommendations.map((s, i) => `${i + 1}. ${s}`) }] })
  }
  sections.push({ type: 'separator' }, {
    type: 'note',
    size: 'xs',
    text: input.card.note || `レポート全文はこのあとのPDF（${input.fileName}）をご覧ください。`,
  })
  const text = cleanText(
    [
      `[AI分析レポート] ${input.title}`,
      `送信者: ${input.senderLabel}`,
      ...input.card.fields.map((f) => `${f.label}: ${f.value}`),
      ...input.card.highlights.map((s) => `・${s}`),
    ].join('\n'),
    2000,
    { multiline: true },
  )
  return {
    text,
    cards: [{
      header: { eyebrow: 'AI分析レポート', title: input.title, subtitle: input.card.subtitle || null },
      sections,
      actions: [],
    }],
  }
}

export type RecipientRow = { id: string; username: string; stores: string[] }

/** 有効（利用可・未削除・制限なし）な人間の利用者だけを、名前順で返す。 */
export function activeRecipients(
  users: { id: string; username: string | null; is_bot: boolean | null }[],
  access: { user_id: string; access_enabled: boolean | null; deleted_at: string | null; restricted_until: string | null }[],
  userStores: { user_id: string; store_key: string }[],
  catalog: { store_key: string; display_name: string | null }[],
  nowMs = Date.now(),
): RecipientRow[] {
  const active = new Set(
    access
      .filter((a) => a.access_enabled === true && !a.deleted_at && (!a.restricted_until || Date.parse(a.restricted_until) <= nowMs))
      .map((a) => a.user_id),
  )
  const names = new Map(catalog.map((c) => [c.store_key, c.display_name || c.store_key]))
  const storesOf = new Map<string, string[]>()
  for (const s of userStores) {
    const list = storesOf.get(s.user_id) ?? []
    list.push(names.get(s.store_key) ?? s.store_key)
    storesOf.set(s.user_id, list)
  }
  return users
    .filter((u) => u.is_bot !== true && active.has(u.id) && String(u.username ?? '').trim())
    .map((u) => ({ id: u.id, username: String(u.username).trim(), stores: [...new Set(storesOf.get(u.id) ?? [])].sort() }))
    .sort((a, b) => a.username.localeCompare(b.username, 'ja'))
}
