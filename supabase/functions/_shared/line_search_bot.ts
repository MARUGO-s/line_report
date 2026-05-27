import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { StoreRegistryRow } from './store_receipt.ts'
import { lineReplyPayloadToMessages } from './receipt_correction.ts'
import type { LineReplyPayload } from './receipt_types.ts'
import { replyLineMessages } from './line_client.ts'
import { formatYenAmount } from './receipt_parse.ts'

export type SearchKind = 'message' | 'calendar' | 'media' | 'sales'

const SEARCH_GUIDE_ENABLED = (() => {
  const raw = String(Deno.env.get('LINE_SEARCH_GUIDE_ENABLED') ?? '').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
})()

const PENDING_TTL_MS = 15 * 60 * 1000
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

type RoomSearchFlags = {
  bot_reply_hard_mute_enabled: boolean
  message_search_enabled: boolean
  message_search_library_enabled: boolean
  media_file_access_enabled: boolean
  calendar_ai_auto_create_enabled: boolean
  calendar_silent_auto_register_enabled: boolean
  receipt_midreport_enabled: boolean
  receipt_monthend_report_enabled: boolean
}

type LineBotEvent = {
  type?: string
  replyToken?: string
  postback?: { data?: string }
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string }
  message?: { type?: string; text?: string }
}

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

