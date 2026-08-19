/**
 * LINE へ送っている通知を chat.html（Supabase Realtime のグループチャット）へ複製する。
 *
 * 使い方:
 *   const groupId = await resolveChatGroupId(supabase, roomId)
 *   if (groupId) await postChatCard(supabase, { groupId, text, cards, kind })
 *
 * content にはプレーンテキスト版を必ず入れる。トーク一覧のプレビューと Web Push の
 * 本文はここを見るため、payload が読めないクライアントでも意味が通る。
 */

// 20260819160000_chat_notification_cards.sql で作った Bot。
const CHAT_BOT_USER_ID = '00000000-0000-4000-8000-00000000b071'
const CHAT_BOT_USERNAME = '予約通知'
const CHAT_MESSAGE_CONTENT_MAX = 2000

// deno-lint-ignore no-explicit-any
type DbClient = any

/** ラベルと値の2列で並べる行。Flex の buildGmailReservationFlexRow 相当。 */
export type ChatCardFieldRow = {
  label: string
  value: string
  /** 履歴・予約回数欄のように1要素=1段落で縦に積むもの。 */
  paragraphs?: string[]
}

/** 予約1件分の行。Flex の buildReservationRow 相当。 */
export type ChatCardListItem = {
  time?: string | null
  name?: string | null
  size?: string | null
  note?: string | null
  /** 赤字で出す警告（アレルギーなど）。 */
  warn?: string | null
}

export type ChatCardSection =
  | { type: 'fields'; rows: ChatCardFieldRow[] }
  | { type: 'list'; items: ChatCardListItem[] }
  | { type: 'note'; text: string }

export type ChatCard = {
  header: {
    eyebrow?: string | null
    title: string
    subtitle?: string | null
  }
  sections: ChatCardSection[]
  action?: { label: string; url: string } | null
}

export type ChatCardPayload = {
  v: 1
  kind: string
  cards: ChatCard[]
}

/** このLINEルームに対応する chat.html のトークルーム。未設定なら null。 */
export async function resolveChatGroupId(
  supabase: DbClient,
  roomId: string,
): Promise<number | null> {
  const id = String(roomId ?? '').trim()
  if (!id) return null
  try {
    const { data, error } = await supabase
      .from('room_summary_settings')
      .select('chat_group_id')
      .eq('room_id', id)
      .maybeSingle()
    if (error) {
      console.error('resolveChatGroupId failed:', error.message)
      return null
    }
    const groupId = Number(data?.chat_group_id)
    return Number.isSafeInteger(groupId) && groupId > 0 ? groupId : null
  } catch (err) {
    console.error('resolveChatGroupId threw:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * カードを1件投稿し、続けて Web Push を配信する。
 * LINE 送信の成否とは独立に扱いたいので、失敗しても例外を投げず結果を返すだけにする。
 */
export async function postChatCard(
  supabase: DbClient,
  options: {
    groupId: number
    /** プレビュー・プッシュ本文に使うプレーンテキスト版。 */
    text: string
    cards: ChatCard[]
    /** payload.kind。'reservation_today' など通知の種類。 */
    kind: string
  },
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const groupId = Number(options.groupId)
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    return { ok: false, error: 'invalid chat group id' }
  }
  const cards = Array.isArray(options.cards) ? options.cards : []
  if (cards.length === 0) return { ok: false, error: 'no cards' }

  const content = String(options.text ?? '').trim().slice(0, CHAT_MESSAGE_CONTENT_MAX)
  if (!content) return { ok: false, error: 'empty text fallback' }

  const payload: ChatCardPayload = { v: 1, kind: options.kind, cards }

  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .insert({
        group_id: groupId,
        user_id: CHAT_BOT_USER_ID,
        username: CHAT_BOT_USERNAME,
        content,
        kind: 'card',
        payload,
      })
      .select('id')
      .single()
    if (error) return { ok: false, error: `chat insert failed: ${error.message}` }

    const messageId = Number(data?.id)
    if (!Number.isSafeInteger(messageId)) {
      return { ok: false, error: 'chat insert returned no id' }
    }

    // プッシュは届かなくても投稿自体は成功扱いにする（開けば読める）。
    const pushed = await dispatchChatPush(supabase, messageId)
    if (!pushed.ok) console.error('chat push dispatch failed:', pushed.error)

    return { ok: true, messageId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** chat-push Edge Function の内部ディスパッチ経路を叩く。 */
async function dispatchChatPush(
  supabase: DbClient,
  messageId: number,
): Promise<{ ok: boolean; error?: string }> {
  const supabaseUrl = String(Deno.env.get('SUPABASE_URL') ?? '').trim()
  if (!supabaseUrl) return { ok: false, error: 'SUPABASE_URL is missing' }

  const { data, error } = await supabase
    .from('chat_push_internal_config')
    .select('dispatch_secret')
    .eq('id', true)
    .maybeSingle()
  if (error) return { ok: false, error: `dispatch secret load failed: ${error.message}` }
  const secret = String(data?.dispatch_secret ?? '').trim()
  if (!secret) return { ok: false, error: 'dispatch secret is not configured' }

  try {
    const response = await fetch(
      `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/chat-push?action=dispatch`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ message_id: messageId }),
      },
    )
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return { ok: false, error: `chat-push HTTP ${response.status}: ${body.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
