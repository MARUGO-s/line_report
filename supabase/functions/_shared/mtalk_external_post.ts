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

// ---------- 口コミ通知（gourmet agent-api → POST /alert、GET /store-bots） ----------
// gourmet が取り込み時に検出した「新着口コミ」「食べログ総合点の変化」を、店舗ごとに1通（カードを重ねる）で届ける。
// 送り先は その店舗の店舗Bot（bot_id）として Bot が参加しているグループのルーム（1対1・ゴミ箱・管理者通知は除く。
// room_ids で絞れる）。旧形式の recipient_user_id（「AI分析」Botとの1対1）も互換のため受け付ける。
// カードはここで組み立てる（gourmet から来るのは項目だけ）。リンクは許可したホストだけ。
export const REVIEW_ALERT_KIND = 'gourmet_review_alert'
export const REVIEW_ALERT_LIMITS = {
  storeNameMax: 100,
  siteMax: 30,
  scoreChangesMax: 10,
  reviewsMax: 10,
  titleMax: 100,
  textMax: 1000,
  noteMax: 100,
  urlMax: 500,
  moreMax: 100_000,
  roomsMax: 20,
} as const
const ALERT_URL_HOSTS = new Set(['tabelog.com', 'owner.tabelog.com', 'restaurant.ikyu.com', 'marugo-s.github.io'])
const SCORE = /^[0-5](\.[0-9]{1,2})?$/
const DIFF = /^[+-]?[0-5]\.[0-9]{2}$/
const DAY_OR_MONTH = /^\d{4}-\d{2}(-\d{2})?$/

/** https で許可したホストのURLだけ（それ以外は null＝リンクを出さない）。 */
export function alertUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw || raw.length > REVIEW_ALERT_LIMITS.urlMax) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !ALERT_URL_HOSTS.has(url.hostname)) return null
    return url.href
  } catch {
    return null
  }
}
const pick = (value: unknown, pattern: RegExp) => {
  const s = String(value ?? '').trim()
  return pattern.test(s) ? s : null
}
const count = (value: unknown) => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null)

export type AlertScoreChange = { site: string; from: string; to: string; diff: string | null; date: string | null; reviewCountFrom: number | null; reviewCountTo: number | null; url: string | null }
export type AlertReview = { site: string; rating: string | null; postedDate: string | null; visit: string | null; title: string; text: string; textNote: string; url: string | null; urlLabel: string }
export type AlertTarget = { kind: 'bot'; botId: string; roomIds: number[] | null } | { kind: 'user'; recipientUserId: string }
export type AlertInput = { target: AlertTarget; dedupeKey: string; storeName: string; scoreChanges: AlertScoreChange[]; reviews: AlertReview[]; moreCount: number; appUrl: string | null }

export function validateAlertInput(raw: unknown): AlertInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ExternalPostError('送信内容が不正です')
  const v = raw as Record<string, unknown>
  const L = REVIEW_ALERT_LIMITS
  let target: AlertTarget
  if (v.bot_id != null) {
    if (!isUuid(v.bot_id) || v.recipient_user_id != null) throw new ExternalPostError('店舗Botが不正です')
    let roomIds: number[] | null = null
    if (v.room_ids != null) {
      if (!Array.isArray(v.room_ids) || !v.room_ids.length || v.room_ids.length > L.roomsMax || v.room_ids.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0)) {
        throw new ExternalPostError(`room_ids は1〜${L.roomsMax}件のルームIDで指定してください`)
      }
      roomIds = [...new Set(v.room_ids as number[])]
    }
    target = { kind: 'bot', botId: String(v.bot_id).toLowerCase(), roomIds }
  } else {
    if (!isUuid(v.recipient_user_id)) throw new ExternalPostError('送信先が不正です')
    target = { kind: 'user', recipientUserId: String(v.recipient_user_id).toLowerCase() }
  }
  const dedupeKey = String(v.dedupe_key ?? '')
  if (!DEDUPE.test(dedupeKey)) throw new ExternalPostError('dedupe_key が不正です')
  const storeName = cleanText(v.store_name, L.storeNameMax)
  if (!storeName) throw new ExternalPostError('店舗名が必要です')
  const rows = (x: unknown, max: number, what: string) => {
    if (x == null) return []
    if (!Array.isArray(x) || x.length > max) throw new ExternalPostError(`${what}は${max}件までです`)
    return x.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : {}))
  }
  const scoreChanges = rows(v.score_changes, L.scoreChangesMax, '総合点の変化').map((r) => {
    const from = pick(r.from, SCORE), to = pick(r.to, SCORE)
    if (!from || !to) throw new ExternalPostError('総合点が不正です')
    return {
      site: cleanText(r.site, L.siteMax) || '食べログ', from, to, diff: pick(r.diff, DIFF), date: pick(r.date, DAY_OR_MONTH),
      reviewCountFrom: count(r.review_count_from), reviewCountTo: count(r.review_count_to), url: alertUrl(r.url),
    }
  })
  const reviews = rows(v.reviews, L.reviewsMax, '口コミ').map((r) => ({
    site: cleanText(r.site, L.siteMax) || '口コミサイト',
    rating: pick(r.rating, SCORE),
    postedDate: pick(r.posted_date, DAY_OR_MONTH),
    visit: pick(r.visit, DAY_OR_MONTH),
    title: cleanText(r.title, L.titleMax),
    text: cleanText(r.text, L.textMax, { multiline: true }),
    textNote: cleanText(r.text_note, L.noteMax),
    url: alertUrl(r.url),
    urlLabel: cleanText(r.url_label, 20) || '口コミを見る',
  }))
  const moreCount = v.more_count == null ? 0 : count(v.more_count)
  if (moreCount == null || moreCount > L.moreMax) throw new ExternalPostError('more_count が不正です')
  if (!scoreChanges.length && !reviews.length) throw new ExternalPostError('通知する内容がありません')
  return { target, dedupeKey, storeName, scoreChanges, reviews, moreCount, appUrl: alertUrl(v.app_url) }
}

