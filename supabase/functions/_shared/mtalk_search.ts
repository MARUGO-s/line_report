/**
 * LINE の「検索」メニューと会話／予定／メディア／売上検索を M-talk へ載せる。
 * 店舗Botのいるルームでは、LINE 1対1 と同じ4ボタンを出す。
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

function toChatReply(payload: LineReplyPayload): { text: string; card?: ChatCard } {
  const first = asMessages(payload)[0]
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

  if (postback === 'message' || postback === 'calendar' || postback === 'media' || postback === 'sales') {
    await reply(await startSearchKind(supabase, roomId, userId, postback, flags))
    return true
  }

  if (pending) {
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
