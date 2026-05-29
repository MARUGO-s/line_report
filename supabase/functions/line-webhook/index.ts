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
  alignReceiptStoreNameToRegistry,
  receiptStoreNameMatchesRegistry,
  resolveParsedStoreNameForDisplay,
} from '../_shared/receipt_store_name_match.ts'
import { persistLearnedReceiptPhone } from '../_shared/store_receipt_phones.ts'
import type { LineReplyPayload } from '../_shared/receipt_types.ts'
import {
  clearPendingReceiptCorrection,
  handleReceiptCorrectionPostback,
  handleStoreReceiptTextMessage,
  isReceiptCorrectionPostbackData,
  lineReplyPayloadToMessages,
} from '../_shared/receipt_correction.ts'
import {
  computeReceiptHeuristicConfidence,
  mergeReceiptConfidence,
  normalizeInlineText,
  resolveReceiptDateIsoForPersist,
} from '../_shared/receipt_parse.ts'
import { RECEIPT_ANALYSIS_CONFIDENCE_MIN } from '../_shared/receipt_types.ts'
import { analyzeLineImageWithGroqScout } from '../_shared/receipt_vision.ts'
import { ensureRoomAutoLinkedToStore } from '../_shared/auto_link_room.ts'
import { runWebhookDisplayNameSync } from '../_shared/line_display_names.ts'
import {
  isLineRoomMessageRecordingEnabled,
  persistLineRoomMessageFromWebhook,
} from '../_shared/line_room_messages.ts'
import { persistLineRoomSearchArchivesFromWebhook } from '../_shared/line_room_search_archive.ts'
import {
  handleLineSearchPostback,
  handleLineSearchTextMessage,
  isLineDirectMessageChat,
  isLineDirectMessageEvent,
  isLineSearchGuideEnabled,
  loadRoomSearchFlags,
  registerSearchExcludedMessage,
  shouldSkipLineSearchMessageRecording,
  shouldSkipPendingSearchKeywordRecording,
} from '../_shared/line_search_bot.ts'
import {
  createServiceClient,
  type StoreRegistryRow,
} from '../_shared/store_receipt.ts'
import { serveAdminApprovalWebhook } from '../_shared/line_admin_webhook.ts'
import {
  ADMIN_STORE_PARTITION_KEY,
  gateInvitedRoomBotAccess,
  handleStoreFollowForUserApproval,
  tryHandleStoreRegistrationInteraction,
  isInvitedChatRoomId,
  loadLineUserPermissionGate,
  replyLinePermissionBlocked,
  shouldBlockUnapprovedDirectMessage,
} from '../_shared/line_user_approval.ts'

const STORE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/

