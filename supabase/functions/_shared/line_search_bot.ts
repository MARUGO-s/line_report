import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { StoreRegistryRow } from './store_receipt.ts'
import {
  isReceiptCorrectionControlText,
  lineReplyPayloadToMessages,
} from './receipt_correction.ts'
import type { LineReplyPayload } from './receipt_types.ts'
import { pushLineMessages, replyLineMessages, type LineWebhookDeliveryLogContext } from './line_client.ts'
import {
  formatYenAmount,
  isPlausibleReceiptCount,
  resolveCanonicalStoreDisplayName,
} from './receipt_parse.ts'
import { buildLineFlexBlueHeader } from './line_flex_messages.ts'
import {
  buildReceiptAnalyticsDashboardUri,
  buildReceiptAnalysisDeletionCommandTextForLineMessageId,
  buildReceiptAnalysisDeletionCommandTextForReceiptRowId,
  buildReceiptCorrectionCommandTextForLineMessageId,
  buildReceiptCorrectionCommandTextForReceiptRowId,
  clampLineMessageActionText,
} from './receipt_line_actions.ts'

export type SearchKind = 'message' | 'calendar' | 'media' | 'sales'

const SEARCH_GUIDE_ENABLED = (() => {
  const raw = String(Deno.env.get('LINE_SEARCH_GUIDE_ENABLED') ?? '').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
})()

const PENDING_TTL_MS = 2 * 60 * 1000
const PENDING_TTL_MINUTES = 2
/** Flex 等に表示する検索待ちの注意（待ち中キーワード1通のみ非記録） */
const SEARCH_PENDING_RECORDING_NOTICE =
  `※検索待ちは${PENDING_TTL_MINUTES}分です。待ち中に送ったキーワード1通だけ会話に記録しません（検索ノイズ防止）。それ以外のトークは通常どおり記録されます。`
const MAX_RESULT_LINES = 5

const MENU_TRIGGERS = new Set([
  '検索',
  '検索ヘルプ',
  '検索の仕方',
  '検索方法',
  'ヘルプ',
  '使い方',
  'search',
  'help',
])

const KIND_TRIGGERS: Record<SearchKind, string[]> = {
  message: ['会話検索', 'トーク検索', '会話を検索'],
  calendar: ['予定検索', 'カレンダー検索', '予定を検索'],
  media: ['メディア検索', '画像検索', 'ファイル検索'],
  sales: ['売上検索', '売り上げ検索', 'レシート検索'],
}

const POSTBACK_MENU = 'srch=menu'
const POSTBACK_PREFIX = 'srch='
const POSTBACK_CANCEL = 'srch=cancel'
const POSTBACK_HELP = 'srch=help'

const GROUP_OTHER_SEARCH_TEXT =
  '会話検索・予定検索・メディア検索は、Botを友だち追加した1対1トークでもできます。' +
  'グループ等で記録したデータも、1対1から横断して検索できます。\n\n' +
  'このルームでは売上検索のみ可能です。日付8桁（例: 20260521）または月6桁（例: 202605）を送ってください。'

type RoomSearchFlags = {
  bot_reply_hard_mute_enabled: boolean
  image_analysis_reply_enabled: boolean
  receipt_reply_executive_detail_enabled: boolean
  receipt_correction_reply_enabled: boolean
  non_receipt_image_reply_enabled: boolean
  message_search_enabled: boolean
  message_search_library_enabled: boolean
  media_file_access_enabled: boolean
  calendar_ai_auto_create_enabled: boolean
  calendar_silent_auto_register_enabled: boolean
  receipt_midreport_enabled: boolean
  receipt_monthend_report_enabled: boolean
  media_save_enabled: boolean
  budget_entry_enabled: boolean
  petty_receipt_analysis_enabled: boolean
  /** 売上(精算)レシートをこのルームから本番テーブルへDB登録するか（既定ON）。試運転ルームはOFF。 */
  receipt_sales_registration_enabled: boolean
}

type LineBotEvent = {
  type?: string
  replyToken?: string
  postback?: { data?: string }
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string }
  message?: { type?: string; text?: string; id?: string }
}

const SEARCH_CONTROL_TEXTS = new Set([
  '検索', '検索ヘルプ', '検索の仕方', '検索方法', 'ヘルプ', '使い方', 'search', 'help',
  '会話検索', 'トーク検索', '会話を検索',
  '予定検索', 'カレンダー検索', '予定を検索',
  'メディア検索', '画像検索', 'ファイル検索',
  '売上検索', '売り上げ検索', 'レシート検索',
  'キャンセル', 'やめる', 'cancel',
])

function normalizeTriggerText(text: string): string {
  return String(text ?? '').trim().replace(/\s+/g, '')
}

function resolveRoomId(event: LineBotEvent): string | null {
  const source = event.source || {}
  const groupId = source.groupId ? String(source.groupId).trim() : ''
  const roomId = source.roomId ? String(source.roomId).trim() : ''
  const userId = source.userId ? String(source.userId).trim() : ''
  if (groupId) return groupId
  if (roomId) return roomId
  if (userId && String(source.type || '').trim() === 'user') return userId
  return null
}

function resolveUserId(event: LineBotEvent): string | null {
  const userId = event.source?.userId ? String(event.source.userId).trim() : ''
  return userId || null
}

/** 公式アカウントとの1対1トーク（source.type === user） */
export function isLineDirectMessageEvent(event: LineBotEvent): boolean {
  return String(event.source?.type ?? '').trim() === 'user'
}

/** 招待グループ（C…）または複数人トーク（R…） */
export function isLineInvitedChatRoomId(roomId: string): boolean {
  const id = String(roomId ?? '').trim()
  return id.startsWith('C') || id.startsWith('R')
}

/** 招待ルーム上のトークか（source.type / groupId を最優先。room_id の U 誤判定を防ぐ） */
export function isLineInvitedChatRoom(event: LineBotEvent, roomId: string): boolean {
  const source = event.source || {}
  const sourceType = String(source.type ?? '').trim().toLowerCase()
  if (sourceType === 'group' || sourceType === 'room') return true
  if (String(source.groupId ?? '').trim()) return true
  if (String(source.roomId ?? '').trim()) return true
  return isLineInvitedChatRoomId(roomId)
}

/** 1対1トークか（招待ルームでなければ1対1扱い） */
export function isLineDirectMessageChat(event: LineBotEvent, roomId: string): boolean {
  return !isLineInvitedChatRoom(event, roomId)
}

/** 1対1の room_id（LINE ユーザーID = U…。C/R は常に false） */
export function isDirectMessageRoomId(roomId: string): boolean {
  if (isLineInvitedChatRoomId(roomId)) return false
  return String(roomId ?? '').trim().startsWith('U')
}

/** 1対1からの検索は全会話検索ONルームを横断。グループ等は当該ルームのみ */
function resolveSearchScopeRoomId(roomId: string): string | null {
  return isDirectMessageRoomId(roomId) ? null : roomId
}

function isLineSearchPostbackAction(action: SearchKind | 'menu' | 'cancel' | 'help' | null): boolean {
  return action !== null
}

function isLineSearchIntentText(text: string, flags: RoomSearchFlags | null): boolean {
  if (isMenuTrigger(text) || detectKindTrigger(text)) return true
  if (!flags) return false
  const salesInput = parseSalesDateInput(text)
  return !!(salesInput && (flags.receipt_midreport_enabled || flags.receipt_monthend_report_enabled))
}

function parsePostbackKind(data: string): SearchKind | 'menu' | 'cancel' | 'help' | null {
  const raw = String(data ?? '').trim()
  if (raw === POSTBACK_MENU) return 'menu'
  if (raw === POSTBACK_CANCEL) return 'cancel'
  if (raw === POSTBACK_HELP) return 'help'
  if (!raw.startsWith(POSTBACK_PREFIX)) return null
  const kind = raw.slice(POSTBACK_PREFIX.length)
  if (kind === 'msg' || kind === 'message') return 'message'
  if (kind === 'cal' || kind === 'calendar') return 'calendar'
  if (kind === 'med' || kind === 'media') return 'media'
  if (kind === 'sal' || kind === 'sales') return 'sales'
  return null
}

function detectKindTrigger(text: string): SearchKind | null {
  const compact = normalizeTriggerText(text)
  for (const [kind, triggers] of Object.entries(KIND_TRIGGERS) as Array<[SearchKind, string[]]>) {
    if (triggers.some((t) => compact === normalizeTriggerText(t))) return kind
  }
  return null
}

function isMenuTrigger(text: string): boolean {
  const compact = normalizeTriggerText(text).toLowerCase()
  return MENU_TRIGGERS.has(compact) || MENU_TRIGGERS.has(normalizeTriggerText(text))
}

function isCancelText(text: string): boolean {
  const t = normalizeTriggerText(text)
  return t === 'キャンセル' || t === 'cancel' || t === 'やめる'
}

