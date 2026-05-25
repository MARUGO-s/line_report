import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import {
  fetchLineMessageBinary,
  replyLineFlex,
  replyLineMessages,
  replyLineText,
  resolveChannelAccessToken,
  resolveGroqApiKey,
} from '../_shared/line_client.ts'
import {
  clearPendingReceiptDuplicate,
} from '../_shared/receipt_duplicate.ts'
import { attemptReceiptRegistration } from '../_shared/receipt_save_flow.ts'
import {
  buildReceiptStoreMismatchFlexReply,
  buildStoreMismatchGuidance,
  clearPendingStoreNameMismatch,
} from '../_shared/receipt_store_mismatch.ts'
import {
  receiptStoreNameMatchesRegistry,
  resolveParsedStoreNameForDisplay,
} from '../_shared/receipt_store_name_match.ts'
import { persistLearnedReceiptPhone } from '../_shared/store_receipt_phones.ts'
import type { LineReplyPayload } from '../_shared/receipt_types.ts'
import { clearPendingReceiptCorrection, handleStoreReceiptTextMessage, lineReplyPayloadToMessages } from '../_shared/receipt_correction.ts'
import {
  computeReceiptHeuristicConfidence,
  mergeReceiptConfidence,
  normalizeInlineText,
  resolveReceiptDateIsoForPersist,
} from '../_shared/receipt_parse.ts'
import { RECEIPT_ANALYSIS_CONFIDENCE_MIN } from '../_shared/receipt_types.ts'
import { analyzeLineImageWithGroqScout } from '../_shared/receipt_vision.ts'
import {
  createServiceClient,
  type StoreRegistryRow,
} from '../_shared/store_receipt.ts'

const STORE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/

type LineEvent = {
  type?: string
  webhookEventId?: string
  timestamp?: number
  replyToken?: string
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string }
  message?: { id?: string; type?: string; text?: string }
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function parseStoreKeyFromRequest(req: Request): string | null {
  const url = new URL(req.url)
  const parts = url.pathname.split('/').filter(Boolean)
  const idx = parts.lastIndexOf('line-webhook')
  if (idx >= 0 && parts.length > idx + 1) {
    return decodeURIComponent(parts[idx + 1] || '').trim()
  }
  const last = parts[parts.length - 1] || ''
  if (last && last !== 'line-webhook') return decodeURIComponent(last).trim()
  return null
}

