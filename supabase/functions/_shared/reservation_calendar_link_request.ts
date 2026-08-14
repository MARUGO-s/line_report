// 予約カレンダー再ログイン導線。
// LINEの予約通知に含まれるログインリンクは短期・単一使用のため、使い切りや期限切れ後は
// 同じ店舗のLINEルームで「予約確認」と送ると、新しい店舗固定のリンクを返信する。
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { StoreRegistryRow } from './store_receipt.ts'
import { replyLineMessages, resolveChannelAccessToken } from './line_client.ts'
import { issueAdminDashboardLoginLinkToken } from './admin_dashboard_link_auth.ts'
import { buildReservationCalendarPageUrl } from './reservation_calendar_link.ts'

// 完全一致だけで起動し、通常会話中の「予約確認」を含む文章では誤作動させない。
const TRIGGER_WORDS = new Set(['予約確認'])

function buildReservationCalendarLinkFlex(uri: string): Record<string, unknown> {
  return {
    type: 'flex',
    altText: '予約カレンダーを開くログインリンクを発行しました',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '予約カレンダーを開く', weight: 'bold', size: 'lg', wrap: true, color: '#1F6FEB' },
          { type: 'text', text: '下のボタンから、この店舗の予約カレンダーへログインできます。', size: 'sm', wrap: true, color: '#444444' },
          { type: 'text', text: 'このリンクは24時間・1回のみ有効です。もう一度必要になったら、このルームで「予約確認」と送ってください。', size: 'xs', wrap: true, color: '#6B7280' },
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
 * 同じLINEルームで「予約確認」と送ると、その店舗に限定した新しい予約カレンダー用ログインリンクを返す。
 * 既存リンクと同じ短期・単一使用トークンを再発行するため、失効済みリンクを復活させない。
 */
export async function handleReservationCalendarLinkTextMessage(
  supabase: SupabaseClient,
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
    const issued = await issueAdminDashboardLoginLinkToken(supabase, {
      source: 'line_reservation_calendar_request',
      store_partition_key: storeKey,
      room_id: roomId,
    })
    const uri = buildReservationCalendarPageUrl(storeKey, { loginToken: issued.token })
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
