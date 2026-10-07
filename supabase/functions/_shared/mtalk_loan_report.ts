// ---------- 貸借管理アプリの月次「重複チェック」報告（mtalk-loan-report → POST /report） ----------
// 貸借管理アプリ（MARUGO-s/management）の GAS が毎月1日に前々月・前月の2か月分の重複・入力ミスの疑いを集計し、
// 専用Bot「貸借管理 報告」（…b074）として届ける。送り先は
//   - 現在の全権管理者それぞれとの1対1（chat_ensure_bot_direct で作成・再利用）
//   - Bot が参加しているグループのルーム（1対1・ゴミ箱・管理者通知を除く。招待できるのは全権管理者だけ）
// カードはここで組み立てる（GAS から来るのは見出し・項目・要点・リンクだけ）。リンクは許可したホストだけ。
// 入力者名などは送らない前提。念のためメールアドレス・電話番号らしき文字列があれば受け付けない。
// 同じルームに同じ dedupe_key は1回だけ（chat_alert_dispatches kind = loan_duplicate_report）。
import type { ChatCard, ChatCardSection } from './chat_bridge.ts'
import {
  alertUrl,
  type BotRoomRow,
  cleanText,
  ExternalPostError,
  looksLikePersonalInfo,
} from './mtalk_external_post.ts'

export const LOAN_REPORT_BOT_ID = '00000000-0000-4000-8000-00000000b074'
export const LOAN_REPORT_BOT_USERNAME = '貸借管理 報告'
export const LOAN_REPORT_PATH = '/report'
export const LOAN_REPORT_CARD_KIND = 'loan_duplicate_report'
export const LOAN_REPORT_LIMITS = {
  bodyMaxBytes: 64 * 1024,
  titleMax: 120,
  subtitleMax: 120,
  sectionsMax: 4,
  headingMax: 40,
  fieldsMax: 8,
  fieldLabelMax: 24,
  fieldValueMax: 120,
  itemsMax: 5,
  itemMax: 200,
  noteMax: 300,
  linksMax: 2,
  linkLabelMax: 20,
} as const

const DEDUPE = /^[A-Za-z0-9:_.-]{8,112}$/

export type LoanReportSection = { heading: string; fields: { label: string; value: string }[]; items: string[] }
export type LoanReportInput = {
  dedupeKey: string
  title: string
  subtitle: string
  sections: LoanReportSection[]
  note: string
  links: { label: string; url: string }[]
  dryRun: boolean
}

/** POST /report の本文を検証する。 */
export function validateLoanReportInput(raw: unknown): LoanReportInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ExternalPostError('送信内容が不正です')
  const v = raw as Record<string, unknown>
  const L = LOAN_REPORT_LIMITS
  const dedupeKey = String(v.dedupe_key ?? '')
  if (!DEDUPE.test(dedupeKey)) throw new ExternalPostError('dedupe_key が不正です')
  const title = cleanText(v.title, L.titleMax)
  if (!title) throw new ExternalPostError('タイトルが必要です')
  if (v.sections != null && (!Array.isArray(v.sections) || v.sections.length > L.sectionsMax)) {
    throw new ExternalPostError(`sections は${L.sectionsMax}件までです`)
  }
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
  const input: LoanReportInput = {
    dedupeKey,
    title,
    subtitle: cleanText(v.subtitle, L.subtitleMax),
    sections,
    note: cleanText(v.note, L.noteMax, { multiline: true }),
    links,
    dryRun: v.dry_run === true,
  }
  const texts = [input.title, input.subtitle, input.note, ...sections.flatMap((s) => [s.heading, ...s.fields.flatMap((f) => [f.label, f.value]), ...s.items])]
  if (texts.some(looksLikePersonalInfo)) {
    throw new ExternalPostError('カードに個人情報らしき文字列（メールアドレス・電話番号）が含まれています', 422)
  }
  return input
}

/** 報告のカード（見出し → 項目 → 要点、セクションごとに区切り線）とプレビュー用の文。 */
export function buildLoanReportCard(
  input: Pick<LoanReportInput, 'title' | 'subtitle' | 'sections' | 'note' | 'links'>,
): { text: string; cards: ChatCard[] } {
  const sections: ChatCardSection[] = []
  input.sections.forEach((s, i) => {
    if (i > 0) sections.push({ type: 'separator' })
    if (s.heading) sections.push({ type: 'heading', text: s.heading })
    if (s.fields.length) sections.push({ type: 'fields', rows: s.fields.map((f) => ({ label: f.label, value: f.value })) })
    if (s.items.length) sections.push({ type: 'fields', rows: [{ label: '主なもの', value: '', paragraphs: s.items.map((x) => `・${x}`) }] })
  })
  if (input.note) sections.push({ type: 'separator' }, { type: 'note', size: 'xs', text: input.note })
  const lines = [`[貸借管理] ${input.title}`]
  if (input.subtitle) lines.push(input.subtitle)
  for (const s of input.sections) {
    const head = s.fields.slice(0, 2).map((f) => `${f.label} ${f.value}`).join(' / ')
    if (head) lines.push(`${s.heading ? `${s.heading}: ` : ''}${head}`)
  }
  return {
    text: cleanText(lines.join('\n'), 500, { multiline: true }),
    cards: [{
      header: { eyebrow: '貸借管理', title: input.title, subtitle: input.subtitle || null },
      sections,
      actions: input.links.map((l, i) => ({ label: l.label, url: l.url, style: i === 0 ? 'primary' as const : 'secondary' as const })),
    }],
  }
}

/** Bot が参加しているグループのうち、報告を投稿してよいルーム（1対1・ゴミ箱・管理者通知を除く）。 */
export function loanReportRooms(rooms: BotRoomRow[]): { id: number; name: string }[] {
  return rooms
    .filter((r) => !r.is_direct && !r.trashed_at && !r.is_admin_notice_room)
    .map((r) => ({ id: Number(r.id), name: String(r.group_name ?? '') }))
    .filter((r) => Number.isSafeInteger(r.id) && r.id > 0)
    .sort((a, b) => a.id - b.id)
}
