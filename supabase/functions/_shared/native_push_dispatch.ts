// chat-push dispatch のうち、アプリ版（APNs）宛ての送信部分。
// 宛先の決定（参加者・ミュート・利用停止・通知ON/OFF・二重配信防止）は呼び出し側の
// 既存処理が済ませており、ここでは決まった端末へ送って結果を記録するだけにする。
import {
  type ApnsConfig,
  type ApnsEnvironment,
  apnsDeviceExpired,
  buildApnsPayload,
  sendApns,
} from "./apns_push.ts"

type DbClient = any
type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type NativeDeviceRow = {
  id: string
  user_id: string
  token: string
  apns_environment: ApnsEnvironment
  failure_count: number | null
}

export type NativePushResult = { sent: number; failed: number; skipped: number; errors: string[] }

export async function sendNativePushes(input: {
  supabase: DbClient
  devices: NativeDeviceRow[]
  config: ApnsConfig | null
  message: { id: number; group_id: number }
  contentFor: (userId: string) => { title: string; body: string }
  badgeFor: (userId: string) => number | null
  fetchImpl?: FetchLike
  now?: () => string
}): Promise<NativePushResult> {
  const result: NativePushResult = { sent: 0, failed: 0, skipped: 0, errors: [] }
  if (!input.devices.length) return result
  if (!input.config) {
    // APNsの鍵が未設定の間はアプリ版だけ送らない。Web Pushは止めない。
    result.skipped = input.devices.length
    return result
  }
  const now = input.now ?? (() => new Date().toISOString())
  for (const row of input.devices) {
    const content = input.contentFor(row.user_id)
    const payload = buildApnsPayload({
      title: content.title,
      body: content.body,
      groupId: input.message.group_id,
      messageId: input.message.id,
      badgeCount: input.badgeFor(row.user_id),
    })
    try {
      const sent = await sendApns(
        { token: row.token, environment: row.apns_environment },
        payload,
        input.config,
        { fetchImpl: input.fetchImpl, collapseId: `m-${input.message.id}` },
      )
      if (sent.ok) {
        result.sent += 1
        await input.supabase.from("chat_push_native_devices").update({
          failure_count: 0,
          is_active: true,
          last_success_at: now(),
          updated_at: now(),
        }).eq("id", row.id)
        continue
      }
      result.failed += 1
      result.errors.push(`native ${row.id}: HTTP ${sent.status}${sent.reason ? ` ${sent.reason}` : ""}`)
      await input.supabase.from("chat_push_native_devices").update({
        is_active: !apnsDeviceExpired(sent),
        failure_count: (Number(row.failure_count) || 0) + 1,
        updated_at: now(),
      }).eq("id", row.id)
    } catch (error) {
      result.failed += 1
      const reason = error instanceof Error ? error.message : String(error)
      result.errors.push(`native ${row.id}: ${reason.slice(0, 300)}`)
      await input.supabase.from("chat_push_native_devices").update({
        failure_count: (Number(row.failure_count) || 0) + 1,
        updated_at: now(),
      }).eq("id", row.id)
    }
  }
  return result
}
