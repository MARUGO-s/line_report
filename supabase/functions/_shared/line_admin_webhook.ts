import {
  ADMIN_STORE_PARTITION_KEY,
  handleAdminApprovalEvents,
} from './line_user_approval.ts'
import { createServiceClient } from './store_receipt.ts'

type LineEvent = {
  type?: string
  replyToken?: string
  postback?: { data?: string }
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string }
  message?: { type?: string; text?: string; id?: string }
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function verifyLineSignature(
  rawBody: string,
  signatureHeader: string | null,
  channelSecret: string,
): Promise<boolean> {
  if (!channelSecret) return true
  if (!signatureHeader) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  const hashArray = Array.from(new Uint8Array(signatureBuffer))
  const hashString = String.fromCharCode(...hashArray)
  const hashBase64 = btoa(hashString)
  return hashBase64 === signatureHeader
}

function resolveAdminChannelSecret(): string {
  return String(Deno.env.get('LINE_CHANNEL_SECRET__ADMIN') || '').trim()
}

/**
 * 管理Bot専用 Webhook（利用許可の承認のみ）。
 * 会話記録・レシート・検索・ルーム連携などは一切行わない。
 */
export async function serveAdminApprovalWebhook(
  req: Request,
  rawBody?: string,
): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const supabase = createServiceClient()
  if (!supabase) {
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500)
  }

  const bodyText = rawBody ?? await req.text()
  const channelSecret = resolveAdminChannelSecret()
  const signature = req.headers.get('x-line-signature')
  const valid = await verifyLineSignature(bodyText, signature, channelSecret)
  if (!valid) {
    if (!channelSecret) {
      console.error('admin webhook: LINE_CHANNEL_SECRET__ADMIN is not set')
    } else {
      console.error('admin webhook: signature invalid')
    }
    return new Response('Forbidden', { status: 403 })
  }

  let payload: { events?: LineEvent[] }
  try {
    payload = JSON.parse(bodyText)
  } catch {
    return jsonResponse({ ok: false, error: 'invalid JSON body' }, 400)
  }

  const events = Array.isArray(payload.events) ? payload.events : []
  const result = await handleAdminApprovalEvents(supabase, events)

  return jsonResponse({
    ok: result.errors.length === 0,
    store_partition_key: ADMIN_STORE_PARTITION_KEY,
    mode: 'approval_only',
    processed: events.length,
    replies: result.replies,
    errors: result.errors,
  }, result.errors.length > 0 ? 500 : 200)
}
