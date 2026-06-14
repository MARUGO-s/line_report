// ルーム・セルフ設定フロー（独立モジュール）。
// LINEルームで「設定」と送ると、そのルームが管理者により有効化（room_config_access_enabled かつ
// アクセスパスワード設定済み）の場合のみ、ルーム専用の使い捨てログインリンク(lt)を発行し、
// room_settings.html へのボタンを返す。パスワードはリンクに含めず、ページで別途入力させる（二段ゲート）。
// 既存のレシート/予約/検索/予算/小口の処理には一切干渉しない。
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { StoreRegistryRow } from './store_receipt.ts'
import { replyLineMessages, resolveChannelAccessToken } from './line_client.ts'
import { issueAdminDashboardLoginLinkToken, ROOM_CONFIG_SCOPE } from './admin_dashboard_link_auth.ts'

const ROOM_CONFIG_BASE = 'https://marugo-s.github.io/line_report/room_settings.html'
// room_settings.html を更新したらこの値を上げる（LINEアプリ内ブラウザのキャッシュ無効化）。
const ROOM_CONFIG_APP_VERSION = '20260615'
// 起動トリガー（完全一致のみ。部分一致で誤爆させない）。
const TRIGGER_WORDS = new Set(['設定', '権限設定', 'せってい', 'ルーム設定'])
const LINE_URI_MAX = 1000

function buildRoomConfigUri(roomId: string, loginToken: string): string {
  const params = new URLSearchParams({ from: 'line', v: ROOM_CONFIG_APP_VERSION })
  if (roomId) params.set('room_id', roomId)
  if (loginToken) params.set('lt', loginToken)
  return `${ROOM_CONFIG_BASE}?${params.toString()}`.slice(0, LINE_URI_MAX)
}

function infoFlex(
  title: string,
  lines: string[],
  color = '#1F6FEB',
  uri?: string,
): Record<string, unknown> {
  const bubble: Record<string, unknown> = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true, color },
        ...lines.map((t) => ({ type: 'text', text: t, wrap: true, size: 'sm', color: '#444444' })),
      ],
    },
  }
  if (uri) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      contents: [{
        type: 'button',
        style: 'primary',
        height: 'sm',
        color,
        action: { type: 'uri', label: '設定ページを開く', uri },
      }],
    }
  }
  return { type: 'flex', altText: title, contents: bubble }
}

/**
 * 「設定」コマンドをルーム・セルフ設定フローとして処理する。
 * - トリガー語に完全一致したときだけ作動。それ以外は { handled:false } で従来処理へフォールスルー。
 * - room_config_access_enabled かつ password 設定済みのルームのみリンクを返す。
 */
export async function handleRoomConfigTextMessage(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  params: { roomId: string; replyToken: string; text: string },
): Promise<{ handled: boolean; replied: boolean }> {
  const roomId = String(params.roomId ?? '').trim()
  const replyToken = String(params.replyToken ?? '').trim()
  const text = String(params.text ?? '').trim()
  if (!roomId || !text || !TRIGGER_WORDS.has(text)) return { handled: false, replied: false }

  const storeKey = String(registry?.store_partition_key ?? '').trim()
  const accessToken = resolveChannelAccessToken(storeKey)
  const reply = async (msg: Record<string, unknown>): Promise<boolean> => {
    if (!replyToken || !accessToken) return false
    const r = await replyLineMessages(replyToken, [msg], accessToken, {
      storePartitionKey: storeKey,
      context: 'room_config',
      roomId,
    })
    return r.ok
  }

  // 管理者がこのルームのセルフ設定を有効化＋パスワード設定済みか確認。
  const { data: room, error } = await supabase
    .from('room_summary_settings')
    .select('room_config_access_enabled, room_config_password_hash')
    .eq('room_id', roomId)
    .maybeSingle()
  if (error) {
    return {
      handled: true,
      replied: await reply(infoFlex('設定を開けませんでした', ['少し時間を置いて、もう一度お試しください。'], '#D14343')),
    }
  }
  const enabled = !!(room as { room_config_access_enabled?: boolean } | null)?.room_config_access_enabled
  const hasPw = !!String((room as { room_config_password_hash?: unknown } | null)?.room_config_password_hash ?? '')
  if (!enabled || !hasPw) {
    return {
      handled: true,
      replied: await reply(infoFlex(
        'このルームの設定は無効です',
        ['このルームのセルフ設定は管理者がまだ有効化していません。', '利用したい場合は管理者にパスワード設定を依頼してください。'],
        '#D14343',
      )),
    }
  }

  let uri = ''
  try {
    const issued = await issueAdminDashboardLoginLinkToken(supabase, {
      source: 'line_room_config',
      room_id: roomId,
      scope: ROOM_CONFIG_SCOPE,
    })
    uri = buildRoomConfigUri(roomId, issued.token)
  } catch (_e) {
    return {
      handled: true,
      replied: await reply(infoFlex('設定を開けませんでした', ['少し時間を置いて、もう一度お試しください。'], '#D14343')),
    }
  }
  return {
    handled: true,
    replied: await reply(infoFlex(
      'このルームの設定ページ',
      [
        '下のボタンから開き、管理者から伝えられた「アクセスパスワード」を入力してください。',
        'このリンクは24時間・1回のみ有効です。',
      ],
      '#1F6FEB',
      uri,
    )),
  }
}
