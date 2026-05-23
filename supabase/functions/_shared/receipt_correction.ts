import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { LineImageReceiptAnalysis, LineReplyPayload } from './receipt_types.ts'
import { buildReceiptFlexMessage } from './receipt_flex_reply.ts'
import {
  parseReceiptAnalysisDeleteDirective,
  parseReceiptCorrectionStartDirective,
} from './receipt_line_actions.ts'
import { loadReceiptReplyContext } from './receipt_reply_context.ts'
import {
  formatYenAmount,
  normalizeInlineText,
  normalizeReceiptFieldText,
  parseCurrencyAmount,
  parseIntegerCount,
  parseReceiptDateToIso,
} from './receipt_parse.ts'
import {
  clearPendingReceiptDuplicate,
  tryHandlePendingReceiptDuplicateConfirmation,
} from './receipt_duplicate.ts'
import {
  clearPendingStoreNameMismatch,
  tryHandlePendingStoreNameMismatchConfirmation,
} from './receipt_store_mismatch.ts'
import {
  deleteStoreReceiptByLineMessageId,
  loadLatestStoreReceiptForRoom,
  loadStoreReceiptByLineMessageId,
  receiptRowToAnalysis,
  type StoreRegistryRow,
  updateStoreReceiptFromDraft,
} from './store_receipt.ts'

const PENDING_TABLE = 'store_receipt_correction_pending'
const PENDING_TTL_MIN = 30

type ReceiptCorrectionFieldKey =
  | 'storeName'
  | 'date'
  | 'netSales'
  | 'taxAmount'
  | 'grossSales'
  | 'partyCount'
  | 'guestCount'
  | 'unitPrice'

type ReceiptCorrectionStage = 'select_field' | 'input_value'

type PendingStoreReceiptCorrection = {
  store_partition_key: string
  receipt_table: string
  receipt_row_id: number
  line_message_id: string
  stage: ReceiptCorrectionStage
  current_field_key: ReceiptCorrectionFieldKey | null
  draft: LineImageReceiptAnalysis
}

const RECEIPT_CORRECTION_FIELDS: Array<{
  key: ReceiptCorrectionFieldKey
  label: string
  valueKind: 'text' | 'date' | 'currency' | 'count'
  maxLen: number
}> = [
  { key: 'storeName', label: '店名', valueKind: 'text', maxLen: 80 },
  { key: 'date', label: '日付', valueKind: 'date', maxLen: 80 },
  { key: 'netSales', label: '純売上', valueKind: 'currency', maxLen: 40 },
  { key: 'taxAmount', label: '消費税', valueKind: 'currency', maxLen: 40 },
  { key: 'grossSales', label: '総売上', valueKind: 'currency', maxLen: 40 },
  { key: 'partyCount', label: '会計組数', valueKind: 'count', maxLen: 20 },
  { key: 'guestCount', label: '客数', valueKind: 'count', maxLen: 20 },
  { key: 'unitPrice', label: '客単価', valueKind: 'currency', maxLen: 40 },
]

function normalizeForRuleParsing(raw: string): string {
  return normalizeInlineText(String(raw ?? '').normalize('NFKC'))
}

function conversationKey(roomId: string, userId: string | null): string {
  return `${roomId || '__unknown_room__'}::${userId || '__anonymous__'}`
}

function lineSafeFlexText(value: string, maxLen: number): string {
  return String(value ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, maxLen)
}

