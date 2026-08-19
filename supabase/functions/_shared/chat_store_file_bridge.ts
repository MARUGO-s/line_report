/**
 * M-talk 店舗ルームの画像／ファイルを LINE と同じ経路へ載せる。
 * - #メモ なし: メディア閲覧へ保存し、画像ならレシート解析して同じ内容を返す
 * - #メモ 引用: 資料登録後にメディア閲覧の複製を消す（LINE と同じ）
 */
import { resolveGeminiApiKey, resolveReceiptGeminiFlashLiteModel } from './line_client.ts'
import { removeRoomMediaByMessageId, saveMediaBytesToLibrary } from './line_media_store.ts'
import { analyzeLineImageWithGemini } from './receipt_vision.ts'
import {
  applySauvageNetSalesAsGrossSales,
  computeReceiptHeuristicConfidence,
  mergeReceiptConfidence,
  resolveReceiptDateIsoForPersist,
} from './receipt_parse.ts'
import { RECEIPT_ANALYSIS_CONFIDENCE_MIN } from './receipt_types.ts'
import {
  alignReceiptStoreNameToRegistry,
  receiptStoreNameMatchesRegistry,
} from './receipt_store_name_match.ts'
import { attemptReceiptRegistration } from './receipt_save_flow.ts'
import { fetchStoreReceiptAnalysisPromptAddition, resolveBuiltinStoreReceiptPrompt, combineStoreReceiptPromptAdditions } from './receipt_prompt.ts'
import type { StoreRegistryRow } from './store_receipt.ts'
import { postChatCard, type ChatCard } from './chat_bridge.ts'

// deno-lint-ignore no-explicit-any
type DbClient = any

export function mtalkMediaMessageId(chatMessageId: number): string {
  return `mtalk-${chatMessageId}`
}

export async function resolveStoreLineRoomId(supabase: DbClient, storeKey: string): Promise<string | null> {
  const key = String(storeKey || '').trim()
  if (!key) return null
  const { data, error } = await supabase
    .from('room_summary_settings')
    .select('room_id')
    .eq('receipt_report_store_partition_key', key)
    .not('room_id', 'is', null)
    .limit(1)
    .maybeSingle()
  if (error) {
    console.warn('resolveStoreLineRoomId failed:', error.message)
    return null
  }
  const roomId = String(data?.room_id ?? '').trim()
  return roomId || null
}

export async function loadStoreRegistryRow(supabase: DbClient, storeKey: string): Promise<StoreRegistryRow | null> {
  const { data, error } = await supabase
    .from('store_webhook_tables')
    .select('store_partition_key, display_name, webhook_raw_table, receipt_table, receipt_phones')
    .eq('store_partition_key', storeKey)
    .maybeSingle()
  if (error) {
    console.warn('loadStoreRegistryRow failed:', error.message)
    return null
  }
  return data as StoreRegistryRow | null
}

export async function saveStoreRoomFileToMediaLibrary(
  supabase: DbClient,
  params: {
    storeKey: string
    groupId: number
    chatMessageId: number
    senderName: string
    senderUserId?: string | null
    mediaType: 'image' | 'file'
    fileName?: string | null
    contentType?: string | null
    bytes: Uint8Array
  },
): Promise<{ saved: boolean; lineMessageId: string; roomId: string; reason?: string }> {
  const lineRoomId = await resolveStoreLineRoomId(supabase, params.storeKey)
  const roomId = lineRoomId || `mtalk-group-${params.groupId}`
  const lineMessageId = mtalkMediaMessageId(params.chatMessageId)
  const result = await saveMediaBytesToLibrary(supabase, {
    roomId,
    lineMessageId,
    userId: params.senderUserId || null,
    senderDisplayName: params.senderName,
    mediaType: params.mediaType,
    storeKey: params.storeKey,
    fileName: params.fileName || `mtalk_${params.chatMessageId}`,
    contentType: params.contentType,
    bytes: params.bytes,
  })
  return { saved: result.saved, lineMessageId, roomId, reason: result.reason }
}

export async function removeStoreRoomMediaForChatMessage(
  supabase: DbClient,
  chatMessageId: number,
): Promise<boolean> {
  return await removeRoomMediaByMessageId(supabase, mtalkMediaMessageId(chatMessageId))
}

function receiptCardFromRegistration(
  storeName: string,
  dateIso: string,
  receipt: { taxAmount?: string | null; grossSales?: string | null; partyCount?: string | null; guestCount?: string | null },
  analyticsUrl?: string | null,
): ChatCard {
  return {
    header: {
      eyebrow: 'レシート',
      title: `${storeName} ${dateIso} 売上レポート`,
    },
    sections: [{
      type: 'fields',
      rows: [
        { label: '店名', value: storeName },
        { label: '日付', value: dateIso },
        { label: '消費税', value: String(receipt.taxAmount || '-') },
        { label: '総売上（税込）', value: String(receipt.grossSales || '-') },
        { label: '会計組数', value: receipt.partyCount ? `${receipt.partyCount} 組` : '-' },
        { label: '客数', value: receipt.guestCount ? `${receipt.guestCount} 人` : '-' },
      ],
    }],
    action: analyticsUrl ? { label: '売上推移を見る', url: analyticsUrl } : null,
  }
}