export type BotRoomRow = { id: number; group_name: string | null; is_direct: boolean | null; trashed_at: string | null; is_admin_notice_room?: boolean | null; is_store_room?: boolean | null }

/** 店舗Botが投稿してよいルーム: 参加しているグループ（1対1・ゴミ箱・管理者通知は除く）。requested があればその中だけ（ID順）。 */
export function alertRooms(rooms: BotRoomRow[], requested: number[] | null = null): { id: number; name: string; isStoreRoom: boolean }[] {
  const wanted = requested ? new Set(requested) : null
  return rooms
    .filter((r) => Number.isSafeInteger(Number(r.id)) && r.is_direct !== true && !r.trashed_at && r.is_admin_notice_room !== true)
    .filter((r) => !wanted || wanted.has(Number(r.id)))
    .map((r) => ({ id: Number(r.id), name: cleanText(r.group_name, 100) || `ルーム${r.id}`, isStoreRoom: r.is_store_room === true }))
    .sort((a, b) => a.id - b.id)
}

/** GET /store-bots: 削除されていない店舗Bot（store_key あり）と、投稿できるルーム（名前・人数）。名前順。 */
export function storeBotList(
  bots: { id: string; username: string | null; store_key: string | null; is_bot: boolean | null; bot_deleted_at: string | null }[],
  memberships: { user_id: string; group_id: number }[],
  groups: BotRoomRow[],
  memberCounts: Map<number, number>,
): { id: string; username: string; store_key: string; rooms: { id: number; name: string; is_store_room: boolean; members: number | null }[] }[] {
  const byId = new Map(groups.map((g) => [Number(g.id), g]))
  return bots
    .filter((b) => b.is_bot === true && !b.bot_deleted_at && String(b.store_key ?? '').trim() && String(b.username ?? '').trim())
    .map((b) => ({
      id: b.id,
      username: String(b.username).trim(),
      store_key: String(b.store_key).trim(),
      rooms: alertRooms(memberships.filter((m) => m.user_id === b.id).map((m) => byId.get(Number(m.group_id))).filter((g): g is BotRoomRow => !!g))
        .map((r) => ({ id: r.id, name: r.name, is_store_room: r.isStoreRoom, members: memberCounts.get(r.id) ?? null })),
    }))
    .sort((a, b) => a.username.localeCompare(b.username, 'ja'))
}

type AlertCard = {
  header: { eyebrow: string; title: string; subtitle: string | null }
  sections: CardSection[]
  actions: { label: string; url: string; style: 'primary' | 'secondary' }[]
}

