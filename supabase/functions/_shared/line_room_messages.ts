import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'

export type LineMessageEvent = {
  type?: string
  webhookEventId?: string
  timestamp?: number
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string }
  message?: {
    id?: string
    type?: string
    text?: string
    fileName?: string
    address?: string
    title?: string
    stickerId?: string
    packageId?: string
  }
}

const LINE_ROOM_MESSAGE_RECORDING = (() => {
  const raw = String(Deno.env.get('LINE_ROOM_MESSAGE_RECORDING') ?? '').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
})()

export function isLineRoomMessageRecordingEnabled(): boolean {
  return LINE_ROOM_MESSAGE_RECORDING
}

export function extractLineMessageTextContent(event: LineMessageEvent): string {
  const msg = event.message
  if (!msg) return ''

  const type = String(msg.type || '').trim().toLowerCase()
  if (type === 'text') {
    return String(msg.text || '').trim()
  }
  if (type === 'image') return '[画像]'
  if (type === 'video') return '[動画]'
  if (type === 'audio') return '[音声]'
  if (type === 'file') {
    const name = String(msg.fileName || '').trim()
    return name ? `[ファイル] ${name}` : '[ファイル]'
  }
  if (type === 'sticker') return '[スタンプ]'
  if (type === 'location') {
    const title = String(msg.title || '').trim()
    const address = String(msg.address || '').trim()
    if (title && address) return `[位置情報] ${title} / ${address}`
    if (title) return `[位置情報] ${title}`
    if (address) return `[位置情報] ${address}`
    return '[位置情報]'
  }
  return type ? `[${type}]` : ''
}

export function resolveRoomIdFromEvent(event: LineMessageEvent): string | null {
  const source = event.source || {}
  const groupId = source.groupId ? String(source.groupId).trim() : ''
  const roomId = source.roomId ? String(source.roomId).trim() : ''
  const userId = source.userId ? String(source.userId).trim() : ''
  if (groupId) return groupId
  if (roomId) return roomId
  if (userId && String(source.type || '').trim() === 'user') return userId
  return null
}

export async function persistLineRoomMessageFromWebhook(
  supabase: SupabaseClient,
  event: LineMessageEvent,
  roomId: string,
): Promise<{ saved: boolean; reason?: string }> {
  if (!LINE_ROOM_MESSAGE_RECORDING) {
    return { saved: false, reason: 'recording_disabled' }
  }

  if (event.type !== 'message' || !event.message) {
    return { saved: false, reason: 'not_message_event' }
  }

  const textContent = extractLineMessageTextContent(event)
  if (!textContent) {
    return { saved: false, reason: 'empty_content' }
  }

  const lineMessageId = String(event.message.id || '').trim() || null
  const webhookEventId = String(event.webhookEventId || '').trim() || null
  const userId = event.source?.userId ? String(event.source.userId).trim() : null
  const messageType = String(event.message.type || 'unknown').trim() || 'unknown'

  const { data, error } = await supabase.rpc('insert_line_room_message', {
    p_room_id: roomId,
    p_line_message_id: lineMessageId,
    p_webhook_event_id: webhookEventId,
    p_user_id: userId,
    p_message_type: messageType,
    p_text_content: textContent,
    p_payload: event,
  })

  if (error) {
    console.error(`insert_line_room_message failed (${roomId}):`, error.message)
    return { saved: false, reason: 'insert_failed' }
  }

  if (data == null) {
    return { saved: false, reason: 'empty_content' }
  }

  return { saved: true }
}