function isLineSearchControlText(text: string): boolean {
  const compact = normalizeTriggerText(text).toLowerCase()
  if (SEARCH_CONTROL_TEXTS.has(compact) || SEARCH_CONTROL_TEXTS.has(normalizeTriggerText(text))) {
    return true
  }
  // 8桁: YYYYMMDD, 6桁: YYYYMM
  return /^20\d{6}$/.test(compact) || /^20\d{4}$/.test(compact)
}

export async function shouldSkipLineSearchMessageRecording(
  supabase: SupabaseClient,
  roomId: string,
  userId: string | null,
  text: string,
  options: { salesSearchAllowed?: boolean } = {},
): Promise<boolean> {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return false
  if (isLineSearchControlText(trimmed)) return true
  if (isMenuTrigger(trimmed) || isCancelText(trimmed)) return true
  if (detectKindTrigger(trimmed)) return true
  if (options.salesSearchAllowed && parseSalesDateInput(trimmed)) return true
  if (userId) {
    const pending = await loadSearchPending(supabase, roomId, userId)
    if (pending) return true
  }
  return false
}

/** 検索待ち中に送ったキーワード1通のみ記録しない（1対1・グループ共通） */
export async function shouldSkipPendingSearchKeywordRecording(
  supabase: SupabaseClient,
  roomId: string,
  userId: string | null,
): Promise<boolean> {
  if (!userId) return false
  const pending = await loadSearchPending(supabase, roomId, userId)
  return pending !== null
}

export async function registerSearchExcludedMessage(
  supabase: SupabaseClient,
  lineMessageId: string,
  roomId: string,
  textContent: string,
): Promise<void> {
  const mid = String(lineMessageId ?? '').trim()
  if (!mid || !roomId) return

  const { error: markError } = await supabase.rpc('mark_line_room_search_excluded_message', {
    p_line_message_id: mid,
    p_room_id: roomId,
    p_text_content: textContent,
  })
  if (markError) {
    console.error('mark_line_room_search_excluded_message failed:', markError.message)
  }

  const { error: purgeError } = await supabase.rpc('purge_line_message_from_search_archives', {
    p_line_message_id: mid,
    p_room_id: roomId,
  })
  if (purgeError) {
    console.error('purge_line_message_from_search_archives failed:', purgeError.message)
  }
}

async function loadRoomNameMap(
  supabase: SupabaseClient,
  roomIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(roomIds.filter(Boolean))]
  const map = new Map<string, string>()
  if (!unique.length) return map

  const [{ data: settings }, { data: names }] = await Promise.all([
    supabase.from('room_summary_settings').select('room_id, room_name').in('room_id', unique),
    supabase.from('line_room_names').select('room_id, room_name').in('room_id', unique),
  ])

  for (const row of names || []) {
    const id = String((row as { room_id?: unknown }).room_id || '').trim()
    const name = String((row as { room_name?: unknown }).room_name || '').trim()
    if (id && name) map.set(id, name)
  }
  for (const row of settings || []) {
    const id = String((row as { room_id?: unknown }).room_id || '').trim()
    const name = String((row as { room_name?: unknown }).room_name || '').trim()
    if (id && name && !map.has(id)) map.set(id, name)
  }

  return map
}

function formatRoomLabel(roomId: string, roomNames: Map<string, string>): string | null {
  const id = String(roomId || '').trim()
  if (!id) return null
  const name = String(roomNames.get(id) || '').trim()
  if (!name || name === id) return null
  return name
}

function flexFullTextBlocks(text: string, size: 'sm' | 'xs' = 'sm'): Array<Record<string, unknown>> {
  const raw = String(text ?? '')
  if (!raw.trim()) {
    return [{ type: 'text', text: '（本文なし）', size, wrap: true }]
  }
  const maxChunk = 900
  const blocks: Array<Record<string, unknown>> = []
  for (let i = 0; i < raw.length; i += maxChunk) {
    blocks.push({
      type: 'text',
      text: raw.slice(i, i + maxChunk),
      size,
      wrap: true,
      ...(i > 0 ? { margin: 'xs' } : {}),
    })
  }
  return blocks
}

export async function loadRoomSearchFlags(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RoomSearchFlags | null> {
  const { data, error } = await supabase
    .from('room_summary_settings')
    .select(
      'bot_reply_hard_mute_enabled, image_analysis_reply_enabled, receipt_reply_executive_detail_enabled, receipt_correction_reply_enabled, non_receipt_image_reply_enabled, message_search_enabled, message_search_library_enabled, media_file_access_enabled, calendar_ai_auto_create_enabled, calendar_silent_auto_register_enabled, receipt_midreport_enabled, receipt_monthend_report_enabled, media_save_enabled, budget_entry_enabled, petty_receipt_analysis_enabled, receipt_sales_registration_enabled',
    )
    .eq('room_id', roomId)
    .maybeSingle()

  if (error) {
    console.error(`line_search_bot settings failed (${roomId}):`, error.message)
    return null
  }
  if (!data) {
    return {
      bot_reply_hard_mute_enabled: false,
      image_analysis_reply_enabled: true,
      receipt_reply_executive_detail_enabled: true,
      receipt_correction_reply_enabled: false,
      non_receipt_image_reply_enabled: true,
      message_search_enabled: false,
      message_search_library_enabled: false,
      media_file_access_enabled: false,
      calendar_ai_auto_create_enabled: false,
      calendar_silent_auto_register_enabled: false,
      receipt_midreport_enabled: true,
      receipt_monthend_report_enabled: true,
      media_save_enabled: true,
      budget_entry_enabled: false,
      petty_receipt_analysis_enabled: true,
      receipt_sales_registration_enabled: true,
    }
  }

  const row = data as Record<string, unknown>
  return {
    bot_reply_hard_mute_enabled: row.bot_reply_hard_mute_enabled === true,
    image_analysis_reply_enabled: row.image_analysis_reply_enabled !== false,
    receipt_reply_executive_detail_enabled: row.receipt_reply_executive_detail_enabled !== false,
    receipt_correction_reply_enabled: row.receipt_correction_reply_enabled === true,
    non_receipt_image_reply_enabled: row.non_receipt_image_reply_enabled !== false,
    message_search_enabled: row.message_search_enabled === true,
    message_search_library_enabled: row.message_search_library_enabled === true,
    media_file_access_enabled: row.media_file_access_enabled === true,
    calendar_ai_auto_create_enabled: row.calendar_ai_auto_create_enabled === true,
    calendar_silent_auto_register_enabled: row.calendar_silent_auto_register_enabled === true,
    receipt_midreport_enabled: row.receipt_midreport_enabled !== false,
    receipt_monthend_report_enabled: row.receipt_monthend_report_enabled !== false,
    media_save_enabled: row.media_save_enabled !== false,
    budget_entry_enabled: row.budget_entry_enabled === true,
    petty_receipt_analysis_enabled: row.petty_receipt_analysis_enabled !== false,
    receipt_sales_registration_enabled: row.receipt_sales_registration_enabled !== false,
  }
}

/** 1対1検索: いずれかのルームでONになっている機能を利用可能にする */
async function loadDirectMessageSearchFlags(supabase: SupabaseClient): Promise<RoomSearchFlags> {
  const { data, error } = await supabase
    .from('room_summary_settings')
    .select(
      'image_analysis_reply_enabled, receipt_reply_executive_detail_enabled, receipt_correction_reply_enabled, non_receipt_image_reply_enabled, message_search_enabled, message_search_library_enabled, media_file_access_enabled, calendar_ai_auto_create_enabled, calendar_silent_auto_register_enabled, receipt_midreport_enabled, receipt_monthend_report_enabled, media_save_enabled, petty_receipt_analysis_enabled',
    )

  if (error) {
    console.error('loadDirectMessageSearchFlags failed:', error.message)
    return {
      bot_reply_hard_mute_enabled: false,
      image_analysis_reply_enabled: true,
      receipt_reply_executive_detail_enabled: true,
      receipt_correction_reply_enabled: false,
      non_receipt_image_reply_enabled: true,
      message_search_enabled: false,
      message_search_library_enabled: false,
      media_file_access_enabled: false,
      calendar_ai_auto_create_enabled: false,
      calendar_silent_auto_register_enabled: false,
      receipt_midreport_enabled: true,
      receipt_monthend_report_enabled: true,
      media_save_enabled: true,
      budget_entry_enabled: false,
      petty_receipt_analysis_enabled: true,
      receipt_sales_registration_enabled: true,
    }
  }

  const rows = Array.isArray(data) ? data : []
  const any = (col: string) =>
    rows.some((row) => (row as Record<string, unknown>)[col] === true)
  const anyReceiptOn = (col: string) =>
    rows.length === 0 || rows.some((row) => (row as Record<string, unknown>)[col] !== false)

  return {
    bot_reply_hard_mute_enabled: false,
    image_analysis_reply_enabled: anyReceiptOn('image_analysis_reply_enabled'),
    receipt_reply_executive_detail_enabled: anyReceiptOn('receipt_reply_executive_detail_enabled'),
    receipt_correction_reply_enabled: any('receipt_correction_reply_enabled'),
    non_receipt_image_reply_enabled: anyReceiptOn('non_receipt_image_reply_enabled'),
    message_search_enabled: any('message_search_enabled'),
    message_search_library_enabled: any('message_search_library_enabled'),
    media_file_access_enabled: any('media_file_access_enabled'),
    calendar_ai_auto_create_enabled: any('calendar_ai_auto_create_enabled'),
    calendar_silent_auto_register_enabled: any('calendar_silent_auto_register_enabled'),
    receipt_midreport_enabled: anyReceiptOn('receipt_midreport_enabled'),
    receipt_monthend_report_enabled: anyReceiptOn('receipt_monthend_report_enabled'),
    media_save_enabled: anyReceiptOn('media_save_enabled'),
    budget_entry_enabled: false,
    petty_receipt_analysis_enabled: anyReceiptOn('petty_receipt_analysis_enabled'),
    // DM横断の検索集約では未使用（売上登録の判定は per-room の loadRoomSearchFlags 側で行う）。
    receipt_sales_registration_enabled: true,
  }
}

/** 1対1は店舗ルームの集約フラグ＋個人チャットのミュートのみ */
export async function loadSearchFlagsForContext(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RoomSearchFlags | null> {
  if (!isDirectMessageRoomId(roomId)) {
    return loadRoomSearchFlags(supabase, roomId)
  }
  const [aggregate, personal] = await Promise.all([
    loadDirectMessageSearchFlags(supabase),
    loadRoomSearchFlags(supabase, roomId),
  ])
  return {
    ...aggregate,
    bot_reply_hard_mute_enabled: personal?.bot_reply_hard_mute_enabled === true,
    image_analysis_reply_enabled: aggregate.image_analysis_reply_enabled,
    receipt_reply_executive_detail_enabled: aggregate.receipt_reply_executive_detail_enabled,
    receipt_correction_reply_enabled: aggregate.receipt_correction_reply_enabled,
    non_receipt_image_reply_enabled: aggregate.non_receipt_image_reply_enabled,
  }
}

function kindAllowed(flags: RoomSearchFlags, kind: SearchKind): boolean {
  if (kind === 'message') return flags.message_search_enabled
  if (kind === 'calendar') {
    return flags.calendar_ai_auto_create_enabled || flags.calendar_silent_auto_register_enabled
  }
  if (kind === 'media') return flags.media_file_access_enabled
  if (kind === 'sales') return flags.receipt_midreport_enabled || flags.receipt_monthend_report_enabled
  return false
}

async function setSearchPending(
  supabase: SupabaseClient,
  roomId: string,
  userId: string,
  kind: SearchKind,
): Promise<void> {
  const { error } = await supabase.from('line_room_search_pending').upsert({
    room_id: roomId,
    user_id: userId,
    search_kind: kind,
    updated_at: new Date().toISOString(),
  })
  if (error) console.error('setSearchPending failed:', error.message)
}

async function clearSearchPending(
  supabase: SupabaseClient,
  roomId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('line_room_search_pending')
    .delete()
    .eq('room_id', roomId)
    .eq('user_id', userId)
  if (error) console.error('clearSearchPending failed:', error.message)
}

async function loadSearchPending(
  supabase: SupabaseClient,
  roomId: string,
  userId: string,
): Promise<SearchKind | null> {
  const { data, error } = await supabase
    .from('line_room_search_pending')
    .select('search_kind, updated_at')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error || !data) return null
  const updatedAt = new Date(String((data as { updated_at?: string }).updated_at || '')).getTime()
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > PENDING_TTL_MS) {
    await clearSearchPending(supabase, roomId, userId)
    return null
  }
  const kind = String((data as { search_kind?: string }).search_kind || '') as SearchKind
  if (kind === 'message' || kind === 'calendar' || kind === 'media' || kind === 'sales') return kind
  return null
}