/** 口コミ通知のカード（総合点の変化 → 口コミ（新しい順）→「ほか N件」）とプレビュー用の文。 */
export function buildReviewAlertCards(input: Omit<AlertInput, 'target' | 'dedupeKey'>): { text: string; cards: AlertCard[] } {
  const cards: AlertCard[] = []
  for (const s of input.scoreChanges) {
    const change = `${s.from} → ${s.to}${s.diff ? `（${s.diff}）` : ''}`
    const rows: { label: string; value: string; weight?: 'bold' | null }[] = [{ label: '総合点', value: change, weight: 'bold' }]
    if (s.reviewCountFrom != null && s.reviewCountTo != null) rows.push({ label: '口コミ数', value: s.reviewCountFrom === s.reviewCountTo ? `${s.reviewCountTo}件` : `${s.reviewCountFrom} → ${s.reviewCountTo}件` })
    if (s.date) rows.push({ label: '確認日', value: s.date })
    cards.push({
      header: { eyebrow: `${s.site} 総合点が変わりました`, title: input.storeName, subtitle: change },
      sections: [{ type: 'fields', rows }],
      actions: s.url ? [{ label: `${s.site}で見る`, url: s.url, style: 'secondary' }] : [],
    })
  }
  for (const r of input.reviews) {
    const rows: { label: string; value: string; paragraphs?: string[]; weight?: 'bold' | null }[] = []
    if (r.rating) rows.push({ label: '評価', value: `★${r.rating}`, weight: 'bold' })
    if (r.postedDate) rows.push({ label: '投稿日', value: r.postedDate })
    if (r.visit) rows.push({ label: '来店', value: r.visit })
    const sections: CardSection[] = [{ type: 'fields', rows }]
    if (r.text) sections.push({ type: 'separator' }, { type: 'fields', rows: [{ label: '本文', value: '', paragraphs: r.text.split('\n').filter(Boolean) }] })
    if (r.textNote) sections.push({ type: 'note', size: 'xs', text: r.textNote })
    cards.push({
      header: { eyebrow: `${r.site} 新着口コミ`, title: input.storeName, subtitle: r.title || null },
      sections,
      actions: r.url ? [{ label: r.urlLabel, url: r.url, style: 'secondary' }] : [],
    })
  }
  if (input.moreCount > 0) {
    cards.push({
      header: { eyebrow: '新着口コミ', title: `ほか ${input.moreCount}件`, subtitle: input.storeName },
      sections: [{ type: 'note', size: 'xs', text: '残りの口コミはアプリのダッシュボードで確認できます。' }],
      actions: input.appUrl ? [{ label: 'アプリで見る', url: input.appUrl, style: 'primary' }] : [],
    })
  }
  const total = input.reviews.length + input.moreCount
  const lines = [`[口コミ通知] ${input.storeName}`]
  for (const s of input.scoreChanges) lines.push(`${s.site} 総合点 ${s.from} → ${s.to}`)
  if (total) {
    lines.push(`新着口コミ ${total}件`)
    const first = input.reviews[0]
    if (first) lines.push(`${first.site}${first.rating ? ` ★${first.rating}` : ''} ${first.title || first.text}`.trim())
  }
  return { text: cleanText(lines.join('\n'), 500, { multiline: true }), cards }
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

// ---------- 「AI分析」Bot への質問（M-talk → gourmet ai-analyst POST /mtalk-chat） ----------
// 利用者が「AI分析」Botとの1対1に書いた文章を、DBトリガー（pg_net、chat_push_internal_config.dispatch_secret）が
// mtalk-external-post /chat-dispatch へ渡す。ここで対象かを確かめ、直近の会話を付けて gourmet へ署名つきで問い合わせ、
// 回答を Bot の発言として投稿する。署名は gourmet → M-talk と同じ規則・同じ GOURMET_MTALK_TOKEN（逆方向）。

export const AI_CHAT_REPLY_KIND = 'ai_chat_reply'
export const AI_CHAT_PATH = '/mtalk-chat'
export const DEFAULT_GOURMET_AI_ANALYST_URL = 'https://ycsqfajidusuibqljjwr.supabase.co/functions/v1/ai-analyst'
export const AI_CHAT_LIMITS = {
  historyMessages: 10,
  historyCharsEach: 1500,
  questionMax: 2000,
  replyMax: 2000,
  replyParts: 3,
  // gourmet への問い合わせを打ち切るまで。Edge Function の実行時間の上限（150秒）と
  // 2分の見張り（chat_ai_analysis_reply_timeouts）より前に、関数自身が案内を出せるようにする。
  timeoutMs: 100_000,
  // この時間を過ぎても答えが出ていない質問には、見張り（pg_cron）が案内を出す。
  replyDeadlineSeconds: 120,
} as const

/** 失敗・時間切れのときに Bot が送る案内（画面の「・・・」が時間切れになったときの表示と同じ文）。 */
export const AI_CHAT_GENERIC_ERROR = 'すみません、返事に時間がかかっています。エラーが起きた可能性があるので、もう一度送ってください。'

/** chat_alert_dispatches.status（kind = ai_chat_reply のときだけ使う）。pending から一度だけ変わる。 */
export const AI_CHAT_STATUS = {
  pending: 'pending',
  answered: 'answered',
  failed: 'failed',
  timedOut: 'timed_out',
} as const

export type AiChatMessageRow = {
  id: number
  group_id: number
  user_id: string | null
  content: string | null
  kind: string | null
  payload?: unknown
}

/** gourmet の AI分析 の URL（https の …/functions/v1/ai-analyst だけ受け付ける。秘密情報ではない）。 */
export function gourmetAiAnalystUrl(value: string | null | undefined): string {
  const url = String(value ?? '').trim().replace(/\/+$/, '') || DEFAULT_GOURMET_AI_ANALYST_URL
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' && /\/functions\/v1\/ai-analyst$/.test(u.pathname)) return url
  } catch { /* 既定へ */ }
  return DEFAULT_GOURMET_AI_ANALYST_URL
}

