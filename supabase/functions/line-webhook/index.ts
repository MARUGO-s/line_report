import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import {
  fetchLineMessageBinary,
  pushLineTextToTarget,
  replyLineFlex,
  replyLineMessages,
  replyLineText,
  resolveChannelAccessToken,
  resolveGeminiApiKey,
  resolveGroqApiKey,
  resolveReceiptGeminiModel,
} from '../_shared/line_client.ts'
import {
  clearPendingReceiptDuplicate,
} from '../_shared/receipt_duplicate.ts'
import { attemptReceiptRegistration } from '../_shared/receipt_save_flow.ts'
import { saveRoomMediaToLibrary } from '../_shared/line_media_store.ts'
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
import type { LineImageAnalysisResult, LineReplyPayload } from '../_shared/receipt_types.ts'
import {
  clearPendingReceiptCorrection,
  handleReceiptCorrectionPostback,
  handleStoreReceiptTextMessage,
  isReceiptCorrectionPostbackData,
  lineReplyPayloadToMessages,
} from '../_shared/receipt_correction.ts'
import {
  applySauvageNetSalesAsGrossSales,
  computeReceiptHeuristicConfidence,
  mergeReceiptConfidence,
  normalizeInlineText,
  resolveReceiptDateIsoForPersist,
} from '../_shared/receipt_parse.ts'
import { RECEIPT_ANALYSIS_CONFIDENCE_MIN } from '../_shared/receipt_types.ts'
import { analyzeLineImageWithGemini, analyzeLineImageWithGroqScout, type LineImageVisionUsage } from '../_shared/receipt_vision.ts'
import {
  combineStoreReceiptPromptAdditions,
  fetchStoreReceiptAnalysisPromptAddition,
  resolveBuiltinStoreReceiptPrompt,
} from '../_shared/receipt_prompt.ts'
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
): Promise<'inserted' | 'duplicate' | 'error'> {
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
  if (!error) return 'inserted'
  // 23505 = unique_violation。同一 webhook_event_id の再送＝既に処理済み。
  // 返信・処理の重複を防ぐため、呼び出し側でこのイベントをスキップする。
  if (String(error.code) === '23505') return 'duplicate'
  console.error(`insert ${rawTable} failed:`, error.message)
  return 'error'
}

/** 期間集計（GP/期間）レポート用の「売上登録しません」通知（リッチテキスト=Flex）を組み立てる。 */
function buildReceiptNonSalesNoticeFlex(summaryText: string): Record<string, unknown> {
  const detail = String(summaryText || '').trim()
  const bodyContents: Record<string, unknown>[] = [
    { type: 'text', text: '期間集計レポート', weight: 'bold', size: 'md', color: '#1a6fa8' },
    { type: 'separator', margin: 'md' },
    {
      type: 'text',
      text: 'このレシートは日々の売上レシートではないため、売上には登録していません。',
      wrap: true,
      size: 'sm',
      color: '#333333',
      margin: 'md',
    },
  ]
  if (detail) {
    bodyContents.push({ type: 'text', text: detail, wrap: true, size: 'xs', color: '#8a96a3', margin: 'sm' })
  }
  return {
    type: 'flex',
    altText: 'このレシートは日々の売上ではないため登録していません（期間集計レポート）',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'none', contents: bodyContents },
    },
  }
}

// レシート画像解析に Gemini を使う店舗（手書き数字などの読み取り精度向上が目的）。他店は Groq のまま。
const GEMINI_RECEIPT_STORE_KEYS = new Set<string>(['sauvage', 'sushikoruri'])

// Gemini 採用店で「レシートらしさ」を示すテキストの手掛かり（Groq 事前判定の summary を見る）。
// 注意: お品書き/メニューにも出る価格系トークン（円・¥・金額・税込・税抜・総額・売価）は誤昇格を招くため含めない。
// ここに残すのは「売上集計書類」に固有で、料理メニューには通常出ない語のみ。
const RECEIPT_LIKELIHOOD_TEXT =
  /売上|日報|領収|レシート|レポート|精算|合計|小計|消費税|客数|組数|来客|純売/

