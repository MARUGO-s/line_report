import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { LineImageReceiptAnalysis, LineReplyPayload } from './receipt_types.ts'
import { normalizeInlineText, parseReceiptDateToIso } from './receipt_parse.ts'
import { findRegistryEntryForParsedStoreName } from './receipt_store_name_match.ts'
import { loadStoreRegistry } from './store_receipt_query.ts'
import type { StoreRegistryRow } from './store_receipt.ts'

const PENDING_TABLE = 'store_receipt_store_mismatch_pending'

export type StoreMismatchGuidance = {
  registeredStoreName: string
  parsedStoreName: string
  receipt: LineImageReceiptAnalysis
  suggestedStore: StoreRegistryRow | null
}

function resolveDisplayedParsedStoreName(guidance: StoreMismatchGuidance): string {
  if (guidance.suggestedStore) {
    return guidance.suggestedStore.display_name || guidance.suggestedStore.store_partition_key
  }
  return guidance.parsedStoreName
}

function conversationKey(roomId: string, userId: string | null): string {
  return `${roomId || '__unknown_room__'}::${userId || '__anonymous__'}`
}

function normalizeForRuleParsing(raw: string): string {
  return normalizeInlineText(String(raw ?? '').normalize('NFKC'))
}

function capText(raw: string | null | undefined, max: number): string {
  const s = String(raw ?? '').trim()
  if (!s) return '-'
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function formatJapaneseReceiptDateFromIso(iso: string | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim())
  if (!m) return null
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`
}

function kvRow(label: string, value: string, valueColor = '#1F1F1F') {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    margin: 'xs',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#7A7A7A', flex: 4, wrap: true },
      {
        type: 'text',
        text: value,
        size: 'sm',
        color: valueColor,
        flex: 6,
        align: 'start',
        wrap: true,
        weight: 'bold',
      },
    ],
  }
}

export function buildReceiptStoreMismatchFlexReply(
  guidance: StoreMismatchGuidance,
): Record<string, unknown> {
  const { registeredStoreName, receipt, suggestedStore } = guidance
  const parsedStoreName = resolveDisplayedParsedStoreName(guidance)
  const parsedDateIso = parseReceiptDateToIso(receipt.date)
  const displayDate = formatJapaneseReceiptDateFromIso(parsedDateIso) ?? capText(receipt.date, 80)
  const phoneLabel = receipt.storePhone ? capText(receipt.storePhone, 24) : '-'
  const storeLabel = suggestedStore ? '解析店名' : '解析店名'
  const detailRows = [
    kvRow('このWebhook', registeredStoreName, '#B45309'),
    kvRow(storeLabel, parsedStoreName, '#B45309'),
    kvRow('解析電話', phoneLabel),
    kvRow('日付', displayDate),
    kvRow('総売上', capText(receipt.grossSales, 40)),
    kvRow('会計組数', capText(receipt.partyCount, 20)),
    kvRow('客数', capText(receipt.guestCount, 20)),
  ]

  const guidanceLines: string[] = [
    'このWebhookでは登録できません。',
  ]
  if (suggestedStore) {
    const targetName = suggestedStore.display_name || suggestedStore.store_partition_key
    if (guidance.parsedStoreName !== parsedStoreName && receipt.storePhone) {
      guidanceLines.push(`解析電話が一致したため、店舗は「${targetName}」と推定しました。`)
    }
    guidanceLines.push(`解析結果の店舗「${parsedStoreName}」のWebhookに、同じ画像を送り直してください。`)
    guidanceLines.push(`送り先店舗: ${targetName}`)
  } else {
    guidanceLines.push(
      `解析結果の店舗「${parsedStoreName}」に対応するWebhookが見つかりませんでした。`,
    )
    guidanceLines.push('管理画面でWebhook設定を確認するか、正しい店舗のトークに送り直してください。')
  }

  const altText = [
    '店名不一致',
    registeredStoreName,
    parsedStoreName,
  ].filter(Boolean).join(' / ').slice(0, 400)

  return {
    type: 'flex',
    altText: altText || '店名不一致',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: '登録店舗と解析結果の店名が異なります。',
            size: 'sm',
            weight: 'bold',
            wrap: true,
          },
          ...guidanceLines.map((line, index) => ({
            type: 'text',
            text: line,
            size: 'sm',
            wrap: true,
            margin: index === 0 ? 'sm' : 'xs',
          })),
          { type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md', contents: detailRows },
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
            action: { type: 'message', label: '了解', text: '了解' },
          },
        ],
      },
    },
  }
}

export async function buildStoreMismatchGuidance(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  registeredStoreName: string,
  parsedStoreName: string,
  receipt: LineImageReceiptAnalysis,
): Promise<StoreMismatchGuidance> {
  const allStores = await loadStoreRegistry(supabase)
  const suggestedStore = findRegistryEntryForParsedStoreName(
    allStores,
    parsedStoreName,
    registry.store_partition_key,
    receipt.storePhone,
  )
  return {
    registeredStoreName,
    parsedStoreName,
    receipt,
    suggestedStore,
  }
}

function buildStoreMismatchGuidanceText(guidance: StoreMismatchGuidance): string {
  const parsedStoreName = resolveDisplayedParsedStoreName(guidance)
  const lines = [
    '登録店舗と解析結果の店名が異なります。',
    `このWebhook（${guidance.registeredStoreName}）では登録できません。`,
  ]
  if (guidance.suggestedStore) {
    const targetName = guidance.suggestedStore.display_name || guidance.suggestedStore.store_partition_key
    if (guidance.parsedStoreName !== parsedStoreName && guidance.receipt.storePhone) {
      lines.push(`解析電話が一致したため、店舗は「${targetName}」と推定しました。`)
    }
    lines.push(
      `解析結果の店舗「${parsedStoreName}」のWebhookに、同じ画像を送り直してください。`,
      `送り先店舗: ${targetName}`,
    )
  } else {
    lines.push(
      `解析結果の店舗「${guidance.parsedStoreName}」に対応するWebhookが見つかりませんでした。`,
      '管理画面でWebhook設定を確認するか、正しい店舗のトークに送り直してください。',
    )
  }
  return lines.join('\n')
}

export async function clearPendingStoreNameMismatch(
  supabase: SupabaseClient,
  roomId: string,
  userId: string | null,
): Promise<void> {
  await supabase.from(PENDING_TABLE).delete().eq('conversation_key', conversationKey(roomId, userId))
}

async function loadLegacyPendingStoreNameMismatch(
  supabase: SupabaseClient,
  roomId: string,
  userId: string | null,
): Promise<{ parsed_store_name: string } | null> {
  const { data, error } = await supabase
    .from(PENDING_TABLE)
    .select('parsed_store_name, expires_at')
    .eq('conversation_key', conversationKey(roomId, userId))
    .maybeSingle()
  if (error || !data) return null
  const expiresAt = String((data as { expires_at?: unknown }).expires_at ?? '')
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    await clearPendingStoreNameMismatch(supabase, roomId, userId)
    return null
  }
  return {
    parsed_store_name: String((data as { parsed_store_name?: unknown }).parsed_store_name ?? ''),
  }
}

/** 旧フローで残った pending や「このまま登録」返信を案内に統一する */
export async function tryHandlePendingStoreNameMismatchConfirmation(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  roomId: string,
  userId: string | null,
  text: string,
): Promise<LineReplyPayload | null> {
  const pending = await loadLegacyPendingStoreNameMismatch(supabase, roomId, userId)
  const compact = normalizeForRuleParsing(text)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[。．.!！?？、,]/g, '')

  const isLegacyRegisterAttempt = /^(このまま登録|このままで登録|登録|登録して|このまま|はい|ok|okay|yes|y|1|１)$/.test(compact)
  const isDismiss = /^(了解|削除|登録しない|中止|キャンセル|やめる|不要|いいえ|no|n|2|２)$/.test(compact)

  if (!pending && !isLegacyRegisterAttempt) return null
  if (pending && !isLegacyRegisterAttempt && !isDismiss) return null

  if (pending) {
    await clearPendingStoreNameMismatch(supabase, roomId, userId)
  }

  if (isDismiss && !isLegacyRegisterAttempt) {
    return '店名不一致のため登録していません。正しい店舗のWebhookに送り直してください。'
  }

  const parsedStoreName = pending?.parsed_store_name || '（解析店名）'
  const guidance = await buildStoreMismatchGuidance(
    supabase,
    registry,
    registry.display_name || registry.store_partition_key,
    parsedStoreName,
    {
      storeName: parsedStoreName,
      storePhone: null,
      date: null,
      netSales: null,
      taxAmount: null,
      grossSales: null,
      partyCount: null,
      guestCount: null,
      unitPrice: null,
      items: [],
    },
  )
  return buildStoreMismatchGuidanceText(guidance)
}