/** 返信の対象か（Bot自身・他のBot・文章以外・空・1対1でない・利用停止中は対象外）。理由はログ用の短い語だけ。 */
export function aiChatEligibility(
  input: {
    message: AiChatMessageRow | null
    group: { id: number; is_direct: boolean | null; direct_key: string | null; trashed_at: string | null } | null
    sender: { id: string; is_bot: boolean | null } | null
    access: { access_enabled: boolean | null; deleted_at: string | null; restricted_until: string | null } | null
    botIsMember: boolean
  },
  nowMs = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const { message, group, sender, access } = input
  if (!message || !group) return { ok: false, reason: 'missing' }
  if (String(message.user_id ?? '') === AI_ANALYSIS_BOT_ID) return { ok: false, reason: 'self' }
  if (String(message.kind ?? 'text') !== 'text') return { ok: false, reason: 'kind' }
  if (!String(message.content ?? '').trim()) return { ok: false, reason: 'empty' }
  if (group.is_direct !== true || group.trashed_at) return { ok: false, reason: 'room' }
  const key = String(group.direct_key ?? '').split(':')
  if (key.length !== 2 || !key.includes(AI_ANALYSIS_BOT_ID) || !key.includes(String(message.user_id))) return { ok: false, reason: 'room' }
  if (!input.botIsMember) return { ok: false, reason: 'room' }
  if (!sender || sender.is_bot === true) return { ok: false, reason: 'sender' }
  if (!access || access.access_enabled !== true || access.deleted_at || (access.restricted_until && Date.parse(access.restricted_until) > nowMs)) {
    return { ok: false, reason: 'access' }
  }
  return { ok: true }
}

/** 直前の会話（古い順）。Bot の発言は assistant、利用者は user。カードは本文（プレーンテキスト版）、PDFはファイル名だけ。 */
export function buildAiChatHistory(rows: AiChatMessageRow[], limit: number = AI_CHAT_LIMITS.historyMessages): { role: 'user' | 'assistant'; content: string }[] {
  return [...rows]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((r) => {
      const role = String(r.user_id ?? '') === AI_ANALYSIS_BOT_ID ? 'assistant' as const : 'user' as const
      const kind = String(r.kind ?? 'text')
      let content = ''
      if (kind === 'text' || kind === 'card') content = cleanText(r.content, AI_CHAT_LIMITS.historyCharsEach, { multiline: true })
      else if (kind === 'file') content = `[PDFなどのファイル] ${cleanText(r.content, 200)}`
      return { role, content }
    })
    .filter((m) => m.content)
    .slice(-limit)
}

export function aiChatRequestBody(message: AiChatMessageRow, history: { role: string; content: string }[]): string {
  return JSON.stringify({
    mtalk_user_id: String(message.user_id),
    mtalk_group_id: Number(message.group_id),
    message_id: Number(message.id),
    question: cleanText(message.content, AI_CHAT_LIMITS.questionMax, { multiline: true }),
    history,
  })
}

// 利用者に見せてはいけない内部の言葉（gourmet の取得の仕組み・道具・認証まわり）。gourmet の failure-text.js と同じ一覧。
// gourmet 側でも落としているが、念のため M-talk へ投稿する直前にも、これを含む行を落とす（言い換えはしない）。
export const INTERNAL_TERMS = new RegExp([
  'computer\\s*-?\\s*use', 'sub-?agents?', 'サブエージェント', 'executor', 'エグゼキュータ', '親エージェント', 'この実行環境',
  '\\bshell\\b', '\\bclaim(?:[-_ ]?ids?)?\\b', 'claimid', 'playwright', 'puppeteer', 'xdotool', 'devtools', '\\bcdp\\b', '\\bmcp\\b',
  'ingest_token', 'agent-queue', 'stage_cred', '--fail\\b', '--kind\\b', 'x-ingest-token', 'service_role',
].join('|'), 'i')
export const SCRUBBED_FALLBACK = '（回答を表示できませんでした。もう一度質問してください）'

