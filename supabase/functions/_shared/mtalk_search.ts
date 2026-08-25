/**
 * LINE の「検索」メニューから予定／メディア／売上検索を M-talk へ載せる。
 * 会話検索は M-talk 画面上部の「トークルームとメッセージ検索」へ一本化する。
 */
import type { LineReplyPayload } from './receipt_types.ts'
import type { StoreRegistryRow } from './store_receipt.ts'
import { isReceiptCorrectionControlText } from './receipt_correction.ts'
import { mtalkCardFromLineReply } from './chat_flex_card.ts'
import { postChatCard, type ChatCard } from './chat_bridge.ts'
import {
  buildAllFeaturesGuideFlex,
  buildSearchEntryReply,
  clearSearchPending,
  detectKindTrigger,
  executeSalesSearch,
  isCancelText,
  isMenuTrigger,
  loadSearchFlagsForContext,
  loadSearchPending,
  parsePostbackKind,
  parseSalesDateInput,
  runPendingSearch,
  startSearchKind,
} from './line_search_bot.ts'

// deno-lint-ignore no-explicit-any
type DbClient = any

const MTALK_MESSAGE_SEARCH_GUIDANCE =
  'M-talkの会話検索は、トーク一覧上部の「トークルームとメッセージ検索」を使ってください。'

export function mtalkSearchRoomId(groupId: number): string {
  const id = Number(groupId)
  if (!Number.isSafeInteger(id) || id <= 0) return ''
  return `mtalk-dm-${id}`
}

function asMessages(payload: LineReplyPayload): Array<string | Record<string, unknown>> {
  if (typeof payload === 'string') return [payload]
  if (Array.isArray(payload)) return payload
  return [payload]
}

export function removeConversationSearchFromMtalk(payload: LineReplyPayload): LineReplyPayload {
  if (typeof payload === 'string') {
    return payload
      .replaceAll('会話／予定／メディア／売上', '予定／メディア／売上')
      .replaceAll('会話・予定・メディア・売上', '予定・メディア・売上')
      .replaceAll('会話検索・予定検索・メディア検索', '予定検索・メディア検索')
      .replaceAll('会話・予定・メディア', '予定・メディア')
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => removeConversationSearchFromMtalk(item) as string | Record<string, unknown>)
  }
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value
        .filter((item) => {
          const action = item && typeof item === 'object' ? (item as { action?: { data?: unknown } }).action : null
          return String(action?.data ?? '') !== 'srch=msg'
        })
        .map(walk)
    }
    if (!value || typeof value !== 'object') {
      return typeof value === 'string' ? removeConversationSearchFromMtalk(value) : value
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, walk(item)]))
  }
  return walk(structuredClone(payload)) as Record<string, unknown>
}

function toChatReply(payload: LineReplyPayload): { text: string; card?: ChatCard } {
  const first = asMessages(removeConversationSearchFromMtalk(payload))[0]
  return mtalkCardFromLineReply(first)
}

export async function handleMtalkSearchText(
  supabase: DbClient,
  params: {
    groupId: number
    senderUserId: string
    text: string
    registry: StoreRegistryRow
    asUser?: { id: string; username: string } | null
  },
): Promise<boolean> {
  const text = String(params.text ?? '').trim()
  const userId = String(params.senderUserId ?? '').trim()
  const roomId = mtalkSearchRoomId(params.groupId)
  if (!text || !userId || !roomId) return false

  const postback = parsePostbackKind(text)
  const pending = await loadSearchPending(supabase, roomId, userId)
  const salesInput = parseSalesDateInput(text)
  if (
    !postback
    && !pending
    && !isMenuTrigger(text)
    && !detectKindTrigger(text)
    && !isCancelText(text)
    && !salesInput
  ) {
    return false
  }

  const flags = await loadSearchFlagsForContext(supabase, roomId)
  if (!flags) return false
  if (flags.bot_reply_hard_mute_enabled) {
    const salesDateOverride = flags.receipt_correction_reply_enabled && !!salesInput
    if (!salesDateOverride) return false
  }

  const event = { source: { type: 'user', userId } }
  const reply = async (payload: LineReplyPayload): Promise<void> => {
    const converted = toChatReply(payload)
    if (converted.card) {
      await postChatCard(supabase, {
        groupId: params.groupId,
        kind: 'search',
        text: converted.text,
        cards: [converted.card],
        asUser: params.asUser,
      })
      return
    }
    await supabase.from('chat_messages').insert({
      group_id: params.groupId,
      user_id: params.asUser?.id || '00000000-0000-4000-8000-00000000b071',
      username: params.asUser?.username || '予約通知',
      content: converted.text,
      kind: 'text',
    })
  }

  if (isReceiptCorrectionControlText(text) && pending) {
    await clearSearchPending(supabase, roomId, userId)
    await reply('レシート修正の操作です。修正中のカードの「確定」「キャンセル」ボタンを使うか、「この結果を修正」からやり直してください。')
    return true
  }

  if (postback === 'cancel' || (isCancelText(text) && pending)) {
    if (!pending && postback !== 'cancel') return false
    await clearSearchPending(supabase, roomId, userId)
    await reply('検索をキャンセルしました。')
    return true
  }

  if (postback === 'help') {
    await reply(buildAllFeaturesGuideFlex())
    return true
  }

  if (postback === 'menu' || isMenuTrigger(text)) {
    await reply(buildSearchEntryReply(flags, event, roomId))
    return true
  }

  if (postback === 'message') {
    if (pending === 'message') await clearSearchPending(supabase, roomId, userId)
    await reply(MTALK_MESSAGE_SEARCH_GUIDANCE)
    return true
  }

  if (postback === 'calendar' || postback === 'media' || postback === 'sales') {
    await reply(await startSearchKind(supabase, roomId, userId, postback, flags))
    return true
  }

  if (pending) {
    if (pending === 'message') {
      await clearSearchPending(supabase, roomId, userId)
      await reply(MTALK_MESSAGE_SEARCH_GUIDANCE)
      return true
    }
    await reply(await runPendingSearch(
      supabase,
      params.registry,
      roomId,
      userId,
      pending,
      text,
      flags,
    ))
    return true
  }

  const directKind = detectKindTrigger(text)
  if (directKind) {
    if (directKind === 'message') {
      await reply(MTALK_MESSAGE_SEARCH_GUIDANCE)
      return true
    }
    await reply(await startSearchKind(supabase, roomId, userId, directKind, flags))
    return true
  }

  const salesSearchAllowed = flags.receipt_midreport_enabled || flags.receipt_monthend_report_enabled
  if (salesInput && salesSearchAllowed) {
    await reply(await executeSalesSearch(
      supabase,
      params.registry,
      roomId,
      text.replace(/\s+/g, ''),
    ))
    return true
  }

  return false
}