type LineEvent = {
  type?: string
  webhookEventId?: string
  timestamp?: number
  replyToken?: string
  postback?: { data?: string }
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

function webhookReplyLog(
  registry: StoreRegistryRow,
  roomId: string | null,
  context: string,
) {
  return {
    storePartitionKey: registry.store_partition_key,
    roomId,
    context,
  }
}

function resolveChannelSecret(storeKey: string): string {
  const envKey = `LINE_CHANNEL_SECRET__${storeKey.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()}`
  const perStore = String(Deno.env.get(envKey) || '').trim()
  if (perStore) return perStore
  // 管理Bot(admin)は店舗用 secret にフォールバックしない（署名不一致で 403 になるため）
  if (storeKey === ADMIN_STORE_PARTITION_KEY) return ''
  return String(Deno.env.get('LINE_CHANNEL_SECRET') || '').trim()
}

async function inferStoreKeyFromSignature(
  supabase: NonNullable<ReturnType<typeof createServiceClient>>,
  rawBody: string,
  signatureHeader: string | null,
): Promise<string | null> {
  if (!signatureHeader) return null
  const { data, error } = await supabase
    .from('store_webhook_tables')
    .select('store_partition_key')

  if (error) {
    console.error('inferStoreKeyFromSignature: store list failed:', error.message)
    return null
  }

  const rows = Array.isArray(data) ? data : []
  for (const row of rows) {
    const key = String((row as { store_partition_key?: unknown }).store_partition_key ?? '').trim()
    if (!key || !STORE_KEY_PATTERN.test(key)) continue
    const secret = resolveChannelSecret(key)
    if (!secret) continue
    const valid = await verifyLineSignature(rawBody, signatureHeader, secret)
    if (valid) return key
  }
  return null
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
  suppressAll = false,          // bot_reply_hard_mute_enabled: 一切返信しない
  suppressReceiptReply = false, // !image_analysis_reply_enabled: レシート結果のみ返信しない
  suppressNonReceiptReply = false, // !non_receipt_image_reply_enabled: 非レシート画像の返信のみ抑止
): Promise<{ saved: boolean; replied: boolean; reason?: string }> {
  const lineMessageId = String(event.message?.id ?? '').trim()
  const rawReplyToken = String(event.replyToken ?? '').trim()
  // 非レシート画像（「画像を確認しました」等）の返信: AI返信完全無し、または
  // 「画像解析結果を送信（その他権限）」OFF で抑止。レシート画像の返信とは独立。
  const nonReceiptReplyToken = (suppressAll || suppressNonReceiptReply) ? '' : rawReplyToken
  // レシート関連の返信（解析カード・確信度警告・店舗不一致・取得失敗）:
  // 「レシートの解析結果を送信」OFF のときのみ抑止。AI返信完全無しより優先される。
  const receiptReplyToken = suppressReceiptReply ? '' : rawReplyToken
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
    if (receiptReplyToken) {
      await replyLineText(
        receiptReplyToken,
        '画像の取得に失敗しました。時間をおいて再度お試しください。',
        accessToken,
        webhookReplyLog(registry, roomId, 'receipt_image_fetch_failed'),
      )
    }
    return { saved: false, replied: !!receiptReplyToken, reason: contentFetch.error }
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
    // 非レシート画像の返信: AI返信完全無しのみで抑止（レシート解析返信フラグは関係しない）
    if (nonReceiptReplyToken) {
      await replyLineText(nonReceiptReplyToken, msg, accessToken, webhookReplyLog(registry, roomId, 'receipt_image_no_receipt'))
    }
    return { saved: false, replied: !!nonReceiptReplyToken, reason: analyzed.failure?.stage ?? 'no_receipt' }
  }

  const receiptRaw = analyzed.analysis.receipt
  const alignedStoreName = alignReceiptStoreNameToRegistry(receiptRaw.storeName, registry)
  const receipt = String(alignedStoreName ?? '') !== String(receiptRaw.storeName ?? '')
    ? { ...receiptRaw, storeName: alignedStoreName }
    : receiptRaw
  const confidence = mergeReceiptConfidence(
    computeReceiptHeuristicConfidence(receipt),
    analyzed.analysis.receiptModelConfidence ?? null,
  )
  if (confidence < RECEIPT_ANALYSIS_CONFIDENCE_MIN) {
    const lowMsg = [
      'レシートの自動解析の確信度が低いため、売上登録していません。',
      '影・反射を避け、金額・日付がはっきり読める距離でもう一度撮影してください。',
    ].join('\n')
    if (receiptReplyToken) {
      await replyLineText(receiptReplyToken, lowMsg, accessToken, webhookReplyLog(registry, roomId, 'receipt_image_low_confidence'))
    }
    return { saved: false, replied: !!receiptReplyToken, reason: 'low_confidence' }
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
    if (receiptReplyToken) {
      const flexMessage = buildReceiptStoreMismatchFlexReply(guidance)
      await replyLineFlex(
        receiptReplyToken,
        flexMessage,
        accessToken,
        webhookReplyLog(registry, roomId, 'receipt_store_mismatch'),
      )
    }
    return {
      saved: false,
      replied: !!receiptReplyToken,
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

  if (receiptReplyToken) {
    const messages = lineReplyPayloadToMessages(result.reply)
    const replyResult = await replyLineMessages(
      receiptReplyToken,
      messages,
      accessToken,
      webhookReplyLog(registry, roomId, 'receipt_image_registration'),
    )
    if (!replyResult.ok) {
      console.error('LINE reply failed:', replyResult.error)
    }
  }
  return {
    saved: result.saved,
    replied: !!receiptReplyToken,
    reason: result.saved ? undefined : 'registration_pending_or_failed',
  }
}

async function processReceiptTextEvent(
  registry: StoreRegistryRow,
  event: LineEvent,
  supabase: NonNullable<ReturnType<typeof createServiceClient>>,
  suppressReply = false,
): Promise<{ handled: boolean; replied: boolean; reason?: string }> {
  const text = String(event.message?.text ?? '').trim()
  // AI返信完全無し（bot_reply_hard_mute_enabled）が ON のルームでは返信トークンを空にして
  // 一切返信しない。修正・重複確認・削除などの処理はそのまま継続する。
  const replyToken = suppressReply ? '' : String(event.replyToken ?? '').trim()
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
    await replyLineMessages(
      replyToken,
      messages,
      accessToken,
      webhookReplyLog(registry, roomId, 'receipt_text_reply'),
    )
  }
  return { handled: true, replied: !!replyToken }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const requestedStoreKey = parseStoreKeyFromRequest(req)

  // 管理Bot: 承認専用（店舗Botの DB・レシート・会話記録には触れない）
  if (requestedStoreKey === ADMIN_STORE_PARTITION_KEY) {
    return serveAdminApprovalWebhook(req)
  }

  const supabase = createServiceClient()
  if (!supabase) {
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500)
  }

  let rawBody = ''
  let storeKey = requestedStoreKey && STORE_KEY_PATTERN.test(requestedStoreKey)
    ? requestedStoreKey
    : ''

  if (!storeKey) {
    rawBody = await req.text()
    const signature = req.headers.get('x-line-signature')
    const inferred = await inferStoreKeyFromSignature(supabase, rawBody, signature)
    if (!inferred) {
      return jsonResponse({ ok: false, error: 'store_partition_key required in URL path' }, 400)
    }
    storeKey = inferred
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

  if (!rawBody) rawBody = await req.text()
  const channelSecret = resolveChannelSecret(storeKey)
  const signature = req.headers.get('x-line-signature')
  const valid = await verifyLineSignature(rawBody, signature, channelSecret)
  if (!valid) {
    console.error(
      `webhook signature invalid (store=${storeKey}, hasSecret=${!!channelSecret})`,
    )
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
  const storeDisplayName = String(registry.display_name || registry.store_partition_key || storeKey)

  let rawInserted = 0
  let receiptsSaved = 0
  let receiptReplies = 0
  let textHandled = 0
  let roomsAutoLinked = 0
  let roomMessagesSaved = 0
  let searchGuideHandled = 0
  const autoLinkedRoomIds = new Set<string>()
  const roomMessagePersistTasks: Promise<void>[] = []
  const displayNameUsers = new Map<string, { userId: string; roomId: string | null }>()
  const displayNameRoomIds = new Set<string>()
  const errors: string[] = []
  const userPermissionCache = new Map<string, Awaited<ReturnType<typeof loadLineUserPermissionGate>>>()
  const roomSearchFlagsCache = new Map<string, Awaited<ReturnType<typeof loadRoomSearchFlags>>>()
  const loadRoomSearchFlagsCached = async (
    roomId: string,
  ): Promise<Awaited<ReturnType<typeof loadRoomSearchFlags>>> => {
    if (roomSearchFlagsCache.has(roomId)) return roomSearchFlagsCache.get(roomId)!
    const flags = await loadRoomSearchFlags(supabase, roomId)
    roomSearchFlagsCache.set(roomId, flags)
    return flags
  }
  const storeAccessToken = resolveChannelAccessToken(storeKey)

  for (const event of events) {
    const rawOk = await insertRawWebhookEvent(supabase, rawTable, event)
    if (rawOk) rawInserted += 1

    const eventRoomId = resolveRoomId(event)
    const eventUserId = event.source?.userId ? String(event.source.userId).trim() : ''
    const isDirectMessage = eventRoomId
      ? isLineDirectMessageChat(event, eventRoomId)
      : isLineDirectMessageEvent(event)
    if (eventUserId.startsWith('U')) {
      displayNameUsers.set(eventUserId, { userId: eventUserId, roomId: eventRoomId })
    }
    if (
      eventRoomId
      && (eventRoomId.startsWith('C') || eventRoomId.startsWith('R') || eventRoomId.startsWith('U'))
    ) {
      displayNameRoomIds.add(eventRoomId)
    }

    if (rawOk && eventRoomId && !autoLinkedRoomIds.has(eventRoomId)) {
      autoLinkedRoomIds.add(eventRoomId)
      try {
        const linkResult = await ensureRoomAutoLinkedToStore(
          supabase,
          storeKey,
          eventRoomId,
          { undismissOnLink: true, restoreIfDismissed: true },
        )
        if (linkResult.linked) roomsAutoLinked += 1
      } catch (linkErr) {
        const msg = linkErr instanceof Error ? linkErr.message : String(linkErr)
        console.error('ensureRoomAutoLinkedToStore failed:', msg)
      }
    }

    if (
      eventRoomId
      && isInvitedChatRoomId(eventRoomId)
      && storeAccessToken
    ) {
      try {
        const roomGate = await gateInvitedRoomBotAccess(
          supabase,
          eventRoomId,
          storeKey,
          storeDisplayName,
          storeAccessToken,
          event,
        )
        if (!roomGate.allowed) {
          if (roomGate.replied) receiptReplies += 1
          continue
        }
      } catch (e) {
        console.error('gateInvitedRoomBotAccess failed:', String(e))
      }
    }

    if (
      isDirectMessage
      && eventUserId.startsWith('U')
      && event.type === 'follow'
      && storeAccessToken
    ) {
      try {
        await handleStoreFollowForUserApproval(
          supabase,
          eventUserId,
          storeKey,
          storeDisplayName,
          storeAccessToken,
          event,
        )
      } catch (e) {
        console.error('handleStoreFollowForUserApproval failed:', String(e))
      }
      continue
    }

    if (
      isDirectMessage
      && eventUserId.startsWith('U')
      && storeAccessToken
      && (event.type === 'message' || event.type === 'postback')
    ) {
      try {
        const reg = await tryHandleStoreRegistrationInteraction(
          supabase,
          event,
          storeKey,
          storeDisplayName,
          storeAccessToken,
        )
        if (reg.handled) {
          if (reg.replied) receiptReplies += 1
          continue
        }
      } catch (e) {
        console.error('tryHandleStoreRegistrationInteraction failed:', String(e))
      }
    }

    if (isDirectMessage && eventUserId.startsWith('U')) {
      let gate = userPermissionCache.get(eventUserId)
      if (!gate) {
        gate = await loadLineUserPermissionGate(supabase, eventUserId)
        userPermissionCache.set(eventUserId, gate)
      }
      if (shouldBlockUnapprovedDirectMessage(event, gate)) {
        try {
          const replied = await replyLinePermissionBlocked(event, registry.store_partition_key)
          if (replied) receiptReplies += 1
        } catch (e) {
          console.error('replyLinePermissionBlocked failed:', String(e))
        }
        continue
      }
    }

    // AI返信完全無し（bot_reply_hard_mute_enabled）: このルームでは一切返信しない。
    // レシートの解析結果を送信（image_analysis_reply_enabled）: OFF なら解析カード等を返信しない。
    // レシート修正の返信を許可（receipt_correction_reply_enabled）: ON なら AI返信完全無しでも
    //   修正系の返信（修正ボタン・加算/中止/置換・削除確認）を送る（解析返信と同じ優先ロジック）。
    // 生ログ・レシート保存・会話記録などの処理はそのまま継続する。
    let roomHardMuted = false
    let suppressReceiptReply = false
    let suppressNonReceiptReply = false
    let allowCorrectionReply = false
    if (eventRoomId) {
      const muteFlags = await loadRoomSearchFlagsCached(eventRoomId)
      roomHardMuted = !!muteFlags?.bot_reply_hard_mute_enabled
      // flags が null（DB エラー）のときはデフォルト送信（suppress = false）
      suppressReceiptReply = muteFlags !== null ? !muteFlags.image_analysis_reply_enabled : false
      suppressNonReceiptReply = muteFlags !== null ? !muteFlags.non_receipt_image_reply_enabled : false
      allowCorrectionReply = muteFlags !== null ? !!muteFlags.receipt_correction_reply_enabled : false
    }

    if (event.type === 'message' && event.message?.type === 'image') {
      try {
        const result = await processReceiptImageEvent(registry as StoreRegistryRow, event, roomHardMuted, suppressReceiptReply, suppressNonReceiptReply)
        if (result.saved) receiptsSaved += 1
        if (result.replied) receiptReplies += 1
        if (result.reason && !result.saved) {
          errors.push(normalizeInlineText(result.reason).slice(0, 160))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('processReceiptImageEvent failed:', msg)
        errors.push(msg.slice(0, 160))
        const replyToken = roomHardMuted ? '' : String(event.replyToken ?? '').trim()
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

    const lineAccessTokenForSearch = resolveChannelAccessToken(storeKey)

    if (event.type === 'postback' && lineAccessTokenForSearch) {
      const postbackData = String(event.postback?.data ?? '').trim()
      const eventRoomIdForPostback = resolveRoomId(event)
      const postbackUserId = event.source?.userId ? String(event.source.userId) : null
      const postbackReplyToken = String(event.replyToken ?? '').trim()

      if (isReceiptCorrectionPostbackData(postbackData) && postbackReplyToken && eventRoomIdForPostback) {
        try {
          const correctionPayload = await handleReceiptCorrectionPostback(
            supabase,
            registry as StoreRegistryRow,
            eventRoomIdForPostback,
            postbackUserId,
            postbackData,
          )
          if (correctionPayload) {
            // 修正は適用済み。AI返信完全無しでも「レシート修正の返信を許可」がONなら返信する。
            if (!roomHardMuted || allowCorrectionReply) {
              await replyLineMessages(
                postbackReplyToken,
                lineReplyPayloadToMessages(correctionPayload),
                lineAccessTokenForSearch,
                {
                  storePartitionKey: storeKey,
                  roomId: eventRoomIdForPostback,
                  context: 'receipt_correction_postback',
                },
              )
              receiptReplies += 1
            }
            continue
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('handleReceiptCorrectionPostback failed:', msg)
          errors.push(msg.slice(0, 160))
        }
      }

      if (isLineSearchGuideEnabled()) {
        try {
          const searchResult = await handleLineSearchPostback(
            supabase,
            event,
            lineAccessTokenForSearch,
            storeKey,
          )
          if (searchResult.handled) searchGuideHandled += 1
          if (searchResult.replied) receiptReplies += 1
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('handleLineSearchPostback failed:', msg)
          errors.push(msg.slice(0, 160))
        }
      }
    }

    let skipSearchMessageRecording = false
    if (event.type === 'message' && event.message?.type === 'text') {
      const text = String(event.message?.text ?? '').trim()
      const eventUserId = event.source?.userId ? String(event.source.userId).trim() : ''
      if (text && eventRoomId && eventUserId) {
        if (isDirectMessage) {
          // 1対1: 検索待ちのキーワード1通のみ記録しない（「検索」等の操作トークは記録する）
          skipSearchMessageRecording = await shouldSkipPendingSearchKeywordRecording(
            supabase,
            eventRoomId,
            eventUserId,
          )
        } else {
          const roomFlags = await loadRoomSearchFlagsCached(eventRoomId)
          skipSearchMessageRecording = await shouldSkipLineSearchMessageRecording(
            supabase,
            eventRoomId,
            eventUserId,
            text,
            {
              salesSearchAllowed: !!(
                roomFlags?.receipt_midreport_enabled || roomFlags?.receipt_monthend_report_enabled
              ),
            },
          )
        }
      }

      let receiptHandled = false
      try {
        const result = await processReceiptTextEvent(registry as StoreRegistryRow, event, supabase, roomHardMuted && !allowCorrectionReply)
        receiptHandled = result.handled
        if (result.handled) textHandled += 1
        if (result.replied) receiptReplies += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('processReceiptTextEvent failed:', msg)
        errors.push(msg.slice(0, 160))
      }

      if (!receiptHandled && isLineSearchGuideEnabled() && lineAccessTokenForSearch) {
        try {
          const searchResult = await handleLineSearchTextMessage(
            supabase,
            registry as StoreRegistryRow,
            event,
            lineAccessTokenForSearch,
          )
          if (searchResult.handled) {
            searchGuideHandled += 1
            if (!isDirectMessage) {
              skipSearchMessageRecording = true
            }
          }
          if (searchResult.replied) receiptReplies += 1
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('handleLineSearchTextMessage failed:', msg)
          errors.push(msg.slice(0, 160))
        }
      }

      if (skipSearchMessageRecording && eventRoomId) {
        const lineMessageId = String(event.message?.id ?? '').trim()
        if (lineMessageId) {
          await registerSearchExcludedMessage(supabase, lineMessageId, eventRoomId, text)
        }
      }
    }

    if (
      isLineRoomMessageRecordingEnabled()
      && event.type === 'message'
      && event.message
      && eventRoomId
      && !skipSearchMessageRecording
    ) {
      roomMessagePersistTasks.push(
        persistLineRoomMessageFromWebhook(supabase, event, eventRoomId)
          .then((result) => {
            if (result.saved) roomMessagesSaved += 1
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            console.error('persistLineRoomMessageFromWebhook failed:', msg)
          }),
      )
      roomMessagePersistTasks.push(
        persistLineRoomSearchArchivesFromWebhook(supabase, event, eventRoomId)
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            console.error('persistLineRoomSearchArchivesFromWebhook failed:', msg)
          }),
      )
    }
  }

  if (roomMessagePersistTasks.length > 0) {
    const persistPromise = Promise.all(roomMessagePersistTasks).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('room message persist batch failed:', msg)
    })
    EdgeRuntime.waitUntil(persistPromise)
  }

  const lineAccessToken = resolveChannelAccessToken(storeKey)
  if (
    lineAccessToken
    && (displayNameUsers.size > 0 || displayNameRoomIds.size > 0)
  ) {
    const displayNamePromise = runWebhookDisplayNameSync(
      supabase,
      lineAccessToken,
      displayNameUsers.values(),
      displayNameRoomIds,
    ).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('runWebhookDisplayNameSync failed:', msg)
    })
    EdgeRuntime.waitUntil(displayNamePromise)
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
    rooms_auto_linked: roomsAutoLinked,
    room_messages_saved: roomMessagesSaved,
    search_guide_handled: searchGuideHandled,
    errors,
  }, errors.length > 0 && rawInserted === 0 && receiptsSaved === 0 && textHandled === 0 ? 500 : 200)
})