/** 内部の言葉を含む行を落とす。 */
export function scrubInternalLines(text: string): string {
  return text.split('\n').filter((line) => !INTERNAL_TERMS.test(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 投稿する本文の最後の確認。空になった部分は除き、もとは本文があったのにすべて空なら決まった文を1つ。 */
function scrubParts(parts: string[]): string[] {
  const out = parts.map(scrubInternalLines).filter(Boolean)
  return out.length || !parts.length ? out : [SCRUBBED_FALLBACK]
}

/** gourmet の回答（parts）を M-talk の発言に収まる形へ。空なら []。 */
export function aiChatReplyParts(data: unknown): string[] {
  const parts = (data && typeof data === 'object' && Array.isArray((data as { parts?: unknown }).parts)) ? (data as { parts: unknown[] }).parts : []
  return scrubParts(parts
    .map((p) => cleanText(p, AI_CHAT_LIMITS.replyMax, { multiline: true }))
    .filter(Boolean)
    .slice(0, AI_CHAT_LIMITS.replyParts))
}

/** 失敗時に Bot が返す短い案内。gourmet が返した利用者向けの文（回数制限など）だけ使い、それ以外は定型文。 */
export function aiChatErrorMessage(status: number, data: unknown): string {
  const msg = data && typeof data === 'object' ? cleanText((data as { error?: unknown }).error, 200) : ''
  if (msg && [400, 404, 413, 429, 503].includes(status)) return `すみません、${msg.replace(/^すみません、?/, '')}`
  return AI_CHAT_GENERIC_ERROR
}

// ---------- 「最新を調べる／今あるデータで答える」の選択（廃止） ----------
// 2026-10-01: gourmet の AI分析はデータの質問にも常にすぐ答える（gourmet の DB は毎日の取得で確定値をためておく保存場所）。
// 選択のカード（kind = ai_chat_choice）・「最新を調べる」の見張り（kind = ai_chat_live）・POST /chat-reply は使わない。
// 過去の行と chat_ai_analysis_live_timeouts() は残すが、見張りは何もしない（migration 20261001190000）。
// gourmet の古い版が choice / live を返しても、ここでは parts の文をふつうの返事として送るだけ。

// ---------- 「ログイン情報を更新」のボタン（gourmet の取得がログインの問題で失敗したとき） ----------
// gourmet は { kind: 'relogin', source, store_name, url } を送る。ボタンの文はここで決め、URL は gourmet のアプリ
// （https://marugo-s.github.io/gourmet/ の ?view=accounts&source=…&store=…&retry=…）だけを通す。パスワードはトークを通らない
// （ボタンはアプリの登録画面を開くだけ）。不正なボタンは捨てる（回答の本文は送る）。

export const AI_CHAT_LOGIN_LINKS_KIND = 'ai_chat_login_links'
export const AI_CHAT_NOTICE_KIND = 'ai_chat_notice'
export const AI_CHAT_NOTICE_PATH = '/chat-notice'
export const GOURMET_APP_URL = 'https://marugo-s.github.io/gourmet/'
export const LOGIN_LINK_LIMITS = { max: 6, urlMax: 500, storeNameMax: 60 } as const
const GOURMET_SITE_LABELS: Record<string, string> = { tabelog: '食べログ', ikyu: '一休', hotpepper: 'ホットペッパー', google: 'Google', toreta: 'トレタ', retty: 'Retty' }
const LINK_QUERY_KEYS = new Set(['view', 'source', 'store', 'retry'])

export type LoginLink = { kind: 'relogin'; source: string; storeName: string; url: string }

/** gourmet のアプリの「ログイン情報を更新」の URL だけを通す（それ以外は null）。 */
export function gourmetCredentialUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw || raw.length > LOGIN_LINK_LIMITS.urlMax) return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  const app = new URL(GOURMET_APP_URL)
  if (u.protocol !== 'https:' || u.host !== app.host || u.pathname !== app.pathname || u.username || u.password || u.hash) return null
  for (const key of u.searchParams.keys()) if (!LINK_QUERY_KEYS.has(key)) return null
  const source = u.searchParams.get('source') ?? ''
  const store = u.searchParams.get('store') ?? ''
  const retry = u.searchParams.get('retry')
  if (u.searchParams.get('view') !== 'accounts' || !/^[a-z]{2,20}$/.test(source) || !/^[0-9A-Za-z_-]{0,40}$/.test(store) || (retry != null && !UUID.test(retry))) return null
  return u.toString()
}

/** gourmet から届いた links → 表示してよいボタン（kind = relogin だけ、同じ URL は1つ、最大6）。 */
export function loginLinksFrom(raw: unknown): LoginLink[] {
  if (!Array.isArray(raw)) return []
  const out: LoginLink[] = []
  for (const item of raw.slice(0, LOGIN_LINK_LIMITS.max * 2)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const url = gourmetCredentialUrl(r.url)
    const source = String(r.source ?? '')
    if (r.kind !== 'relogin' || !url || new URL(url).searchParams.get('source') !== source) continue
    if (out.some((l) => l.url === url)) continue
    out.push({ kind: 'relogin', source, storeName: cleanText(r.store_name, LOGIN_LINK_LIMITS.storeNameMax), url })
    if (out.length >= LOGIN_LINK_LIMITS.max) break
  }
  return out
}

const siteLabel = (source: string) => GOURMET_SITE_LABELS[source] ?? 'サイト'
const linkTarget = (l: LoginLink) => `${siteLabel(l.source)}${l.storeName ? `（${l.storeName}）` : ''}`

/** 「ログイン情報を更新」のカード（店舗×サイトごとにボタン1つ。押すと gourmet のアプリの登録画面が開く）。 */
export function buildLoginLinksCard(links: LoginLink[]): { text: string; cards: LinkCard[] } {
  const targets = links.map(linkTarget)
  return {
    text: `ログイン情報の更新が必要です（${targets.join('、')}）。gourmet のアプリで登録し直してください。パスワードはこのトークに書かないでください。`,
    cards: [{
      header: { eyebrow: AI_ANALYSIS_BOT_USERNAME, title: 'ログイン情報の更新が必要です', subtitle: targets.join('、') },
      sections: [
        { type: 'note', text: 'ボタンを押すと gourmet のアプリが開きます（ログインしていなければ、ふつうにログインしてください）。保存すると、最新のデータを取り直してこのトークでお知らせします。', size: 'sm' },
        { type: 'note', text: 'パスワードはこのトークに書かないでください。', size: 'xs' },
      ],
      actions: links.map((l, i) => ({ label: `ログイン情報を更新（${linkTarget(l)}）`, url: l.url, style: i === 0 ? 'primary' : 'secondary' })),
    }],
  }
}

type LinkCard = {
  header: { eyebrow: string; title: string; subtitle: string | null }
  sections: CardSection[]
  actions: { label: string; url?: string; command?: string; style: 'primary' | 'secondary' }[]
}

type ChatPostBase = { mtalkUserId: string; groupId: number; parts: string[]; links: LoginLink[] }

/** gourmet → M-talk の投稿の共通部分 { mtalk_user_id, mtalk_group_id, parts[1..3], links? } */
function validateChatPostBase(r: Record<string, unknown>): ChatPostBase {
  const mtalkUserId = String(r.mtalk_user_id ?? '')
  const groupId = Number(r.mtalk_group_id)
  if (!UUID.test(mtalkUserId)) throw new ExternalPostError('mtalk_user_id が不正です')
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new ExternalPostError('mtalk_group_id が不正です')
  if (!Array.isArray(r.parts)) throw new ExternalPostError('parts が不正です')
  const parts = r.parts.map((p) => cleanText(p, AI_CHAT_LIMITS.replyMax, { multiline: true })).filter(Boolean)
  if (!parts.length || r.parts.length > AI_CHAT_LIMITS.replyParts) throw new ExternalPostError(`parts は1〜${AI_CHAT_LIMITS.replyParts}通です`)
  return { mtalkUserId: mtalkUserId.toLowerCase(), groupId, parts: scrubParts(parts), links: loginLinksFrom(r.links) }
}

/** /mtalk-chat の返事の links（取り込みが「ログイン情報の確認が必要」で止まっているサイト）→ 答えのあとに出すボタン。 */
export function aiChatLinks(data: unknown): LoginLink[] {
  return data && typeof data === 'object' ? loginLinksFrom((data as { links?: unknown }).links) : []
}

export type ChatNoticeInput = { noticeId: string; mtalkUserId: string; groupId: number; parts: string[]; links: LoginLink[] }
export const aiChatNoticeDedupeKey = (noticeId: string) => `notice:${String(noticeId).toLowerCase()}`

/**
 * gourmet → M-talk: お知らせ（例: ログイン情報を更新したあとの「再ログイン後の取得結果」）。
 * { notice_id, mtalk_user_id, mtalk_group_id, parts[1..3], links? }。notice_id ごとに1回だけ送る。
 */
export function validateChatNoticeInput(raw: unknown): ChatNoticeInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ExternalPostError('送信内容が不正です')
  const r = raw as Record<string, unknown>
  const noticeId = String(r.notice_id ?? '')
  if (!UUID.test(noticeId)) throw new ExternalPostError('notice_id が不正です')
  const base = validateChatPostBase(r)
  return { noticeId: noticeId.toLowerCase(), mtalkUserId: base.mtalkUserId, groupId: base.groupId, parts: base.parts, links: base.links }
}

