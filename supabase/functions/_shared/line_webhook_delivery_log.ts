import { createServiceClient } from './store_receipt.ts'

export type LineWebhookDeliveryLogContext = {
  storePartitionKey: string
  context: string
  roomId?: string | null
}

function currentJstHour(): number {
  const nowJstMs = Date.now() + 9 * 60 * 60 * 1000
  return new Date(nowJstMs).getUTCHours()
}

/** LINE 返信・Push の送信結果を管理画面の Webhook ログ用に記録する */
export async function recordLineWebhookDeliveryLog(input: {
  storePartitionKey: string
  method: 'reply' | 'push'
  context: string
  targetRoomId?: string | null
  attempted: boolean
  success: boolean
  httpStatus?: number | null
  reason?: string
  details?: Record<string, unknown>
}): Promise<void> {
  const storeKey = String(input.storePartitionKey ?? '').trim().toLowerCase()
  if (!storeKey) return

  const supabase = createServiceClient()
  if (!supabase) return

  const status = input.success
    ? 'WEBHOOK_LINE_DELIVERED'
    : input.attempted
    ? 'WEBHOOK_LINE_REPLY_FAILED'
    : 'WEBHOOK_LINE_SKIPPED'

  const { error } = await supabase.from('line_webhook_delivery_logs').insert({
    jst_hour: currentJstHour(),
    status,
    reason: input.reason ?? (input.success ? 'Webhook経由でLINEへ送信しました。' : 'LINE送信に失敗しました。'),
    method: input.method,
    context: String(input.context ?? '').trim() || 'unknown',
    line_send_attempted: input.attempted,
    line_send_success: input.success,
    line_http_status: input.httpStatus ?? null,
    target_room_id: input.targetRoomId ? String(input.targetRoomId) : null,
    store_partition_key: storeKey,
    details: input.details ?? {},
  })

  if (error) {
    console.error('recordLineWebhookDeliveryLog failed:', error.message)
  }
}
