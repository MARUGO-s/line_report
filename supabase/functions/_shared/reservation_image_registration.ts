import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'

export type ReservationImagePermission = 'allowed' | 'disabled' | 'unavailable'

/** キャッシュせず、画像検出時とカード操作時に最新のルーム設定を再確認する。DB障害時は登録しない。 */
export async function loadReservationImagePermission(
  supabase: SupabaseClient,
  roomId: string,
): Promise<ReservationImagePermission> {
  if (!roomId.trim()) return 'unavailable'
  try {
    const { data, error } = await supabase
      .from('room_summary_settings')
      .select('reservation_image_registration_enabled')
      .eq('room_id', roomId)
      .maybeSingle()
    if (error) return 'unavailable'
    // 設定行のない新規ルームはDBの既定値(ON)と同じ。行はあるのに値を取得できない場合は許可しない。
    if (!data) return 'allowed'
    return data.reservation_image_registration_enabled === true ? 'allowed' : 'disabled'
  } catch {
    return 'unavailable'
  }
}

/** 連番カードIDだけで他ルーム・他店舗の予約を操作できないよう、署名検証済みイベントの送信元に束縛する。 */
export function reservationImportMatchesSource(
  pending: { room_id?: unknown; store_partition_key?: unknown; payload?: Record<string, unknown> | null },
  roomId: string,
  storeKey: string,
): boolean {
  return !!roomId && !!storeKey
    && pending.room_id === roomId
    && pending.store_partition_key === storeKey
    && (!pending.payload?.manual_store_key || pending.payload.manual_store_key === storeKey)
}