// ---------- 店舗Botの投稿（gourmet の週報など → POST /store-post） ----------
// 店舗Bot（bot_id）として、Bot が参加しているグループのルーム（1対1・ゴミ箱・管理者通知を除く。room_ids で絞れる）へ
// 要約カード1通＋任意のPDF（最大3つ、静かに続ける）を投稿する。口コミ通知（/alert）とは別の入口・別の kind。
// カードはここで組み立てる（gourmet から来るのは見出し・項目・要点・リンクだけ）。リンクは /alert と同じ許可したホストだけ。
// お客様の個人情報（メールアドレス・電話番号）らしき文字列がカードにあれば受け付けない（念のため。gourmet 側でも確認する）。
// 同じルームに同じ dedupe_key は1回だけ（カード: chat_alert_dispatches kind = gourmet_store_post、
// PDF: kind = gourmet_store_post_file、dedupe_key = <dedupe_key>:f<番号>）。
export const STORE_POST_PATH = '/store-post'
export const STORE_POST_CARD_KIND = 'gourmet_store_post'
export const STORE_POST_FILE_KIND = 'gourmet_store_post_file'
/** 投稿の種類 → カードの見出し（eyebrow）とプレビューの接頭辞。種類を増やすときはここに足す。 */
export const STORE_POST_TYPES: Record<string, { eyebrow: string; prefix: string }> = {
  weekly_report: { eyebrow: '週報', prefix: '[週報]' },
}
export const STORE_POST_LIMITS = {
  storeNameMax: 100,
  titleMax: 120,
  subtitleMax: 120,
  sectionsMax: 4,
  headingMax: 40,
  fieldsMax: 8,
  fieldLabelMax: 24,
  fieldValueMax: 120,
  itemsMax: 3,
  itemMax: 200,
  noteMax: 300,
  linksMax: 2,
  linkLabelMax: 20,
  filesMax: 3,
  /** PDF（デコード後）の合計。本文（base64）は EXTERNAL_POST_LIMITS.bodyMaxBytes まで。 */
  filesTotalBytes: 8 * 1024 * 1024,
  roomsMax: 20,
} as const

