/**
 * LINE Flex 返信を M-talk の ChatCard に写す。
 * 本文の並び（説明・項目・警告・ボタン）を保ち、太字と色も残す。
 */
import type { ChatCard, ChatCardAction, ChatCardSection } from './chat_bridge.ts'

type FlexField = {
  label: string
  value: string
  color?: string | null
  weight?: 'bold' | null
}

type FlexWalkOut = {
  pendingFields: FlexField[]
  sections: ChatCardSection[]
  notes: string[]
  actions: ChatCardAction[]
}

function flushFlexFields(out: FlexWalkOut): void {
  if (!out.pendingFields.length) return
  out.sections.push({ type: 'fields', rows: out.pendingFields })
  out.pendingFields = []
}

function flexColor(raw: unknown): string | null {
  const color = String(raw ?? '').trim()
  if (!color) return null
  if (/^#111111$/i.test(color) || /^#1F1F1F$/i.test(color)) return null
  return color
}

function flexWeight(raw: unknown): 'bold' | null {
  return String(raw ?? '').trim().toLowerCase() === 'bold' ? 'bold' : null
}

function flexNoteSize(raw: unknown): 'xs' | 'sm' | null {
  const size = String(raw ?? '').trim().toLowerCase()
  if (size === 'xs' || size === 'xxs') return 'xs'
  if (size === 'sm') return 'sm'
  return null
}

function emitFlexNote(
  out: FlexWalkOut,
  text: string,
  rec: Record<string, unknown>,
): void {
  flushFlexFields(out)
  out.notes.push(text)
  out.sections.push({
    type: 'note',
    text,
    color: flexColor(rec.color),
    weight: flexWeight(rec.weight),
    size: flexNoteSize(rec.size),
  })
}

export function mtalkCardFromLineReply(reply: unknown): { text: string; card?: ChatCard } {
  if (typeof reply === 'string') return { text: reply }
  if (Array.isArray(reply)) {
    const first = reply.find((item) => item != null)
    return mtalkCardFromLineReply(first)
  }
  if (!reply || typeof reply !== 'object') return { text: '操作を受け付けました。' }
  const rec = reply as Record<string, unknown>
  const collected: FlexWalkOut = {
    pendingFields: [],
    sections: [],
    notes: [],
    actions: [],
  }
  walkLineFlex(rec, collected)
  flushFlexFields(collected)
  const alt = String(rec.altText ?? '').trim()
  const text = alt || collected.notes[0] || '操作を受け付けました。'
  if (!collected.sections.length && !collected.actions.length) return { text }
  const title = (alt.split(' / ')[0] || alt || 'レシート').trim()
  return {
    text,
    card: {
      variant: 'line',
      header: { title },
      sections: collected.sections,
      actions: collected.actions.length ? collected.actions : null,
    },
  }
}

function walkLineFlex(
  node: unknown,
  out: FlexWalkOut,
  ctx?: { inHeader?: boolean; inFooter?: boolean },
): void {
  if (!node || typeof node !== 'object') return
  const rec = node as Record<string, unknown>
  if (rec.type === 'separator') {
    flushFlexFields(out)
    out.sections.push({ type: 'separator' })
    return
  }
  if (rec.layout === 'horizontal' && Array.isArray(rec.contents) && rec.contents.length === 2) {
    const left = rec.contents[0] as Record<string, unknown> | undefined
    const right = rec.contents[1] as Record<string, unknown> | undefined
    if (left?.type === 'text' && right?.type === 'text') {
      const label = String(left.text ?? '').trim()
      const value = String(right.text ?? '').trim()
      if (label && value) {
        out.pendingFields.push({
          label,
          value,
          color: flexColor(right.color),
          weight: flexWeight(right.weight),
        })
        return
      }
    }
  }
  if (rec.type === 'text' && rec.text) {
    const text = String(rec.text)
    if (ctx?.inFooter || ctx?.inHeader) return
    if (rec.weight === 'bold' && (text.startsWith('【') || text.startsWith('対象:'))) {
      flushFlexFields(out)
      out.sections.push({ type: 'heading', text })
      return
    }
    emitFlexNote(out, text, rec)
    return
  }
  if (rec.type === 'button' && rec.action && typeof rec.action === 'object') {
    const action = rec.action as Record<string, unknown>
    const label = String(action.label || rec.label || '').trim()
    const command = action.type === 'postback'
      ? String(action.data || action.displayText || '').trim()
      : String(action.text || action.displayText || '').trim()
    const url = action.type === 'uri' ? String(action.uri || '') : ''
    const style = rec.style === 'primary' ? 'primary' : 'secondary'
    if (url) out.actions.push({ label: label || '開く', url, style })
    else if (command) out.actions.push({ label: label || command, command, style })
    return
  }
  const hasParts = !!(rec.header || rec.body || rec.footer)
  if (rec.header) walkLineFlex(rec.header, out, { inHeader: true })
  if (rec.body) walkLineFlex(rec.body, out, ctx)
  if (rec.footer) walkLineFlex(rec.footer, out, { inFooter: true })
  if (!hasParts) {
    if (Array.isArray(rec.contents)) rec.contents.forEach((child) => walkLineFlex(child, out, ctx))
    else if (rec.contents) walkLineFlex(rec.contents, out, ctx)
  }
}
