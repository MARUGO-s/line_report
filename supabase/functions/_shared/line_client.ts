import type { LineWebhookDeliveryLogContext } from './line_webhook_delivery_log.ts'
import { recordLineWebhookDeliveryLog } from './line_webhook_delivery_log.ts'

export type { LineWebhookDeliveryLogContext }

export async function fetchLineMessageBinary(
  lineMessageId: string,
  lineAccessToken: string,
  maxBytes = 8 * 1024 * 1024,
): Promise<{ ok: true; bytes: Uint8Array; contentType: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `https://api-data.line.me/v2/bot/message/${encodeURIComponent(lineMessageId)}/content`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${lineAccessToken}` },
      },
    )
    if (!response.ok) {
      const errorText = await response.text()
      return { ok: false, error: `LINE content API ${response.status}: ${errorText}` }
    }
    const lengthHeader = Number(response.headers.get('content-length'))
    if (Number.isFinite(lengthHeader) && lengthHeader > maxBytes) {
      return { ok: false, error: `content too large: ${lengthHeader} bytes` }
    }
    const contentType = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > maxBytes) {
      return { ok: false, error: `content too large: ${arrayBuffer.byteLength} bytes` }
    }
    return { ok: true, bytes: new Uint8Array(arrayBuffer), contentType }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function replyLineMessages(
  replyToken: string,
  messages: Record<string, unknown>[],
  channelAccessToken: string,
  logCtx?: LineWebhookDeliveryLogContext,
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: messages.slice(0, 5),
    }),
  })
  const httpStatus = response.status
  const ok = response.ok
  const errText = ok ? '' : await response.text()

  if (logCtx?.storePartitionKey) {
    void recordLineWebhookDeliveryLog({
      storePartitionKey: logCtx.storePartitionKey,
      method: 'reply',
      context: logCtx.context,
      targetRoomId: logCtx.roomId ?? null,
      attempted: true,
      success: ok,
      httpStatus,
      reason: ok ? 'Webhook経由でLINEへ送信しました。' : `LINE返信APIエラー: ${errText.slice(0, 200)}`,
      details: { message_count: Math.min(messages.length, 5) },
    })
  }

  if (!ok) {
    return { ok: false, error: `LINE reply API ${httpStatus}: ${errText}` }
  }
  return { ok: true }
}

export async function replyLineText(
  replyToken: string,
  text: string,
  channelAccessToken: string,
  logCtx?: LineWebhookDeliveryLogContext,
): Promise<{ ok: boolean; error?: string }> {
  return replyLineMessages(
    replyToken,
    [{ type: 'text', text: String(text ?? '').slice(0, 4900) }],
    channelAccessToken,
    logCtx,
  )
}

export async function replyLineFlex(
  replyToken: string,
  flexMessage: Record<string, unknown>,
  channelAccessToken: string,
  logCtx?: LineWebhookDeliveryLogContext,
): Promise<{ ok: boolean; error?: string }> {
  return replyLineMessages(replyToken, [flexMessage], channelAccessToken, logCtx)
}

export function resolveChannelAccessToken(storeKey: string): string {
  const envKey = `LINE_CHANNEL_ACCESS_TOKEN__${storeKey.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()}`
  const perStore = String(Deno.env.get(envKey) || '').trim()
  if (perStore) return perStore
  return String(Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') || '').trim()
}

export async function pushLineMessages(
  toUserId: string,
  messages: Record<string, unknown>[],
  channelAccessToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const userId = String(toUserId ?? '').trim()
  if (!userId.startsWith('U')) {
    return { ok: false, error: 'invalid user id' }
  }
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: messages.slice(0, 5),
    }),
  })
  if (!response.ok) {
    const errText = await response.text()
    return { ok: false, error: `LINE push API ${response.status}: ${errText}` }
  }
  return { ok: true }
}

export async function pushLineText(
  toUserId: string,
  text: string,
  channelAccessToken: string,
): Promise<{ ok: boolean; error?: string }> {
  return pushLineMessages(
    toUserId,
    [{ type: 'text', text: String(text ?? '').slice(0, 4900) }],
    channelAccessToken,
  )
}

export function resolveGroqApiKey(): string {
  return String(Deno.env.get('GROQ_API_KEY') || '').trim()
}