const PII_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
// 日本の電話番号（0から始まる10〜11桁。区切りはハイフン・空白・全角ハイフン類）と +81
const PII_PHONE = /(?:^|[^\d])(?:0\d{1,4}[-‐‑–—−ー－\s]?\d{1,4}[-‐‑–—−ー－\s]?\d{3,4}|\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})(?:[^\d]|$)/
/** メールアドレス・電話番号らしき文字列があれば true（カードに載せない）。 */
export function looksLikePersonalInfo(text: string): boolean {
  const s = String(text ?? '').normalize('NFKC')
  if (PII_EMAIL.test(s)) return true
  const m = PII_PHONE.exec(s)
  if (!m) return false
  const digits = m[0].replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 12
}

export type StorePostSection = { heading: string; fields: { label: string; value: string }[]; items: string[] }
export type StorePostFile = { pdf: Uint8Array<ArrayBuffer>; fileName: string }
export type StorePostInput = {
  botId: string
  roomIds: number[] | null
  dedupeKey: string
  type: string
  storeName: string
  title: string
  subtitle: string
  sections: StorePostSection[]
  note: string
  links: { label: string; url: string }[]
  files: StorePostFile[]
  dryRun: boolean
}

/** POST /store-post の本文を検証する。/alert の形式（score_changes・reviews）は受け付けない。 */
export function validateStorePostInput(raw: unknown): StorePostInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ExternalPostError('送信内容が不正です')
  const v = raw as Record<string, unknown>
  const L = STORE_POST_LIMITS
  if (!isUuid(v.bot_id)) throw new ExternalPostError('店舗Botが不正です')
  if (v.recipient_user_id != null || v.reviews != null || v.score_changes != null) throw new ExternalPostError('送信内容が不正です（口コミ通知は /alert）')
  let roomIds: number[] | null = null
  if (v.room_ids != null) {
    if (!Array.isArray(v.room_ids) || !v.room_ids.length || v.room_ids.length > L.roomsMax || v.room_ids.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0)) {
      throw new ExternalPostError(`room_ids は1〜${L.roomsMax}件のルームIDで指定してください`)
    }
    roomIds = [...new Set(v.room_ids as number[])]
  }
  const dedupeKey = String(v.dedupe_key ?? '')
  if (!DEDUPE.test(dedupeKey) || dedupeKey.length > 112) throw new ExternalPostError('dedupe_key が不正です')
  const type = String(v.type ?? '')
  if (!Object.hasOwn(STORE_POST_TYPES, type)) throw new ExternalPostError('type が不正です')
  const storeName = cleanText(v.store_name, L.storeNameMax)
  if (!storeName) throw new ExternalPostError('店舗名が必要です')
  const title = cleanText(v.title, L.titleMax)
  if (!title) throw new ExternalPostError('タイトルが必要です')
  if (v.sections != null && (!Array.isArray(v.sections) || v.sections.length > L.sectionsMax)) throw new ExternalPostError(`sections は${L.sectionsMax}件までです`)
  const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {})
  const sections = ((v.sections as unknown[] | undefined) ?? []).map((s) => {
    const r = obj(s)
    const fields = (Array.isArray(r.fields) ? r.fields : []).slice(0, L.fieldsMax)
      .map((f) => ({ label: cleanText(obj(f).label, L.fieldLabelMax), value: cleanText(obj(f).value, L.fieldValueMax) }))
      .filter((f) => f.label && f.value)
    const items = (Array.isArray(r.items) ? r.items : []).slice(0, L.itemsMax).map((x) => cleanText(x, L.itemMax)).filter(Boolean)
    return { heading: cleanText(r.heading, L.headingMax), fields, items }
  }).filter((s) => s.fields.length || s.items.length)
  if (!sections.length) throw new ExternalPostError('カードに載せる内容がありません')
  const links = (Array.isArray(v.links) ? v.links : []).slice(0, L.linksMax)
    .map((l) => ({ label: cleanText(obj(l).label, L.linkLabelMax), url: alertUrl(obj(l).url) }))
    .filter((l): l is { label: string; url: string } => !!l.label && !!l.url)
  if (v.files != null && (!Array.isArray(v.files) || v.files.length > L.filesMax)) throw new ExternalPostError(`files は${L.filesMax}件までです`)
  const files = ((v.files as unknown[] | undefined) ?? []).map((f) => ({ pdf: decodePdfBase64(obj(f).pdf_base64), fileName: sanitizePdfFileName(obj(f).filename) }))
  if (files.reduce((a, f) => a + f.pdf.byteLength, 0) > L.filesTotalBytes) throw new ExternalPostError('PDFが大きすぎます', 413)
  const input: StorePostInput = {
    botId: String(v.bot_id).toLowerCase(), roomIds, dedupeKey, type, storeName, title,
    subtitle: cleanText(v.subtitle, L.subtitleMax), sections, note: cleanText(v.note, L.noteMax, { multiline: true }), links, files,
    dryRun: v.dry_run === true,
  }
  const texts = [input.storeName, input.title, input.subtitle, input.note, ...sections.flatMap((s) => [s.heading, ...s.fields.flatMap((f) => [f.label, f.value]), ...s.items])]
  if (texts.some(looksLikePersonalInfo)) throw new ExternalPostError('カードに個人情報らしき文字列（メールアドレス・電話番号）が含まれています', 422)
  return input
}