// Gemini 採用店向けの事前判定: まず安価な Groq で解析し、レシートの可能性があれば高価な Gemini へ「昇格」させる。
// 【重要な学び】お品書き（寿司ネタ/料理名の一覧）は「店名＋日付＋items」を持つため、Groq が kind=receipt と
// 誤判定すると normalizeLineImageReceiptAnalysis が非null の receipt を返す。旧実装は「receipt が非null」
// だけで昇格していたため、金額が皆無のお品書きでも Gemini へ昇格していた（2026-06-04 実機で確認）。
// そこで昇格条件を「売上の集計が実際に読めているか（金額または組数/客数/単価）」に厳格化する。
// 手書き売上日報の取りこぼし対策として、Groq失敗時・summary に売上系の強い語句がある時も昇格させる（安全側）。
function shouldEscalateToGeminiReceipt(analysis: LineImageAnalysisResult | null): boolean {
  if (!analysis) return true // Groq が解析できなかった → 安全側で Gemini を呼ぶ
  const r = analysis.receipt
  // 「売上の集計」が実際に読めている＝金額(総/純/税)または 組数/客数/単価 → レシート/売上日報の可能性大。
  // 店名・日付・品目（ネタ一覧）だけでは昇格しない（＝お品書きを弾く核心）。
  if (r && (r.grossSales || r.netSales || r.taxAmount || r.partyCount || r.guestCount || r.unitPrice)) {
    return true
  }
  // Groq が kind=general にした取りこぼし対策: summary に売上系の強い語句があれば昇格。
  if (RECEIPT_LIKELIHOOD_TEXT.test(String(analysis.summary ?? ''))) return true
  return false // 売上の手掛かりが皆無（お品書き・献立・メニュー等）→ 無解析・無反応
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

  const supabase = createServiceClient()
  if (!supabase) return { saved: false, replied: false, reason: 'server_misconfigured' }
  // 店舗別レシート解析プロンプト = コード常駐ルール（恒久）＋ DB追記（任意）。
  // 例: 鮨こるりは手書きの「売上日報」を必ずレシート扱いにするルールをコード側で保証する。
  const dbReceiptPromptAddition = await fetchStoreReceiptAnalysisPromptAddition(
    supabase,
    registry.store_partition_key,
  )
  const receiptPromptAddition = combineStoreReceiptPromptAdditions(
    resolveBuiltinStoreReceiptPrompt(registry.store_partition_key),
    dbReceiptPromptAddition,
  )

  // 一部店舗（ソバージュ・鮨こるり）は Gemini で解析する（手書き数字などの読み取り精度向上が目的）。
  const useGeminiForReceipt = GEMINI_RECEIPT_STORE_KEYS.has(String(registry.store_partition_key ?? ''))
  const receiptGeminiModel = resolveReceiptGeminiModel()
  const GROQ_RECEIPT_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

  // AI使用料ページの「実測」表示用に、APIが返した実測トークンを1行記録する。
  // best-effort: 失敗してもレシート処理は止めない（売上登録・返信が最優先）。
  const recordAiUsage = async (
    provider: 'gemini' | 'groq',
    model: string,
    usage: LineImageVisionUsage | null | undefined,
  ): Promise<void> => {
    if (!usage) return
    try {
      const { error: usageErr } = await supabase.from('ai_usage_events').insert({
        store_partition_key: registry.store_partition_key,
        provider,
        model,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        thinking_tokens: usage.thinkingTokens,
        total_tokens: usage.totalTokens,
        line_message_id: lineMessageId,
      })
      if (usageErr) console.error('ai_usage_events insert failed:', usageErr.message)
    } catch (e) {
      console.error('ai_usage_events insert threw:', (e instanceof Error ? e.message : String(e)).slice(0, 200))
    }
  }

  let analyzed: Awaited<ReturnType<typeof analyzeLineImageWithGroqScout>>

  if (useGeminiForReceipt) {
    // 手順1: まず安価な Groq で「レシートか否か」だけ事前判定する（お品書き等の非レシート画像を弾く）。
    const pre = await analyzeLineImageWithGroqScout(
      contentFetch.bytes,
      contentFetch.contentType,
      lineMessageId,
      groqApiKey,
      receiptPromptAddition,
    )
    await recordAiUsage('groq', GROQ_RECEIPT_MODEL, pre.usage)

    if (!shouldEscalateToGeminiReceipt(pre.analysis)) {
      // 売上の手掛かりが皆無（メニュー・献立・お品書き等）→ Gemini を呼ばず、解析中push も結果返信もしない。
      console.log(
        `[receipt_pre_filter] skip non-receipt image (store=${registry.store_partition_key}, msg=${lineMessageId})`,
      )
      return { saved: false, replied: false, reason: 'pre_filter_non_receipt' }
    }

    // 手順2: レシートの可能性あり → ここで初めて「解析中」push を送り、Gemini で高精度解析へ昇格する。
    // receiptReplyToken が空（レシート返信OFF）の部屋には送らない＝結果返信と歩調を合わせる。
    if (receiptReplyToken) {
      await pushLineTextToTarget(
        roomId,
        '📸 画像を受け付けました。\nAI（Gemini）で内容を解析しています。高精度な解析のため、結果のご案内まで少しお時間（最大1分ほど）をいただく場合があります。少々お待ちください。',
        accessToken,
      )
    }

    const gem = await analyzeLineImageWithGemini(
      contentFetch.bytes,
      contentFetch.contentType,
      lineMessageId,
      resolveGeminiApiKey(),
      receiptPromptAddition,
      receiptGeminiModel,
    )
    if (gem.analysis) {
      analyzed = gem
      await recordAiUsage('gemini', receiptGeminiModel, gem.usage)
    } else {
      // Gemini が失敗したら、手順1で得た Groq の事前判定結果をそのまま使う（当店の解析を止めない）。
      console.error(
        `Gemini receipt analysis failed (store=${registry.store_partition_key}); using Groq pre-classification:`,
        gem.failure?.stage,
        gem.failure?.message,
      )
      analyzed = pre
    }
  } else {
    // Gemini 非採用店（大多数）は従来どおり Groq のみで解析する。
    analyzed = await analyzeLineImageWithGroqScout(
      contentFetch.bytes,
      contentFetch.contentType,
      lineMessageId,
      groqApiKey,
      receiptPromptAddition,
    )
    await recordAiUsage('groq', GROQ_RECEIPT_MODEL, analyzed.usage)
  }

  // 期間集計／グループ期間（GP）レポートは「売上レシート」ではないため、売上に加算せず返信もしない。
  // 店舗プロンプト（例: マルゴオット）が、期間/日付範囲を含む集計レポートの summary に
  // 「期間集計レポート」等のマーカーを入れることで判定する。
  const analyzedSummaryText = String(analyzed.analysis?.summary ?? '')
  if (/期間集計|日付範囲|GP（グループ）|ＧＰ（グループ）|［期間］|\[期間\]/.test(analyzedSummaryText)) {
    // 売上には登録しないが、「これは日々の売上ではないので登録していません」の通知を返信する。
    // 重要: この通知は receiptReplyToken を使う。
    //   - AI返信完全無し(hard mute)であっても送る（レシート解析返信はhard muteをバイパスする）。
    //   - ただし「レシートの解析結果を送信」(image_analysis_reply_enabled) が OFF のときは送らない。
    if (receiptReplyToken) {
      await replyLineFlex(
        receiptReplyToken,
        buildReceiptNonSalesNoticeFlex(analyzedSummaryText),
        accessToken,
        webhookReplyLog(registry, roomId, 'receipt_period_summary_notice'),
      )
    }
    return { saved: false, replied: !!receiptReplyToken, reason: 'period_summary_skip' }
  }

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
  const receiptAligned = String(alignedStoreName ?? '') !== String(receiptRaw.storeName ?? '')
    ? { ...receiptRaw, storeName: alignedStoreName }
    : receiptRaw
  // ソバージュは「総売上」に出前の預かり金が含まれるため、売上は「純売上」を採用する。
  const receipt = applySauvageNetSalesAsGrossSales(receiptAligned, registry.store_partition_key)
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
  let duplicateSkipped = 0
  let mediaSaved = 0
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
    const rawStatus = await insertRawWebhookEvent(supabase, rawTable, event)
    if (rawStatus === 'duplicate') {
      // 同一 webhook_event_id を既に処理済み（LINE の再送）。
      // 返信・記録・自動連携などの重複を防ぐため、このイベントは丸ごとスキップする。
      duplicateSkipped += 1
      continue
    }
    const rawOk = rawStatus === 'inserted'
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
    let allowMediaSave = true
    if (eventRoomId) {
      const muteFlags = await loadRoomSearchFlagsCached(eventRoomId)
      roomHardMuted = !!muteFlags?.bot_reply_hard_mute_enabled
      // flags が null（DB エラー）のときはデフォルト送信（suppress = false）
      suppressReceiptReply = muteFlags !== null ? !muteFlags.image_analysis_reply_enabled : false
      suppressNonReceiptReply = muteFlags !== null ? !muteFlags.non_receipt_image_reply_enabled : false
      allowCorrectionReply = muteFlags !== null ? !!muteFlags.receipt_correction_reply_enabled : false
      // メディア保存（メディア閲覧）: OFF のルームは保存しない。null（DBエラー）時は既定で保存。
      allowMediaSave = muteFlags !== null ? muteFlags.media_save_enabled !== false : true
    }

    // メディア閲覧用の保存（画像/動画/音声/ファイル）。1ルーム合計20MBまで、超過分は古い順に自動削除。
    // ルームの「メディア保存」権限が OFF のときは保存しない。
    if (
      event.type === 'message'
      && eventRoomId
      && storeAccessToken
      && allowMediaSave
      && ['image', 'video', 'audio', 'file'].includes(String(event.message?.type || ''))
    ) {
      try {
        const mediaResult = await saveRoomMediaToLibrary(supabase, {
          roomId: eventRoomId,
          storeKey: registry.store_partition_key || storeKey || null,
          userId: eventUserId || null,
          lineMessageId: String(event.message?.id || ''),
          mediaType: String(event.message?.type || ''),
          fileName: String(event.message?.type) === 'file'
            ? String((event.message as { fileName?: string } | undefined)?.fileName || '')
            : '',
          accessToken: storeAccessToken,
        })
        if (mediaResult.saved) mediaSaved += 1
      } catch (mediaErr) {
        console.error('saveRoomMediaToLibrary failed:', mediaErr instanceof Error ? mediaErr.message : String(mediaErr))
      }
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
            // 修正は適用済み。レシート操作の返信は AI返信完全無しの対象外。
            // 「レシートの解析結果を送信」または「レシート修正の返信を許可」がONなら返信する。
            if (!suppressReceiptReply || allowCorrectionReply) {
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
        // レシート操作の返信（重複確認 加算/中止/置き換え・修正・削除の結果）は AI返信完全無しの対象外。
        // 「レシートの解析結果を送信」または「レシート修正の返信を許可」の両方OFFのときだけ抑止する。
        const result = await processReceiptTextEvent(registry as StoreRegistryRow, event, supabase, suppressReceiptReply && !allowCorrectionReply)
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
    ok: errors.length === 0 || rawInserted > 0 || receiptsSaved > 0 || textHandled > 0 || searchGuideHandled > 0,
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
    duplicate_skipped: duplicateSkipped,
    media_saved: mediaSaved,
    errors,
    // 成功した検索（searchGuideHandled）も「処理済み」とみなし、500→LINE再送→重複返信を防ぐ。
  }, errors.length > 0 && rawInserted === 0 && receiptsSaved === 0 && textHandled === 0 && searchGuideHandled === 0 ? 500 : 200)
})