function normalizeReceiptCorrectionDraft(raw: unknown): LineImageReceiptAnalysis {
  const source = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  return {
    storeName: source.storeName != null ? String(source.storeName) : null,
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

function normalizeReceiptCorrectionFieldKey(raw: unknown): ReceiptCorrectionFieldKey | null {
  const normalized = String(raw ?? '').trim()
  return RECEIPT_CORRECTION_FIELDS.find((field) => field.key === normalized)?.key ?? null
}

function getReceiptCorrectionFieldConfig(fieldKey: ReceiptCorrectionFieldKey) {
  return RECEIPT_CORRECTION_FIELDS.find((field) => field.key === fieldKey) ?? null
}

function getReceiptCorrectionFieldValue(
  draft: LineImageReceiptAnalysis,
  fieldKey: ReceiptCorrectionFieldKey,
): string | null {
  switch (fieldKey) {
    case 'storeName': return draft.storeName
    case 'date': return draft.date
    case 'netSales': return draft.netSales
    case 'taxAmount': return draft.taxAmount
    case 'grossSales': return draft.grossSales
    case 'partyCount': return draft.partyCount
    case 'guestCount': return draft.guestCount
    case 'unitPrice': return draft.unitPrice
    default: return null
  }
}

function setReceiptCorrectionFieldValue(
  draft: LineImageReceiptAnalysis,
  fieldKey: ReceiptCorrectionFieldKey,
  value: string | null,
): LineImageReceiptAnalysis {
  const next = { ...draft }
  switch (fieldKey) {
    case 'storeName': next.storeName = value; break
    case 'date': next.date = value; break
    case 'netSales': next.netSales = value; break
    case 'taxAmount': next.taxAmount = value; break
    case 'grossSales': next.grossSales = value; break
    case 'partyCount': next.partyCount = value; break
    case 'guestCount': next.guestCount = value; break
    case 'unitPrice': next.unitPrice = value; break
  }
  return next
}

function parseReceiptCorrectionFieldChoice(rawText: string): ReceiptCorrectionFieldKey | null {
  const direct = normalizeReceiptCorrectionFieldKey(rawText)
  if (direct) return direct
  const compact = normalizeForRuleParsing(rawText).replace(/\s+/g, '').toLowerCase()
  if (!compact) return null
  const index = Number(compact)
  if (Number.isInteger(index) && index >= 1 && index <= RECEIPT_CORRECTION_FIELDS.length) {
    return RECEIPT_CORRECTION_FIELDS[index - 1]?.key ?? null
  }
  if (/^(店名|店舗|店舗名)$/.test(compact)) return 'storeName'
  if (/^(日付|営業日|会計日)$/.test(compact)) return 'date'
  if (/^(純売上|net)$/.test(compact)) return 'netSales'
  if (/^(消費税|税)$/.test(compact)) return 'taxAmount'
  if (/^(総売上|売上)$/.test(compact)) return 'grossSales'
  if (/^(組数|会計組数)$/.test(compact)) return 'partyCount'
  if (/^(客数|人数)$/.test(compact)) return 'guestCount'
  if (/^(客単価|単価)$/.test(compact)) return 'unitPrice'
  return null
}

function normalizeReceiptCorrectionControl(rawText: string): 'confirm' | 'cancel' | 'back' | null {
  const compact = normalizeForRuleParsing(rawText).replace(/\s+/g, '').toLowerCase()
  if (!compact) return null
  if (/^(確定|保存|反映|完了|ok|はい)$/.test(compact)) return 'confirm'
  if (/^(キャンセル|中止|終了|やめる|破棄|取消|取り消し)$/.test(compact)) return 'cancel'
  if (/^(戻る|もどる|back|項目選択|修正項目)$/.test(compact)) return 'back'
  return null
}

function normalizeReceiptCorrectionInputValue(
  fieldKey: ReceiptCorrectionFieldKey,
  rawText: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const field = getReceiptCorrectionFieldConfig(fieldKey)
  if (!field) return { ok: false, error: '修正項目を認識できませんでした。' }
  const compact = normalizeForRuleParsing(rawText).replace(/\s+/g, '').toLowerCase()
  if (!compact || /^(?:-|ー|―|無し|なし|未設定|空欄|空|null|クリア|削除)$/.test(compact)) {
    return { ok: true, value: null }
  }
  const normalized = normalizeReceiptFieldText(String(rawText ?? '').normalize('NFKC'), field.maxLen)
  if (!normalized) return { ok: true, value: null }
  if (field.valueKind === 'text') return { ok: true, value: normalized }
  if (field.valueKind === 'date') {
    const iso = parseReceiptDateToIso(normalized)
    if (!iso) return { ok: false, error: '日付は「2026-04-19」または「2026年4月19日」で入力してください。' }
    return { ok: true, value: normalized }
  }
  if (field.valueKind === 'currency') {
    const amount = parseCurrencyAmount(normalized)
    if (amount == null || !Number.isFinite(amount) || amount < 0) {
      return { ok: false, error: `${field.label}は金額で入力してください（例: 46200 / ¥46,200）。` }
    }
    return { ok: true, value: formatYenAmount(amount) }
  }
  const count = parseIntegerCount(normalized)
  if (count == null || !Number.isFinite(count) || count < 0) {
    return { ok: false, error: `${field.label}は0以上の整数で入力してください。` }
  }
  return { ok: true, value: String(count) }
}

async function clearPendingCorrection(
  supabase: SupabaseClient,
  roomId: string,
  userId: string | null,
): Promise<void> {
  await supabase.from(PENDING_TABLE).delete().eq('conversation_key', conversationKey(roomId, userId))
}

export async function clearPendingReceiptCorrection(
  supabase: SupabaseClient,
  roomId: string,
  userId: string | null,
): Promise<void> {
  await clearPendingCorrection(supabase, roomId, userId)
}

async function savePendingCorrection(
  supabase: SupabaseClient,
  roomId: string,
  userId: string | null,
  state: PendingStoreReceiptCorrection,
): Promise<void> {
  const expiresAt = new Date(Date.now() + PENDING_TTL_MIN * 60 * 1000).toISOString()
  await supabase.from(PENDING_TABLE).upsert({
    conversation_key: conversationKey(roomId, userId),
    store_partition_key: state.store_partition_key,
    receipt_table: state.receipt_table,
    receipt_row_id: state.receipt_row_id,
    room_id: roomId,
    user_id: userId,
    line_message_id: state.line_message_id,
    stage: state.stage,
    current_field_key: state.current_field_key,
    draft_json: state.draft,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'conversation_key' })
}

async function loadPendingCorrection(
  supabase: SupabaseClient,
  roomId: string,
  userId: string | null,
): Promise<PendingStoreReceiptCorrection | null> {
  const { data, error } = await supabase
    .from(PENDING_TABLE)
    .select('*')
    .eq('conversation_key', conversationKey(roomId, userId))
    .maybeSingle()
  if (error || !data) return null
  const expiresAt = String((data as { expires_at?: unknown }).expires_at ?? '')
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    await clearPendingCorrection(supabase, roomId, userId)
    return null
  }
  const stageRaw = String((data as { stage?: unknown }).stage ?? '')
  const currentFieldRaw = String((data as { current_field_key?: unknown }).current_field_key ?? '')
  return {
    store_partition_key: String((data as { store_partition_key?: unknown }).store_partition_key ?? ''),
    receipt_table: String((data as { receipt_table?: unknown }).receipt_table ?? ''),
    receipt_row_id: Number((data as { receipt_row_id?: unknown }).receipt_row_id ?? 0),
    line_message_id: String((data as { line_message_id?: unknown }).line_message_id ?? ''),
    stage: stageRaw === 'input_value' ? 'input_value' : 'select_field',
    current_field_key: normalizeReceiptCorrectionFieldKey(currentFieldRaw),
    draft: normalizeReceiptCorrectionDraft((data as { draft_json?: unknown }).draft_json),
  }
}

function buildCorrectionFlexHeader(title: string, subtitle: string) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#1E4FB1',
    paddingTop: 'md',
    paddingBottom: 'md',
    paddingStart: 'md',
    paddingEnd: 'md',
    contents: [
      { type: 'text', text: lineSafeFlexText(title, 80), size: 'lg', weight: 'bold', color: '#FFFFFF' },
      { type: 'text', text: lineSafeFlexText(subtitle, 200), size: 'sm', color: '#D7E6FF', margin: 'sm', wrap: true },
    ],
  }
}