function kindLabel(kind: SearchKind): string {
  if (kind === 'message') return '会話検索'
  if (kind === 'calendar') return '予定検索'
  if (kind === 'media') return 'メディア検索'
  return '売上検索'
}

function kindDescription(kind: SearchKind): string {
  if (kind === 'message') {
    return [
      '招待されているグループ等も含め、会話検索がONのルームのトークを横断してキーワード検索します（直近1年）。',
      '※会話は常に記録されますが、検索結果に含まれるのは「会話検索」がONのルームだけです。',
      '次のメッセージで、探したい語句をそのまま送ってください。',
      '例: 予約 変更 / 田中',
      SEARCH_PENDING_RECORDING_NOTICE,
    ].join('\n')
  }
  if (kind === 'calendar') {
    return [
      '招待されているグループ等も含め、予定機能がONのルームの予定・予定関連トークを横断してキーワード検索します（直近1年）。',
      '※予定関連のトークは常に記録されますが、検索結果に含まれるのは予定機能がONのルームだけです。',
      '次のメッセージで、件名やメモに含まれそうな語句を送ってください。',
      '例: 面接 / 貸切',
      SEARCH_PENDING_RECORDING_NOTICE,
    ].join('\n')
  }
  if (kind === 'media') {
    return [
      '招待されているグループ等も含め、「メディア閲覧」がONのルームに保存された画像・動画・ファイルを横断してキーワード検索します（直近1年）。',
      '※メディアは常に記録されますが、検索結果に含まれるのは「メディア閲覧」がONのルームだけです。',
      '次のメッセージで、ファイル名やメモに含まれる語句を送ってください。',
      SEARCH_PENDING_RECORDING_NOTICE,
    ].join('\n')
  }
  return [
    'このルームのレシート売上を、日付で探します（直近1年）。',
    '※売上はレシート保存時に常に記録されますが、検索できるのはレシートレポート系がONのルームだけです。',
    '次のメッセージで日付を8桁で送ってください。',
    '例: 20260521（2026年5月21日）',
    SEARCH_PENDING_RECORDING_NOTICE,
  ].join('\n')
}

function flexParagraph(
  text: string,
  opts: { size?: string; weight?: string; color?: string; margin?: string } = {},
): Record<string, unknown> {
  return {
    type: 'text',
    text,
    size: opts.size ?? 'sm',
    weight: opts.weight,
    color: opts.color ?? '#666666',
    wrap: true,
    ...(opts.margin ? { margin: opts.margin } : {}),
  }
}

function buildGroupSalesSearchGuideText(flags: RoomSearchFlags): string {
  if (!kindAllowed(flags, 'sales')) {
    return 'このルームでは売上検索がOFFです。管理画面のルーム設定でレシートレポートを有効にしてください。'
  }
  return [
    'このルームでは売上（レシート）検索のみ利用できます。',
    '下のボタンから日付を送って検索してください。',
    '会話・予定・メディアは1対1トークでも検索できます。',
  ].join('\n')
}

/** 招待ルーム：売上案内＋「売上を検索する」ボタン（4種メニューは出さない） */
function buildGroupSalesSearchGuideFlex(flags: RoomSearchFlags): Record<string, unknown> {
  const salesEnabled = kindAllowed(flags, 'sales')
  const bodyContents: Array<Record<string, unknown>> = [
    flexParagraph('このルームでできる検索', { size: 'md', weight: 'bold', color: '#111111' }),
    flexParagraph('売上（レシート）のみ', { size: 'sm', color: '#111111', margin: 'xs' }),
    { type: 'separator', margin: 'lg' },
    flexParagraph('売上（レシート）を調べる', { weight: 'bold', color: '#111111' }),
    flexParagraph(
      'ボタンを押したあと、日付を8桁で送ると、この店舗に蓄積されたレシート売上を表示します（全ルーム合算）。',
      { margin: 'sm' },
    ),
    flexParagraph('例：20260521（2026年5月21日）', { size: 'xs', color: '#888888', margin: 'sm' }),
    { type: 'separator', margin: 'lg' },
    flexParagraph('1対1トークでは', { weight: 'bold', color: '#111111' }),
    flexParagraph('会話検索・予定検索・メディア検索も利用できます。', { margin: 'sm' }),
    flexParagraph(
      'グループ等で記録した過去データも、Botを友だち追加した1対1から横断して検索できます（直近1年）。',
      { size: 'xs', color: '#888888', margin: 'sm' },
    ),
  ]

  if (!salesEnabled) {
    bodyContents.push(
      flexParagraph(
        '※このルームでは売上検索がOFFです。管理画面のルーム設定でレシートレポートを有効にしてください。',
        { color: '#E53935', margin: 'md' },
      ),
    )
  }

  const bubble: Record<string, unknown> = {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '16px',
      contents: bodyContents,
    },
  }

  const footerButtons: Array<Record<string, unknown>> = []
  if (salesEnabled) {
    footerButtons.push({
      type: 'button',
      style: 'primary',
      height: 'sm',
      action: {
        type: 'postback',
        label: '売上（レシート）を検索する',
        data: 'srch=sal',
        displayText: '売上検索',
      },
    })
  }
  footerButtons.push({
    type: 'button',
    style: 'secondary',
    height: 'sm',
    action: { type: 'postback', label: '📖 使い方（全機能）', data: POSTBACK_HELP, displayText: '使い方' },
  })
  bubble.footer = {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    paddingAll: '12px',
    contents: footerButtons,
  }

  return {
    type: 'flex',
    altText: 'このルームでは売上検索のみ。ボタンから日付を入力',
    contents: bubble,
  }
}