function resolveRoomId(event: LineEvent): string | null {
  const source = event.source || {}
  const groupId = source.groupId ? String(source.groupId).trim() : ''
  const roomId = source.roomId ? String(source.roomId).trim() : ''
  const userId = source.userId ? String(source.userId).trim() : ''
  if (groupId) return groupId
  if (roomId) return roomId
  // 1:1 トーク（公式アカウントへの直接送信）も room 相当として扱う
  if (userId && String(source.type || '').trim() === 'user') return userId
  return null
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

function resolveChannelSecret(storeKey: string): string {
  const envKey = `LINE_CHANNEL_SECRET__${storeKey.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()}`
  const perStore = String(Deno.env.get(envKey) || '').trim()
  if (perStore) return perStore
  return String(Deno.env.get('LINE_CHANNEL_SECRET') || '').trim()
}

async function insertRawWebhookEvent(
  supabase: NonNullable<ReturnType<typeof createServiceClient>>,
  rawTable: string,
  event: LineEvent,
): Promise<boolean> {
  const webhookEventId = String(
    event.webhookEventId || `${event.timestamp || Date.now()}-${Math.random()}`,
  ).trim()
  const { error } = await supabase.from(rawTable).insert({
    webhook_event_id: webhookEventId || null,
    event_type: String(event.type || 'unknown'),
    room_id: resolveRoomId(event),
    user_id: event.source?.userId ? String(event.source.userId) : null,
    payload: event,
  })
  if (error && String(error.code) !== '23505') {
    console.error(`insert ${rawTable} failed:`, error.message)
    return false
  }
  return true
}

async function processReceiptImageEvent(
  registry: StoreRegistryRow,
  event: LineEvent,
): Promise<{ saved: boolean; replied: boolean; reason?: string }> {
  const lineMessageId = String(event.message?.id ?? '').trim()
  const replyToken = String(event.replyToken ?? '').trim()
  const roomId = resolveRoomId(event)
  if (!lineMessageId || !roomId) {
    return { saved: false, replied: false, reason: 'missing_line_message_or_room' }
  }

  const accessToken = resolveChannelAccessToken(registry.store_partition_key)
  if (!accessToken) {
    return { saved: false, replied: false, reason: 'missing_line_access_token' }
  }

  const groqApiKey = resolveGroqApiKey()
  const contentFetch = await fetchLineMessageBinary(lineMessageId, accessToken)
  if (!contentFetch.ok) {
    if (replyToken) {
      await replyLineText(replyToken, '画像の取得に失敗しました。時間をおいて再度お試しください。', accessToken)
    }
    return { saved: false, replied: !!replyToken, reason: contentFetch.error }
  }

  const analyzed = await analyzeLineImageWithGroqScout(
    contentFetch.bytes,
    contentFetch.contentType,
    lineMessageId,
    groqApiKey,
  )

  if (!analyzed.analysis?.receipt) {
    const msg = analyzed.analysis?.summary
      ? `画像を確認しました。\n${analyzed.analysis.summary}`
      : 'レシートとして読み取れる項目がありませんでした。'
    if (replyToken) await replyLineText(replyToken, msg, accessToken)
    return { saved: false, replied: !!replyToken, reason: analyzed.failure?.stage ?? 'no_receipt' }
  }

  const receipt = analyzed.analysis.receipt
  const confidence = mergeReceiptConfidence(
    computeReceiptHeuristicConfidence(receipt),
    analyzed.analysis.receiptModelConfidence ?? null,
  )
  if (confidence < RECEIPT_ANALYSIS_CONFIDENCE_MIN) {
    const lowMsg = [
      'レシートの自動解析の確信度が低いため、売上登録していません。',
      '影・反射を避け、金額・日付がはっきり読める距離でもう一度撮影してください。',
    ].join('\n')
    if (replyToken) await replyLineText(replyToken, lowMsg, accessToken)
    return { saved: false, replied: !!replyToken, reason: 'low_confidence' }
  }

  const supabase = createServiceClient()
  if (!supabase) return { saved: false, replied: false, reason: 'server_misconfigured' }

  const storeDisplayName = registry.display_name || registry.store_partition_key
  const receiptDateIso = resolveReceiptDateIsoForPersist(receipt.date)
  const userId = event.source?.userId ? String(event.source.userId) : null
  const parsedStoreName = resolveParsedStoreNameForDisplay(receipt.storeName)

  const registrationPayload = {
    line_message_id: lineMessageId,
    room_id: roomId,
    user_id: userId,
    receipt_date: receiptDateIso,
    receipt_payload: receipt,
    summary_text: analyzed.analysis.summary ?? null,
    store_display_name: storeDisplayName,
    sender_display_name: null as string | null,
  }

  const currentStoreMatched = receiptStoreNameMatchesRegistry(
    storeDisplayName,
    registry.store_partition_key,
    receipt.storeName,
    receipt.storePhone,
    registry.receipt_phones,
  )

  if (!currentStoreMatched) {
    await clearPendingReceiptCorrection(supabase, roomId, userId)
    await clearPendingReceiptDuplicate(supabase, roomId, userId)
    await clearPendingStoreNameMismatch(supabase, roomId, userId)
    const guidance = await buildStoreMismatchGuidance(
      supabase,
      registry,
      storeDisplayName,
      parsedStoreName,
      receipt,
    )
    if (guidance.suggestedStore && receipt.storePhone) {
      try {
        await persistLearnedReceiptPhone(
          supabase,
          guidance.suggestedStore.store_partition_key,
          receipt.storePhone,
          guidance.suggestedStore.receipt_phones,
        )
      } catch (e) {
        console.error('persist learned receipt phone (suggested store) failed:', String(e))
      }
    }
    if (replyToken) {
      const flexMessage = buildReceiptStoreMismatchFlexReply(guidance)
      await replyLineFlex(replyToken, flexMessage, accessToken)
    }
    return {
      saved: false,
      replied: !!replyToken,
      reason: 'store_name_mismatch_resend_required',
    }
  }

  await clearPendingStoreNameMismatch(supabase, roomId, userId)
  await clearPendingReceiptDuplicate(supabase, roomId, userId)
  if (receipt.storePhone) {
    try {
      await persistLearnedReceiptPhone(
        supabase,
        registry.store_partition_key,
        receipt.storePhone,
        registry.receipt_phones,
      )
    } catch (e) {
      console.error('persist learned receipt phone (current store) failed:', String(e))
    }
  }
  const result = await attemptReceiptRegistration(supabase, registry, registrationPayload)

  if (replyToken) {
    const messages = lineReplyPayloadToMessages(result.reply)
    const replyResult = await replyLineMessages(replyToken, messages, accessToken)
    if (!replyResult.ok) {
      console.error('LINE reply failed:', replyResult.error)
    }
  }
  return {
    saved: result.saved,
    replied: !!replyToken,
    reason: result.saved ? undefined : 'registration_pending_or_failed',
  }
}

async function processReceiptTextEvent(
  registry: StoreRegistryRow,
  event: LineEvent,
  supabase: NonNullable<ReturnType<typeof createServiceClient>>,
): Promise<{ handled: boolean; replied: boolean; reason?: string }> {
  const text = String(event.message?.text ?? '').trim()
  const replyToken = String(event.replyToken ?? '').trim()
  const roomId = resolveRoomId(event)
  if (!text || !roomId) {
    return { handled: false, replied: false, reason: 'missing_text_or_room' }
  }

  const accessToken = resolveChannelAccessToken(registry.store_partition_key)
  if (!accessToken) {
    return { handled: false, replied: false, reason: 'missing_line_access_token' }
  }

  const userId = event.source?.userId ? String(event.source.userId) : null
  const replyPayload = await handleStoreReceiptTextMessage(
    supabase,
    registry,
    roomId,
    userId,
    text,
  )
  if (!replyPayload) return { handled: false, replied: false }

  if (replyToken) {
    const messages = lineReplyPayloadToMessages(replyPayload)
    await replyLineMessages(replyToken, messages, accessToken)
  }
  return { handled: true, replied: !!replyToken }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const storeKey = parseStoreKeyFromRequest(req)
  if (!storeKey || !STORE_KEY_PATTERN.test(storeKey)) {
    return jsonResponse({ ok: false, error: 'store_partition_key required in URL path' }, 400)
  }

  const supabase = createServiceClient()
  if (!supabase) {
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500)
  }

  const { data: registry, error: registryError } = await supabase
    .from('store_webhook_tables')
    .select('store_partition_key, display_name, webhook_raw_table, receipt_table')
    .eq('store_partition_key', storeKey)
    .maybeSingle()

  if (registryError) {
    console.error('store_webhook_tables lookup failed:', registryError.message)
    return jsonResponse({ ok: false, error: 'registry lookup failed' }, 500)
  }
  if (!registry) {
    return jsonResponse({ ok: false, error: `unknown store: ${storeKey}` }, 404)
  }

  const rawBody = await req.text()
  const channelSecret = resolveChannelSecret(storeKey)
  const signature = req.headers.get('x-line-signature')
  const valid = await verifyLineSignature(rawBody, signature, channelSecret)
  if (!valid) {
    return new Response('Forbidden', { status: 403 })
  }

  let payload: { events?: LineEvent[] }
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return jsonResponse({ ok: false, error: 'invalid JSON body' }, 400)
  }

  const events = Array.isArray(payload.events) ? payload.events : []
  const rawTable = String(registry.webhook_raw_table)
  let rawInserted = 0
  let receiptsSaved = 0
  let receiptReplies = 0
  let textHandled = 0
  const errors: string[] = []

  for (const event of events) {
    const rawOk = await insertRawWebhookEvent(supabase, rawTable, event)
    if (rawOk) rawInserted += 1

    if (event.type === 'message' && event.message?.type === 'image') {
      try {
        const result = await processReceiptImageEvent(registry as StoreRegistryRow, event)
        if (result.saved) receiptsSaved += 1
        if (result.replied) receiptReplies += 1
        if (result.reason && !result.saved) {
          errors.push(normalizeInlineText(result.reason).slice(0, 160))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('processReceiptImageEvent failed:', msg)
        errors.push(msg.slice(0, 160))
        const replyToken = String(event.replyToken ?? '').trim()
        if (replyToken) {
          try {
            const accessToken = resolveChannelAccessToken(registry.store_partition_key)
            if (accessToken) {
              await replyLineText(
                replyToken,
                'レシート処理中にエラーが発生しました。時間をおいて再度お試しください。',
                accessToken,
              )
              receiptReplies += 1
            }
          } catch (replyErr) {
            console.error('failed to send error reply:', replyErr)
          }
        }
      }
    }

    if (event.type === 'message' && event.message?.type === 'text') {
      try {
        const result = await processReceiptTextEvent(registry as StoreRegistryRow, event, supabase)
        if (result.handled) textHandled += 1
        if (result.replied) receiptReplies += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('processReceiptTextEvent failed:', msg)
        errors.push(msg.slice(0, 160))
      }
    }
  }

  return jsonResponse({
    ok: errors.length === 0 || rawInserted > 0 || receiptsSaved > 0 || textHandled > 0,
    store_partition_key: storeKey,
    webhook_raw_table: rawTable,
    receipt_table: registry.receipt_table,
    processed: events.length,
    raw_inserted: rawInserted,
    receipts_saved: receiptsSaved,
    text_handled: textHandled,
    receipt_replies: receiptReplies,
    errors,
  }, errors.length > 0 && rawInserted === 0 && receiptsSaved === 0 && textHandled === 0 ? 500 : 200)
})