function buildFieldSelectionPrompt(
  draft: LineImageReceiptAnalysis,
  note?: string,
): Record<string, unknown> {
  const fieldRows = RECEIPT_CORRECTION_FIELDS.map((field, idx) => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    margin: 'xs',
    contents: [
      { type: 'text', text: `${idx + 1}. ${field.label}`, size: 'sm', color: '#888888', flex: 4, wrap: true },
      {
        type: 'text',
        text: lineSafeFlexText(getReceiptCorrectionFieldValue(draft, field.key) || '-', 120),
        size: 'sm',
        color: '#111111',
        flex: 6,
        align: 'start',
        wrap: true,
      },
    ],
  }))
  const bodyContents: Record<string, unknown>[] = [
    {
      type: 'text',
      text: 'レシート修正中です。修正する項目番号を返信してください。',
      size: 'sm',
      wrap: true,
    },
  ]
  if (note) {
    bodyContents.push({
      type: 'text',
      text: lineSafeFlexText(note, 500),
      size: 'xs',
      color: '#666666',
      wrap: true,
      margin: 'sm',
    })
  }
  bodyContents.push({ type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md', contents: fieldRows })
  bodyContents.push({
    type: 'text',
    text: [
      '・1〜8 の数字…その項目の修正へ進む',
      '・「確定」「保存」「反映」「完了」「OK」など…変更を保存して終了',
      '・「キャンセル」「中止」「終了」など…修正をやめる',
    ].join('\n'),
    size: 'xxs',
    color: '#888888',
    wrap: true,
    margin: 'md',
  })
  return {
    type: 'flex',
    altText: 'レシート修正 番号で項目を選んでください',
    contents: {
      type: 'bubble',
      header: buildCorrectionFlexHeader('レシート修正', '番号を返信して項目を選んでください'),
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: bodyContents },
    },
  }
}

