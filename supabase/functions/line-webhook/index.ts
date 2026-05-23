import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import {
  fetchLineMessageBinary,
  replyLineText,
  resolveChannelAccessToken,
  resolveGroqApiKey,
} from '../_shared/line_client.ts'
import {
  buildReceiptTextReply,
  computeReceiptHeuristicConfidence,
  mergeReceiptConfidence,
  normalizeInlineText,
  resolveReceiptDateIsoForPersist,
} from '../_shared/receipt_parse.ts'
import { RECEIPT_ANALYSIS_CONFIDENCE_MIN } from '../_shared/receipt_types.ts'
import { analyzeLineImageWithGroqScout } from '../_shared/receipt_vision.ts'
import {
  createServiceClient,
  loadMonthCumulativeTotalsForStoreTable,
  saveStoreReceiptEntry,
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
  if (groupId) return groupId
  if (roomId) return roomId
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
  const saveResult = await saveStoreReceiptEntry(supabase, registry.receipt_table, {
    lineMessageId,
    roomId,
    userId: event.source?.userId ? String(event.source.userId) : null,
    senderDisplayName: null,
    storeDisplayName,
    receipt,
    summary: analyzed.analysis.summary,
  })

  if (saveResult.duplicate) {
    if (replyToken) {
      await replyLineText(replyToken, 'このレシートは既に登録済みです。', accessToken)
    }
    return { saved: false, replied: !!replyToken, reason: 'duplicate' }
  }
  if (!saveResult.ok) {
    console.error('saveStoreReceiptEntry failed:', saveResult.error)
    if (replyToken) {
      await replyLineText(replyToken, 'レシートの保存に失敗しました。', accessToken)
    }
    return { saved: false, replied: !!replyToken, reason: saveResult.error ?? 'save_failed' }
  }

  const receiptDateIso = resolveReceiptDateIsoForPersist(receipt.date)
  const monthTotals = await loadMonthCumulativeTotalsForStoreTable(
    supabase,
    registry.receipt_table,
    receiptDateIso,
  )
  const replyText = buildReceiptTextReply(receipt, storeDisplayName, monthTotals)
  if (replyToken) {
    await replyLineText(replyToken, replyText, accessToken)
  }
  return { saved: true, replied: !!replyToken }
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
      }
    }
  }

  return jsonResponse({
    ok: errors.length === 0 || rawInserted > 0 || receiptsSaved > 0,
    store_partition_key: storeKey,
    webhook_raw_table: rawTable,
    receipt_table: registry.receipt_table,
    processed: events.length,
    raw_inserted: rawInserted,
    receipts_saved: receiptsSaved,
    receipt_replies: receiptReplies,
    errors,
  }, errors.length > 0 && rawInserted === 0 && receiptsSaved === 0 ? 500 : 200)
})