/** 招待ルーム：売上検索ボタン押下後の日付入力待ち */
function buildGroupSalesDatePromptFlex(): Record<string, unknown> {
  return {
    type: 'flex',
    altText: '売上検索 — 日付を8桁で送ってください',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          flexParagraph('売上（レシート）検索', { size: 'md', weight: 'bold', color: '#111111' }),
          { type: 'separator', margin: 'md' },
          flexParagraph('次のメッセージで、調べたい日付を送ってください。', { margin: 'sm' }),
          flexParagraph('8桁の数字（西暦・月・日）', { weight: 'bold', color: '#111111', margin: 'md' }),
          flexParagraph('例：20260521', { size: 'md', weight: 'bold', color: '#1DB446', margin: 'sm' }),
          flexParagraph('→ 2026年5月21日の売上を表示します', { size: 'xs', color: '#888888', margin: 'xs' }),
          flexParagraph(SEARCH_PENDING_RECORDING_NOTICE, { size: 'xs', color: '#888888', margin: 'md' }),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: 'キャンセル',
              data: POSTBACK_CANCEL,
              displayText: 'キャンセル',
            },
          },
        ],
      },
    },
  }
}

function buildSearchEntryReply(
  flags: RoomSearchFlags,
  event: LineBotEvent,
  roomId: string,
): LineReplyPayload {
  const invited = isLineInvitedChatRoom(event, roomId)
  if (invited) {
    console.log('line_search: invited room → sales-only guide', {
      roomId,
      sourceType: event.source?.type,
      groupId: event.source?.groupId,
    })
    return buildGroupSalesSearchGuideFlex(flags)
  }
  return buildSearchMenuFlex(flags)
}

/** 全機能の使い方を1枚にまとめた案内（「使い方」ボタン／help postback で返す）。文脈に依らず安全な情報表示のみ。 */
function buildAllFeaturesGuideFlex(): Record<string, unknown> {
  const h = (text: string): Record<string, unknown> => ({ type: 'text', text, weight: 'bold', size: 'sm', wrap: true, margin: 'md' })
  const d = (text: string): Record<string, unknown> => ({ type: 'text', text, size: 'xs', color: '#666666', wrap: true, margin: 'xs' })
  return {
    type: 'flex',
    altText: '使い方ガイド（できること一覧）',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: '📖 使い方ガイド', weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text: 'このBotでできること一覧です。', size: 'xs', color: '#888888', wrap: true, margin: 'sm' },
          h('🔍 検索（1対1トーク）'),
          d('「検索」と送ると 会話／予定／メディア／売上 のボタンが出ます。種類を選んでキーワードを送ると結果が返ります。売上は日付8桁(例 20260521)・月6桁(例 202605)。'),
          h('🧾 レシート → 売上（店舗トーク）'),
          d('レシート画像を送ると自動で売上登録。「この結果を修正」で修正、削除も可能です。'),
          h('🗒️ 過去の売上（日次売上Excel・店舗トーク）'),
          d('日次売上のExcel(.xlsx/.csv)を店舗トークに送ると、過去日の売上をまとめて登録。新しい日付は自動登録、既存がある期間は確認カードで置き換え。テンプレートが必要な場合は「日別売上管理表」または「売上管理表テンプレート」と送るとダウンロードできます。レポート・売上検索・分析に反映されます。'),
          h('💰 予算登録（店舗トーク）'),
          d('「予算登録」と送ると会話形式で月予算を登録できます（有効なルームのみ）。'),
          h('⚙️ 設定（店舗トーク）'),
          d('「設定」と送るとそのルームの権限設定ページのリンクが届きます（有効なルームのみ）。'),
          h('📊 自動レポート'),
          d('中間（毎月16日10時）・月末（翌月1日10時）に売上集計を自動でお届けします。'),
          h('📅 予約通知'),
          d('Gmail予約・当日予約を自動でLINE通知します。'),
          h('🆔 自分のID'),
          d('「ID確認」と送ると自分のユーザーIDを表示します（管理Bot）。'),
        ],
      },
    },
  }
}

function buildSearchMenuFlex(flags: RoomSearchFlags): Record<string, unknown> {
  const buttons: Array<Record<string, unknown>> = []

  const addBtn = (label: string, data: string, enabled: boolean) => {
    buttons.push({
      type: 'button',
      style: enabled ? 'primary' : 'secondary',
      height: 'sm',
      color: enabled ? undefined : '#aaaaaa',
      action: enabled
        ? { type: 'postback', label, data, displayText: label }
        : { type: 'postback', label: `${label}（未設定）`, data: POSTBACK_MENU, displayText: '検索' },
    })
  }

  addBtn('会話検索', 'srch=msg', kindAllowed(flags, 'message'))
  addBtn('予定検索', 'srch=cal', kindAllowed(flags, 'calendar'))
  addBtn('メディア検索', 'srch=med', kindAllowed(flags, 'media'))
  addBtn('売上検索', 'srch=sal', kindAllowed(flags, 'sales'))
  buttons.push({
    type: 'button',
    style: 'secondary',
    height: 'sm',
    action: { type: 'postback', label: '📖 使い方（全機能）', data: POSTBACK_HELP, displayText: '使い方' },
  })

  return {
    type: 'flex',
    altText: '検索メニュー — 1対1で会話・予定・メディア・売上を検索',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: '過去データの検索（1対1）',
            weight: 'bold',
            size: 'md',
            wrap: true,
          },
          {
            type: 'text',
            text: '検索したい種類のボタンを押し、続けてキーワード（売上は日付8桁）を送ると結果が返ります。',
            size: 'sm',
            color: '#666666',
            wrap: true,
            margin: 'sm',
          },
          {
            type: 'text',
            text:
              '会話・予定・メディアは、招待されているグループ等で記録した過去データも、ここ（1対1）から横断して検索できます（直近1年）。',
            size: 'xs',
            color: '#888888',
            wrap: true,
            margin: 'md',
          },
          {
            type: 'text',
            text: SEARCH_PENDING_RECORDING_NOTICE,
            size: 'xs',
            color: '#888888',
            wrap: true,
            margin: 'md',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: buttons,
      },
    },
  }
}

function buildSearchMenuFooter(roomId: string): Record<string, unknown> | undefined {
  if (!isDirectMessageRoomId(roomId)) return undefined
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    contents: [
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: { type: 'postback', label: '検索メニュー', data: POSTBACK_MENU, displayText: '検索' },
      },
    ],
  }
}

function buildKindPromptFlex(kind: SearchKind): Record<string, unknown> {
  return {
    type: 'flex',
    altText: `${kindLabel(kind)} — キーワード入力待ち`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: kindLabel(kind),
            weight: 'bold',
            size: 'md',
            wrap: true,
          },
          {
            type: 'text',
            text: kindDescription(kind),
            size: 'sm',
            wrap: true,
            margin: 'sm',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '検索メニューに戻る',
              data: POSTBACK_MENU,
              displayText: '検索',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: 'キャンセル',
              data: POSTBACK_CANCEL,
              displayText: 'キャンセル',
            },
          },
        ],
      },
    },
  }
}

function parseSalesDateYyyymmdd(text: string): string | null {
  const compact = normalizeTriggerText(text)
  const m = /^20(\d{2})(\d{2})(\d{2})$/.exec(compact)
  if (!m) return null
  const y = Number(compact.slice(0, 4))
  const mo = Number(compact.slice(4, 6))
  const d = Number(compact.slice(6, 8))
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  if (!Number.isFinite(y) || y < 2000 || y > 2100) return null
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
}

type SalesDateInput =
  | { mode: 'day'; iso: string; compact: string }
  | { mode: 'month'; year: number; month: number; yyyymm: string; fromIso: string; toIsoExclusive: string }

