import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { LineImageReceiptAnalysis, LineReplyPayload } from './receipt_types.ts'
import { buildReceiptFlexMessage } from './receipt_flex_reply.ts'
import { loadReceiptReplyContext } from './receipt_reply_context.ts'
import { normalizeInlineText, parseReceiptDateToIso } from './receipt_parse.ts'
import {
  deleteReceiptsForDateExcludingLineMessageId,
  saveStoreReceiptEntry,
  type StoreRegistryRow,
} from './store_receipt.ts'

const PENDING_TABLE = 'store_receipt_duplicate_pending'
const PENDING_TTL_MIN = 30

export type PendingStoreReceiptDuplicate = {
  store_partition_key: string
  receipt_table: string
  room_id: string
  user_id: string | null
  line_message_id: string
  receipt_date: string
  receipt_payload: LineImageReceiptAnalysis
  summary_text: string | null
  store_display_name: string
  sender_display_name: string | null
}

function conversationKey(roomId: string, userId: string | null): string {
  return `${roomId || '__unknown_room__'}::${userId || '__anonymous__'}`
}

function normalizeForRuleParsing(raw: string): string {
  return normalizeInlineText(String(raw ?? '').normalize('NFKC'))
}

function formatJapaneseReceiptDateFromIso(iso: string | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim())
  if (!m) return null
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`
}

function capText(raw: string | null | undefined, max: number): string {
  const s = String(raw ?? '').trim()
  if (!s) return '-'
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function buildReceiptDuplicateConfirmationFlexReply(
  receipt: LineImageReceiptAnalysis,
  receiptDateIso: string,
): Record<string, unknown> {
  const parsedDateIso = parseReceiptDateToIso(receipt.date)
  const displayDate = formatJapaneseReceiptDateFromIso(parsedDateIso) ?? capText(receipt.date, 80)
  const rows = [
    { label: '店名', value: capText(receipt.storeName, 120) },
    { label: '日付', value: displayDate },
    { label: '総売上', value: capText(receipt.grossSales, 40) },
    { label: '会計組数', value: capText(receipt.partyCount, 20) },
    { label: '客数', value: capText(receipt.guestCount, 20) },
  ]
  const detailRows = rows.map((row) => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    margin: 'xs',
    contents: [
      { type: 'text', text: row.label, size: 'sm', color: '#7A7A7A', flex: 4, wrap: true },
      {
        type: 'text',
        text: row.value,
        size: 'sm',
        color: '#1F1F1F',
        flex: 6,
        align: 'start',
        wrap: true,
        weight: 'bold',
      },
    ],
  }))

  const altText = [
    'レシート解析（同日重複の確認）',
    receipt.storeName,
    receipt.grossSales,
    `${receiptDateIso}は登録済み`,
  ].filter(Boolean).join(' / ').slice(0, 400)

  return {
    type: 'flex',
    altText: altText || 'レシート解析（同日重複の確認）',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: '同日のレシートが既に登録されています。次のいずれかを選んでください。',
            size: 'sm',
            weight: 'bold',
            wrap: true,
          },
          { type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md', contents: detailRows },
          {
            type: 'text',
            text: `同じ店舗・同じレシート日（${receiptDateIso}）のデータがあります。`,
            size: 'xs',
            color: '#B45309',
            weight: 'bold',
            wrap: true,
            margin: 'md',
          },
          {
            type: 'text',
            text: 'ボタンまたは「加算」「中止」「置き換え」、番号 1／2／3 で返信できます。',
            size: 'xs',
            color: '#555555',
            wrap: true,
          },
          {
            type: 'text',
            text: '1・加算 … 既存のまま今回も追加。2・中止 … 登録しない。3・置き換え … 同日分を削除して今回のみ。',
            size: 'xs',
            color: '#333333',
            wrap: true,
            margin: 'md',
          },
          {
            type: 'text',
            text: '※「はい」＝加算、「いいえ」＝中止',
            size: 'xs',
            color: '#888888',
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '1 加算', text: '加算' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '2 中止', text: '中止' } },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '3 置き換え', text: '置き換え' } },
        ],
      },
    },
  }
}

export async function savePendingReceiptDuplicate(
  supabase: SupabaseClient,
  payload: PendingStoreReceiptDuplicate,
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + PENDING_TTL_MIN * 60 * 1000).toISOString()
  const { error } = await supabase.from(PENDING_TABLE).upsert({
    conversation_key: conversationKey(payload.room_id, payload.user_id),
    store_partition_key: payload.store_partition_key,
    receipt_table: payload.receipt_table,
    room_id: payload.room_id,
    user_id: payload.user_id,
    line_message_id: payload.line_message_id,
    receipt_date: payload.receipt_date,
    receipt_payload: payload.receipt_payload,
    summary_text: normalizeInlineText(payload.summary_text ?? '').slice(0, 240) || null,
    store_display_name: payload.store_display_name,
    sender_display_name: payload.sender_display_name,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'conversation_key' })
  if (error) {
    console.error('savePendingReceiptDuplicate failed:', error.message)
    return false
  }
  return true
}

export async function loadPendingReceiptDuplicate(
  supabase: SupabaseClient,
  roomId: string,
  userId: string | null,
): Promise<PendingStoreReceiptDuplicate | null> {
  const { data, error } = await supabase
    .from(PENDING_TABLE)
    .select('*')
    .eq('conversation_key', conversationKey(roomId, userId))
    .maybeSingle()
  if (error || !data) return null
  const expiresAt = String((data as { expires_at?: unknown }).expires_at ?? '')
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    await clearPendingReceiptDuplicate(supabase, roomId, userId)
    return null
  }
  return {
    store_partition_key: String((data as { store_partition_key?: unknown }).store_partition_key ?? ''),
    receipt_table: String((data as { receipt_table?: unknown }).receipt_table ?? ''),
    room_id: String((data as { room_id?: unknown }).room_id ?? roomId),
    user_id: (data as { user_id?: unknown }).user_id != null
      ? String((data as { user_id?: unknown }).user_id)
      : null,
    line_message_id: String((data as { line_message_id?: unknown }).line_message_id ?? ''),
    receipt_date: String((data as { receipt_date?: unknown }).receipt_date ?? '').slice(0, 10),
    receipt_payload: normalizeReceiptPayload((data as { receipt_payload?: unknown }).receipt_payload),
    summary_text: (data as { summary_text?: unknown }).summary_text != null
      ? String((data as { summary_text?: unknown }).summary_text)
      : null,
    store_display_name: String((data as { store_display_name?: unknown }).store_display_name ?? ''),
    sender_display_name: (data as { sender_display_name?: unknown }).sender_display_name != null
      ? String((data as { sender_display_name?: unknown }).sender_display_name)
      : null,
  }
}

function normalizeReceiptPayload(raw: unknown): LineImageReceiptAnalysis {
  const source = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  return {
    storeName: source.storeName != null ? String(source.storeName) : null,
    storePhone: source.storePhone != null ? String(source.storePhone) : null,
    date: source.date != null ? String(source.date) : null,
    netSales: source.netSales != null ? String(source.netSales) : null,
    taxAmount: source.taxAmount != null ? String(source.taxAmount) : null,
    grossSales: source.grossSales != null ? String(source.grossSales) : null,
    partyCount: source.partyCount != null ? String(source.partyCount) : null,
    guestCount: source.guestCount != null ? String(source.guestCount) : null,
    unitPrice: source.unitPrice != null ? String(source.unitPrice) : null,
    items: Array.isArray(source.items) ? source.items.map(String) : [],
  }
}

export async function clearPendingReceiptDuplicate(
  supabase: SupabaseClient,
  roomId: string,
  userId: string | null,
): Promise<void> {
  await supabase.from(PENDING_TABLE).delete().eq('conversation_key', conversationKey(roomId, userId))
}

export function normalizeReceiptDuplicateDecision(rawText: string): 'add' | 'cancel' | 'replace' | null {
  const compact = normalizeForRuleParsing(rawText)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[。．.!！?？、,]/g, '')
  if (!compact) return null
  if (/^(置換|置き換え|上書き|差し替え|入れ替え|3|３|replace|overwrite)$/.test(compact)) return 'replace'
  if (/^(中止|キャンセル|やめる|不要|登録しない|しない|いいえ|no|n|2|２)$/.test(compact)) return 'cancel'
  if (/^(加算|重複登録|重複|追加|累積|複数|1|１|add|はい|ok|okay|yes|y|登録|登録して|お願いします|おねがいします|お願い|おねがい)$/.test(compact)) {
    return 'add'
  }
  return null
}

async function completePendingDuplicateAndReply(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  pending: PendingStoreReceiptDuplicate,
): Promise<LineReplyPayload> {
  const saveResult = await saveStoreReceiptEntry(supabase, pending.receipt_table, {
    lineMessageId: pending.line_message_id,
    roomId: pending.room_id,
    userId: pending.user_id,
    senderDisplayName: pending.sender_display_name,
    storeDisplayName: pending.store_display_name,
    receipt: pending.receipt_payload,
    summary: pending.summary_text ?? '',
  })
  if (!saveResult.ok) {
    return 'レシートの登録に失敗しました。しばらくしてから、もう一度「加算」または「置き換え」を送ってください。'
  }
  await clearPendingReceiptDuplicate(supabase, pending.room_id, pending.user_id)
  const replyContext = await loadReceiptReplyContext(supabase, {
    storePartitionKey: registry.store_partition_key,
    storeDisplayName: pending.store_display_name,
    receiptTable: pending.receipt_table,
    receipt: pending.receipt_payload,
    receiptDateIso: pending.receipt_date,
    lineMessageId: pending.line_message_id,
  })
  return buildReceiptFlexMessage(replyContext)
}

export async function tryHandlePendingReceiptDuplicateConfirmation(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  roomId: string,
  userId: string | null,
  text: string,
): Promise<LineReplyPayload | null> {
  const pending = await loadPendingReceiptDuplicate(supabase, roomId, userId)
  if (!pending) return null
  if (pending.store_partition_key !== registry.store_partition_key) return null

  const choice = normalizeReceiptDuplicateDecision(text)
  if (choice == null) {
    return '「加算」「中止」「置き換え」のいずれかで返信してください。番号（1／2／3）でも構いません。'
  }
  if (choice === 'cancel') {
    await clearPendingReceiptDuplicate(supabase, roomId, userId)
    return '登録を中止しました。'
  }
  if (choice === 'replace') {
    await deleteReceiptsForDateExcludingLineMessageId(
      supabase,
      pending.receipt_table,
      pending.receipt_date,
      pending.line_message_id,
    )
  }
  await clearPendingReceiptDuplicate(supabase, roomId, userId)
  return completePendingDuplicateAndReply(supabase, registry, pending)
}