function parsePostbackKind(data: string): SearchKind | 'menu' | 'cancel' | null {
  const raw = String(data ?? '').trim()
  if (raw === POSTBACK_MENU) return 'menu'
  if (raw === POSTBACK_CANCEL) return 'cancel'
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

async function loadRoomSearchFlags(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RoomSearchFlags | null> {
  const { data, error } = await supabase
    .from('room_summary_settings')
    .select(
      'bot_reply_hard_mute_enabled, message_search_enabled, message_search_library_enabled, media_file_access_enabled, calendar_ai_auto_create_enabled, calendar_silent_auto_register_enabled, receipt_midreport_enabled, receipt_monthend_report_enabled',
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
      message_search_enabled: false,
      message_search_library_enabled: false,
      media_file_access_enabled: false,
      calendar_ai_auto_create_enabled: false,
      calendar_silent_auto_register_enabled: false,
      receipt_midreport_enabled: true,
      receipt_monthend_report_enabled: true,
    }
  }

  const row = data as Record<string, unknown>
  return {
    bot_reply_hard_mute_enabled: row.bot_reply_hard_mute_enabled === true,
    message_search_enabled: row.message_search_enabled === true,
    message_search_library_enabled: row.message_search_library_enabled === true,
    media_file_access_enabled: row.media_file_access_enabled === true,
    calendar_ai_auto_create_enabled: row.calendar_ai_auto_create_enabled === true,
    calendar_silent_auto_register_enabled: row.calendar_silent_auto_register_enabled === true,
    receipt_midreport_enabled: row.receipt_midreport_enabled !== false,
    receipt_monthend_report_enabled: row.receipt_monthend_report_enabled !== false,
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
      'このルームのトークをキーワードで探します（保存期間: 直近1年）。',
      '※会話は常に記録されますが、検索できるのは「会話検索」がONのルームだけです。',
      '次のメッセージで、探したい語句をそのまま送ってください。',
      '例: 予約 変更 / 田中',
    ].join('\n')
  }
  if (kind === 'calendar') {
    return [
      'このルームに登録された予定を、キーワードで探します（直近1年）。',
      '次のメッセージで、件名やメモに含まれそうな語句を送ってください。',
      '例: 面接 / 貸切',
    ].join('\n')
  }
  if (kind === 'media') {
    return [
      '保存された画像・動画・ファイルを、キーワードで探します。',
      '次のメッセージで、ファイル名やメモに含まれる語句を送ってください。',
    ].join('\n')
  }
  return [
    'このルームのレシート売上を、日付で探します。',
    '次のメッセージで日付を8桁で送ってください。',
    '例: 20260521（2026年5月21日）',
  ].join('\n')
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

  return {
    type: 'flex',
    altText: '検索メニュー — 種類を選んでからキーワードや日付を送ると過去データを検索できます',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: '過去データの検索',
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
            text: '会話・予定は直近1年分が対象です。',
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

function truncateLine(text: string, max = 120): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

async function executeMessageSearch(
  supabase: SupabaseClient,
  roomId: string,
  query: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('search_line_room_messages', {
    p_query: query,
    p_room_id: roomId,
    p_limit: MAX_RESULT_LINES,
    p_offset: 0,
  })
  if (error) return `会話検索に失敗しました: ${error.message}`
  const rows = Array.isArray(data) ? data : []
  if (!rows.length) return `「${query}」に一致する会話は見つかりませんでした。`

  const total = Number((rows[0] as { total_count?: unknown }).total_count ?? rows.length)
  const lines = [`【会話検索】「${query}」${total}件（上位${rows.length}件）`]
  for (const row of rows) {
    const r = row as Record<string, unknown>
    const at = String(r.created_at || '').slice(0, 16).replace('T', ' ')
    const body = truncateLine(String(r.text_content || ''))
    lines.push(`・${at}\n  ${body}`)
  }
  lines.push('\n別の語句で探す場合は「検索」と送るか、ボタンから選び直してください。')
  return lines.join('\n')
}

async function executeCalendarSearch(
  supabase: SupabaseClient,
  roomId: string,
  query: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('search_line_room_calendar_events', {
    p_query: query,
    p_room_id: roomId,
    p_limit: MAX_RESULT_LINES,
    p_offset: 0,
  })
  if (error) return `予定検索に失敗しました: ${error.message}`
  const rows = Array.isArray(data) ? data : []
  if (!rows.length) return `「${query}」に一致する予定は見つかりませんでした。`

  const total = Number((rows[0] as { total_count?: unknown }).total_count ?? rows.length)
  const lines = [`【予定検索】「${query}」${total}件`]
  for (const row of rows) {
    const r = row as Record<string, unknown>
    const when = String(r.starts_at || r.created_at || '').slice(0, 16).replace('T', ' ')
    const title = truncateLine(String(r.event_title || '（無題）'))
    lines.push(`・${when} ${title}`)
  }
  return lines.join('\n')
}

async function executeMediaSearch(
  supabase: SupabaseClient,
  roomId: string,
  query: string,
  includeLibrary: boolean,
): Promise<string> {
  const esc = query.replace(/,/g, ' ').replace(/[%_]/g, '').slice(0, 80)
  const ilikeFilter = `original_file_name.ilike.%${esc}%,content_preview.ilike.%${esc}%`
  const { data: mediaRows, error: mediaError } = await supabase
    .from('line_message_media')
    .select('media_type, original_file_name, content_preview, created_at')
    .eq('room_id', roomId)
    .or(ilikeFilter)
    .order('created_at', { ascending: false })
    .limit(MAX_RESULT_LINES)

  if (mediaError) return `メディア検索に失敗しました: ${mediaError.message}`

  const lines: string[] = [`【メディア検索】「${query}」`]
  const media = Array.isArray(mediaRows) ? mediaRows : []
  if (media.length) {
    lines.push(`メディア ${media.length}件:`)
    for (const row of media) {
      const r = row as Record<string, unknown>
      const at = String(r.created_at || '').slice(0, 16).replace('T', ' ')
      const name = truncateLine(String(r.original_file_name || r.content_preview || r.media_type || 'file'))
      lines.push(`・${at} [${r.media_type}] ${name}`)
    }
  }

  if (includeLibrary) {
    const docFilter = `original_file_name.ilike.%${esc}%,extracted_text.ilike.%${esc}%`
    const { data: docRows, error: docError } = await supabase
      .from('line_documents')
      .select('original_file_name, mime_type, created_at')
      .eq('room_id', roomId)
      .or(docFilter)
      .order('created_at', { ascending: false })
      .limit(MAX_RESULT_LINES)

    if (!docError && Array.isArray(docRows) && docRows.length) {
      lines.push(`資料 ${docRows.length}件:`)
      for (const row of docRows) {
        const r = row as Record<string, unknown>
        const at = String(r.created_at || '').slice(0, 16).replace('T', ' ')
        lines.push(`・${at} ${truncateLine(String(r.original_file_name || ''))}`)
      }
    }
  }

  if (lines.length === 1) {
    return `「${query}」に一致するメディア・資料は見つかりませんでした。`
  }
  return lines.join('\n')
}

async function executeSalesSearch(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  roomId: string,
  yyyymmdd: string,
): Promise<string> {
  const iso = parseSalesDateYyyymmdd(yyyymmdd)
  if (!iso) {
    return '日付の形式が正しくありません。8桁で送ってください（例: 20260521）。'
  }

  const receiptTable = String(registry.receipt_table || '').trim()
  if (!receiptTable) return 'この店舗の売上テーブルが見つかりません。'

  const { data, error } = await supabase
    .from(receiptTable)
    .select('receipt_date, gross_sales_yen, net_sales_yen, party_count, guest_count, summary_text, created_at')
    .eq('room_id', roomId)
    .eq('receipt_date', iso)
    .order('created_at', { ascending: false })
    .limit(MAX_RESULT_LINES)

  if (error) return `売上検索に失敗しました: ${error.message}`
  const rows = Array.isArray(data) ? data : []
  if (!rows.length) {
    return `【売上検索】${iso} のレシートはこのルームにありません。`
  }

  const lines = [`【売上検索】${iso} — ${rows.length}件`]
  for (const row of rows) {
    const r = row as Record<string, unknown>
    const gross = r.gross_sales_yen != null ? formatYenAmount(Number(r.gross_sales_yen)) : '-'
    const net = r.net_sales_yen != null ? formatYenAmount(Number(r.net_sales_yen)) : '-'
    const party = r.party_count != null ? `${r.party_count}組` : ''
    const summary = truncateLine(String(r.summary_text || ''))
    lines.push(`・総売上 ${gross} / 純売上 ${net} ${party}\n  ${summary}`)
  }
  return lines.join('\n')
}

async function startSearchKind(
  supabase: SupabaseClient,
  roomId: string,
  userId: string,
  kind: SearchKind,
  flags: RoomSearchFlags,
): Promise<LineReplyPayload> {
  if (!kindAllowed(flags, kind)) {
    return {
      type: 'flex',
      altText: `${kindLabel(kind)}は利用できません`,
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: `${kindLabel(kind)}は、このルームでは有効になっていません。`,
              wrap: true,
              size: 'sm',
            },
            {
              type: 'text',
              text: '管理画面のルーム設定で機能をONにしてください。',
              wrap: true,
              size: 'xs',
              color: '#888888',
              margin: 'md',
            },
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
): Promise<string> {
  if (kind === 'sales') {
    const iso = parseSalesDateYyyymmdd(text)
    if (!iso) {
      return '売上検索は日付8桁で送ってください。\n例: 20260521'
    }
    await clearSearchPending(supabase, roomId, userId)
    return executeSalesSearch(supabase, registry, roomId, normalizeTriggerText(text))
  }

  const query = text.trim()
  if (query.length < 1) {
    return '検索キーワードを送ってください。'
  }

  await clearSearchPending(supabase, roomId, userId)

  if (kind === 'message') {
    if (!flags.message_search_enabled) {
      return '会話検索はこのルームでOFFです。トークは記録されていますが、ONにするまで検索できません。管理画面の「会話検索（ルーム）」を有効にしてください。'
    }
    return executeMessageSearch(supabase, roomId, query)
  }
  if (kind === 'calendar') {
    return executeCalendarSearch(supabase, roomId, query)
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

  const flags = await loadRoomSearchFlags(supabase, roomId)
  if (!flags || flags.bot_reply_hard_mute_enabled) {
    return { handled: false, replied: false }
  }

  const action = parsePostbackKind(String(event.postback?.data ?? ''))
  if (!action) return { handled: false, replied: false }

  if (action === 'cancel') {
    await clearSearchPending(supabase, roomId, userId)
    const result = await replyLineMessages(
      replyToken,
      [{ type: 'text', text: '検索をキャンセルしました。' }],
      accessToken,
    )
    return { handled: true, replied: result.ok }
  }

  if (action === 'menu') {
    const flex = buildSearchMenuFlex(flags)
    const result = await replyLineMessages(replyToken, [flex], accessToken)
    return { handled: true, replied: result.ok }
  }

  const payload = await startSearchKind(supabase, roomId, userId, action, flags)
  const messages = lineReplyPayloadToMessages(payload)
  const result = await replyLineMessages(replyToken, messages, accessToken)
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

  const flags = await loadRoomSearchFlags(supabase, roomId)
  if (!flags || flags.bot_reply_hard_mute_enabled) {
    return { handled: false, replied: false }
  }

  if (isCancelText(text)) {
    const pending = await loadSearchPending(supabase, roomId, userId)
    if (!pending) return { handled: false, replied: false }
    await clearSearchPending(supabase, roomId, userId)
    const result = await replyLineMessages(
      replyToken,
      [{ type: 'text', text: '検索をキャンセルしました。' }],
      accessToken,
    )
    return { handled: true, replied: result.ok }
  }

  const pending = await loadSearchPending(supabase, roomId, userId)
  if (pending) {
    const resultText = await runPendingSearch(
      supabase,
      registry,
      roomId,
      userId,
      pending,
      text,
      flags,
    )
    const result = await replyLineMessages(
      replyToken,
      [{ type: 'text', text: resultText.slice(0, 4900) }],
      accessToken,
    )
    return { handled: true, replied: result.ok }
  }

  const directKind = detectKindTrigger(text)
  if (directKind) {
    const payload = await startSearchKind(supabase, roomId, userId, directKind, flags)
    const messages = lineReplyPayloadToMessages(payload)
    const result = await replyLineMessages(replyToken, messages, accessToken)
    return { handled: true, replied: result.ok }
  }

  if (isMenuTrigger(text)) {
    const flex = buildSearchMenuFlex(flags)
    const result = await replyLineMessages(replyToken, [flex], accessToken)
    return { handled: true, replied: result.ok }
  }

  const salesDate = parseSalesDateYyyymmdd(text)
  if (salesDate && (flags.receipt_midreport_enabled || flags.receipt_monthend_report_enabled)) {
    const resultText = await executeSalesSearch(
      supabase,
      registry,
      roomId,
      normalizeTriggerText(text),
    )
    const result = await replyLineMessages(
      replyToken,
      [{ type: 'text', text: resultText.slice(0, 4900) }],
      accessToken,
    )
    return { handled: true, replied: result.ok }
  }

  return { handled: false, replied: false }
}