function parseSalesDateInput(text: string): SalesDateInput | null {
  const compact = normalizeTriggerText(text)
  const dayIso = parseSalesDateYyyymmdd(compact)
  if (dayIso) return { mode: 'day', iso: dayIso, compact }

  const m = /^20(\d{2})(\d{2})$/.exec(compact)
  if (!m) return null
  const year = Number(compact.slice(0, 4))
  const month = Number(compact.slice(4, 6))
  if (!Number.isFinite(year) || year < 2000 || year > 2100) return null
  if (!Number.isFinite(month) || month < 1 || month > 12) return null

  const fromIso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-01`
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  const mm = String(nextMonth).padStart(2, '0')
  const toIsoExclusive = `${String(nextYear)}-${mm}-01`
  return { mode: 'month', year, month, yyyymm: compact, fromIso, toIsoExclusive }
}

function truncateLine(text: string, max = 120): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

async function executeMessageSearch(
  supabase: SupabaseClient,
  chatRoomId: string,
  query: string,
): Promise<LineReplyPayload> {
  const scopeRoomId = resolveSearchScopeRoomId(chatRoomId)
  const { data, error } = await supabase.rpc('search_line_room_messages', {
    p_query: query,
    p_room_id: scopeRoomId,
    p_limit: MAX_RESULT_LINES,
    p_offset: 0,
  })
  if (error) return `会話検索に失敗しました: ${error.message}`
  const queryNorm = normalizeTriggerText(query).toLowerCase()
  const rows = (Array.isArray(data) ? data : []).filter((row) => {
    const r = row as Record<string, unknown>
    const body = String(r.text_content || '').trim()
    if (isLineSearchControlText(body)) return false
    // 検索入力そのもの（例: キーワードのみ送った行）は結果から除外
    if (queryNorm && normalizeTriggerText(body).toLowerCase() === queryNorm) return false
    return true
  })
  if (!rows.length) {
    return {
      type: 'flex',
      altText: `会話検索 「${query}」0件`,
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            { type: 'text', text: `会話検索「${query}」`, weight: 'bold', size: 'md', wrap: true },
            { type: 'text', text: '一致する会話は見つかりませんでした。', size: 'sm', color: '#666666', wrap: true },
          ],
        },
      },
    }
  }

  const total = rows.length
  const roomIds = rows.map((row) => String((row as { room_id?: unknown }).room_id || '').trim()).filter(Boolean)
  const roomNames = await loadRoomNameMap(supabase, roomIds)

  const bodyContents: Array<Record<string, unknown>> = [
    { type: 'text', text: `会話検索「${query}」`, weight: 'bold', size: 'md', wrap: true },
    { type: 'text', text: `${total}件（上位${rows.length}件）`, size: 'sm', color: '#666666', margin: 'sm' },
  ]
  for (const row of rows) {
    const r = row as Record<string, unknown>
    const rid = String(r.room_id || '').trim()
    const at = String(r.created_at || '').slice(0, 16).replace('T', ' ')
    const body = String(r.text_content || '')
    const roomLabel = formatRoomLabel(rid, roomNames)
    const blockContents: Array<Record<string, unknown>> = []
    if (roomLabel) {
      blockContents.push({
        type: 'text',
        text: `ルーム: ${roomLabel}`,
        size: 'xs',
        color: '#666666',
        weight: 'bold',
        wrap: true,
      })
    }
    blockContents.push({
      type: 'text',
      text: at || '-',
      size: 'xs',
      color: '#888888',
      wrap: true,
      margin: roomLabel ? 'xs' : undefined,
    })
    blockContents.push(...flexFullTextBlocks(body, 'sm'))
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'md',
      spacing: 'xs',
      contents: blockContents,
    })
  }
  const footer = buildSearchMenuFooter(chatRoomId)
  return {
    type: 'flex',
    altText: `会話検索 ${query} ${total}件`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: bodyContents },
      ...(footer ? { footer } : {}),
    },
  }
}

async function executeCalendarSearch(
  supabase: SupabaseClient,
  chatRoomId: string,
  query: string,
): Promise<LineReplyPayload> {
  const scopeRoomId = resolveSearchScopeRoomId(chatRoomId)
  const { data, error } = await supabase.rpc('search_line_room_calendar_events', {
    p_query: query,
    p_room_id: scopeRoomId,
    p_limit: MAX_RESULT_LINES,
    p_offset: 0,
  })
  if (error) return `予定検索に失敗しました: ${error.message}`
  const rows = Array.isArray(data) ? data : []
  if (!rows.length) {
    return {
      type: 'flex',
      altText: `予定検索 「${query}」0件`,
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            { type: 'text', text: `予定検索「${query}」`, weight: 'bold', size: 'md', wrap: true },
            { type: 'text', text: '一致する予定は見つかりませんでした。', size: 'sm', color: '#666666', wrap: true },
          ],
        },
      },
    }
  }

  const total = Number((rows[0] as { total_count?: unknown }).total_count ?? rows.length)
  const bodyContents: Array<Record<string, unknown>> = [
    { type: 'text', text: `予定検索「${query}」`, weight: 'bold', size: 'md', wrap: true },
    { type: 'text', text: `${total}件（上位${rows.length}件）`, size: 'sm', color: '#666666', margin: 'sm' },
  ]
  for (const row of rows) {
    const r = row as Record<string, unknown>
    const when = String(r.starts_at || r.created_at || '').slice(0, 16).replace('T', ' ')
    const title = truncateLine(String(r.event_title || '（無題）'))
    const desc = truncateLine(String(r.event_description || ''), 80)
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'md',
      spacing: 'xs',
      contents: [
        { type: 'text', text: `${when || '-'} ${title}`, size: 'sm', weight: 'bold', wrap: true },
        ...(desc ? [{ type: 'text', text: desc, size: 'xs', color: '#666666', wrap: true }] : []),
      ],
    })
  }
  const calFooter = buildSearchMenuFooter(chatRoomId)
  return {
    type: 'flex',
    altText: `予定検索 ${query} ${total}件`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: bodyContents },
      ...(calFooter ? { footer: calFooter } : {}),
    },
  }
}

async function executeMediaSearch(
  supabase: SupabaseClient,
  chatRoomId: string,
  query: string,
  includeLibrary: boolean,
): Promise<LineReplyPayload> {
  const scopeRoomId = resolveSearchScopeRoomId(chatRoomId)
  const { data: mediaData, error: mediaError } = await supabase.rpc('search_line_room_media_search', {
    p_query: query,
    p_room_id: scopeRoomId,
    p_limit: MAX_RESULT_LINES,
    p_offset: 0,
  })

  if (mediaError) return `メディア検索に失敗しました: ${mediaError.message}`

  const bodyContents: Array<Record<string, unknown>> = [
    { type: 'text', text: `メディア検索「${query}」`, weight: 'bold', size: 'md', wrap: true },
  ]
  const media = Array.isArray(mediaData) ? mediaData : []
  if (media.length) {
    const total = Number((media[0] as { total_count?: unknown }).total_count ?? media.length)
    bodyContents.push({ type: 'text', text: `メディア ${total}件（上位${media.length}件）`, size: 'sm', color: '#666666', margin: 'sm' })
    for (const row of media) {
      const r = row as Record<string, unknown>
      const at = String(r.created_at || '').slice(0, 16).replace('T', ' ')
      const name = truncateLine(String(r.original_file_name || r.content_preview || r.media_type || 'file'))
      bodyContents.push({
        type: 'box',
        layout: 'vertical',
        margin: 'md',
        spacing: 'xs',
        contents: [
          { type: 'text', text: `[${r.media_type}] ${name}`, size: 'sm', weight: 'bold', wrap: true },
          { type: 'text', text: at || '-', size: 'xs', color: '#888888', wrap: true },
        ],
      })
    }
  }

  if (includeLibrary) {
    const { data: docData, error: docError } = await supabase.rpc('search_line_room_document_search', {
      p_query: query,
      p_room_id: scopeRoomId,
      p_limit: MAX_RESULT_LINES,
      p_offset: 0,
    })

    if (!docError && Array.isArray(docData) && docData.length) {
      const docTotal = Number((docData[0] as { total_count?: unknown }).total_count ?? docData.length)
      bodyContents.push({ type: 'separator', margin: 'md' })
      bodyContents.push({ type: 'text', text: `資料 ${docTotal}件（上位${docData.length}件）`, size: 'sm', color: '#666666', margin: 'md' })
      for (const row of docData) {
        const r = row as Record<string, unknown>
        const at = String(r.created_at || '').slice(0, 16).replace('T', ' ')
        bodyContents.push({
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          spacing: 'xs',
          contents: [
            { type: 'text', text: truncateLine(String(r.original_file_name || '')), size: 'sm', weight: 'bold', wrap: true },
            { type: 'text', text: at || '-', size: 'xs', color: '#888888', wrap: true },
          ],
        })
      }
    }
  }

  if (bodyContents.length === 1) {
    return {
      type: 'flex',
      altText: `メディア検索 「${query}」0件`,
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            { type: 'text', text: `メディア検索「${query}」`, weight: 'bold', size: 'md', wrap: true },
            { type: 'text', text: '一致するメディア・資料は見つかりませんでした。', size: 'sm', color: '#666666', wrap: true },
          ],
        },
      },
    }
  }
  const mediaFooter = buildSearchMenuFooter(chatRoomId)
  return {
    type: 'flex',
    altText: `メディア検索 ${query}`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: bodyContents },
      ...(mediaFooter ? { footer: mediaFooter } : {}),
    },
  }
}

function storeReplyLog(
  registry: StoreRegistryRow,
  roomId: string | null,
  context: string,
): LineWebhookDeliveryLogContext {
  return {
    storePartitionKey: registry.store_partition_key,
    roomId,
    context,
  }
}

function dedupeSalesSearchRows(
  rows: Record<string, unknown>[],
  fromLegacyReceiptTable: boolean,
): Record<string, unknown>[] {
  const seen = new Set<string>()
  const out: Record<string, unknown>[] = []
  for (const raw of rows) {
    const r = { ...raw }
    const receiptRowId = fromLegacyReceiptTable
      ? (() => {
        const n = typeof r.id === 'number' ? r.id : Number(r.id)
        return Number.isFinite(n) && n > 0 ? Math.round(n) : null
      })()
      : (() => {
        const n = typeof r.receipt_row_id === 'number' ? r.receipt_row_id : Number(r.receipt_row_id)
        return Number.isFinite(n) && n > 0 ? Math.round(n) : null
      })()
    if (receiptRowId != null) r.receipt_row_id = receiptRowId
    const lmid = String(r.line_message_id ?? '').trim()
    const key = receiptRowId != null
      ? `rid:${receiptRowId}`
      : lmid
      ? `lmid:${lmid}`
      : `anon:${String(r.gross_sales_yen)}:${String(r.created_at)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

async function executeSalesSearch(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  roomId: string,
  yyyymmddOrYyyymm: string,
): Promise<LineReplyPayload> {
  const salesInput = parseSalesDateInput(yyyymmddOrYyyymm)
  if (!salesInput) {
    return '日付の形式が正しくありません。日付8桁（例: 20260521）または月6桁（例: 202605）で送ってください。'
  }

  const receiptTable = String(registry.receipt_table || '').trim()
  if (!receiptTable) {
    return 'この店舗の売上テーブルが見つかりません。'
  }

  // 月次（YYYYMM）: 合計金額・人数・組数（会計組数）を返す
  if (salesInput.mode === 'month') {
    const { data, error } = await supabase.rpc('search_line_room_receipt_month_summary_by_receipt_table', {
      p_receipt_table: receiptTable,
      p_room_id: null,
      p_from_date: salesInput.fromIso,
      p_to_date_exclusive: salesInput.toIsoExclusive,
    })
    if (error) return `売上（月次）検索に失敗しました: ${error.message}`
    const row = (Array.isArray(data) && data.length ? data[0] : null) as Record<string, unknown> | null
    const totalGross = row?.total_gross_sales_yen
    const totalParty = row?.total_party_count
    const totalGuest = row?.total_guest_count
    const receiptCount = row?.receipt_count

    const toNumberOrNull = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) ? n : null
    }
    const yenOrDash = (v: unknown) => {
      const n = toNumberOrNull(v)
      return n == null ? '-' : formatYenAmount(n)
    }
    const countOrDash = (v: unknown, unit: string) => {
      const n = toNumberOrNull(v)
      return n == null ? '-' : `${Math.round(n)}${unit}`
    }

    const storeName = String(registry.store_partition_key ?? '').trim() || '店舗'
    const monthJa = `${salesInput.year}年${salesInput.month}月`
    const monthTarget = `${salesInput.yyyymm.slice(0, 4)}-${salesInput.yyyymm.slice(4, 6)}`
    const trendUrl = buildReceiptAnalyticsDashboardUri(registry.store_partition_key, monthTarget)

    return {
      type: 'flex',
      altText: `売上（月次） ${monthJa}`,
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            { type: 'text', text: `【売上（月次）】${monthJa}`, weight: 'bold', size: 'md', wrap: true },
            { type: 'text', text: storeName, size: 'xs', color: '#666666', wrap: true },
            { type: 'separator', margin: 'md' },
            {
              type: 'box',
              layout: 'vertical',
              margin: 'md',
              spacing: 'sm',
              contents: [
                { type: 'text', text: `合計（税込）: ${yenOrDash(totalGross)}`, size: 'sm', wrap: true },
                { type: 'text', text: `合計組数: ${countOrDash(totalParty, ' 組')}`, size: 'sm', wrap: true },
                { type: 'text', text: `合計人数: ${countOrDash(totalGuest, ' 人')}`, size: 'sm', wrap: true },
                { type: 'text', text: `レシート件数: ${countOrDash(receiptCount, ' 件')}`, size: 'sm', color: '#666666', wrap: true },
              ],
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            ...(trendUrl
              ? [{
                type: 'button',
                style: 'link',
                height: 'sm',
                action: { type: 'uri', label: 'ダッシュボードを見る', uri: trendUrl },
              }]
              : []),
            {
              type: 'button',
              style: 'secondary',
              height: 'sm',
              action: { type: 'postback', label: '検索メニューに戻る', data: POSTBACK_MENU, displayText: '検索' },
            },
          ],
        },
      },
    }
  }

  const iso = salesInput.iso

  // 店舗 webhook の receipt_table で横断（グループ・1対1どちらもルーム ID では絞らない）
  const { data, error } = await supabase.rpc('search_line_room_receipt_search_by_receipt_table', {
    p_receipt_table: receiptTable,
    p_room_id: null,
    p_receipt_date: iso,
    p_limit: MAX_RESULT_LINES,
    p_offset: 0,
  })

  if (error) return `売上検索に失敗しました: ${error.message}`
  let rows = Array.isArray(data) ? data : []

  // Historical rows: 0件だけでなく、過去インデックスが新カラム未埋めの場合も再取得する
  const needsBackfillFields =
    rows.length > 0
    && ((rows[0] as Record<string, unknown>).tax_amount_yen == null
      || (rows[0] as Record<string, unknown>).party_count == null
      || (rows[0] as Record<string, unknown>).guest_count == null
      || (rows[0] as Record<string, unknown>).unit_price_yen == null
      || (rows[0] as Record<string, unknown>).store_name == null
      || (rows[0] as Record<string, unknown>).receipt_date_text == null)

  let fromLegacyReceiptTable = false

  // Fallback: line_room_receipt_search 未登録・旧行は店舗レシートテーブルから日付一致で取得
  if (!rows.length || needsBackfillFields) {
    fromLegacyReceiptTable = true
    const y = Number(iso.slice(0, 4))
    const mo = Number(iso.slice(5, 7))
    const d = Number(iso.slice(8, 10))
    const jaDateLabel = Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)
      ? `${y}年${mo}月${d}日`
      : ''
    const legacySelect =
      'id, room_id, line_message_id, receipt_date, receipt_date_text, store_name, tax_amount_yen, party_count, guest_count, unit_price_yen, gross_sales_yen, net_sales_yen, summary_text, created_at'

    let legacyQuery = supabase
      .from(receiptTable)
      .select(legacySelect)
      .order('created_at', { ascending: false })
      .limit(MAX_RESULT_LINES)

    if (jaDateLabel) {
      legacyQuery = legacyQuery.or(`receipt_date.eq.${iso},receipt_date_text.ilike.%${jaDateLabel}%`)
    } else {
      legacyQuery = legacyQuery.eq('receipt_date', iso)
    }

    const { data: legacyRows, error: legacyError } = await legacyQuery

    if (legacyError) return `売上検索に失敗しました: ${legacyError.message}`
    rows = Array.isArray(legacyRows) ? legacyRows : []

    // Best-effort reindex for next searches (room_id is preserved from legacy rows).
    if (rows.length) {
      for (const row of rows) {
        const r = row as Record<string, unknown>
        const rRoomId = String(r.room_id || '').trim() || roomId
        const receiptRowId = Number(r.id)
        if (!Number.isFinite(receiptRowId) || receiptRowId <= 0) continue
        try {
          await supabase.rpc('upsert_line_room_receipt_search', {
            p_room_id: rRoomId,
            p_store_partition_key: registry.store_partition_key || null,
            p_line_message_id: r.line_message_id ? String(r.line_message_id) : null,
            p_receipt_date: iso,
              p_receipt_date_text: r.receipt_date_text ? String(r.receipt_date_text) : null,
              p_store_name: resolveCanonicalStoreDisplayName(
                registry.display_name,
                r.store_name ? String(r.store_name) : null,
                registry.store_partition_key,
              ),
            p_summary_text: String(r.summary_text || ''),
            p_gross_sales_yen: r.gross_sales_yen == null ? null : Number(r.gross_sales_yen),
            p_net_sales_yen: r.net_sales_yen == null ? null : Number(r.net_sales_yen),
              p_tax_amount_yen: r.tax_amount_yen == null ? null : Number(r.tax_amount_yen),
              p_party_count: (() => {
                if (r.party_count == null) return null
                const n = Number(r.party_count)
                return Number.isFinite(n) && isPlausibleReceiptCount(Math.round(n)) ? Math.round(n) : null
              })(),
              p_guest_count: (() => {
                if (r.guest_count == null) return null
                const n = Number(r.guest_count)
                return Number.isFinite(n) && isPlausibleReceiptCount(Math.round(n), 99_999) ? Math.round(n) : null
              })(),
              p_unit_price_yen: r.unit_price_yen == null ? null : Number(r.unit_price_yen),
            p_receipt_table: receiptTable,
            p_receipt_row_id: receiptRowId,
          })
        } catch (reindexErr) {
          const msg = reindexErr instanceof Error ? reindexErr.message : String(reindexErr)
          console.error('upsert_line_room_receipt_search fallback reindex failed:', msg)
        }
      }
    }
  }

  rows = dedupeSalesSearchRows(rows as Record<string, unknown>[], fromLegacyReceiptTable)

  if (!rows.length) {
    return `【売上検索】${iso} のレシートは店舗ボットのデータにもありません。`
  }

  const NEGATIVE_COLOR = '#E53935'
  const LABEL_COLOR = '#666666'
  const VALUE_COLOR = '#111111'

  const toNumberOrNull = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : null
  }

  function formatReceiptDateJa(dateText: string | null | undefined, isoFallback: string): string {
    const isoM = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoFallback).slice(0, 10))
    if (isoM) return `${isoM[1]}年${Number(isoM[2])}月${Number(isoM[3])}日`
    const ja = String(dateText ?? '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
    if (ja) return `${ja[1]}年${Number(ja[2])}月${Number(ja[3])}日`
    return String(dateText || isoFallback || '-')
  }

  function formatYenOrDash(value: unknown): string {
    const n = toNumberOrNull(value)
    if (n == null) return '-'
    return formatYenAmount(n)
  }

  function formatCountOrDash(value: unknown, unit: string, max = 9999): string {
    const n = toNumberOrNull(value)
    if (n == null) return '-'
    const rounded = Math.max(0, Math.round(n))
    if (!isPlausibleReceiptCount(rounded, max)) return '-'
    return `${rounded}${unit}`
  }

  function kvRow(label: string, value: string, valueColor = VALUE_COLOR) {
    return {
      type: 'box',
      layout: 'horizontal',
      spacing: 'md',
      margin: 'xs',
      contents: [
        { type: 'text', text: label, size: 'sm', color: LABEL_COLOR, flex: 4, wrap: true },
        { type: 'text', text: value, size: 'sm', color: valueColor, flex: 6, align: 'start', wrap: true },
      ],
    }
  }

  const first = rows[0] as Record<string, unknown>
  const storeName = resolveCanonicalStoreDisplayName(
    registry.display_name,
    first.store_name,
    registry.store_partition_key,
  )
  const receiptDateText = first.receipt_date_text ? String(first.receipt_date_text) : null
  const dateTextJa = formatReceiptDateJa(receiptDateText, iso)

  const monthTarget = iso.slice(0, 7)
  const trendUrl = buildReceiptAnalyticsDashboardUri(registry.store_partition_key, monthTarget)

  const bodyContents: Array<Record<string, unknown>> = []
  const footerButtons: Array<Record<string, unknown>> = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown>
    if (i > 0) {
      bodyContents.push({ type: 'separator', margin: 'md' })
    }

    const localStoreName = resolveCanonicalStoreDisplayName(
      registry.display_name,
      r.store_name ?? storeName,
      registry.store_partition_key,
    )
    const localDateText = r.receipt_date_text ? String(r.receipt_date_text) : receiptDateText
    const localDateJa = formatReceiptDateJa(localDateText, iso)

    bodyContents.push(
      kvRow('店名', localStoreName),
      kvRow('日付', localDateJa),
      kvRow('消費税', formatYenOrDash(r.tax_amount_yen)),
      kvRow('総売上（税込）', formatYenOrDash(r.gross_sales_yen)),
      kvRow('会計組数', formatCountOrDash(r.party_count, ' 組', 9999)),
      kvRow('客数', formatCountOrDash(r.guest_count, ' 人', 99_999)),
      kvRow('客単価', formatYenOrDash(r.unit_price_yen)),
    )

    const lineMessageId = String(r.line_message_id ?? '').trim()
    const receiptRowId = toNumberOrNull(r.receipt_row_id)
    const correctLabel = rows.length > 1 ? `この結果を修正（${i + 1}件目）` : 'この結果を修正'
    const correctText = receiptRowId
      ? clampLineMessageActionText(buildReceiptCorrectionCommandTextForReceiptRowId(receiptRowId))
      : lineMessageId
      ? clampLineMessageActionText(buildReceiptCorrectionCommandTextForLineMessageId(lineMessageId))
      : ''
    if (correctText) {
      footerButtons.push({
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: { type: 'message', label: correctLabel, text: correctText },
      })
    }
    const deleteText = receiptRowId
      ? clampLineMessageActionText(buildReceiptAnalysisDeletionCommandTextForReceiptRowId(receiptRowId))
      : lineMessageId
      ? clampLineMessageActionText(buildReceiptAnalysisDeletionCommandTextForLineMessageId(lineMessageId))
      : ''
    if (deleteText) {
      footerButtons.push({
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: {
          type: 'message',
          label: rows.length > 1 ? `削除（${i + 1}件目）` : 'この解析結果を削除',
          text: deleteText,
        },
      })
    }
  }

  footerButtons.push({
    type: 'button',
    style: 'secondary',
    height: 'sm',
    action: {
      type: 'uri',
      label: '売上推移を見る',
      uri: trendUrl,
    },
  })
  footerButtons.push({
    type: 'button',
    style: 'secondary',
    height: 'sm',
    action: { type: 'postback', label: 'キャンセル', data: POSTBACK_CANCEL, displayText: 'キャンセル' },
  })

  return {
    type: 'flex',
    altText: `${storeName} ${dateTextJa} 売上検索結果`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: buildLineFlexBlueHeader(
        '売上検索結果',
        rows.length > 1
          ? `${dateTextJa} — 同一日付のレシートが ${rows.length} 件あります`
          : `${dateTextJa} — 修正・削除は下のボタンから`,
      ),
      body: {
        type: 'box',
        layout: 'vertical',
        contents: bodyContents,
        paddingAll: '16px',
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: footerButtons,
        paddingAll: '12px',
      },
    },
  }
}