function buildValueInputPrompt(
  fieldKey: ReceiptCorrectionFieldKey,
  draft: LineImageReceiptAnalysis,
): Record<string, unknown> | string {
  const field = getReceiptCorrectionFieldConfig(fieldKey)
  if (!field) return '修正項目を認識できませんでした。番号で選び直してください。'
  const currentValue = getReceiptCorrectionFieldValue(draft, fieldKey) || '-'
  const kindHint = field.valueKind === 'currency'
    ? '例: 46200 / ¥46,200'
    : field.valueKind === 'count'
      ? '例: 5'
      : field.valueKind === 'date'
        ? '例: 2026-04-19 / 2026年4月19日'
        : '例: ビストロ サヴァサヴァ'
  return {
    type: 'flex',
    altText: `レシート修正 ${field.label}の値を入力`,
    contents: {
      type: 'bubble',
      header: buildCorrectionFlexHeader(field.label, '新しい値をテキストで送ってください'),
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: `${field.label}の新しい値を送ってください。`, size: 'sm', wrap: true },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'md',
            margin: 'md',
            contents: [
              { type: 'text', text: '現在値', size: 'sm', color: '#7A7A7A', flex: 4 },
              { type: 'text', text: lineSafeFlexText(currentValue, 200), size: 'sm', flex: 6, align: 'start', wrap: true },
            ],
          },
          { type: 'text', text: `入力のヒント: ${kindHint}`, size: 'xs', color: '#666666', wrap: true, margin: 'sm' },
          { type: 'text', text: '未設定にする場合は「-」または「なし」と入力してください。', size: 'xxs', color: '#888888', wrap: true },
          { type: 'text', text: '「戻る」で一覧に戻れます。', size: 'xxs', color: '#888888', wrap: true, margin: 'xs' },
        ],
      },
    },
  }
}

async function buildUpdatedReceiptFlexReply(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  receipt: LineImageReceiptAnalysis,
  receiptDateIso: string,
  lineMessageId: string,
): Promise<Record<string, unknown>> {
  const storeDisplayName = registry.display_name || registry.store_partition_key
  const replyContext = await loadReceiptReplyContext(supabase, {
    storePartitionKey: registry.store_partition_key,
    storeDisplayName,
    receiptTable: registry.receipt_table,
    receipt,
    receiptDateIso,
    lineMessageId,
  })
  return buildReceiptFlexMessage(replyContext)
}

async function startCorrectionSession(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  roomId: string,
  userId: string | null,
  targetLineMessageId: string | null,
): Promise<LineReplyPayload> {
  const target = targetLineMessageId
    ? await loadStoreReceiptByLineMessageId(supabase, registry.receipt_table, roomId, targetLineMessageId)
    : await loadLatestStoreReceiptForRoom(supabase, registry.receipt_table, roomId)
  if (!target) {
    if (targetLineMessageId) {
      return '指定されたレシートをこのルームで見つけられませんでした。もう一度解析結果カードの「この結果を修正」ボタンを押してください。'
    }
    return 'このルームには修正対象のレシートがまだありません。先にレシート画像を送信してください。'
  }
  const draft = receiptRowToAnalysis(target)
  await clearPendingReceiptDuplicate(supabase, roomId, userId)
  await clearPendingStoreNameMismatch(supabase, roomId, userId)
  await savePendingCorrection(supabase, roomId, userId, {
    store_partition_key: registry.store_partition_key,
    receipt_table: registry.receipt_table,
    receipt_row_id: target.id,
    line_message_id: target.line_message_id,
    stage: 'select_field',
    current_field_key: null,
    draft,
  })
  const targetLabel = [
    draft.storeName ? `店名:${draft.storeName}` : '',
    draft.date ? `日付:${draft.date}` : '',
  ].filter(Boolean).join(' / ')
  return buildFieldSelectionPrompt(
    draft,
    targetLabel ? `対象: ${targetLabel}` : (targetLineMessageId ? '対象: 指定レシート' : '対象: 直近のレシート'),
  )
}

