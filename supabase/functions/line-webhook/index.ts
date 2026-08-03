import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import {
  fetchLineMessageBinary,
  replyLineFlex,
  replyLineMessages,
  replyLineText,
  resolveChannelAccessToken,
  resolveGeminiApiKey,
  resolveReceiptGeminiFlashModel,
  resolveReceiptGeminiFlashLiteModel,
  resolveReceiptGeminiModel,
} from '../_shared/line_client.ts'
import {
  clearPendingReceiptDuplicate,
} from '../_shared/receipt_duplicate.ts'
import { attemptReceiptRegistration } from '../_shared/receipt_save_flow.ts'
import { maybeHandleFoodCourtReport, handleFoodCourtReportPostback } from '../_shared/foodcourt_compare.ts'
import { handleBudgetEntryTextMessage } from '../_shared/budget_entry_flow.ts'
import { extractExpenseFromReceipt, handlePettyCashTextMessage, handlePettyCashImageIfPending, handlePettyCashPostback, savePettyCashPendingFromReceipt, handlePettyCashCashOutSlip } from '../_shared/petty_cash_flow.ts'
import { handleRoomConfigTextMessage } from '../_shared/room_config_link.ts'
import { saveRoomMediaToLibrary } from '../_shared/line_media_store.ts'
import {
  countExistingReceiptsForDates,
  importDailyReceiptsOverwrite,
  importManualMonthSalesOverwrite,
  parseMonthlyDailySalesWorkbook,
  resolveReceiptTableForStore,
  type ManualMonthImportEntry,
} from '../_shared/daily_sales_import.ts'
import { fetchManualMonthSales, type ManualMonthSalesRecord } from '../_shared/manual_month_sales.ts'
import { resolveReceiptNamePartitionKey } from '../_shared/receipt_store_name_resolve.ts'
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
import type { LineImageAnalysisResult, LineImageReservationAnalysis, LineReplyPayload } from '../_shared/receipt_types.ts'
import {
  clearPendingReceiptCorrection,
  handleReceiptCorrectionPostback,
  handleStoreReceiptTextMessage,
  isReceiptCorrectionPostbackData,
  lineReplyPayloadToMessages,
} from '../_shared/receipt_correction.ts'
import type { ReceiptReplyVisibilityOptions } from '../_shared/receipt_flex_reply.ts'
import {
  applySauvageNetSalesAsGrossSales,
  computeReceiptHeuristicConfidence,
  mergeReceiptConfidence,
  normalizeInlineText,
  isSingleDayPeriodSettlementReport,
  resolveReceiptDateIsoForPersist,
} from '../_shared/receipt_parse.ts'
import { RECEIPT_ANALYSIS_CONFIDENCE_MIN } from '../_shared/receipt_types.ts'
import { analyzeExpenseReceiptWithAzureFoundry, analyzeLineImageWithAzureFoundry, analyzeLineImageWithClaude, analyzeLineImageWithGemini, AZURE_FOUNDRY_VISION_MODEL, needsGeminiProPettyCashReview, shouldFallbackLineImageVisionFailure, type LineImageVisionUsage } from '../_shared/receipt_vision.ts'
import {
  combineStoreReceiptPromptAdditions,
  EXPENSE_RECEIPT_PROMPT_ADDITION,
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
import { recordLineWebhookDeliveryLog } from '../_shared/line_webhook_delivery_log.ts'
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
const DAILY_SALES_TEMPLATE_KEY = 'daily_sales_management_xlsx'
const DAILY_SALES_TEMPLATE_FILENAME = '日別売上管理表.xlsx'

type LineEvent = {
  type?: string
  webhookEventId?: string
  timestamp?: number
  replyToken?: string
  postback?: { data?: string; params?: { date?: string } }
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string }
  message?: { id?: string; type?: string; text?: string }
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(String(base64 || '').replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function buildTemplateDownloadUrl(storeKey: string): string {
  const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '')
  const base = supabaseUrl
    ? `${supabaseUrl}/functions/v1/line-webhook`
    : 'https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/line-webhook'
  return `${base}/${encodeURIComponent(storeKey)}?download=${encodeURIComponent(DAILY_SALES_TEMPLATE_KEY)}`
}

async function maybeServeTemplateDownload(
  req: Request,
  supabase: NonNullable<ReturnType<typeof createServiceClient>>,
): Promise<Response | null> {
  const url = new URL(req.url)
  const requested = String(url.searchParams.get('download') || '').trim()
  if (!requested) return null
  if (requested !== DAILY_SALES_TEMPLATE_KEY) return jsonResponse({ ok: false, error: 'unknown template' }, 404)

  const { data, error } = await supabase
    .from('line_file_templates')
    .select('filename, content_type, content_base64')
    .eq('template_key', DAILY_SALES_TEMPLATE_KEY)
    .maybeSingle()

  if (error) {
    console.error('line_file_templates lookup failed:', error.message)
    return jsonResponse({ ok: false, error: 'template lookup failed' }, 500)
  }
  if (!data) return jsonResponse({ ok: false, error: 'template not found' }, 404)

  const row = data as { filename?: unknown; content_type?: unknown; content_base64?: unknown }
  const filename = String(row.filename || DAILY_SALES_TEMPLATE_FILENAME)
  const encodedFilename = encodeURIComponent(filename)
  const contentType = String(row.content_type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const bytes = decodeBase64Bytes(String(row.content_base64 || ''))

  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="daily-sales-template.xlsx"; filename*=UTF-8''${encodedFilename}`,
      'Cache-Control': 'private, max-age=300',
    },
  })
}

function isDailySalesTemplateRequestText(text: string): boolean {
  const compact = String(text || '').replace(/\s+/g, '').toLowerCase()
  if (!compact) return false
  const exact = new Set([
    '日別売上管理表',
    '月次日別売上管理表',
    '売上管理表',
    '売上管理表テンプレート',
    '日別売上テンプレート',
    '過去売上テンプレート',
    'excelテンプレート',
    'エクセルテンプレート',
  ])
  if (exact.has(compact)) return true
  const asksTemplate = compact.includes('テンプレ') || compact.includes('ひな形') || compact.includes('雛形') || compact.includes('フォーマット') || compact.includes('ダウンロード')
  const asksSalesSheet = compact.includes('売上') || compact.includes('日別') || compact.includes('excel') || compact.includes('エクセル')
  return asksTemplate && asksSalesSheet
}

function buildDailySalesTemplateDownloadFlex(storeKey: string): Record<string, unknown> {
  return {
    type: 'flex',
    altText: '日別売上管理表テンプレートのダウンロード',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '日別売上管理表テンプレート', weight: 'bold', size: 'md', wrap: true },
          { type: 'text', text: '過去売上をLINEから登録するための基本Excelです。ダウンロードして金額を入力し、このトークへ送信してください。', size: 'sm', color: '#666666', wrap: true, margin: 'sm' },
          { type: 'text', text: '月合計だけ登録する場合は、B37「合計だけ入力」に総売上を入れてください。', size: 'xs', color: '#888888', wrap: true, margin: 'md' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            action: {
              type: 'uri',
              label: 'Excelをダウンロード',
              uri: buildTemplateDownloadUrl(storeKey),
            },
          },
        ],
      },
    },
  }
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
  // フェイルクローズ: secret 未設定なら署名を検証できない＝拒否する
  // （旧実装は return true で署名検証を素通ししていた＝偽造 webhook 注入の余地があった）
  if (!channelSecret) return false
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

// ───────── 予約スクショ取込（予約確認画面 → 確認カード → 登録） ─────────

// "YYYY-MM-DD" + "HH:MM"（JST）を UTC ISO に変換。Edge は UTC 実行のため JST→UTC は -9h で構成する。
function combineReservationVisitAtIso(date: string | null, time: string | null): string | null {
  const dm = String(date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!dm) return null
  const y = Number(dm[1]), mo = Number(dm[2]), d = Number(dm[3])
  let h = 0, mi = 0
  const tm = String(time ?? '').match(/^(\d{1,2}):(\d{2})$/)
  if (tm) { h = Number(tm[1]); mi = Number(tm[2]) }
  const ms = Date.UTC(y, mo - 1, d, h - 9, mi, 0)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

// 抽出した予約から、予約表が解釈する reservation_detail(JSON文字列)を組み立てる。
function buildReservationImportDetailJson(r: LineImageReservationAnalysis): string {
  const detail: Record<string, unknown> = { route: '予約スクショ', reservationSite: '予約スクショ' }
  if (r.storeName) detail.storeName = r.storeName
  if (r.customerName) detail.customerName = r.customerName
  if (r.partySize) detail.partySize = r.partySize
  if (r.course) detail.plan = r.course
  if (r.tableNo) detail.table = r.tableNo
  if (r.allergy) detail.allergy = r.allergy
  if (r.dislikes) detail.dislikes = r.dislikes
  if (r.anniversary) detail.anniversary = r.anniversary
  if (r.notes) detail.notes = r.notes
  if (r.bookingDate) detail.bookingDate = r.bookingDate
  if (r.date) detail.visitDateTime = `${r.date}${r.time ? ' ' + r.time : ''}`
  return JSON.stringify(detail)
}

// 氏名は空白除去、電話番号は数字のみに正規化して比較する（OCR/表記ゆれ「080-6260-2238」と
// 「08062602238」、姓名間の全角/半角スペース差異などを吸収するため）。
function normalizeReservationName(s: string | null | undefined): string {
  return String(s ?? '').replace(/[\s　]+/g, '').trim()
}
function normalizeReservationPhone(s: string | null | undefined): string {
  return String(s ?? '').replace(/[^\d]/g, '')
}

// 予約スクショの重複検知: 同店舗・同日（JSTの暦日）・同氏名・同電話番号の既存予約
// (manual_reservation_visit_events、非表示を除く)を1件返す。無ければ null。
// 「別予約」の誤爆を避けるため、氏名・電話のどちらかが読めない場合や日付不明の場合は検索しない。
async function findSameDayManualReservationMatch(
  supabase: NonNullable<ReturnType<typeof createServiceClient>>,
  storeKey: string,
  customerName: string | null | undefined,
  customerPhone: string | null | undefined,
  dateYmd: string | null | undefined,
): Promise<{ id: number; visit_at: string } | null> {
  const name = normalizeReservationName(customerName)
  const phone = normalizeReservationPhone(customerPhone)
  if (!name || !phone || !storeKey) return null
  const dayStart = combineReservationVisitAtIso(String(dateYmd ?? ''), '00:00')
  if (!dayStart) return null
  const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 3600 * 1000).toISOString()
  const { data, error } = await supabase
    .from('manual_reservation_visit_events')
    .select('id, visit_at, customer_name, customer_phone')
    .eq('manual_store_key', storeKey)
    .eq('manual_hidden', false)
    .gte('visit_at', dayStart)
    .lt('visit_at', dayEnd)
  if (error || !Array.isArray(data)) return null
  for (const row of data as Array<{ id: number; visit_at: string; customer_name: string | null; customer_phone: string | null }>) {
    if (
      normalizeReservationName(row.customer_name) === name &&
      normalizeReservationPhone(row.customer_phone) === phone
    ) {
      return { id: row.id, visit_at: row.visit_at }
    }
  }
  return null
}

function reservationFieldRowsForFlex(
  r: LineImageReservationAnalysis,
  visitAtIso: string | null,
): Record<string, unknown>[] {
  const rows: Array<[string, string | null]> = [
    ['店舗', r.storeName],
    ['来店日時', visitAtIso ? `${r.date ?? ''}${r.time ? ' ' + r.time : ''}`.trim() : (r.date || null)],
    ['予約登録日', r.bookingDate],
    ['予約者', r.customerName],
    ['電話', r.customerPhone],
    ['人数', r.partySize],
    ['コース', r.course],
    ['卓', r.tableNo],
    ['アレルギー', r.allergy],
    ['苦手・嫌い', r.dislikes],
    ['記念日', r.anniversary],
    ['メモ', r.notes],
  ]
  return rows
    .filter(([, v]) => v && String(v).trim())
    .map(([label, v]) => ({
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        { type: 'text', text: label, size: 'sm', color: '#8a96a3', flex: 2 },
        { type: 'text', text: String(v), size: 'sm', color: '#333333', flex: 5, wrap: true },
      ],
    }))
}

// 解析した予約内容の確認カード。
//   通常時: 「この内容で登録」/「破棄」の2択。
//   existingMatch あり（同店舗・同日・同氏名・同電話番号の予約が既に登録済み）のときは、
//   誤って別予約として重複登録しないよう「更新する（上書き）」を1st候補にした3択にする。
function buildReservationConfirmFlex(
  pendingId: number,
  r: LineImageReservationAnalysis,
  visitAtIso: string | null,
  existingMatch: { id: number; visit_at: string } | null = null,
): Record<string, unknown> {
  const altParts = [r.storeName, r.date, r.time, r.customerName].filter(Boolean).join(' ')
  const isDuplicate = !!existingMatch
  const headerContents: Record<string, unknown>[] = isDuplicate
    ? [
        { type: 'text', text: '⚠ 同じ日に同じお客様の予約が既にあります', weight: 'bold', size: 'md', color: '#c0392b' },
        {
          type: 'text',
          text: `既存の登録内容: ${formatReservationVisitLabelJst(existingMatch!.visit_at)}\n変更後の内容と見比べて、更新するか新規の別予約として登録するか選んでください。`,
          wrap: true,
          size: 'xs',
          color: '#8a96a3',
        },
      ]
    : [
        { type: 'text', text: '予約を登録しますか？', weight: 'bold', size: 'md', color: '#1a6fa8' },
        { type: 'text', text: '予約確認画面を読み取りました。内容を確認して登録してください。', wrap: true, size: 'xs', color: '#8a96a3' },
      ]
  const footerButtons: Record<string, unknown>[] = isDuplicate
    ? [
        {
          type: 'button',
          style: 'primary',
          color: '#c0392b',
          action: { type: 'postback', label: '更新する（上書き）', data: `resv_update=${pendingId}`, displayText: '予約内容を更新します' },
        },
        {
          type: 'button',
          style: 'secondary',
          action: { type: 'postback', label: '別予約として新規登録', data: `resv_imp=${pendingId}`, displayText: '別予約として登録します' },
        },
        {
          type: 'button',
          style: 'secondary',
          action: { type: 'postback', label: '破棄（登録しない）', data: `resv_imp_skip=${pendingId}`, displayText: '予約登録を取りやめます' },
        },
      ]
    : [
        {
          type: 'button',
          style: 'primary',
          color: '#1a6fa8',
          action: { type: 'postback', label: 'この内容で登録', data: `resv_imp=${pendingId}`, displayText: '予約を登録します' },
        },
        {
          type: 'button',
          style: 'secondary',
          action: { type: 'postback', label: '破棄（登録しない）', data: `resv_imp_skip=${pendingId}`, displayText: '予約登録を取りやめます' },
        },
      ]
  return {
    type: 'flex',
    altText: `予約の登録確認: ${altParts}`.slice(0, 380),
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          ...headerContents,
          { type: 'separator', margin: 'md' },
          ...reservationFieldRowsForFlex(r, visitAtIso),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: footerButtons,
      },
    },
  }
}

// 予約確認画面を検知 → pending に保存して確認カードを返信（本登録は postback で）。
async function handleReservationImageDetected(
  supabase: NonNullable<ReturnType<typeof createServiceClient>>,
  registry: StoreRegistryRow,
  roomId: string,
  replyToken: string,
  accessToken: string,
  lineMessageId: string,
  reservation: LineImageReservationAnalysis,
  _summary: string,
): Promise<{ saved: boolean; replied: boolean; reason?: string }> {
  const storeKey = String(registry.store_partition_key ?? '').trim()
  const visitAtIso = combineReservationVisitAtIso(reservation.date, reservation.time)

  // 同店舗・同日・同氏名・同電話番号の予約が既に登録済みなら、確認カードで「更新」を選べるようにする
  // （「変更」スクショを送っても新規の別予約として重複登録されてしまうのを防ぐ）。
  const existingMatch = await findSameDayManualReservationMatch(
    supabase,
    storeKey,
    reservation.customerName,
    reservation.customerPhone,
    reservation.date,
  )

  // べき等化: 同一 line_message_id で pending 済みなら再利用（Webhook 再送で二重カードを出さない）。
  let pendingId: number | null = null
  try {
    const { data: existing } = await supabase
      .from('pending_reservation_imports')
      .select('id')
      .eq('line_message_id', lineMessageId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (existing && (existing as { id?: number }).id) pendingId = Number((existing as { id?: number }).id)
  } catch (_e) { /* noop */ }

  if (pendingId == null) {
    const payload = {
      visit_at: visitAtIso,
      customer_name: reservation.customerName,
      customer_phone: reservation.customerPhone,
      party_size: reservation.partySize,
      plan: reservation.course,
      store_name: reservation.storeName,
      table: reservation.tableNo,
      booking_date: reservation.bookingDate,
      status: reservation.status,
      allergy: reservation.allergy,
      dislikes: reservation.dislikes,
      anniversary: reservation.anniversary,
      notes: reservation.notes,
      reservation_type: reservation.status || '予約',
      reservation_detail: buildReservationImportDetailJson(reservation),
      manual_store_key: storeKey || null,
    }
    const { data: ins, error } = await supabase
      .from('pending_reservation_imports')
      .insert({
        room_id: roomId,
        store_partition_key: storeKey || null,
        line_message_id: lineMessageId,
        payload,
        status: 'pending',
        existing_event_id: existingMatch?.id ?? null,
      })
      .select('id')
      .single()
    if (error) {
      console.error('pending_reservation_imports insert failed:', error.message)
      return { saved: false, replied: false, reason: 'reservation_pending_insert_failed' }
    }
    pendingId = Number((ins as { id?: number } | null)?.id ?? 0)
  }

  if (!replyToken || !pendingId) {
    return { saved: false, replied: false, reason: 'reservation_detected_no_reply' }
  }
  await replyLineFlex(
    replyToken,
    buildReservationConfirmFlex(pendingId, reservation, visitAtIso, existingMatch),
    accessToken,
    webhookReplyLog(registry, roomId, 'reservation_image_confirm'),
  )
  return { saved: false, replied: true, reason: existingMatch ? 'reservation_confirm_card_duplicate' : 'reservation_confirm_card' }
}

function buildSimpleNoticeFlex(text: string): Record<string, unknown> {
  return {
    type: 'flex',
    altText: text.slice(0, 380),
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text, wrap: true, size: 'sm', color: '#333333' }] },
    },
  }
}

// UTC ISO → JST "M月D日(曜) HH:MM" 表示。
function formatReservationVisitLabelJst(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const j = new Date(d.getTime() + 9 * 3600 * 1000)
  const wd = ['日', '月', '火', '水', '木', '金', '土'][j.getUTCDay()]
  return `${j.getUTCMonth() + 1}月${j.getUTCDate()}日(${wd}) ${String(j.getUTCHours()).padStart(2, '0')}:${String(j.getUTCMinutes()).padStart(2, '0')}`
}

function buildReservationRegisteredFlex(
  payload: Record<string, unknown>,
  visitAtIso: string,
  visitStats: { visit_count: number; recent_visits: Array<{ visit_at?: string | null }> } | null = null,
): Record<string, unknown> {
  const str = (v: unknown) => { const s = String(v ?? '').trim(); return s || null }
  const rows: Array<[string, string | null]> = [
    ['店舗', str(payload.store_name)],
    ['来店日時', visitAtIso ? formatReservationVisitLabelJst(visitAtIso) : null],
    ['予約登録日', str(payload.booking_date)],
    ['予約者', str(payload.customer_name)],
    ['電話', str(payload.customer_phone)],
    ['人数', str(payload.party_size)],
    ['コース', str(payload.plan)],
    ['アレルギー', str(payload.allergy)],
    ['苦手・嫌い', str(payload.dislikes)],
    ['記念日', str(payload.anniversary)],
    ['メモ', str(payload.notes)],
  ]
  const fieldBoxes = rows.filter(([, v]) => v).map(([label, v]) => ({
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#8a96a3', flex: 2 },
      { type: 'text', text: String(v), size: 'sm', color: '#333333', flex: 5, wrap: true },
    ],
  }))
  // メール予約と同じく「予約回数」「過去の予約」を表示（partner='manual' の履歴/サマリ集計）。
  const historyContents: Record<string, unknown>[] = []
  if (visitStats) {
    const recentLabels = (visitStats.recent_visits ?? [])
      .map((it) => { const iso = String(it?.visit_at ?? '').trim(); return iso ? formatReservationVisitLabelJst(iso) : null })
      .filter((v): v is string => !!v)
      .slice(0, 5)
    historyContents.push({ type: 'separator', margin: 'md' })
    historyContents.push({
      type: 'box', layout: 'baseline', spacing: 'sm',
      contents: [
        { type: 'text', text: '予約回数', size: 'sm', color: '#8a96a3', flex: 2 },
        { type: 'text', text: `${visitStats.visit_count}回`, size: 'sm', color: '#333333', flex: 5, wrap: true },
      ],
    })
    if (recentLabels.length > 0) {
      historyContents.push({ type: 'text', text: '過去の予約', size: 'xs', color: '#8a96a3', margin: 'sm' })
      for (const label of recentLabels) {
        historyContents.push({ type: 'text', text: `・${label}`, size: 'xs', color: '#333333', wrap: true })
      }
    }
  }
  return {
    type: 'flex',
    altText: '予約を登録しました',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '✅ 予約を登録しました', weight: 'bold', size: 'md', color: '#1a7f37' },
          { type: 'separator', margin: 'md' },
          ...fieldBoxes,
          ...historyContents,
          { type: 'text', text: '予約表・本日のご予約に反映され、予約回数・過去の予約にも算入されます。', size: 'xs', color: '#8a96a3', margin: 'md', wrap: true },
        ],
      },
    },
  }
}

// 既存予約を「更新（上書き）」した結果カード。新規登録と違い、予約回数は変わらない
// （同一予約の内容変更のため）ことが分かるようメッセージを分ける。
function buildReservationUpdatedFlex(
  payload: Record<string, unknown>,
  visitAtIso: string,
): Record<string, unknown> {
  const str = (v: unknown) => { const s = String(v ?? '').trim(); return s || null }
  const rows: Array<[string, string | null]> = [
    ['店舗', str(payload.store_name)],
    ['来店日時', visitAtIso ? formatReservationVisitLabelJst(visitAtIso) : null],
    ['予約者', str(payload.customer_name)],
    ['電話', str(payload.customer_phone)],
    ['人数', str(payload.party_size)],
    ['コース', str(payload.plan)],
    ['アレルギー', str(payload.allergy)],
    ['苦手・嫌い', str(payload.dislikes)],
    ['記念日', str(payload.anniversary)],
    ['メモ', str(payload.notes)],
  ]
  const fieldBoxes = rows.filter(([, v]) => v).map(([label, v]) => ({
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#8a96a3', flex: 2 },
      { type: 'text', text: String(v), size: 'sm', color: '#333333', flex: 5, wrap: true },
    ],
  }))
  return {
    type: 'flex',
    altText: '予約内容を更新しました',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '✅ 予約内容を更新しました', weight: 'bold', size: 'md', color: '#1a7f37' },
          { type: 'separator', margin: 'md' },
          ...fieldBoxes,
          { type: 'text', text: '既存の予約をこの内容で上書きしました（別予約として重複登録はしていません）。', size: 'xs', color: '#8a96a3', margin: 'md', wrap: true },
        ],
      },
    },
  }
}

// 確認カードの postback（resv_imp=<id> 登録 / resv_update=<id> 既存予約を更新 / resv_imp_skip=<id> 破棄）。
async function handleReservationImportPostback(
  supabase: NonNullable<ReturnType<typeof createServiceClient>>,
  postbackData: string,
): Promise<Record<string, unknown> | null> {
  const isRegister = postbackData.startsWith('resv_imp=')
  const isUpdate = postbackData.startsWith('resv_update=')
  const isSkip = postbackData.startsWith('resv_imp_skip=')
  const pendingId = Number(postbackData.split('=')[1] ?? '')
  if (!Number.isInteger(pendingId) || pendingId <= 0) return null

  const { data: pending, error } = await supabase
    .from('pending_reservation_imports')
    .select('id, status, payload, store_partition_key, existing_event_id')
    .eq('id', pendingId)
    .maybeSingle()
  if (error || !pending) return buildSimpleNoticeFlex('対象の予約が見つかりませんでした。')
  const p = pending as {
    id: number
    status: string
    payload: Record<string, unknown>
    store_partition_key: string | null
    existing_event_id: number | null
  }

  if (p.status === 'registered') return buildSimpleNoticeFlex('この予約はすでに登録済みです。')

  if (isSkip) {
    await supabase.from('pending_reservation_imports')
      .update({ status: 'dismissed', updated_at: new Date().toISOString() }).eq('id', pendingId)
    return buildSimpleNoticeFlex('予約の登録を取りやめました。')
  }

  const payload = p.payload ?? {}
  const visitAt = String(payload.visit_at ?? '').trim()
  if (!visitAt) {
    return buildSimpleNoticeFlex('来店日時が読み取れなかったため自動登録できませんでした。お手数ですが予約表から手動で追加してください。')
  }

  // 「更新する（上書き）」: 新規行は作らず、確認カード時点で見つかっていた既存予約を書き換える。
  // 予約回数(visit_count)は同一予約の内容変更なので増減させない。履歴の内容だけ合わせる（best-effort）。
  if (isUpdate) {
    const existingEventId = Number(p.existing_event_id ?? 0)
    if (!Number.isInteger(existingEventId) || existingEventId <= 0) {
      return buildSimpleNoticeFlex('更新対象の既存予約が見つかりませんでした。お手数ですが「別予約として新規登録」からやり直してください。')
    }
    const updateRow = {
      customer_name: (payload.customer_name as string | null) ?? null,
      customer_phone: (payload.customer_phone as string | null) ?? null,
      visit_at: visitAt,
      reservation_type: (payload.reservation_type as string | null) ?? '予約',
      reservation_detail: (payload.reservation_detail as string | null) ?? null,
      manual_edited_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    const { error: updErr } = await supabase
      .from('manual_reservation_visit_events')
      .update(updateRow)
      .eq('id', existingEventId)
    if (updErr) {
      console.error('manual reservation update (from import) failed:', updErr.message)
      return buildSimpleNoticeFlex('更新に失敗しました。時間をおいて再度お試しください。')
    }
    try {
      const { error: histErr } = await supabase
        .from('reservation_customer_visit_history')
        .update({
          visit_at: visitAt,
          reservation_type: updateRow.reservation_type,
          reservation_detail: updateRow.reservation_detail,
        })
        .eq('partner', 'manual')
        .eq('gmail_message_id', `manual:${existingEventId}`)
      if (histErr) console.error('reservation_customer_visit_history update (from import) failed:', histErr.message)
    } catch (e) {
      console.error('reservation_customer_visit_history update threw:', (e as Error)?.message)
    }
    await supabase.from('pending_reservation_imports')
      .update({ status: 'registered', manual_reservation_id: existingEventId, updated_at: new Date().toISOString() })
      .eq('id', pendingId)
    return buildReservationUpdatedFlex(payload, visitAt)
  }

  if (!isRegister) return null

  const insertRow = {
    customer_name: (payload.customer_name as string | null) ?? null,
    customer_phone: (payload.customer_phone as string | null) ?? null,
    visit_at: visitAt,
    reservation_type: (payload.reservation_type as string | null) ?? '予約',
    reservation_detail: (payload.reservation_detail as string | null) ?? null,
    manual_store_key: (payload.manual_store_key as string | null) ?? p.store_partition_key ?? null,
  }
  const { data: created, error: insErr } = await supabase
    .from('manual_reservation_visit_events').insert(insertRow).select('id').single()
  if (insErr) {
    console.error('manual reservation insert (from import) failed:', insErr.message)
    return buildSimpleNoticeFlex('登録に失敗しました。時間をおいて再度お試しください。')
  }
  const newId = Number((created as { id?: number } | null)?.id ?? 0)

  // メール予約と同じく「予約回数」「過去の予約」に算入（partner='manual' で履歴＋サマリへ）。
  // 表示用イベント行(manual_reservation_visit_events)とは別に、回数サマリと履歴へ登録する。
  let visitStats: { visit_count: number; recent_visits: Array<{ visit_at?: string | null }> } | null = null
  try {
    const { data: stat, error: rpcErr } = await supabase.rpc('record_manual_reservation_visit', {
      p_dedup_key: `manual:${newId}`,
      p_customer_name: (payload.customer_name as string | null) ?? null,
      p_customer_phone: (payload.customer_phone as string | null) ?? null,
      p_visit_at: visitAt,
      p_reservation_type: (payload.reservation_type as string | null) ?? '予約',
      p_reservation_detail: (payload.reservation_detail as string | null) ?? null,
    })
    if (rpcErr) {
      console.error('record_manual_reservation_visit failed:', rpcErr.message)
    } else if (stat && typeof stat === 'object') {
      const s = stat as { visit_count?: unknown; recent_visits?: unknown }
      visitStats = {
        visit_count: Math.max(0, Math.floor(Number(s.visit_count ?? 0))),
        recent_visits: Array.isArray(s.recent_visits) ? (s.recent_visits as Array<{ visit_at?: string | null }>) : [],
      }
    }
  } catch (e) {
    console.error('record_manual_reservation_visit threw:', (e as Error)?.message)
  }

  await supabase.from('pending_reservation_imports')
    .update({ status: 'registered', manual_reservation_id: newId, updated_at: new Date().toISOString() })
    .eq('id', pendingId)
  return buildReservationRegisteredFlex(payload, visitAt, visitStats)
}

// ───────── 月次日別売上管理表（Excel/CSV）の LINE 取込 ─────────
function formatDailySalesPeriodLabel(parsed: { period: string | null; entries: Array<{ sales_date: string }> }): string {
  if (parsed.period) return parsed.period
  const ds = parsed.entries.map((e) => e.sales_date).sort()
  return ds.length ? `${ds[0]}〜${ds[ds.length - 1]}` : ''
}

function buildDailySalesSummaryRows(
  parsed: {
    import_mode?: string
    period: string | null
    entries: Array<{ sales_date: string }>
    day_count: number
    total_gross_yen: number
    manual_month_entry?: ManualMonthImportEntry | null
  },
  storeDisplay: string,
  fileStoreName: string | null,
  storeMatched: boolean,
  existingCount: number,
  existingManualMonth: ManualMonthSalesRecord | null = null,
): Record<string, unknown>[] {
  const yen = (n: number) => '¥' + Number(n || 0).toLocaleString('ja-JP')
  const manual = parsed.import_mode === 'manual_month' ? parsed.manual_month_entry ?? null : null
  const rows: Array<[string, string]> = [
    ['投入先店舗', storeDisplay],
    ['期間', formatDailySalesPeriodLabel(parsed)],
    ['取込形式', manual ? '月合計（合計だけ入力）' : '日別売上'],
    ['対象日数', manual ? '日別なし' : `${parsed.day_count}日`],
    ['合計総売上', yen(parsed.total_gross_yen)],
  ]
  if (manual?.tax_amount_yen != null) rows.push(['消費税', yen(manual.tax_amount_yen)])
  if (manual?.party_count != null) rows.push(['会計組数', `${manual.party_count}`])
  if (manual?.guest_count != null) rows.push(['客数', `${manual.guest_count}`])
  if (manual?.operating_days_count != null) rows.push(['営業日数', `${manual.operating_days_count}日`])
  if (fileStoreName) rows.push(['ファイル店舗', `${fileStoreName}${storeMatched ? '（一致）' : '（不一致）'}`])
  if (existingManualMonth) {
    rows.push(['既存月合計', yen(existingManualMonth.gross_sales_yen)])
    if (existingManualMonth.tax_amount_yen != null) rows.push(['既存消費税', yen(existingManualMonth.tax_amount_yen)])
    if (existingManualMonth.party_count != null) rows.push(['既存会計組数', `${existingManualMonth.party_count}`])
    if (existingManualMonth.guest_count != null) rows.push(['既存客数', `${existingManualMonth.guest_count}`])
    if (existingManualMonth.operating_days_count != null) rows.push(['既存営業日数', `${existingManualMonth.operating_days_count}日`])
  }
  if (existingCount > 0) rows.push(['既存データ', `${existingCount}件あり`])
  return rows.filter(([, v]) => v && String(v).trim()).map(([label, v]) => ({
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#8a96a3', flex: 3 },
      { type: 'text', text: String(v), size: 'sm', color: '#333333', flex: 5, wrap: true },
    ],
  }))
}

function buildDailySalesConfirmFlex(
  pendingId: number,
  parsed: { import_mode?: string; period: string | null; entries: Array<{ sales_date: string }>; day_count: number; total_gross_yen: number; manual_month_entry?: ManualMonthImportEntry | null },
  storeDisplay: string,
  fileStoreName: string | null,
  storeMatched: boolean,
  existingCount: number,
  existingManualMonth: ManualMonthSalesRecord | null = null,
): Record<string, unknown> {
  const warn: Record<string, unknown>[] = []
  if (!storeMatched) warn.push({ type: 'text', text: `⚠️ このルームの店舗とファイルの店舗名が一致しません。投入先は【${storeDisplay}】です。`, wrap: true, size: 'xs', color: '#c0392b', margin: 'sm' })
  const isManualMonth = parsed.import_mode === 'manual_month'
  if (isManualMonth && existingManualMonth) warn.push({ type: 'text', text: '⚠️ 対象月に既に月合計売上が登録されています。「上書きして登録」で既存の月合計を上書きします。', wrap: true, size: 'xs', color: '#c0392b', margin: 'sm' })
  if (existingCount > 0) warn.push({ type: 'text', text: isManualMonth ? `⚠️ 対象月に既に ${existingCount}件 の日別データがあります。「置き換えて登録」で日別データをクリアし、月合計として登録します。` : `⚠️ 取込対象期間に既に ${existingCount}件 のデータがあります。「置き換えて登録」で期間を丸ごと置換します（0=休業の日は売上なしにクリア／以前のデータは残りません）。`, wrap: true, size: 'xs', color: '#c0392b', margin: 'sm' })
  const hasExisting = existingCount > 0 || !!existingManualMonth
  return {
    type: 'flex',
    altText: '日次売上の取込確認',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: isManualMonth ? '月合計売上を登録しますか？' : '日次売上を登録しますか？', weight: 'bold', size: 'md', color: '#1a6fa8' },
          { type: 'text', text: isManualMonth ? '「合計だけ入力」を読み取りました。日別ではなく月合計の手入力売上として登録します。' : '月次日別売上管理表を読み取りました。総売上をレシートとして登録します。', wrap: true, size: 'xs', color: '#8a96a3' },
          { type: 'separator', margin: 'md' },
          ...buildDailySalesSummaryRows(parsed, storeDisplay, fileStoreName, storeMatched, existingCount, existingManualMonth),
          ...warn,
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#1a6fa8', action: { type: 'postback', label: hasExisting ? (isManualMonth ? '上書きして登録' : '置き換えて登録') : 'この内容で登録', data: `dsimp=${pendingId}`, displayText: isManualMonth ? '月合計売上を登録します' : '日次売上を登録します' } },
          { type: 'button', style: 'secondary', action: { type: 'postback', label: '中止', data: `dsimp_skip=${pendingId}`, displayText: '取込を中止します' } },
        ],
      },
    },
  }
}

function buildDailySalesImportedFlex(
  parsed: { import_mode?: string; period: string | null; entries: Array<{ sales_date: string }>; day_count: number; total_gross_yen: number; manual_month_entry?: ManualMonthImportEntry | null },
  storeDisplay: string,
  applied: number,
): Record<string, unknown> {
  const isManualMonth = parsed.import_mode === 'manual_month'
  return {
    type: 'flex',
    altText: isManualMonth ? '月合計売上を登録しました' : '日次売上を登録しました',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: isManualMonth ? '✅ 月合計売上を登録しました' : '✅ 日次売上を登録しました', weight: 'bold', size: 'md', color: '#1a7f37' },
          { type: 'separator', margin: 'md' },
          ...buildDailySalesSummaryRows(parsed, storeDisplay, null, true, 0),
          { type: 'text', text: isManualMonth ? '日別データは作らず、月合計の手入力売上として登録しました（売上分析・前年比に反映）。' : `${applied}日分をレシートとして登録（売上分析・前年比に反映）。`, size: 'xs', color: '#8a96a3', margin: 'md', wrap: true },
        ],
      },
    },
  }
}

// ファイル受信 → 月次日別売上管理表なら、ルーム店舗へ「レシート同等」で登録。新規＆店舗一致は即登録、
// 重複 or 店舗不一致は確認カード（置き換え/中止）。
async function processDailySalesFileEvent(
  registry: StoreRegistryRow,
  event: LineEvent,
  _suppressAll: boolean, // ハードミュート状態。日次売上登録はレシート同等＝ミュートをバイパスするため未使用。
  salesRegistrationAllowed = true, // receipt_sales_registration_enabled: 試運転ルームは本番DBへ登録しない
): Promise<{ replied: boolean; reason?: string }> {
  const lineMessageId = String(event.message?.id ?? '').trim()
  const roomId = resolveRoomId(event)
  const fileName = String((event.message as { fileName?: string } | undefined)?.fileName ?? '')
  if (!lineMessageId || !roomId) return { replied: false }
  if (!/\.(xlsx|xls|csv)$/i.test(fileName)) return { replied: false }
  const accessToken = resolveChannelAccessToken(registry.store_partition_key)
  if (!accessToken) return { replied: false, reason: 'missing_line_access_token' }
  const fetched = await fetchLineMessageBinary(lineMessageId, accessToken)
  if (!fetched.ok) return { replied: false, reason: fetched.error }
  const parsed = parseMonthlyDailySalesWorkbook(fetched.bytes, fileName)
  if (!parsed.recognized) {
    const looksLikeDailySalesTemplate = !!(parsed.period || parsed.store_name || parsed.store_key || parsed.error)
    if (looksLikeDailySalesTemplate) {
      const replyToken = String(event.replyToken ?? '').trim()
      if (replyToken) {
        const detail = [
          '日別売上管理表として読み取りましたが、登録対象の売上がありません。',
          parsed.error ? `理由: ${parsed.error}` : '',
          '月合計だけ登録する場合は、B37「合計だけ入力」の総売上欄に金額を入れてください。',
          '日別で登録する場合は、各日の「総売上(税込）」欄に金額を入れてください。',
        ].filter(Boolean).join('\n')
        await replyLineFlex(
          replyToken,
          buildSimpleNoticeFlex(detail.slice(0, 500)),
          accessToken,
          webhookReplyLog(registry, roomId, 'daily_sales_import_no_rows'),
        )
      }
      return { replied: !!replyToken, reason: 'daily_sales_import_no_rows' }
    }
    return { replied: false, reason: 'not_daily_sales_file' } // 日次売上ファイルでない→無反応（メディア保存のみ）
  }

  // 売上のDB登録ゲート（試運転ルームは本番テーブルへ保存しない）。日次ファイルもレシートと同じ正本に書くため対象。
  if (!salesRegistrationAllowed) {
    const replyTokenForNotice = String(event.replyToken ?? '').trim()
    if (replyTokenForNotice) {
      await replyLineText(
        replyTokenForNotice,
        '🧪 このルームは「売上をDB登録しない」設定（試運転）のため、日次売上ファイルはDB登録していません。',
        accessToken,
        webhookReplyLog(registry, roomId, 'daily_sales_file_registration_disabled'),
      )
    }
    return { replied: !!replyTokenForNotice, reason: 'sales_registration_disabled' }
  }

  const supabase = createServiceClient()
  if (!supabase) return { replied: false, reason: 'server_misconfigured' }
  const roomStoreKey = String(registry.store_partition_key ?? '').trim().toLowerCase()
  // 新テンプレは C3 に店舗キーを持つ。あればそれを最優先で使い、無ければ従来の店名ゆらぎ照合にフォールバック。
  const fileStoreKey = (parsed.store_key && parsed.store_key.trim())
    ? parsed.store_key.trim().toLowerCase()
    : (parsed.store_name ? resolveReceiptNamePartitionKey(parsed.store_name) : null)
  const storeMatched = !!fileStoreKey && String(fileStoreKey).toLowerCase() === roomStoreKey
  const resolved = await resolveReceiptTableForStore(supabase, roomStoreKey)
  const storeDisplay = resolved?.storeDisplay ?? (registry.display_name || roomStoreKey)
  const receiptTable = resolved?.receiptTable ?? `line_receipt__${roomStoreKey}`
  // 「既存データあり」の判定は、ファイルに載っている全日付(0=休業含む)で行う。
  // 値のある日に既存が無くても、0にする日に既存があれば確認カードを出す（＝期間まるごと置換の確認）。
  const coveredDates = (parsed.covered_dates && parsed.covered_dates.length)
    ? parsed.covered_dates
    : parsed.entries.map((e) => e.sales_date)
  const existingCount = await countExistingReceiptsForDates(supabase, receiptTable, coveredDates)
  const existingManualMonth = parsed.import_mode === 'manual_month' && parsed.manual_month_entry
    ? await fetchManualMonthSales(supabase, roomStoreKey, parsed.manual_month_entry.sales_month)
    : null
  // 日次売上の登録はレシートと同等の「売上登録」操作なので、AI返信完全なし(ハードミュート)でも
  // 返信（自動登録の完了通知・重複/不一致の確認カード）を出す＝ミュートをバイパスする。
  // これがないと、確認カードが出ず置き換え/中止を押せないため、ミュート部屋では登録できなくなる。
  const replyToken = String(event.replyToken ?? '').trim()

  // 新規かつ店舗一致 → 即登録（ご要望どおり自動）。
  if (existingCount === 0 && !existingManualMonth && storeMatched) {
    try {
      const res = parsed.import_mode === 'manual_month' && parsed.manual_month_entry
        ? await importManualMonthSalesOverwrite(supabase, roomStoreKey, parsed.manual_month_entry, coveredDates)
        : await importDailyReceiptsOverwrite(supabase, roomStoreKey, parsed.entries, coveredDates)
      if (replyToken) {
        await replyLineFlex(replyToken, buildDailySalesImportedFlex(parsed, storeDisplay, res.applied), accessToken, webhookReplyLog(registry, roomId, 'daily_sales_imported'))
      }
      return { replied: !!replyToken, reason: parsed.import_mode === 'manual_month' ? 'manual_month_sales_auto_imported' : 'daily_sales_auto_imported' }
    } catch (e) {
      const msg = (e as { message?: string })?.message || String(e)
      if (replyToken) await replyLineFlex(replyToken, buildSimpleNoticeFlex(`日次売上の登録に失敗しました: ${msg}`.slice(0, 300)), accessToken, webhookReplyLog(registry, roomId, 'daily_sales_import_failed'))
      return { replied: !!replyToken, reason: 'daily_sales_import_failed' }
    }
  }

  // 重複 or 店舗不一致 → 確認カード（pending保存）。
  let pendingId: number | null = null
  try {
    const { data: existing } = await supabase
      .from('pending_daily_sales_imports')
      .select('id')
      .eq('line_message_id', lineMessageId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (existing && (existing as { id?: number }).id) pendingId = Number((existing as { id?: number }).id)
  } catch (_e) { /* noop */ }
  if (pendingId == null) {
    const { data: ins, error } = await supabase
      .from('pending_daily_sales_imports')
      .insert({
        room_id: roomId,
        store_partition_key: roomStoreKey,
        file_store_name: parsed.store_name,
        file_name: fileName,
        line_message_id: lineMessageId,
	        period: parsed.period,
	        import_mode: parsed.import_mode,
	        manual_month_entry: parsed.manual_month_entry,
	        entries: parsed.entries,
        covered_dates: coveredDates,
        day_count: parsed.day_count,
        total_gross_yen: parsed.total_gross_yen,
        existing_count: existingCount,
        store_matched: storeMatched,
        status: 'pending',
      })
      .select('id')
      .single()
    if (error) {
      console.error('pending_daily_sales_imports insert failed:', error.message)
      return { replied: false, reason: 'daily_sales_pending_insert_failed' }
    }
    pendingId = Number((ins as { id?: number } | null)?.id ?? 0)
  }
  if (!replyToken || !pendingId) return { replied: false, reason: 'daily_sales_confirm_no_reply' }
  await replyLineFlex(
    replyToken,
    buildDailySalesConfirmFlex(pendingId, parsed, storeDisplay, parsed.store_name, storeMatched, existingCount, existingManualMonth),
    accessToken,
    webhookReplyLog(registry, roomId, 'daily_sales_confirm'),
  )
  return { replied: true, reason: 'daily_sales_confirm_card' }
}

// 確認カードの postback（dsimp=登録/置き換え, dsimp_skip=中止）。
async function handleDailySalesImportPostback(
  supabase: NonNullable<ReturnType<typeof createServiceClient>>,
  postbackData: string,
): Promise<Record<string, unknown> | null> {
  const isImport = postbackData.startsWith('dsimp=')
  const pendingId = Number(postbackData.split('=')[1] ?? '')
  if (!Number.isInteger(pendingId) || pendingId <= 0) return null
  const { data: pending, error } = await supabase
    .from('pending_daily_sales_imports')
    .select('id, status, store_partition_key, import_mode, manual_month_entry, entries, covered_dates')
    .eq('id', pendingId)
    .maybeSingle()
  if (error || !pending) return buildSimpleNoticeFlex('対象の取込が見つかりませんでした。')
  const p = pending as { id: number; status: string; store_partition_key: string | null; import_mode?: string | null; manual_month_entry?: unknown; entries: unknown; covered_dates: unknown }
  if (p.status === 'imported') return buildSimpleNoticeFlex('この取込はすでに登録済みです。')
  if (!isImport) {
    await supabase.from('pending_daily_sales_imports').update({ status: 'dismissed', updated_at: new Date().toISOString() }).eq('id', pendingId)
    return buildSimpleNoticeFlex('日次売上の取込を中止しました。')
  }
  const entries = Array.isArray(p.entries)
    ? p.entries as Array<{ sales_date: string; gross_sales_yen: number; party_count: number | null; guest_count: number | null }>
    : []
  const storeKey = String(p.store_partition_key ?? '').trim().toLowerCase()
  const coveredDates = Array.isArray(p.covered_dates)
    ? (p.covered_dates as unknown[]).map((d) => String(d ?? '').trim().slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    : []
  if (p.import_mode === 'manual_month') {
    const raw = p.manual_month_entry && typeof p.manual_month_entry === 'object'
      ? p.manual_month_entry as Record<string, unknown>
      : null
    const gross = Number(raw?.gross_sales_yen)
    const salesMonth = String(raw?.sales_month ?? '').trim().slice(0, 7)
    if (!storeKey || !raw || !/^\d{4}-\d{2}$/.test(salesMonth) || !Number.isFinite(gross) || gross <= 0) {
      return buildSimpleNoticeFlex('登録できる月合計データがありませんでした。')
    }
    try {
      const entry: ManualMonthImportEntry = {
        sales_month: salesMonth,
        gross_sales_yen: Math.round(gross),
        tax_amount_yen: raw.tax_amount_yen == null || raw.tax_amount_yen === '' ? null : Math.round(Number(raw.tax_amount_yen)),
        net_sales_yen: raw.net_sales_yen == null || raw.net_sales_yen === '' ? null : Math.round(Number(raw.net_sales_yen)),
        party_count: raw.party_count == null || raw.party_count === '' ? null : Math.round(Number(raw.party_count)),
        guest_count: raw.guest_count == null || raw.guest_count === '' ? null : Math.round(Number(raw.guest_count)),
        operating_days_count: raw.operating_days_count == null || raw.operating_days_count === '' ? null : Math.round(Number(raw.operating_days_count)),
      }
      const res = await importManualMonthSalesOverwrite(supabase, storeKey, entry, coveredDates)
      await supabase.from('pending_daily_sales_imports').update({ status: 'imported', updated_at: new Date().toISOString() }).eq('id', pendingId)
      return buildSimpleNoticeFlex(`✅ ${res.sales_month} の月合計売上を登録しました（日別データ ${res.cleared_dates}日分をクリアして月合計として保存）。売上分析・前年比に反映されます。`)
    } catch (e) {
      const msg = (e as { message?: string })?.message || String(e)
      return buildSimpleNoticeFlex(`登録に失敗しました: ${msg}`.slice(0, 300))
    }
  }
  if (!storeKey || (entries.length === 0 && coveredDates.length === 0)) return buildSimpleNoticeFlex('登録できる内容がありませんでした。')
  try {
    const res = await importDailyReceiptsOverwrite(supabase, storeKey, entries, coveredDates)
    await supabase.from('pending_daily_sales_imports').update({ status: 'imported', updated_at: new Date().toISOString() }).eq('id', pendingId)
    return buildSimpleNoticeFlex(`✅ ${res.applied}日分を登録しました（対象期間 ${res.cleared_dates}日分をクリアして置き換え／0の日は売上なし）。売上分析・前年比に反映されます。`)
  } catch (e) {
    const msg = (e as { message?: string })?.message || String(e)
    return buildSimpleNoticeFlex(`登録に失敗しました: ${msg}`.slice(0, 300))
  }
}

// 受信専用店（レシートしか送られない店）: Azure が反射・光で kind を外して general 誤判定したとき、
// 「この店舗のレシートで確定」と宣言して1回だけ Azure で再解析する対象。
const FORCE_RECEIPT_RETRY_STORE_KEYS = new Set<string>(['barpelota'])
const FOOTER_COUNT_RETRY_STORE_KEYS = new Set<string>(['marugos', 'sauvage'])
const PRINTED_TIME_RETRY_STORE_KEYS = new Set<string>(['barpelota'])
const CLAUDE_RECEIPT_MODEL = 'claude-haiku-4-5'

function resolveClaudeApiKey(): string {
  return (Deno.env.get('claude_haiku') ?? Deno.env.get('CLAUDE_HAIKU') ?? Deno.env.get('ANTHROPIC_API_KEY') ?? '').trim()
}

// 非レシート判定でも「経費の領収書／明細書／レジ出金伝票」を強く示す語。summary にこれが出ていれば
// 経費プロンプト(Amazonブロック等を含む)で1回だけ強制再解析し、小口(経費)フローへ回す。
// Amazonの「支払い明細書」等のフォーマットが kind=receipt にならず無反応で落ちるのを救済する目的。
// 食品の写真等を誤検知しないよう、経費書類に固有の語だけに限定（「レシート」「円」等の汎用語は入れない）。
const EXPENSE_DOC_RESCUE_MARKERS =
  /支払明細|支払い明細|明細書|領収書|領収証|請求書|注文番号|レジ出金|出金伝票|今回出金額|出金額|Amazon|アマゾン/i

// 「解析中」案内（プッシュ）は、連投・再送のたびに送るとプッシュ枠（月◯通の無料枠）を浪費する。
// 同じルームで直近(既定3分)に画像が来ていれば「最初の1枚だけ送る／2枚目以降は送らない」で間引く。
// ※受信(webhook)と結果カード(返信=無料)は従来どおり。案内プッシュだけを節約する。
async function shouldSendAnalyzingNotice(
  supabase: NonNullable<ReturnType<typeof createServiceClient>>,
  registry: StoreRegistryRow,
  roomId: string,
  windowSeconds = 180,
): Promise<boolean> {
  const rawTable = String(registry.webhook_raw_table ?? '').trim()
  if (!rawTable || !roomId) return true
  try {
    const sinceIso = new Date(Date.now() - windowSeconds * 1000).toISOString()
    const { count, error } = await supabase
      .from(rawTable)
      .select('*', { count: 'exact', head: true })
      .eq('room_id', roomId)
      .eq('payload->message->>type', 'image')
      .gte('received_at', sinceIso)
    if (error) return true // 取得失敗時は従来どおり送る（案内が消えるより安全側）
    return (count ?? 0) <= 1 // この画像のみ＝最初の1枚→送る。直近に他の画像あり（再送/連投）→送らない。
  } catch {
    return true
  }
}

async function processReceiptImageEvent(
  registry: StoreRegistryRow,
  event: LineEvent,
  suppressAll = false,          // bot_reply_hard_mute_enabled: 一切返信しない
  suppressReceiptReply = false, // !image_analysis_reply_enabled: レシート結果のみ返信しない
  suppressNonReceiptReply = false, // !non_receipt_image_reply_enabled: 非レシート画像の返信のみ抑止
  allowPettyCash = true,        // petty_receipt_analysis_enabled: 経費(小口)フローの許可（ONなら hard mute でも優先返信）
  salesRegistrationAllowed = true, // receipt_sales_registration_enabled: 売上(精算)をこのルームから本番DBへ登録するか（試運転ルームはOFF）
  replyVisibility: ReceiptReplyVisibilityOptions = {},
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

  const azureFoundryProjectEndpoint = String(Deno.env.get('AZURE_FOUNDRY_PROJECT_ENDPOINT') ?? '').trim()
  const azureFoundryApiKey = String(Deno.env.get('AZURE_FOUNDRY_API_KEY') ?? '').trim()
  const azureFoundryDeployment = String(Deno.env.get('AZURE_FOUNDRY_VISION_DEPLOYMENT') ?? '').trim() || AZURE_FOUNDRY_VISION_MODEL
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

  const receiptGeminiModel = resolveReceiptGeminiModel()
  const receiptGeminiFlashModel = resolveReceiptGeminiFlashModel()
  // 売上の日計・精算レシートはFlash Liteを通常経路にする。
  // 小口用のFlash/Pro経路は従来どおり別モデルのまま維持する。
  const normalReceiptGeminiModel = resolveReceiptGeminiFlashLiteModel()
  const AZURE_RECEIPT_MODEL = azureFoundryDeployment

  // AI使用料ページの「実測」表示用に、APIが返した実測トークンを1行記録する。
  // best-effort: 失敗してもレシート処理は止めない（売上登録・返信が最優先）。
  const recordAiUsage = async (
    provider: 'azure_openai' | 'gemini' | 'claude',
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

  // 経費(小口)専用の再解析（独立経路）: 売上(精算)解析プロンプトには一切手を入れず、
  // 経費専用の追記(EXPENSE_RECEIPT_PROMPT_ADDITION)で line_items・小計/外税 を取得する。
  // 小口レシートはGemini Flashを通常経路にし、整合性が取れない時だけProへ昇格する。
  const reanalyzeAsExpense = async () => {
    const geminiApiKey = resolveGeminiApiKey()
    let g: Awaited<ReturnType<typeof analyzeLineImageWithGemini>> | Awaited<ReturnType<typeof analyzeExpenseReceiptWithAzureFoundry>>
    if (geminiApiKey) {
      g = await analyzeLineImageWithGemini(
        contentFetch.bytes,
        contentFetch.contentType,
        lineMessageId,
        geminiApiKey,
        EXPENSE_RECEIPT_PROMPT_ADDITION,
        receiptGeminiFlashModel,
      )
      await recordAiUsage('gemini', receiptGeminiFlashModel, g.usage)
      if (needsGeminiProPettyCashReview(g.analysis) || !extractExpenseFromReceipt(g.analysis?.receipt ?? null)) {
        console.info(`[petty_cash_flash_review] Flash result needs Pro review (msg=${lineMessageId})`)
        const proReview = await analyzeLineImageWithGemini(
          contentFetch.bytes,
          contentFetch.contentType,
          `${lineMessageId}#pro-review`,
          geminiApiKey,
          EXPENSE_RECEIPT_PROMPT_ADDITION,
          receiptGeminiModel,
        )
        await recordAiUsage('gemini', receiptGeminiModel, proReview.usage)
        if (proReview.analysis || !g.analysis || shouldFallbackLineImageVisionFailure(proReview.failure)) {
          g = proReview
        }
      }
      if (!g.analysis && shouldFallbackLineImageVisionFailure(g.failure)) {
        console.error(`[petty_cash_gemini_fallback] Gemini failed; retrying with Azure (msg=${lineMessageId}, stage=${g.failure?.stage ?? 'unknown'})`)
        g = await analyzeExpenseReceiptWithAzureFoundry(
          contentFetch.bytes,
          contentFetch.contentType,
          lineMessageId,
          azureFoundryProjectEndpoint,
          azureFoundryApiKey,
          azureFoundryDeployment,
          EXPENSE_RECEIPT_PROMPT_ADDITION,
        )
        await recordAiUsage('azure_openai', AZURE_RECEIPT_MODEL, g.usage)
      }
    } else {
      g = await analyzeExpenseReceiptWithAzureFoundry(
        contentFetch.bytes,
        contentFetch.contentType,
        lineMessageId,
        azureFoundryProjectEndpoint,
        azureFoundryApiKey,
        azureFoundryDeployment,
        EXPENSE_RECEIPT_PROMPT_ADDITION,
      )
      await recordAiUsage('azure_openai', AZURE_RECEIPT_MODEL, g.usage)
    }
    return g.analysis?.receipt ?? null
  }

  // 小口現金（経費）の「先打ち」最適化: 直前に「経費」と送られ画像待ち(await_image)なら、
  // 売上(精算)解析（Groq判定＋Claude/Gemini）をスキップして、経費専用解析だけ実行する。
  // ＝先打ち時は AI 呼び出しを1回（経費解析のみ）に削減。pending が無ければ {handled:false} で
  // 通常の精算解析へフォールスルー（普通に画像だけ送る従来フローは一切変わらない）。
  // 権限「小口レシートの解析をする」OFF のルームでは作動しない（ONなら hard mute でも優先返信）。
  if (allowPettyCash) {
    const pettyUserId = event.source?.userId ? String(event.source.userId) : null
    const pettyEarly = await handlePettyCashImageIfPending(supabase, registry, {
      roomId,
      userId: pettyUserId,
      replyToken: rawReplyToken,
      lineMessageId,
      receipt: null,
      summary: '',
      reanalyze: reanalyzeAsExpense,
    })
    if (pettyEarly.handled) {
      return { saved: !!pettyEarly.saved, replied: !!pettyEarly.replied, reason: pettyEarly.reason ?? 'petty_cash_image' }
    }
  }

  let analyzed: Awaited<ReturnType<typeof analyzeLineImageWithGemini>> | Awaited<ReturnType<typeof analyzeLineImageWithAzureFoundry>>

  // 全店舗の通常レシートは Gemini Flash Lite を最初の画像解析として使う。
  // Gemini障害時だけ Azure Foundry nano、さらに失敗時だけClaudeへ退避する。
  analyzed = await analyzeLineImageWithGemini(
    contentFetch.bytes,
    contentFetch.contentType,
    lineMessageId,
    resolveGeminiApiKey(),
    receiptPromptAddition,
    normalReceiptGeminiModel,
  )
  await recordAiUsage('gemini', normalReceiptGeminiModel, analyzed.usage)

  if (!analyzed.analysis && shouldFallbackLineImageVisionFailure(analyzed.failure)) {
    console.error(
      `[receipt_analysis_fallback] Gemini Flash Lite failed; retrying with Azure Foundry (store=${registry.store_partition_key}, msg=${lineMessageId}, stage=${analyzed.failure?.stage ?? 'unknown'})`,
    )
    const fallback = await analyzeLineImageWithAzureFoundry(
      contentFetch.bytes,
      contentFetch.contentType,
      lineMessageId,
      azureFoundryProjectEndpoint,
      azureFoundryApiKey,
      azureFoundryDeployment,
      receiptPromptAddition,
    )
    await recordAiUsage('azure_openai', AZURE_RECEIPT_MODEL, fallback.usage)
    if (fallback.analysis || fallback.failure) analyzed = fallback

    if (!analyzed.analysis && shouldFallbackLineImageVisionFailure(fallback.failure) && resolveClaudeApiKey()) {
      console.error(
        `[receipt_analysis_fallback] Azure Foundry also failed; retrying with Claude (store=${registry.store_partition_key}, msg=${lineMessageId}, stage=${fallback.failure?.stage ?? 'unknown'})`,
      )
      const secondFallback = await analyzeLineImageWithClaude(
        contentFetch.bytes,
        contentFetch.contentType,
        lineMessageId,
        resolveClaudeApiKey(),
        receiptPromptAddition,
        CLAUDE_RECEIPT_MODEL,
      )
      await recordAiUsage('claude', CLAUDE_RECEIPT_MODEL, secondFallback.usage)
      if (secondFallback.analysis || secondFallback.failure) analyzed = secondFallback
    }
  }

  // マルゴエス／ソバージュの日計精算レポートは、画像下部の人数・組数が小さく、売上金額だけ読めても
  // 二つの数値を落とすことがある。欠損時だけ Gemini Flash Lite に数値部分を再確認させ、
  // 初回で正しく読めた金額・日付・店名はそのまま保持する。
  const initialReceipt = analyzed.analysis?.receipt ?? null
  const receiptStoreKey = String(registry.store_partition_key ?? '').toLowerCase()
  const needsFooterCountRetry = !!initialReceipt &&
    FOOTER_COUNT_RETRY_STORE_KEYS.has(receiptStoreKey) &&
    (!String(initialReceipt.partyCount ?? '').trim() || !String(initialReceipt.guestCount ?? '').trim())
  if (needsFooterCountRetry) {
    const countRetryInstruction = receiptStoreKey === 'sauvage'
      ? [
        '【人数・組数の再確認。最優先】このソバージュ（SOBA-JU）のレジ精算レポートでは、画像の一番下に手書きで「◯人 ◯組」と記載される。',
        '単位文字を正本にし、「人」または「名」の直前の数値を guest_count、「組」の直前の数値を party_count に必ず入れる。例: 「39人 27組」なら guest_count="39"、party_count="27"。左右の位置だけで逆にしないこと。',
      ].join('\n')
      : [
        '【会計組数・客数の再確認。最優先】このマルゴエスの日計精算レポートでは、画像下部の「会計組数・客数」の横並びを必ず読むこと。左の「◯組」を party_count、右の「◯名」を guest_count に入れる。',
        'この二つは必須。薄くても左右のラベルと位置関係で数字を読み直し、既に読めた売上金額ではなく組数・客数の抽出を最優先にすること。',
      ].join('\n')
    const countRetryPrompt = [
      receiptPromptAddition,
      '',
      countRetryInstruction,
    ].join('\n')
    const countRetry = await analyzeLineImageWithGemini(
      contentFetch.bytes,
      contentFetch.contentType,
      `${lineMessageId}#footer-counts`,
      resolveGeminiApiKey(),
      countRetryPrompt,
      normalReceiptGeminiModel,
    )
    await recordAiUsage('gemini', normalReceiptGeminiModel, countRetry.usage)
    const retriedReceipt = countRetry.analysis?.receipt ?? null
    if (retriedReceipt && (String(retriedReceipt.partyCount ?? '').trim() || String(retriedReceipt.guestCount ?? '').trim())) {
      analyzed = {
        ...analyzed,
        analysis: {
          ...analyzed.analysis!,
          receiptModelConfidence: Math.max(
            analyzed.analysis?.receiptModelConfidence ?? 0,
            countRetry.analysis?.receiptModelConfidence ?? 0,
          ),
          receipt: {
            ...initialReceipt,
            partyCount: retriedReceipt.partyCount || initialReceipt.partyCount,
            guestCount: retriedReceipt.guestCount || initialReceipt.guestCount,
          },
        },
      }
    }
  }

  // バー・ペロタの精算票は日付の直後に時刻が必ず印字される。時刻を落とすと深夜精算を前営業日に
  // 寄せられないため、初回抽出で receipt_time が欠けた場合だけ時刻専用の再読取を行う。
  const receiptAfterFooterRetry = analyzed.analysis?.receipt ?? null
  const needsPrintedTimeRetry = !!receiptAfterFooterRetry &&
    PRINTED_TIME_RETRY_STORE_KEYS.has(receiptStoreKey) &&
    !String(receiptAfterFooterRetry.printedTime ?? '').trim()
  if (needsPrintedTimeRetry) {
    const timeRetryPrompt = [
      receiptPromptAddition,
      '',
      '【印字時刻の再確認。最優先】このバー・ペロタの精算票は、見出し「精算」の直下に「YYYY-MM-DD HH:MM:SS」の日時が必ずある。',
      '日付と時刻を別々に出力すること。例: 「2026-07-11 00:12:02」なら receipt.date="2026-07-11"、receipt_time="00:12:02"。00:00〜04:59 は前日の営業日に登録するため、時刻の省略は絶対にしない。',
    ].join('\n')
    const timeRetry = await analyzeLineImageWithGemini(
      contentFetch.bytes,
      contentFetch.contentType,
      `${lineMessageId}#printed-time`,
      resolveGeminiApiKey(),
      timeRetryPrompt,
      normalReceiptGeminiModel,
    )
    await recordAiUsage('gemini', normalReceiptGeminiModel, timeRetry.usage)
    const retriedReceipt = timeRetry.analysis?.receipt ?? null
    if (retriedReceipt?.printedTime) {
      analyzed = {
        ...analyzed,
        analysis: {
          ...analyzed.analysis!,
          receiptModelConfidence: Math.max(
            analyzed.analysis?.receiptModelConfidence ?? 0,
            timeRetry.analysis?.receiptModelConfidence ?? 0,
          ),
          receipt: {
            ...receiptAfterFooterRetry,
            date: retriedReceipt.date || receiptAfterFooterRetry.date,
            printedTime: retriedReceipt.printedTime,
          },
        },
      }
    }
  }

  // 受信専用店（例: バルペロタ）で反射・光により kind を general と誤判定して receipt を外した場合、
  // 「この店舗のレシートで確定。general/reservation判定は適用しない」と宣言して1回だけ強制再解析する。
  if (
    !analyzed.analysis?.receipt &&
    FORCE_RECEIPT_RETRY_STORE_KEYS.has(String(registry.store_partition_key ?? ''))
  ) {
    const forcedReceiptPrompt = [
      receiptPromptAddition,
      '',
      '【強制再解析・絶対遵守】上の画像はこの店舗のレシート（精算）で確定しています。',
      '前述の「general / reservation にする」判断基準は、この店舗には一切適用しないでください。',
      '必ず kind="receipt" を出力し、receipt に読み取れる主要項目（store_name, date, net_sales=純売上, gross_sales=合計/税込, party_count=通常取引数, guest_count=客数 など）を入れること。',
      '反射・光・かすれがあっても、読める数値だけでも receipt に入れて kind=receipt を維持し、receipt_confidence は 0.6 以上にする。',
    ].join('\n')
    const forcedRetry = await analyzeLineImageWithGemini(
      contentFetch.bytes,
      contentFetch.contentType,
      lineMessageId,
      resolveGeminiApiKey(),
      forcedReceiptPrompt,
      normalReceiptGeminiModel,
    )
    await recordAiUsage('gemini', normalReceiptGeminiModel, forcedRetry.usage)
    if (forcedRetry.analysis?.receipt) analyzed = forcedRetry
  }

  // 期間集計／グループ期間（GP）レポートは「売上レシート」ではないため、売上に加算せず返信もしない。
  // 店舗プロンプト（例: マルゴオット）が、期間/日付範囲を含む集計レポートの summary に
  // 「期間集計レポート」等のマーカーを入れることで判定する。
  const analyzedSummaryText = String(analyzed.analysis?.summary ?? '')

  // フードコート「テナント一覧」レポート（v2.mallpro.jp）の自動解析（分析専用・売上には登録しない）。
  //   対象店舗（marugoS 等）＋マーカー一致のときだけ Gemini で全テナントを抽出し、基準店=100の比較カードを返す。
  //   表として成立しなければ handled=false で通常のレシート処理へフォールスルー（誤検知が売上に影響しない）。
  {
    const fcReceipt = analyzed.analysis?.receipt ?? null
    const fcDetectText = [
      analyzedSummaryText,
      fcReceipt?.storeName ?? '',
      Array.isArray(fcReceipt?.items) ? fcReceipt.items.join(' ') : '',
    ].join(' ')
    // 自店(マルゴエス等)レシートとして確信できない画像は、マーカー不一致でも抽出を試す（Groq要約に依存しない）。
    //   通常レシートは「確信あり＋店名一致」で素通り＝余計なGemini呼び出し・遅延を出さない。
    const fcOwnReceiptConfident = !!fcReceipt &&
      mergeReceiptConfidence(computeReceiptHeuristicConfidence(fcReceipt), analyzed.analysis?.receiptModelConfidence ?? null) >= RECEIPT_ANALYSIS_CONFIDENCE_MIN &&
      receiptStoreNameMatchesRegistry(
        registry.display_name || registry.store_partition_key,
        registry.store_partition_key,
        fcReceipt.storeName,
        fcReceipt.storePhone,
        registry.receipt_phones,
      )
    const fc = await maybeHandleFoodCourtReport(supabase, {
      storeKey: String(registry.store_partition_key ?? ''),
      roomId,
      lineMessageId,
      bytes: contentFetch.bytes,
      contentType: contentFetch.contentType,
      detectText: fcDetectText,
      geminiApiKey: resolveGeminiApiKey(),
      geminiModel: receiptGeminiModel,
      azureFoundryProjectEndpoint,
      azureFoundryApiKey,
      azureFoundryDeployment,
      forceAttempt: !fcOwnReceiptConfident,
    })
    if (fc.handled) {
      if (receiptReplyToken && fc.reply) {
        await replyLineFlex(receiptReplyToken, fc.reply, accessToken, webhookReplyLog(registry, roomId, 'foodcourt_compare'))
      }
      return { saved: false, replied: !!(receiptReplyToken && fc.reply), reason: 'foodcourt_compare' }
    }
  }

  // （経費の先打ち await_image 取込と reanalyzeAsExpense の定義は、精算解析を省くため上方へ移動済み。
  //   ここまで来た時点で await_image の経費 pending は無い＝以降は通常の精算レシートとして処理する。）

  // 期間指定帳票は複数日だけを除外する。開始日=終了日・全指定・(1日)は後日再発行した
  // 1営業日分の日計なので、タイトルに[期間]があっても通常の売上として登録する。
  const isSingleDayPeriodSettlement = isSingleDayPeriodSettlementReport(analyzedSummaryText)
  if (!isSingleDayPeriodSettlement && /期間集計|日付範囲|GP（グループ）|ＧＰ（グループ）|［期間］|\[期間\]|開始.{0,24}終了/.test(analyzedSummaryText)) {
    return { saved: false, replied: false, reason: 'period_summary_skip' }
  }

  // 予約管理アプリの「予約確認画面」スクショ（kind=reservation）。売上ではないので登録せず、
  // 解析内容を pending に保存し、確認カード（登録/破棄ボタン）を返信する。「登録」postback で本登録。
  const detectedReservation = analyzed.analysis?.reservation
  if (detectedReservation) {
    // 予約スクショの登録は「明示的な登録操作」なので、レシート登録・予算登録と同様に
    // 「AI返信完全無し」(ハードミュート)でも確認カードを返す（送らないと登録に進めないため）。
    return await handleReservationImageDetected(
      supabase,
      registry,
      roomId,
      rawReplyToken,
      accessToken,
      lineMessageId,
      detectedReservation,
      analyzedSummaryText,
    )
  }

  // 【経費書類の救済】Groqが「非レシート」（receipt無し）にしても、summary が経費の領収書/明細書/
  //   レジ出金伝票を示すなら、経費プロンプト(Amazonブロック等)で1回だけ強制再解析する。receipt が取れれば
  //   下の通常フロー（レジ出金検知→小口オファー／店名不一致→経費オファー）に乗る。小口許可ルームのみ。
  //   Amazonの「支払い明細書」が kind=receipt にならず無反応で落ちる問題への対策（2026-06-18）。
  if (
    !analyzed.analysis?.receipt &&
    allowPettyCash &&
    EXPENSE_DOC_RESCUE_MARKERS.test(String(analyzed.analysis?.summary ?? ''))
  ) {
    const forcedExpensePrompt = [
      EXPENSE_RECEIPT_PROMPT_ADDITION,
      '',
      '【強制再解析・絶対遵守】上の画像は店舗が支払った経費の領収書／明細書、または店舗のレジ出金伝票で確定しています。',
      '「general / 非レシートにする」判断は一切適用せず、必ず kind="receipt" を出力すること。',
      'receipt に store_name（仕入先。Amazonの「支払い明細書」なら "Amazon"）・gross_sales（税込合計）・line_items を入れる。',
      'レジ出金伝票が写っていればその「今回出金額 ¥◯」も金額の手掛かりにする。反射・かすれは読める数値だけで receipt を作り kind=receipt を維持する。',
    ].join('\n')
    const geminiApiKey = resolveGeminiApiKey()
    let forcedExpense: Awaited<ReturnType<typeof analyzeLineImageWithGemini>> | Awaited<ReturnType<typeof analyzeExpenseReceiptWithAzureFoundry>>
    if (geminiApiKey) {
      forcedExpense = await analyzeLineImageWithGemini(
        contentFetch.bytes,
        contentFetch.contentType,
        lineMessageId,
        geminiApiKey,
        forcedExpensePrompt,
        receiptGeminiFlashModel,
      )
      await recordAiUsage('gemini', receiptGeminiFlashModel, forcedExpense.usage)
      if (needsGeminiProPettyCashReview(forcedExpense.analysis) || !extractExpenseFromReceipt(forcedExpense.analysis?.receipt ?? null)) {
        console.info(`[petty_cash_flash_review] Flash forced result needs Pro review (msg=${lineMessageId})`)
        const proReview = await analyzeLineImageWithGemini(
          contentFetch.bytes,
          contentFetch.contentType,
          `${lineMessageId}#pro-review`,
          geminiApiKey,
          forcedExpensePrompt,
          receiptGeminiModel,
        )
        await recordAiUsage('gemini', receiptGeminiModel, proReview.usage)
        if (proReview.analysis || !forcedExpense.analysis || shouldFallbackLineImageVisionFailure(proReview.failure)) {
          forcedExpense = proReview
        }
      }
      if (!forcedExpense.analysis && shouldFallbackLineImageVisionFailure(forcedExpense.failure)) {
        console.error(`[petty_cash_gemini_fallback] Gemini forced reanalysis failed; retrying with Azure (msg=${lineMessageId}, stage=${forcedExpense.failure?.stage ?? 'unknown'})`)
        forcedExpense = await analyzeExpenseReceiptWithAzureFoundry(
          contentFetch.bytes,
          contentFetch.contentType,
          lineMessageId,
          azureFoundryProjectEndpoint,
          azureFoundryApiKey,
          azureFoundryDeployment,
          forcedExpensePrompt,
        )
        await recordAiUsage('azure_openai', AZURE_RECEIPT_MODEL, forcedExpense.usage)
      }
    } else {
      forcedExpense = await analyzeExpenseReceiptWithAzureFoundry(
        contentFetch.bytes,
        contentFetch.contentType,
        lineMessageId,
        azureFoundryProjectEndpoint,
        azureFoundryApiKey,
        azureFoundryDeployment,
        forcedExpensePrompt,
      )
      await recordAiUsage('azure_openai', AZURE_RECEIPT_MODEL, forcedExpense.usage)
    }
    if (forcedExpense.analysis?.receipt) analyzed = forcedExpense
  }

  if (!analyzed.analysis?.receipt) {
    // AI側の一過性障害（HTTPエラー/ネットワーク/タイムアウト/空応答）は「非レシート」ではない。
    // その場合は誤解を招く「読み取れませんでした」ではなく、再送を促す（2026-07-01 Groq 503 で
    // bistrocavacava のレシートが消失した実障害。リトライ後もなお失敗したときの安全網）。
    const failureStage = String(analyzed.failure?.stage ?? '')
    const isProviderFailure = !!analyzed.failure
    if (analyzed.failure) {
      await recordLineWebhookDeliveryLog({
        storePartitionKey: registry.store_partition_key,
        method: 'reply',
        context: 'receipt_image_analysis_failed',
        targetRoomId: roomId,
        attempted: false,
        success: false,
        reason: failureStage || 'image_analysis_failed',
        details: {
          line_message_id: lineMessageId,
          provider_message: String(analyzed.failure.message ?? '').slice(0, 300),
          provider_http_status: analyzed.failure.httpStatus ?? null,
        },
      })
    }
    const msg = isProviderFailure
      ? '⚠ AI画像解析を完了できませんでした。お手数ですが、少し時間をおいてこの画像をもう一度お送りください。'
      : analyzed.analysis?.summary
      ? `画像を確認しました。\n${analyzed.analysis.summary}`
      : 'レシートとして読み取れる項目がありませんでした。'
    // プロバイダー障害は「その他画像」ではなく解析失敗なので、レシート解析返信の設定に従う。
    // これにより non_receipt_image_reply_enabled=false の部屋でも無言終了しない。
    const failureReplyToken = isProviderFailure ? receiptReplyToken : nonReceiptReplyToken
    if (failureReplyToken) {
      await replyLineText(
        failureReplyToken,
        msg,
        accessToken,
        webhookReplyLog(
          registry,
          roomId,
          isProviderFailure ? 'receipt_image_analysis_failed' : 'receipt_image_no_receipt',
        ),
      )
    }
    return { saved: false, replied: !!failureReplyToken, reason: failureStage || 'no_receipt' }
  }

  const receiptRaw = analyzed.analysis.receipt
  const alignedStoreName = alignReceiptStoreNameToRegistry(receiptRaw.storeName, registry)
  const receiptAligned = String(alignedStoreName ?? '') !== String(receiptRaw.storeName ?? '')
    ? { ...receiptRaw, storeName: alignedStoreName }
    : receiptRaw
  // ソバージュは「総売上」に出前の預かり金が含まれるため、売上は「純売上」を採用する。
  const receipt = applySauvageNetSalesAsGrossSales(receiptAligned, registry.store_partition_key)

  // レジ出金（経費）伝票は「売上」ではない → 売上登録せず、小口現金（経費）として記録を案内。
  // 自店名と一致しても出金伝票は売上に入れない（売上の水増し防止）。検知しなければ従来処理へ。
  {
    const cashOutUserId = event.source?.userId ? String(event.source.userId) : null
    // 権限OFFでも検知自体は行い「売上への誤登録」は防ぐ（カード返信だけ出さない）。
    const cashOut = await handlePettyCashCashOutSlip(supabase, registry, {
      roomId,
      userId: cashOutUserId,
      replyToken: (allowPettyCash && receiptReplyToken) ? rawReplyToken : '',
      lineMessageId,
      receipt,
      summary: analyzed.analysis?.summary ?? '',
      reanalyze: reanalyzeAsExpense,
    })
    if (cashOut.handled) {
      return { saved: false, replied: !!cashOut.replied, reason: cashOut.reason ?? 'petty_cash_cashout' }
    }
  }

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
      // 店名不一致＝別店舗のレシート＝経費の可能性が高い。経費候補として pending を作り、
      // いったん不一致カードを挟まず、すぐ「小口現金に記録しますか？」の確認カードを出す。
      // 権限「小口レシートの解析をする」OFF、または金額不読で pending を作れない場合だけ従来の不一致カードへ戻す。
      let pettyPendingId: number | null = null
      if (allowPettyCash) {
        try {
          pettyPendingId = await savePettyCashPendingFromReceipt(supabase, registry, {
            roomId, userId, lineMessageId, receipt, reanalyze: reanalyzeAsExpense,
          })
        } catch (e) {
          console.error('savePettyCashPendingFromReceipt threw:', String(e))
        }
      }
      const pettyConfirmMessage = pettyPendingId
        ? await handlePettyCashPostback(supabase, registry, `pcreview=${pettyPendingId}`)
        : null
      const flexMessage = pettyConfirmMessage ?? buildReceiptStoreMismatchFlexReply(guidance, pettyPendingId)
      await replyLineFlex(
        receiptReplyToken,
        flexMessage,
        accessToken,
        webhookReplyLog(registry, roomId, pettyConfirmMessage ? 'petty_cash_store_mismatch_confirm' : 'receipt_store_mismatch'),
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
  // 売上のDB登録ゲート（試運転ルームは本番テーブルへ保存しない）。
  // 1チャネルに本番＋試運転トークが同居する店舗で、試運転側が同じ営業日を先に登録 → 本番が毎回
  //   「既に登録」になる／集計に試運転が混入する、を根本回避する。解析結果は返すが保存・重複カードはしない。
  if (!salesRegistrationAllowed) {
    if (receiptReplyToken) {
      const noticeLines = [
        '🧪 このルームは「売上をDB登録しない」設定（試運転）のため、今回の内容はDB登録していません。',
        `日付: ${receiptDateIso}`,
        `総売上: ${receipt.grossSales ?? '-'}`,
        `組数: ${receipt.partyCount ?? '-'}／客数: ${receipt.guestCount ?? '-'}`,
      ]
      await replyLineText(
        receiptReplyToken,
        noticeLines.join('\n'),
        accessToken,
        webhookReplyLog(registry, roomId, 'receipt_sales_registration_disabled'),
      )
    }
    return { saved: false, replied: !!receiptReplyToken, reason: 'sales_registration_disabled' }
  }

  const result = await attemptReceiptRegistration(
    supabase,
    registry,
    registrationPayload,
    replyVisibility,
  )

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
  replyVisibility: ReceiptReplyVisibilityOptions = {},
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
    replyVisibility,
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

/**
 * 引用返信（リプライ）で指定された画像を Gemini で解析し、店舗ナレッジとして登録する。
 *
 * LINE の画像メッセージ自体には text フィールドが無く、キャプションを付けて送る手段が
 * 無い。そのため画像は「画像を送る → その画像に引用返信で #メモ と書く」という2手で
 * 指定する。引用返信のテキストイベントには quotedMessageId（引用元＝画像のID）が入る。
 *
 * 通数について: 引用返信は店舗からの受信メッセージなので PUSH 無料枠を消費しない。
 * 完了通知も Reaction API（0通）で行い、返信メッセージは送らない。
 *
 * 注意: この関数は必ずトップレベルに置くこと。Deno.serve 内のイベントループ本体に
 * 置くと、同じブロックで後から const 宣言される変数を巻き込んで TDZ エラーになる。
 *
 * @param imageMessageId 引用元の画像メッセージID（quotedMessageId）
 * @param memoText 引用返信の本文（#メモ を含む）。ナレッジの本文に使う
 */
async function registerQuotedImageAsKnowledge(
  registry: StoreRegistryRow,
  imageMessageId: string,
  memoText: string,
  createdBy: string,
  lineAccessTokenForSearch?: string
): Promise<boolean> {
  try {
    const storeKey = registry.store_partition_key || ''
    const msgId = String(imageMessageId || '').trim()
    const text = String(memoText || '').trim()

    if (!storeKey || !msgId) return false

    const token = resolveChannelAccessToken(storeKey) || lineAccessTokenForSearch || ''
    if (!token) return false

    // 1. LINE API から画像バイナリを取得
    //    引用元がテキスト等で画像でない場合や、保存期間切れの場合はここで ok:false になる
    const fetched = await fetchLineMessageBinary(msgId, token)
    if (!fetched.ok) {
      console.warn('Knowledge image fetch failed:', fetched.error)
      return false
    }
    // BlobPart として渡すため、ArrayBuffer 実体を持つ Uint8Array に整えておく。
    const binary = new Uint8Array(fetched.bytes)
    if (binary.length === 0) return false

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://hocbnifuactbvmyjraxy.supabase.co'

    // 2. Gemini 2.0 Flash 画像AI解析 (/analyze-image)
    const formData = new FormData()
    const blob = new Blob([binary], { type: 'image/jpeg' })
    formData.append('file', blob, `line_${msgId}.jpg`)
    formData.append('store_key', storeKey)

    const analyzeRes = await fetch(`${supabaseUrl}/functions/v1/admin-api/pos-journals/knowledge/analyze-image`, {
      method: 'POST',
      headers: {
        'x-admin-token': 'demo',
        'x-admin-surface': 'line_report',
        'x-store-key': storeKey
      },
      body: formData
    })

    if (!analyzeRes.ok) {
      console.warn('Knowledge image analyze failed:', analyzeRes.status, await analyzeRes.text())
      return false
    }

    const analyzeJson = await analyzeRes.json()
    const result = analyzeJson.result || {}

    // 3. 原本画像を Storage (store-knowledge) へ保存
    const uploadData = new FormData()
    uploadData.append('file', blob, `line_${msgId}.jpg`)
    uploadData.append('store_key', storeKey)

    const uploadRes = await fetch(`${supabaseUrl}/functions/v1/admin-api/pos-journals/knowledge/upload`, {
      method: 'POST',
      headers: {
        'x-admin-token': 'demo',
        'x-admin-surface': 'line_report',
        'x-store-key': storeKey
      },
      body: uploadData
    })

    let storagePath = null
    if (uploadRes.ok) {
      const uploadJson = await uploadRes.json()
      storagePath = uploadJson.storage_path || null
    }

    // 4. ナレッジ DB 登録 & 1,500文字 RAG 生成
    const recordPayload = {
      store_partition_key: storeKey,
      category: result.category || 'メニュー',
      title: result.title || `LINE画像メモ_${msgId}`,
      summary: result.summary || 'LINEより投稿された画像メモ',
      body_text: result.body_text || text || '',
      tags: Array.isArray(result.tags) ? ['LINE投稿', '画像メモ', ...result.tags] : ['LINE投稿', '画像メモ'],
      storage_bucket: 'store-knowledge',
      storage_path: storagePath,
      original_file_name: `line_${msgId}.jpg`,
      mime_type: 'image/jpeg',
      file_size_bytes: binary.length,
      source_type: 'line_post',
      created_by: createdBy || 'LINEユーザー'
    }

    const postKnowledge = (payload: Record<string, unknown>) =>
      fetch(`${supabaseUrl}/functions/v1/admin-api/pos-journals/knowledge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': 'demo',
          'x-admin-surface': 'line_report',
          'x-store-key': storeKey
        },
        body: JSON.stringify(payload)
      })

    let saveRes = await postKnowledge(recordPayload)

    // 本番DBの CHECK 制約に 'line_post' がまだ入っていない環境では source_type で弾かれる。
    // admin-api 側の process-line-post と同じ考え方で 'upload' にフォールバックして再試行する。
    if (!saveRes.ok) {
      const errText = await saveRes.text().catch(() => '')
      if (/source_type/.test(errText)) {
        console.warn('knowledge insert rejected by source_type constraint; retrying as upload')
        saveRes = await postKnowledge({ ...recordPayload, source_type: 'upload' })
      } else {
        console.warn('knowledge insert failed:', saveRes.status, errText.slice(0, 200))
      }
    }

    return saveRes.ok
  } catch (err) {
    console.error('registerQuotedImageAsKnowledge failed:', err)
  }
  return false
}

Deno.serve(async (req) => {
  const supabase = createServiceClient()
  if (!supabase) {
    return jsonResponse({ ok: false, error: 'Server misconfigured' }, 500)
  }

  const templateDownloadResponse = await maybeServeTemplateDownload(req, supabase)
  if (templateDownloadResponse) return templateDownloadResponse

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const requestedStoreKey = parseStoreKeyFromRequest(req)

  // 管理Bot: 承認専用（店舗Botの DB・レシート・会話記録には触れない）
  if (requestedStoreKey === ADMIN_STORE_PARTITION_KEY) {
    return serveAdminApprovalWebhook(req)
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
    let budgetEntryAllowed = false
    // 小口（経費）レシート解析の許可（既定ON）。ONなら「AI返信完全無し」でも経費フローは優先して解析・返信する。
    let pettyAnalysisAllowed = true
    // 売上(精算)レシートをこのルームから本番DBへ登録するか（既定ON）。試運転ルームは OFF にして本番テーブルを汚さない。
    let salesRegistrationAllowed = true
    let receiptReplyVisibility: ReceiptReplyVisibilityOptions = { showExecutiveDetail: true }
    if (eventRoomId) {
      const muteFlags = await loadRoomSearchFlagsCached(eventRoomId)
      roomHardMuted = !!muteFlags?.bot_reply_hard_mute_enabled
      // flags が null（DB エラー）のときはデフォルト送信（suppress = false）
      suppressReceiptReply = muteFlags !== null ? !muteFlags.image_analysis_reply_enabled : false
      suppressNonReceiptReply = muteFlags !== null ? !muteFlags.non_receipt_image_reply_enabled : false
      allowCorrectionReply = muteFlags !== null ? !!muteFlags.receipt_correction_reply_enabled : false
      // メディア保存（メディア閲覧）: OFF のルームは保存しない。null（DBエラー）時は既定で保存。
      allowMediaSave = muteFlags !== null ? muteFlags.media_save_enabled !== false : true
      // 予算登録フローの権限ゲート（既定OFF＝「許可」した部屋だけ作動）。
      budgetEntryAllowed = muteFlags !== null ? !!muteFlags.budget_entry_enabled : false
      pettyAnalysisAllowed = muteFlags !== null ? muteFlags.petty_receipt_analysis_enabled !== false : true
      salesRegistrationAllowed = muteFlags !== null ? muteFlags.receipt_sales_registration_enabled !== false : true
      receiptReplyVisibility = {
        showExecutiveDetail: muteFlags !== null
          ? muteFlags.receipt_reply_executive_detail_enabled !== false
          : true,
      }
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

    // ファイル（Excel/CSV）受信 → 月次日別売上管理表なら日次売上をレシート同等で登録。
    if (event.type === 'message' && event.message?.type === 'file') {
      try {
        const r = await processDailySalesFileEvent(registry as StoreRegistryRow, event, roomHardMuted, salesRegistrationAllowed)
        if (r.replied) receiptReplies += 1
        if (r.reason) errors.push(normalizeInlineText(r.reason).slice(0, 160))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('processDailySalesFileEvent failed:', msg)
        errors.push(msg.slice(0, 160))
      }
    }

    // 画像・postback・テキストの各ブロックから参照するため、最初の利用箇所より前で初期化する。
    const lineAccessTokenForSearch = resolveChannelAccessToken(storeKey)

    if (event.type === 'message' && event.message?.type === 'image') {
      try {
        // 注意: ここで #メモ 判定はしない。LINE の画像メッセージには text フィールドが
        // 無いため、画像単体で #メモ かどうかは判別できない。ナレッジ登録は
        // 「画像への引用返信で #メモ」を受けた text イベント側で行う
        // （registerQuotedImageAsKnowledge を参照）。
        const result = await processReceiptImageEvent(
          registry as StoreRegistryRow,
          event,
          roomHardMuted,
          suppressReceiptReply,
          suppressNonReceiptReply,
          pettyAnalysisAllowed,
          salesRegistrationAllowed,
          receiptReplyVisibility,
        )
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
            receiptReplyVisibility,
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

      // 予約スクショ確認カードの postback（resv_imp=登録 / resv_update=既存予約を更新 / resv_imp_skip=破棄）
      if (
        (postbackData.startsWith('resv_imp=') || postbackData.startsWith('resv_update=') || postbackData.startsWith('resv_imp_skip='))
        && postbackReplyToken
      ) {
        try {
          const reservationReply = await handleReservationImportPostback(supabase, postbackData)
          if (reservationReply) {
            await replyLineFlex(
              postbackReplyToken,
              reservationReply,
              lineAccessTokenForSearch,
              webhookReplyLog(registry as StoreRegistryRow, eventRoomIdForPostback ?? '', 'reservation_import_result'),
            )
            receiptReplies += 1
          }
          continue
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('handleReservationImportPostback failed:', msg)
          errors.push(msg.slice(0, 160))
        }
      }

      // フードコート集計の日付確認カードの postback（fcimp=登録 / fcimp_pick=日付指定(datetimepicker) / fcimp_skip=破棄）
      if ((postbackData.startsWith('fcimp=') || postbackData.startsWith('fcimp_pick=') || postbackData.startsWith('fcimp_skip=')) && postbackReplyToken) {
        try {
          const pickedDate = postbackData.startsWith('fcimp_pick=') ? (event.postback?.params?.date ?? null) : null
          const fcReply = await handleFoodCourtReportPostback(supabase, postbackData, pickedDate)
          if (fcReply) {
            await replyLineFlex(
              postbackReplyToken,
              fcReply,
              lineAccessTokenForSearch,
              webhookReplyLog(registry as StoreRegistryRow, eventRoomIdForPostback ?? '', 'foodcourt_report_import_result'),
            )
            receiptReplies += 1
          }
          continue
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('handleFoodCourtReportPostback failed:', msg)
          errors.push(msg.slice(0, 160))
        }
      }

      // 小口現金（経費）確認カードの postback（pcimp=記録 / pcimp_skip=破棄）
      // 権限「小口レシートの解析をする」OFF のルームでは反応しない（ONなら hard mute でも優先返信）。
      if ((postbackData.startsWith('pcimp=') || postbackData.startsWith('pcimp_skip=') || postbackData.startsWith('pcreview=')) && postbackReplyToken && pettyAnalysisAllowed) {
        try {
          const pettyReply = await handlePettyCashPostback(supabase, registry as StoreRegistryRow, postbackData)
          if (pettyReply) {
            await replyLineFlex(
              postbackReplyToken,
              pettyReply,
              lineAccessTokenForSearch,
              webhookReplyLog(registry as StoreRegistryRow, eventRoomIdForPostback ?? '', 'petty_cash_import_result'),
            )
            receiptReplies += 1
          }
          continue
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('handlePettyCashPostback failed:', msg)
          errors.push(msg.slice(0, 160))
        }
      }

      // 日次売上Excel取込の確認カード postback（dsimp=登録/置き換え, dsimp_skip=中止）
      if ((postbackData.startsWith('dsimp=') || postbackData.startsWith('dsimp_skip=')) && postbackReplyToken) {
        try {
          const dsReply = await handleDailySalesImportPostback(supabase, postbackData)
          if (dsReply) {
            await replyLineFlex(
              postbackReplyToken,
              dsReply,
              lineAccessTokenForSearch,
              webhookReplyLog(registry as StoreRegistryRow, eventRoomIdForPostback ?? '', 'daily_sales_import_result'),
            )
            receiptReplies += 1
          }
          continue
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('handleDailySalesImportPostback failed:', msg)
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

      // 店舗ナレッジ (#メモ / #日報 / #note) の Journal Report 自動転送ブリッジ & 通数0リアクション
      if (text && /#(?:メモ|日報|note)/i.test(text) && storeKey) {
        const msgId = event.message?.id ? String(event.message.id) : ''
        const quotedMessageId = String((event.message as any)?.quotedMessageId ?? '').trim()
        let quotedImageHandled = false

        // 画像への引用返信で #メモ を送った場合は、引用元の画像をナレッジとして登録する。
        // LINE の画像メッセージ自体には text が付かないため、これが画像を指定する唯一の手段。
        if (quotedMessageId) {
          try {
            quotedImageHandled = await registerQuotedImageAsKnowledge(
              registry as StoreRegistryRow,
              quotedMessageId,
              text,
              eventUserId,
              lineAccessTokenForSearch,
            )
          } catch (e) {
            console.error('registerQuotedImageAsKnowledge error:', e)
          }

          if (quotedImageHandled && msgId) {
            // 完了通知は通数0通の thumbs_up (👍)。返信メッセージは送らない。
            const token = resolveChannelAccessToken(storeKey) || lineAccessTokenForSearch
            if (token) {
              fetch('https://api.line.me/v2/bot/message/react', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ messageId: msgId, reactionType: 'thumbs_up' })
              }).catch(e => console.warn('Reaction API error:', e))
            }
          }
        }

        // 画像として登録できた場合はテキスト単体の転送を行わない（二重登録の防止）。
        // 引用元が画像でない／取得できなかった場合は、従来どおりテキストとして登録する。
        if (!quotedImageHandled) {
          try {
            const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://hocbnifuactbvmyjraxy.supabase.co'
            const adminApiUrl = `${supabaseUrl}/functions/v1/admin-api/pos-journals/knowledge/process-line-post`

            fetch(adminApiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                // 関数間の内部ブリッジ認証。admin-api 側で service_role キー一致を検証する
                'x-internal-key': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
                'x-admin-surface': 'line_report',
                'x-store-key': storeKey
              },
              body: JSON.stringify({
                store_key: storeKey,
                text: text,
                sender_name: eventUserId || 'LINEユーザー'
              })
            }).then(async res => {
              if (res.ok) {
                const resJson = await res.json()
                if (resJson.processed && msgId) {
                  // 通数0通のメッセージリアクション (thumbs_up 👍) を付与
                  const token = resolveChannelAccessToken(storeKey) || lineAccessTokenForSearch
                  if (token) {
                    fetch('https://api.line.me/v2/bot/message/react', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                      },
                      body: JSON.stringify({
                        messageId: msgId,
                        reactionType: 'thumbs_up'
                      })
                    }).catch(e => console.warn('Reaction API error:', e))
                  }
                }
              }
            }).catch(err => console.error('Failed to forward #メモ to admin-api:', err))
          } catch (e) {
            console.error('Error forwarding #メモ post:', e)
          }
        }
      }

      let dailySalesTemplateHandled = false
      if (!roomHardMuted && text && isDailySalesTemplateRequestText(text) && lineAccessTokenForSearch) {
        dailySalesTemplateHandled = true
        skipSearchMessageRecording = true
        const replyToken = String(event.replyToken ?? '').trim()
        if (replyToken) {
          const result = await replyLineMessages(
            replyToken,
            [buildDailySalesTemplateDownloadFlex(storeKey)],
            lineAccessTokenForSearch,
            webhookReplyLog(registry as StoreRegistryRow, eventRoomId, 'daily_sales_template_download'),
          )
          receiptReplies += result.ok ? 1 : 0
        }
        textHandled += 1
      }

      // ルーム・セルフ設定コマンド「設定」（独立）。他フローの許可状態に依存しない
      // （権限はハンドラ内で room_config_access_enabled＋パスワード設定済みを確認）。
      // トリガー完全一致でなければ {handled:false} で即フォールスルー＝既存処理に干渉しない。
      let roomConfigHandled = false
      if (!dailySalesTemplateHandled && text && eventRoomId) {
        try {
          const rcResult = await handleRoomConfigTextMessage(supabase, registry as StoreRegistryRow, {
            roomId: eventRoomId,
            replyToken: String(event.replyToken ?? ''),
            text,
          })
          if (rcResult.handled) {
            roomConfigHandled = true
            textHandled += 1
            if (rcResult.replied) receiptReplies += 1
          }
        } catch (err) {
          console.error('room_config_flow failed:', err instanceof Error ? err.message : String(err))
        }
      }

      // 予算登録フロー（独立・他に干渉しない）。トリガー「予算登録」or 予算pending中のみ作動し、
      // 処理した時だけ後続のレシート/検索処理をスキップする（部屋メッセージ記録は通常どおり）。
      let budgetEntryHandled = false
      if (!dailySalesTemplateHandled && !roomConfigHandled && budgetEntryAllowed && text && eventRoomId && eventUserId) {
        try {
          const budgetResult = await handleBudgetEntryTextMessage(supabase, registry as StoreRegistryRow, {
            roomId: eventRoomId,
            userId: eventUserId,
            replyToken: String(event.replyToken ?? ''),
            text,
          })
          if (budgetResult.handled) {
            budgetEntryHandled = true
            textHandled += 1
            if (budgetResult.replied) receiptReplies += 1
          }
        } catch (err) {
          console.error('budget_entry_flow failed:', err instanceof Error ? err.message : String(err))
        }
      }

      // 小口現金（経費）取込フロー（独立・他に干渉しない）。「経費」or 経費pending中の「キャンセル」のみ作動。
      // 権限「小口レシートの解析をする」(petty_receipt_analysis_enabled) OFF のルームでは作動しない。
      let pettyCashHandled = false
      if (!dailySalesTemplateHandled && !roomConfigHandled && !budgetEntryHandled && pettyAnalysisAllowed && text && eventRoomId && eventUserId) {
        try {
          const pettyResult = await handlePettyCashTextMessage(supabase, registry as StoreRegistryRow, {
            roomId: eventRoomId,
            userId: eventUserId,
            replyToken: String(event.replyToken ?? ''),
            text,
          })
          if (pettyResult.handled) {
            pettyCashHandled = true
            textHandled += 1
            if (pettyResult.replied) receiptReplies += 1
          }
        } catch (err) {
          console.error('petty_cash_flow text failed:', err instanceof Error ? err.message : String(err))
        }
      }

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
      if (!dailySalesTemplateHandled && !roomConfigHandled && !budgetEntryHandled && !pettyCashHandled) try {
        // レシート操作の返信（重複確認 加算/中止/置き換え・修正・削除の結果）は AI返信完全無しの対象外。
        // 「レシートの解析結果を送信」または「レシート修正の返信を許可」の両方OFFのときだけ抑止する。
        const result = await processReceiptTextEvent(
          registry as StoreRegistryRow,
          event,
          supabase,
          suppressReceiptReply && !allowCorrectionReply,
          receiptReplyVisibility,
        )
        receiptHandled = result.handled
        if (result.handled) textHandled += 1
        if (result.replied) receiptReplies += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('processReceiptTextEvent failed:', msg)
        errors.push(msg.slice(0, 160))
      }

      if (!dailySalesTemplateHandled && !roomConfigHandled && !budgetEntryHandled && !pettyCashHandled && !receiptHandled && isLineSearchGuideEnabled() && lineAccessTokenForSearch) {
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