async function startSearchKind(
  supabase: SupabaseClient,
  roomId: string,
  userId: string,
  kind: SearchKind,
  flags: RoomSearchFlags,
): Promise<LineReplyPayload> {
  if (isLineInvitedChatRoomId(roomId) && kind !== 'sales') {
    return GROUP_OTHER_SEARCH_TEXT
  }

  if (!kindAllowed(flags, kind)) {
    const offText = `${kindLabel(kind)}は、このルームでは有効になっていません。管理画面のルーム設定で機能をONにしてください。`
    if (isLineInvitedChatRoomId(roomId)) {
      return offText
    }
    return {
      type: 'flex',
      altText: `${kindLabel(kind)}は利用できません`,
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: offText, wrap: true, size: 'sm' },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'link',
              height: 'sm',
              action: { type: 'postback', label: '検索メニュー', data: POSTBACK_MENU, displayText: '検索' },
            },
          ],
        },
      },
    }
  }

  await setSearchPending(supabase, roomId, userId, kind)
  if (isLineInvitedChatRoomId(roomId) && kind === 'sales') {
    return buildGroupSalesDatePromptFlex()
  }
  return buildKindPromptFlex(kind)
}

async function runPendingSearch(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  roomId: string,
  userId: string,
  kind: SearchKind,
  text: string,
  flags: RoomSearchFlags,
): Promise<LineReplyPayload> {
  if (isLineInvitedChatRoomId(roomId) && kind !== 'sales') {
    await clearSearchPending(supabase, roomId, userId)
    return GROUP_OTHER_SEARCH_TEXT
  }

  if (kind === 'sales') {
    const salesInput = parseSalesDateInput(text)
    if (!salesInput) {
      return '売上検索は日付8桁（例: 20260521）または月6桁（例: 202605）で送ってください。'
    }
    await clearSearchPending(supabase, roomId, userId)
    return executeSalesSearch(supabase, registry, roomId, normalizeTriggerText(text))
  }

  const query = text.trim()
  if (query.length < 1) {
    return '検索キーワードを送ってください。'
  }

  await clearSearchPending(supabase, roomId, userId)

  const inDm = isDirectMessageRoomId(roomId)
  const offSuffix = inDm
    ? 'いずれかのグループルームで該当機能をONにしてください。'
    : '管理画面のルーム設定で有効にしてください。'

  if (kind === 'message') {
    if (!flags.message_search_enabled) {
      return `会話検索は利用できません。トークは記録されています。${offSuffix}`
    }
    return executeMessageSearch(supabase, roomId, query)
  }
  if (kind === 'calendar') {
    if (!kindAllowed(flags, 'calendar')) {
      return `予定検索は利用できません。${offSuffix}`
    }
    return executeCalendarSearch(supabase, roomId, query)
  }
  if (!flags.media_file_access_enabled) {
    return `メディア検索は利用できません。${offSuffix}`
  }
  return executeMediaSearch(
    supabase,
    roomId,
    query,
    flags.message_search_library_enabled,
  )
}