async function tryHandlePendingCorrection(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  roomId: string,
  userId: string | null,
  text: string,
): Promise<LineReplyPayload | null> {
  const pending = await loadPendingCorrection(supabase, roomId, userId)
  if (!pending) return null
  if (pending.store_partition_key !== registry.store_partition_key) return null

  const control = normalizeReceiptCorrectionControl(text)
  if (control === 'cancel') {
    await clearPendingCorrection(supabase, roomId, userId)
    return 'レシート修正をキャンセルしました。'
  }

  const storeDisplayName = registry.display_name || registry.store_partition_key

  if (pending.stage === 'select_field') {
    if (control === 'confirm') {
      const persisted = await updateStoreReceiptFromDraft(
        supabase,
        pending.receipt_table,
        pending.receipt_row_id,
        roomId,
        storeDisplayName,
        pending.draft,
      )
      if (!persisted) {
        return 'レシート修正の保存に失敗しました。少し時間を置いて再度お試しください。'
      }
      await clearPendingCorrection(supabase, roomId, userId)
      return buildUpdatedReceiptFlexReply(
        supabase,
        registry,
        persisted.receipt,
        persisted.receiptDateIso,
        pending.line_message_id,
      )
    }
    const field = parseReceiptCorrectionFieldChoice(text)
    if (!field) {
      return buildFieldSelectionPrompt(pending.draft, '修正する項目番号（1〜8）を返信してください。')
    }
    await savePendingCorrection(supabase, roomId, userId, {
      ...pending,
      stage: 'input_value',
      current_field_key: field,
    })
    return buildValueInputPrompt(field, pending.draft)
  }

  const currentFieldKey = pending.current_field_key
  if (!currentFieldKey) {
    await savePendingCorrection(supabase, roomId, userId, {
      ...pending,
      stage: 'select_field',
      current_field_key: null,
    })
    return buildFieldSelectionPrompt(pending.draft, '修正項目を再選択してください。')
  }

  if (control === 'back') {
    await savePendingCorrection(supabase, roomId, userId, {
      ...pending,
      stage: 'select_field',
      current_field_key: null,
    })
    return buildFieldSelectionPrompt(pending.draft)
  }

  const normalizedValue = normalizeReceiptCorrectionInputValue(currentFieldKey, text)
  if (!normalizedValue.ok) {
    return [
      { type: 'text', text: normalizedValue.error },
      buildValueInputPrompt(currentFieldKey, pending.draft),
    ]
  }

  const nextDraft = setReceiptCorrectionFieldValue(pending.draft, currentFieldKey, normalizedValue.value)
  await savePendingCorrection(supabase, roomId, userId, {
    ...pending,
    stage: 'select_field',
    current_field_key: null,
    draft: nextDraft,
  })
  const fieldLabel = getReceiptCorrectionFieldConfig(currentFieldKey)?.label ?? '項目'
  return buildFieldSelectionPrompt(
    nextDraft,
    `${fieldLabel}を更新しました。続けて修正する場合は番号、完了する場合は「確定」を送ってください。`,
  )
}

export async function handleStoreReceiptTextMessage(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  roomId: string,
  userId: string | null,
  text: string,
): Promise<LineReplyPayload | null> {
  const storeMismatchReply = await tryHandlePendingStoreNameMismatchConfirmation(
    supabase,
    registry,
    roomId,
    userId,
    text,
  )
  if (storeMismatchReply) return storeMismatchReply

  const duplicateReply = await tryHandlePendingReceiptDuplicateConfirmation(
    supabase,
    registry,
    roomId,
    userId,
    text,
  )
  if (duplicateReply) return duplicateReply

  const pendingReply = await tryHandlePendingCorrection(supabase, registry, roomId, userId, text)
  if (pendingReply) return pendingReply

  const deleteDirective = parseReceiptAnalysisDeleteDirective(text)
  if (deleteDirective.matched) {
    const targetLmid = deleteDirective.targetLineMessageId
    if (!targetLmid) {
      return '解析結果カードの「この解析結果を削除」ボタンから送るか、「レシート解析削除 ID:（LINEのメッセージID）」の形式で送ってください。'
    }
    await clearPendingCorrection(supabase, roomId, userId)
    await clearPendingReceiptDuplicate(supabase, roomId, userId)
    await clearPendingStoreNameMismatch(supabase, roomId, userId)
    const delResult = await deleteStoreReceiptByLineMessageId(
      supabase,
      registry.receipt_table,
      roomId,
      targetLmid,
    )
    if (!delResult.ok) return delResult.message
    return 'レシート解析データを削除しました（このルームの保存から取り除きました）。'
  }

  const correctionStart = parseReceiptCorrectionStartDirective(text)
  if (correctionStart.matched) {
    return startCorrectionSession(
      supabase,
      registry,
      roomId,
      userId,
      correctionStart.targetLineMessageId,
    )
  }

  return null
}

export function lineReplyPayloadToMessages(payload: LineReplyPayload): Record<string, unknown>[] {
  if (typeof payload === 'string') return [{ type: 'text', text: payload.slice(0, 4900) }]
  if (Array.isArray(payload)) {
    return payload.map((item) => {
      if (typeof item === 'string') return { type: 'text', text: item.slice(0, 4900) }
      return item
    })
  }
  return [payload]
}
