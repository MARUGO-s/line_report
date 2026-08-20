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

import { parseMtalkSyntheticRoomId } from './mtalk_room_id.ts'

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
  /** LINE Flex と同じ赤字など。 */
  color?: string | null
  /** LINE Flex の weight: 'bold'（同日確認の数値など）。 */
  weight?: 'bold' | null
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
  | {
    type: 'note'
    text: string
    color?: string | null
    weight?: 'bold' | null
    size?: 'xs' | 'sm' | null
  }
  | { type: 'separator' }
  | { type: 'heading'; text: string }

export type ChatCardAction = {
  label: string
  url?: string | null
  command?: string | null
  style?: 'primary' | 'secondary' | null
}

export type ChatCard = {
  header?: {
    eyebrow?: string | null
    title?: string
    subtitle?: string | null
  } | null
  /** LINE のレシート Flex と同じ白カード。 */
  variant?: 'line' | null
  sections: ChatCardSection[]
  action?: ChatCardAction | null
  actions?: ChatCardAction[] | null
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
    if (Number.isSafeInteger(groupId) && groupId > 0) return groupId
    return parseMtalkSyntheticRoomId(id)
  } catch (err) {
    console.error('resolveChatGroupId threw:', err instanceof Error ? err.message : String(err))
    return parseMtalkSyntheticRoomId(id)
  }
}

/**
 * ルーム直指定が無いとき、同じ店舗キーで chat_group_id がある設定を使う。
 * 個人LINE（pingus 等）へ流した予約通知も、店舗のトークルームへ複製するため。
 */
export async function resolveChatGroupIdByStore(
  supabase: DbClient,
  storeKey: string | null | undefined,
): Promise<number | null> {
  const key = String(storeKey ?? '').trim()
  if (!key) return null
  try {
    const { data, error } = await supabase
      .from('room_summary_settings')
      .select('chat_group_id')
      .eq('receipt_report_store_partition_key', key)
      .not('chat_group_id', 'is', null)
      .limit(1)
      .maybeSingle()
    if (error) {
      console.error('resolveChatGroupIdByStore failed:', error.message)
      return null
    }
    const groupId = Number(data?.chat_group_id)
    return Number.isSafeInteger(groupId) && groupId > 0 ? groupId : null
  } catch (err) {
    console.error(
      'resolveChatGroupIdByStore threw:',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

/**
 * トークへ単独投稿する。同じ kind + group + dedupeKey は一度だけ送る。
 * LINE の成否とは独立。投稿失敗時は予約を取り消して再送できるようにする。
 */
export async function postChatCardIndependent(
  supabase: DbClient,
  options: {
    groupId: number
    text: string
    cards: ChatCard[]
    kind: string
    dedupeKey: string
    asUser?: { id: string; username: string } | null
  },
): Promise<{ ok: boolean; skipped?: boolean; messageId?: number; error?: string }> {
  const groupId = Number(options.groupId)
  const dedupeKey = String(options.dedupeKey ?? '').trim()
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    return { ok: false, error: 'invalid chat group id' }
  }
  if (!dedupeKey) return { ok: false, error: 'missing dedupe key' }

  const { error: claimError } = await supabase
    .from('chat_alert_dispatches')
    .insert({
      kind: options.kind,
      chat_group_id: groupId,
      dedupe_key: dedupeKey,
    })
  if (claimError) {
    if (String(claimError.code ?? '') === '23505') {
      return { ok: true, skipped: true }
    }
    return { ok: false, error: `chat dispatch claim failed: ${claimError.message}` }
  }

  const posted = await postChatCard(supabase, options)
  if (!posted.ok) {
    try {
      await supabase
        .from('chat_alert_dispatches')
        .delete()
        .eq('kind', options.kind)
        .eq('chat_group_id', groupId)
        .eq('dedupe_key', dedupeKey)
    } catch (_e) { /* noop */ }
    return posted
  }

  if (posted.messageId) {
    await supabase
      .from('chat_alert_dispatches')
      .update({ message_id: posted.messageId })
      .eq('kind', options.kind)
      .eq('chat_group_id', groupId)
      .eq('dedupe_key', dedupeKey)
  }
  return posted
}

/**
 * カードを1件投稿し、続けて Web Push を配信する。
 * 失敗しても例外を投げず結果を返すだけにする。
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
    /** 店舗Botなど。省略時は予約通知Bot。 */
    asUser?: { id: string; username: string } | null
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
  const asUserId = String(options.asUser?.id ?? '').trim() || CHAT_BOT_USER_ID
  const asUsername = String(options.asUser?.username ?? '').trim() || CHAT_BOT_USERNAME

  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .insert({
        group_id: groupId,
        user_id: asUserId,
        username: asUsername,
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