export function isLineSearchGuideEnabled(): boolean {
  return SEARCH_GUIDE_ENABLED
}

export async function handleLineSearchPostback(
  supabase: SupabaseClient,
  event: LineBotEvent,
  accessToken: string,
  storePartitionKey?: string,
): Promise<{ handled: boolean; replied: boolean }> {
  if (!SEARCH_GUIDE_ENABLED || event.type !== 'postback') {
    return { handled: false, replied: false }
  }

  const replyToken = String(event.replyToken ?? '').trim()
  const roomId = resolveRoomId(event)
  const userId = resolveUserId(event)
  if (!replyToken || !roomId || !userId) {
    return { handled: false, replied: false }
  }

  const storeKey = String(storePartitionKey ?? '').trim()
  const logCtx = storeKey
    ? { storePartitionKey: storeKey, roomId, context: 'search_postback' }
    : undefined

  const action = parsePostbackKind(String(event.postback?.data ?? ''))
  const inDm = isLineDirectMessageChat(event, roomId)

  if (!inDm) {
    if (!isLineSearchPostbackAction(action)) return { handled: false, replied: false }
    const flags = await loadRoomSearchFlags(supabase, roomId)
    if (!flags || flags.bot_reply_hard_mute_enabled) {
      return { handled: false, replied: false }
    }
    if (!action) return { handled: false, replied: false }
    if (action === 'cancel') {
      await clearSearchPending(supabase, roomId, userId)
      const result = await replyLineMessages(
        replyToken,
        [{ type: 'text', text: '検索をキャンセルしました。' }],
        accessToken,
        logCtx,
      )
      return { handled: true, replied: result.ok }
    }
    if (action === 'help') {
      const result = await replyLineMessages(
        replyToken,
        [buildAllFeaturesGuideFlex()],
        accessToken,
        logCtx,
      )
      return { handled: true, replied: result.ok }
    }
    if (action === 'menu') {
      const payload = buildSearchEntryReply(flags, event, roomId)
      const result = await replyLineMessages(
        replyToken,
        lineReplyPayloadToMessages(payload),
        accessToken,
        logCtx,
      )
      return { handled: true, replied: result.ok }
    }
    if (action === 'message' || action === 'calendar' || action === 'media') {
      const result = await replyLineMessages(
        replyToken,
        [{ type: 'text', text: GROUP_OTHER_SEARCH_TEXT }],
        accessToken,
        logCtx,
      )
      return { handled: true, replied: result.ok }
    }
    if (action === 'sales') {
      const payload = await startSearchKind(supabase, roomId, userId, 'sales', flags)
      const result = await replyLineMessages(
        replyToken,
        lineReplyPayloadToMessages(payload),
        accessToken,
        logCtx,
      )
      return { handled: true, replied: result.ok }
    }
    return { handled: false, replied: false }
  }

  const flags = await loadSearchFlagsForContext(supabase, roomId)
  if (!flags || flags.bot_reply_hard_mute_enabled) {
    return { handled: false, replied: false }
  }

  if (!action) return { handled: false, replied: false }

  if (action === 'cancel') {
    await clearSearchPending(supabase, roomId, userId)
    const result = await replyLineMessages(
      replyToken,
      [{ type: 'text', text: '検索をキャンセルしました。' }],
      accessToken,
      logCtx,
    )
    return { handled: true, replied: result.ok }
  }

  if (action === 'help') {
    const result = await replyLineMessages(
      replyToken,
      [buildAllFeaturesGuideFlex()],
      accessToken,
      logCtx,
    )
    return { handled: true, replied: result.ok }
  }

  if (action === 'menu') {
    const payload = buildSearchEntryReply(flags, event, roomId)
    const result = await replyLineMessages(
      replyToken,
      lineReplyPayloadToMessages(payload),
      accessToken,
      logCtx,
    )
    return { handled: true, replied: result.ok }
  }

  const payload = await startSearchKind(supabase, roomId, userId, action, flags)
  const messages = lineReplyPayloadToMessages(payload)
  const result = await replyLineMessages(replyToken, messages, accessToken, logCtx)
  return { handled: true, replied: result.ok }
}

