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

/** 「ジャーナル検索」の合図。M-talk 専用で、LINE 側の SearchKind には足さない。 */
const MTALK_JOURNAL_PENDING = 'journal'
/** line_search_bot の PENDING_TTL_MS と揃える（2分）。 */
const MTALK_JOURNAL_PENDING_TTL_MS = 2 * 60 * 1000

/**
 * ジャーナル検索の保留を読む。
 * loadSearchPending は search_kind が既知4種('message'|'calendar'|'media'|'sales')
 * 以外だと null を返すので、この種別には使えない。TTL の扱いだけ合わせる。
 */
async function loadJournalPending(
  supabase: DbClient,
  roomId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('line_room_search_pending')
    .select('search_kind, updated_at')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data) return false
  if (String(data.search_kind ?? '') !== MTALK_JOURNAL_PENDING) return false
  const updatedAt = new Date(String(data.updated_at ?? '')).getTime()
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > MTALK_JOURNAL_PENDING_TTL_MS) {
    await clearSearchPending(supabase, roomId, userId)
    return false
  }
  return true
}

export function isJournalTrigger(text: string): boolean {
  const v = String(text ?? '').trim().replace(/\s+/g, '')
  return v === 'srch=jnl'
    || ['ジャーナル検索', '電子ジャーナル検索', 'ジャーナルに聞く', '電子ジャーナルに聞く', '売上分析'].includes(v)
}

/** 「202608 前年より売れた商品は？」を月と質問に割る。 */
export function parseJournalQuestion(text: string): { month: string; question: string } | null {
  const v = String(text ?? '').trim()
  const m = /^(\d{6})\s*(.*)$/s.exec(v)
  if (!m) return null
  const month = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}`
  const question = m[2].trim()
  if (!question) return null
  const mm = Number(m[1].slice(4, 6))
  if (!(mm >= 1 && mm <= 12)) return null
  return { month, question }
}

function journalPromptCard(): { text: string; card: ChatCard } {
  return {
    text: '電子ジャーナル検索 — 月と質問の入力待ち',
    card: {
      variant: 'line',
      header: { title: '電子ジャーナルに聞く' },
      sections: [
        {
          type: 'note',
          size: 'sm',
          text: '対象月6桁のあとに質問を続けて送ってください。\n'
            + '例: 202608 前年同月より伸びた商品は？\n'
            + '例: 202608 客単価の推移を教えて',
        },
        {
          type: 'note',
          size: 'xs',
          color: '#888888',
          text: '登録済みの電子ジャーナル（日計精算・会計明細）だけを根拠に答えます。',
        },
      ],
      actions: [
        { label: '検索メニューに戻る', command: 'srch=menu', style: 'secondary' },
        { label: 'キャンセル', command: 'srch=cancel', style: 'secondary' },
      ],
    },
  }
}

/**
 * 電子ジャーナルAIへ質問して答えを返す。
 * 集計も回答生成も admin-api の /pos-journals/ai-ask に任せる
 * （画面から聞いたときと同じ根拠・同じ制約で答えさせるため）。
 */
async function askJournalAi(
  storeKey: string,
  month: string,
  question: string,
): Promise<{ text: string; card?: ChatCard }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://hocbnifuactbvmyjraxy.supabase.co'
  const internalKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/admin-api/pos-journals/ai-ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': internalKey,
        'x-admin-surface': 'line_report',
        'x-store-key': storeKey,
      },
      body: JSON.stringify({ store_key: storeKey, month, question }),
    })
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) {
      return { text: `電子ジャーナルに聞けませんでした: ${String(data.error ?? `HTTP ${res.status}`)}` }
    }
    const answer = String(data.answer ?? data.text ?? '').trim()
    if (!answer) return { text: '回答を得られませんでした。質問を変えて試してください。' }
    return {
      text: answer.slice(0, 1800),
      card: {
        variant: 'line',
        header: { title: '電子ジャーナル', subtitle: `${month} の記録から` },
        sections: [
          { type: 'note', size: 'sm', text: answer.slice(0, 1800) },
          { type: 'note', size: 'xs', color: '#888888', text: '登録済みの電子ジャーナルだけを根拠にしています。' },
        ],
      },
    }
  } catch (err) {
    console.error('askJournalAi threw:', err instanceof Error ? err.message : String(err))
    return { text: '電子ジャーナルへの問い合わせに失敗しました。時間をおいて試してください。' }
  }
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
  const journalPending = await loadJournalPending(supabase, roomId, userId)
  const salesInput = parseSalesDateInput(text)
  if (
    !postback
    && !pending
    && !isMenuTrigger(text)
    && !detectKindTrigger(text)
    && !isCancelText(text)
    && !salesInput
    && !isJournalTrigger(text)
    && !journalPending
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

  // 電子ジャーナル検索は M-talk 専用。LINE 側の SearchKind は変えず、
  // 保留テーブルへ 'journal' を積んで次の1通を質問として受ける。
  if (isJournalTrigger(text)) {
    await supabase.from('line_room_search_pending').upsert({
      room_id: roomId,
      user_id: userId,
      search_kind: MTALK_JOURNAL_PENDING,
      updated_at: new Date().toISOString(),
    })
    const prompt = journalPromptCard()
    await postChatCard(supabase, {
      groupId: params.groupId,
      kind: 'search',
      text: prompt.text,
      cards: [prompt.card],
      asUser: params.asUser ?? null,
    })
    return true
  }

  if (journalPending) {
    await clearSearchPending(supabase, roomId, userId)
    const parsed = parseJournalQuestion(text)
    if (!parsed) {
      const prompt = journalPromptCard()
      await postChatCard(supabase, {
        groupId: params.groupId,
        kind: 'search',
        text: '対象月6桁のあとに質問を続けてください（例: 202608 前年より伸びた商品は？）',
        cards: [prompt.card],
        asUser: params.asUser ?? null,
      })
      return true
    }
    const answer = await askJournalAi(
      params.registry.store_partition_key,
      parsed.month,
      parsed.question,
    )
    if (answer.card) {
      await postChatCard(supabase, {
        groupId: params.groupId,
        kind: 'search',
        text: answer.text,
        cards: [answer.card],
        asUser: params.asUser ?? null,
      })
    } else {
      await reply(answer.text)
    }
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