/** PDF ごとの dedupe_key（カードの dedupe_key + :f<番号>）。 */
export const storePostFileDedupeKey = (dedupeKey: string, index: number) => `${dedupeKey}:f${index + 1}`

/** 店舗Botの投稿のカード（見出し → 項目 → 要点、セクションごとに区切り線）とプレビュー用の文。 */
export function buildStorePostCard(input: Pick<StorePostInput, 'type' | 'storeName' | 'title' | 'subtitle' | 'sections' | 'note' | 'links' | 'files'>): { text: string; cards: AlertCard[] } {
  const meta = STORE_POST_TYPES[input.type] ?? { eyebrow: 'お知らせ', prefix: '[お知らせ]' }
  const sections: CardSection[] = []
  input.sections.forEach((s, i) => {
    if (i > 0) sections.push({ type: 'separator' })
    if (s.heading) sections.push({ type: 'heading', text: s.heading })
    if (s.fields.length) sections.push({ type: 'fields', rows: s.fields.map((f) => ({ label: f.label, value: f.value })) })
    if (s.items.length) sections.push({ type: 'fields', rows: [{ label: 'ポイント', value: '', paragraphs: s.items.map((x) => `・${x}`) }] })
  })
  const fileNote = input.files.length ? `詳しくはこのあとのPDF（${input.files.map((f) => f.fileName).join('、')}）をご覧ください。` : ''
  const note = [input.note, fileNote].filter(Boolean).join('\n')
  if (note) sections.push({ type: 'separator' }, { type: 'note', size: 'xs', text: note })
  const lines = [`${meta.prefix} ${input.title}`]
  if (input.subtitle) lines.push(input.subtitle)
  for (const s of input.sections) {
    const head = s.fields.slice(0, 2).map((f) => `${f.label} ${f.value}`).join(' / ')
    if (head) lines.push(`${s.heading ? `${s.heading}: ` : ''}${head}`)
  }
  return {
    text: cleanText(lines.join('\n'), 500, { multiline: true }),
    cards: [{
      header: { eyebrow: input.title.includes(input.storeName) ? meta.eyebrow : `${meta.eyebrow} · ${input.storeName}`, title: input.title, subtitle: input.subtitle || null },
      sections,
      actions: input.links.map((l, i) => ({ label: l.label, url: l.url, style: i === 0 ? 'primary' as const : 'secondary' as const })),
    }],
  }
}