export async function processStoreRoomImageLikeLine(
  supabase: DbClient,
  params: {
    storeKey: string
    groupId: number
    chatMessageId: number
    senderName: string
    senderUserId?: string | null
    contentType?: string | null
    bytes: Uint8Array
  },
): Promise<{ text: string; card?: ChatCard; kind: 'receipt' | 'media' | 'error' }> {
  const media = await saveStoreRoomFileToMediaLibrary(supabase, {
    storeKey: params.storeKey,
    groupId: params.groupId,
    chatMessageId: params.chatMessageId,
    senderName: params.senderName,
    senderUserId: params.senderUserId,
    mediaType: 'image',
    fileName: `mtalk_${params.chatMessageId}.jpg`,
    contentType: params.contentType || 'image/jpeg',
    bytes: params.bytes,
  })

  const registry = await loadStoreRegistryRow(supabase, params.storeKey)
  const geminiKey = resolveGeminiApiKey()
  if (!registry || !geminiKey) {
    return {
      text: media.saved
        ? '画像をメディア閲覧に保存しました。'
        : '画像をメディア閲覧に保存できませんでした。',
      kind: media.saved ? 'media' : 'error',
    }
  }

  const prompt = combineStoreReceiptPromptAdditions(
    resolveBuiltinStoreReceiptPrompt(registry.store_partition_key),
    await fetchStoreReceiptAnalysisPromptAddition(supabase, registry.store_partition_key),
  )
  const analyzed = await analyzeLineImageWithGemini(
    params.bytes,
    params.contentType || 'image/jpeg',
    media.lineMessageId,
    geminiKey,
    prompt,
    resolveReceiptGeminiFlashLiteModel(),
  )

  if (analyzed.failure) {
    return {
      text: '⚠ AI画像解析を完了できませんでした。お手数ですが、少し時間をおいてこの画像をもう一度お送りください。',
      kind: 'error',
    }
  }

  if (!analyzed.analysis?.receipt) {
    const summary = String(analyzed.analysis?.summary ?? '').trim()
    return {
      text: summary ? `画像を確認しました。\n${summary}` : 'レシートとして読み取れる項目がありませんでした。',
      kind: 'media',
    }
  }

  const receiptRaw = analyzed.analysis.receipt
  const alignedStoreName = alignReceiptStoreNameToRegistry(receiptRaw.storeName, registry)
  const receiptAligned = String(alignedStoreName ?? '') !== String(receiptRaw.storeName ?? '')
    ? { ...receiptRaw, storeName: alignedStoreName }
    : receiptRaw
  const receipt = applySauvageNetSalesAsGrossSales(receiptAligned, registry.store_partition_key)
  const confidence = mergeReceiptConfidence(
    computeReceiptHeuristicConfidence(receipt),
    analyzed.analysis.receiptModelConfidence ?? null,
  )
  if (confidence < RECEIPT_ANALYSIS_CONFIDENCE_MIN) {
    return {
      text: 'レシートの自動解析の確信度が低いため、売上登録していません。\n影・反射を避け、金額・日付がはっきり読める距離でもう一度撮影してください。',
      kind: 'error',
    }
  }

  const storeDisplayName = registry.display_name || registry.store_partition_key
  const matched = receiptStoreNameMatchesRegistry(
    storeDisplayName,
    registry.store_partition_key,
    receipt.storeName,
    receipt.storePhone,
    registry.receipt_phones,
  )
  if (!matched) {
    return {
      text: `画像を確認しました。この店舗のレシートとして登録できませんでした（読み取り店名: ${receipt.storeName || '不明'}）。`,
      kind: 'media',
    }
  }

  const receiptDateIso = resolveReceiptDateIsoForPersist(receipt.date)
  const result = await attemptReceiptRegistration(supabase, registry, {
    line_message_id: media.lineMessageId,
    room_id: media.roomId,
    user_id: params.senderUserId || null,
    receipt_date: receiptDateIso,
    receipt_payload: receipt,
    summary_text: analyzed.analysis.summary ?? null,
    store_display_name: storeDisplayName,
    sender_display_name: params.senderName,
  })

  if (typeof result.reply === 'string') {
    return { text: result.reply, kind: result.saved ? 'receipt' : 'error' }
  }

  const card = receiptCardFromRegistration(storeDisplayName, receiptDateIso, receipt)
  const text = `${storeDisplayName} ${receiptDateIso} 売上レポート\n総売上: ${receipt.grossSales || '-'}\n組数: ${receipt.partyCount || '-'}／客数: ${receipt.guestCount || '-'}`
  return { text, card, kind: result.saved ? 'receipt' : 'media' }
}

export async function postStoreRoomLineStyleReply(
  supabase: DbClient,
  groupId: number,
  result: { text: string; card?: ChatCard },
): Promise<void> {
  if (result.card) {
    const posted = await postChatCard(supabase, {
      groupId,
      text: result.text,
      cards: [result.card],
      kind: 'receipt_image',
    })
    if (posted.ok) return
  }
  const { error } = await supabase.from('chat_messages').insert({
    group_id: groupId,
    user_id: '00000000-0000-4000-8000-00000000b071',
    username: '予約通知',
    content: result.text,
    kind: 'text',
  })
  if (error) console.error('store room LINE-style reply failed:', error.message)
}
