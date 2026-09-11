// LINEの「予約確認」からM-talkの店舗予約カレンダーを開く導線。
// URL自体は認証情報を持たず、M-talkのログインと店舗閲覧権限で認可する。
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { StoreRegistryRow } from './store_receipt.ts'
import { replyLineMessages, resolveChannelAccessToken } from './line_client.ts'
import { buildReservationCalendarPageUrl } from './reservation_calendar_link.ts'

// 完全一致だけで起動し、通常会話中の「予約確認」を含む文章では誤作動させない。
const TRIGGER_WORDS = new Set(['予約確認'])

function buildReservationCalendarLinkFlex(uri: string): Record<string, unknown> {
  return {
    type: 'flex',
    altText: 'M-talkの予約カレンダーを開く',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '予約カレンダーを開く', weight: 'bold', size: 'lg', wrap: true, color: '#1F6FEB' },
          { type: 'text', text: '下のボタンから、M-talkのこの店舗の予約カレンダーを開けます。', size: 'sm', wrap: true, color: '#444444' },
          { type: 'text', text: 'M-talkへのログインと、この店舗の閲覧権限が必要です。未ログインの場合は、ログイン後に予約カレンダーを開きます。', size: 'xs', wrap: true, color: '#6B7280' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [{
          type: 'button',
          style: 'primary',
          height: 'sm',
          action: { type: 'uri', label: '予約カレンダーを開く', uri },
        }],
      },
    },
  }
}

/**
 * 同じLINEルームで「予約確認」と送ると、M-talkの店舗予約カレンダーへのリンクを返す。
 * 閲覧権限は遷移先のM-talkとAPIで検証する。URLで権限を付与しない。
 */
export async function handleReservationCalendarLinkTextMessage(
  _supabase: SupabaseClient,
  registry: StoreRegistryRow,
  params: { roomId: string; replyToken: string; text: string },
): Promise<{ handled: boolean; replied: boolean }> {
  const roomId = String(params.roomId ?? '').trim()
  const replyToken = String(params.replyToken ?? '').trim()
  const text = String(params.text ?? '').trim().replace(/\s+/g, '')
  if (!roomId || !text || !TRIGGER_WORDS.has(text)) return { handled: false, replied: false }

  const storeKey = String(registry?.store_partition_key ?? '').trim()
  const accessToken = resolveChannelAccessToken(storeKey)
  if (!storeKey || !replyToken || !accessToken) {
    return { handled: true, replied: false }
  }

  try {
    const uri = buildReservationCalendarPageUrl(storeKey)
    const result = await replyLineMessages(
      replyToken,
      [buildReservationCalendarLinkFlex(uri)],
      accessToken,
      { storePartitionKey: storeKey, roomId, context: 'reservation_calendar_link_request' },
    )
    return { handled: true, replied: result.ok }
  } catch (error) {
    console.error('reservation_calendar_link_request failed:', error instanceof Error ? error.message : String(error))
    const result = await replyLineMessages(
      replyToken,
      [{ type: 'text', text: '予約カレンダーのリンクを発行できませんでした。少し時間をおいて、もう一度「予約確認」と送ってください。' }],
      accessToken,
      { storePartitionKey: storeKey, roomId, context: 'reservation_calendar_link_request_failed' },
    )
    return { handled: true, replied: result.ok }
  }
}