export async function handleLineSearchTextMessage(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  event: LineBotEvent,
  accessToken: string,
): Promise<{ handled: boolean; replied: boolean }> {
  if (!SEARCH_GUIDE_ENABLED || event.type !== 'message' || event.message?.type !== 'text') {
    return { handled: false, replied: false }
  }

  const text = String(event.message?.text ?? '').trim()
  const replyToken = String(event.replyToken ?? '').trim()
  const roomId = resolveRoomId(event)
  const userId = resolveUserId(event)
  if (!text || !replyToken || !roomId || !userId) {
    return { handled: false, replied: false }
  }

  const inDm = isLineDirectMessageChat(event, roomId)
  const flags = inDm
    ? await loadSearchFlagsForContext(supabase, roomId)
    : await loadRoomSearchFlags(supabase, roomId)
  if (!flags) return { handled: false, replied: false }
  if (flags.bot_reply_hard_mute_enabled) {
    // AI返信完全無しでも「レシート修正の返信を許可」がONなら、売上日付クエリ(8桁/6桁)だけは通す。
    // 会話検索・予定/メディア検索など、その他の検索はミュートのまま。
    const salesDateOverride = flags.receipt_correction_reply_enabled && !!parseSalesDateInput(text)
    if (!salesDateOverride) {
      return { handled: false, replied: false }
    }
  }

  const log = (context: string) => storeReplyLog(registry, roomId, context)
  const isInvalidReplyTokenError = (errorText: string): boolean =>
    /invalid reply token/i.test(String(errorText || ''))
  const replyWithDmFallback = async (
    messages: Record<string, unknown>[],
    logCtx: LineWebhookDeliveryLogContext,
  ): Promise<{ ok: boolean; error?: string }> => {
    const replied = await replyLineMessages(replyToken, messages, accessToken, logCtx)
    if (replied.ok || !inDm || !userId || !isInvalidReplyTokenError(String(replied.error ?? ''))) {
      return replied
    }
    const pushed = await pushLineMessages(userId, messages, accessToken)
    if (pushed.ok) return { ok: true }
    return { ok: false, error: `${String(replied.error ?? '')} | push fallback failed: ${String(pushed.error ?? '')}` }
  }

  if (isReceiptCorrectionControlText(text)) {
    const searchPending = await loadSearchPending(supabase, roomId, userId)
    if (searchPending) {
      await clearSearchPending(supabase, roomId, userId)
      const result = await replyLineMessages(
        replyToken,
        [{
          type: 'text',
          text: 'レシート修正の操作です。修正中のカードの「確定」「キャンセル」ボタンを使うか、「この結果を修正」からやり直してください。',
        }],
        accessToken,
        log('search_correction_hint'),
      )
      return { handled: true, replied: result.ok }
    }
    return { handled: false, replied: false }
  }

  if (isCancelText(text)) {
    const pending = await loadSearchPending(supabase, roomId, userId)
    if (!pending) return { handled: false, replied: false }
    await clearSearchPending(supabase, roomId, userId)
    const result = await replyWithDmFallback(
      [
        { type: 'text', text: '検索をキャンセルしました。' },
      ],
      log('search_cancel'),
    )
    return { handled: true, replied: result.ok }
  }

  const pending = await loadSearchPending(supabase, roomId, userId)
  if (pending) {
    if (!inDm && pending !== 'sales') {
      await clearSearchPending(supabase, roomId, userId)
      const result = await replyWithDmFallback(
        [{ type: 'text', text: GROUP_OTHER_SEARCH_TEXT }],
        log('search_group_only_sales'),
      )
      return { handled: true, replied: result.ok }
    }
    const payload = await runPendingSearch(
      supabase,
      registry,
      roomId,
      userId,
      pending,
      text,
      flags,
    )
    const result = await replyWithDmFallback(
      lineReplyPayloadToMessages(payload),
      log(`search_${pending}_result`),
    )
    return { handled: true, replied: result.ok }
  }

  const directKind = detectKindTrigger(text)
  if (directKind) {
    if (!inDm && directKind !== 'sales') {
      const result = await replyWithDmFallback(
        [{ type: 'text', text: GROUP_OTHER_SEARCH_TEXT }],
        log('search_group_only_sales'),
      )
      return { handled: true, replied: result.ok }
    }
    const payload = await startSearchKind(supabase, roomId, userId, directKind, flags)
    const messages = lineReplyPayloadToMessages(payload)
    const result = await replyWithDmFallback(messages, log(`search_start_${directKind}`))
    return { handled: true, replied: result.ok }
  }

  if (isMenuTrigger(text)) {
    const payload = buildSearchEntryReply(flags, event, roomId)
    const result = await replyWithDmFallback(
      lineReplyPayloadToMessages(payload),
      log('search_menu'),
    )
    return { handled: true, replied: result.ok }
  }

  const salesInput = parseSalesDateInput(text)
  const salesSearchAllowed = flags.receipt_midreport_enabled || flags.receipt_monthend_report_enabled || inDm
  if (salesInput && salesSearchAllowed) {
    const payload = await executeSalesSearch(
      supabase,
      registry,
      roomId,
      normalizeTriggerText(text),
    )
    const result = await replyWithDmFallback(
      lineReplyPayloadToMessages(payload),
      log('sales_search_result'),
    )
    return { handled: true, replied: result.ok }
  }

  return { handled: false, replied: false }
}
