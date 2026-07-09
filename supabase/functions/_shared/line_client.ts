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
  // fetch は Authorization ヘッダに不可視文字が混入していると例外を投げる（"is not a valid ByteString"）。
  // 例外で沈黙せず、必ず delivery log に残して {ok:false} を返す（呼び出し側の処理を壊さない）。
  let response: Response
  try {
    response = await fetch('https://api.line.me/v2/bot/message/reply', {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('replyLineMessages fetch threw:', msg)
    if (logCtx?.storePartitionKey) {
      void recordLineWebhookDeliveryLog({
        storePartitionKey: logCtx.storePartitionKey,
        method: 'reply',
        context: logCtx.context,
        targetRoomId: logCtx.roomId ?? null,
        attempted: true,
        success: false,
        httpStatus: 0,
        reason: `LINE返信が例外で失敗: ${msg.slice(0, 200)}`,
        details: { message_count: Math.min(messages.length, 5) },
      })
    }
    return { ok: false, error: `LINE reply threw: ${msg}` }
  }
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

// コピー&ペースト由来の不可視文字（全角空白・ゼロ幅文字・改行等）を除去する。
// LINEトークンはASCIIのみ。混入すると fetch が "is not a valid ByteString" 例外で
// 全返信・画像取得が沈黙する（2026-06 bistrocavacava 移管時の実障害。gmail-alert-cron と同じ対策）。
function sanitizeLineToken(raw: unknown): string {
  return String(raw ?? '').replace(/[^\x21-\x7e]/g, '')
}

export function resolveChannelAccessToken(storeKey: string): string {
  const envKey = `LINE_CHANNEL_ACCESS_TOKEN__${storeKey.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()}`
  const perStore = sanitizeLineToken(Deno.env.get(envKey))
  if (perStore) return perStore
  return sanitizeLineToken(Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN'))
}

export async function pushLineMessages(
  toUserId: string,
  messages: Record<string, unknown>[],
  channelAccessToken: string,
  logCtx?: LineWebhookDeliveryLogContext,
): Promise<{ ok: boolean; error?: string }> {
  const userId = String(toUserId ?? '').trim()
  if (!userId.startsWith('U')) {
    return { ok: false, error: 'invalid user id' }
  }
  let response: Response
  try {
    response = await fetch('https://api.line.me/v2/bot/message/push', {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('pushLineMessages fetch threw:', msg)
    if (logCtx?.storePartitionKey) {
      void recordLineWebhookDeliveryLog({
        storePartitionKey: logCtx.storePartitionKey,
        method: 'push',
        context: logCtx.context,
        targetRoomId: userId,
        attempted: true,
        success: false,
        httpStatus: 0,
        reason: `LINEプッシュが例外で失敗: ${msg.slice(0, 200)}`,
        details: { message_count: Math.min(messages.length, 5) },
      })
    }
    return { ok: false, error: `LINE push threw: ${msg}` }
  }
  const httpStatus = response.status
  const ok = response.ok
  const errText = ok ? '' : await response.text()

  if (logCtx?.storePartitionKey) {
    void recordLineWebhookDeliveryLog({
      storePartitionKey: logCtx.storePartitionKey,
      method: 'push',
      context: logCtx.context,
      targetRoomId: userId,
      attempted: true,
      success: ok,
      httpStatus,
      reason: ok ? 'プッシュ通知でLINEへ送信しました。' : `LINEプッシュAPIエラー: ${errText.slice(0, 200)}`,
      details: { message_count: Math.min(messages.length, 5) },
    })
  }

  if (!ok) {
    return { ok: false, error: `LINE push API ${httpStatus}: ${errText}` }
  }
  return { ok: true }
}

export async function pushLineText(
  toUserId: string,
  text: string,
  channelAccessToken: string,
  logCtx?: LineWebhookDeliveryLogContext,
): Promise<{ ok: boolean; error?: string }> {
  return pushLineMessages(
    toUserId,
    [{ type: 'text', text: String(text ?? '').slice(0, 4900) }],
    channelAccessToken,
    logCtx,
  )
}

/**
 * グループ(C…)/ルーム(R…)/1:1(U…) のいずれの宛先にも push できる版。
 * pushLineMessages は U 宛てのみ許可するため、ルーム/グループへ送る用途で使う。
 */
export async function pushLineTextToTarget(
  to: string,
  text: string,
  channelAccessToken: string,
  logCtx?: LineWebhookDeliveryLogContext,
): Promise<{ ok: boolean; error?: string }> {
  return pushLineMessagesToTarget(to, [{ type: 'text', text: String(text ?? '').slice(0, 4900) }], channelAccessToken, logCtx)
}

/**
 * グループ(C…)/ルーム(R…)/1:1(U…) のいずれの宛先にも任意のメッセージ配列（Flex等）を push できる版。
 * pushLineTextToTarget のテキスト専用版はこの薄いラッパーになっている。
 */
export async function pushLineMessagesToTarget(
  to: string,
  messages: Record<string, unknown>[],
  channelAccessToken: string,
  logCtx?: LineWebhookDeliveryLogContext,
): Promise<{ ok: boolean; error?: string }> {
  const target = String(to ?? '').trim()
  if (!/^[UCR]/.test(target)) {
    return { ok: false, error: 'invalid push target' }
  }
  let response: Response
  try {
    response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify({
        to: target,
        messages: messages.slice(0, 5),
      }),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('pushLineMessagesToTarget fetch threw:', msg)
    if (logCtx?.storePartitionKey) {
      void recordLineWebhookDeliveryLog({
        storePartitionKey: logCtx.storePartitionKey,
        method: 'push',
        context: logCtx.context,
        targetRoomId: target,
        attempted: true,
        success: false,
        httpStatus: 0,
        reason: `LINEプッシュが例外で失敗: ${msg.slice(0, 200)}`,
        details: { message_count: Math.min(messages.length, 5) },
      })
    }
    return { ok: false, error: `LINE push threw: ${msg}` }
  }
  const httpStatus = response.status
  const ok = response.ok
  const errText = ok ? '' : await response.text()

  if (logCtx?.storePartitionKey) {
    void recordLineWebhookDeliveryLog({
      storePartitionKey: logCtx.storePartitionKey,
      method: 'push',
      context: logCtx.context,
      targetRoomId: target,
      attempted: true,
      success: ok,
      httpStatus,
      reason: ok ? 'プッシュ通知でLINEへ送信しました。' : `LINEプッシュAPIエラー: ${errText.slice(0, 200)}`,
      details: { message_count: Math.min(messages.length, 5) },
    })
  }

  if (!ok) {
    return { ok: false, error: `LINE push API ${httpStatus}: ${errText}` }
  }
  return { ok: true }
}

export function resolveGroqApiKey(): string {
  return String(Deno.env.get('GROQ_API_KEY') || '').trim()
}

export function resolveGeminiApiKey(): string {
  return String(Deno.env.get('GEMINI_API_KEY') || '').trim()
}

/**
 * レシート画像解析で Gemini を使う店舗のモデル。RECEIPT_GEMINI_MODEL で差し替え可。
 * 既定は gemini-3.1-pro-preview（旧 gemini-3-pro-preview は提供終了=404 のため後継へ更新）。
 */
export function resolveReceiptGeminiModel(): string {
  return String(Deno.env.get('RECEIPT_GEMINI_MODEL') || '').trim() || 'gemini-3.1-pro-preview'
}
