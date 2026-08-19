/**
 * M-talk 店舗ルームの画像／ファイルを LINE と同じ経路へ載せる。
 * - #メモ なし: メディア閲覧へ保存し、画像ならレシート解析して同じ内容を返す
 * - #メモ 引用: 資料登録後にメディア閲覧の複製を消す（LINE と同じ）
 */
import { resolveGeminiApiKey, resolveReceiptGeminiFlashLiteModel } from './line_client.ts'
import { removeRoomMediaByMessageId, saveMediaBytesToLibrary } from './line_media_store.ts'
import {
  analyzeLineImageWithAzureFoundry,
  analyzeLineImageWithClaude,
  analyzeLineImageWithGemini,
  AZURE_FOUNDRY_VISION_MODEL,
  shouldFallbackLineImageVisionFailure,
} from './receipt_vision.ts'
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
import { loadReceiptReplyContext } from './receipt_reply_context.ts'
import { buildReceiptChatCard } from './receipt_flex_reply.ts'
import { handleStoreReceiptTextMessage } from './receipt_correction.ts'
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
    .limit(20)
  if (error) {
    console.warn('resolveStoreLineRoomId failed:', error.message)
    return null
  }
  const rooms = (Array.isArray(data) ? data : [])
    .map((row) => String((row as { room_id?: string }).room_id ?? '').trim())
    .filter(Boolean)
  return rooms.find((id) => id.startsWith('C')) || rooms[0] || null
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

function resolveClaudeApiKey(): string {
  return String(Deno.env.get('ANTHROPIC_API_KEY') ?? Deno.env.get('CLAUDE_API_KEY') ?? '').trim()
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
  let analyzed = await analyzeLineImageWithGemini(
    params.bytes,
    params.contentType || 'image/jpeg',
    media.lineMessageId,
    geminiKey,
    prompt,
    resolveReceiptGeminiFlashLiteModel(),
  )
  if (!analyzed.analysis && shouldFallbackLineImageVisionFailure(analyzed.failure)) {
    const azureEndpoint = String(Deno.env.get('AZURE_FOUNDRY_PROJECT_ENDPOINT') ?? '').trim()
    const azureKey = String(Deno.env.get('AZURE_FOUNDRY_API_KEY') ?? '').trim()
    const azureDeployment = String(Deno.env.get('AZURE_FOUNDRY_VISION_DEPLOYMENT') ?? '').trim() || AZURE_FOUNDRY_VISION_MODEL
    if (azureEndpoint && azureKey) {
      const fallback = await analyzeLineImageWithAzureFoundry(
        params.bytes,
        params.contentType || 'image/jpeg',
        media.lineMessageId,
        azureEndpoint,
        azureKey,
        azureDeployment,
        prompt,
      )
      if (fallback.analysis || fallback.failure) analyzed = fallback
    }
    if (!analyzed.analysis && shouldFallbackLineImageVisionFailure(analyzed.failure) && resolveClaudeApiKey()) {
      const claude = await analyzeLineImageWithClaude(
        params.bytes,
        params.contentType || 'image/jpeg',
        media.lineMessageId,
        resolveClaudeApiKey(),
        prompt,
        'claude-haiku-4-5',
      )
      if (claude.analysis || claude.failure) analyzed = claude
    }
  }

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

  if (!result.saved) {
    const converted = mtalkCardFromLineReply(result.reply)
    return {
      text: converted.text,
      card: converted.card,
      kind: 'error',
    }
  }

  const replyContext = await loadReceiptReplyContext(supabase, {
    storePartitionKey: registry.store_partition_key,
    storeDisplayName,
    receiptTable: registry.receipt_table,
    receipt,
    receiptDateIso,
    lineMessageId: media.lineMessageId,
  })
  const card = buildReceiptChatCard(replyContext, { receiptRowId: result.receiptRowId ?? null })
  const text = `${storeDisplayName} ${receiptDateIso} 売上レポート\n総売上: ${receipt.grossSales || '-'}\n組数: ${receipt.partyCount || '-'}／客数: ${receipt.guestCount || '-'}`
  return { text, card, kind: 'receipt' }
}

export async function handleStoreRoomReceiptCommand(
  supabase: DbClient,
  params: {
    storeKey: string
    groupId: number
    senderUserId?: string | null
    text: string
  },
): Promise<boolean> {
  const text = String(params.text || '').trim()
  if (!text) return false
  const registry = await loadStoreRegistryRow(supabase, params.storeKey)
  if (!registry) return false
  const roomId = (await resolveStoreLineRoomId(supabase, params.storeKey)) || `mtalk-group-${params.groupId}`
  const reply = await handleStoreReceiptTextMessage(
    supabase,
    registry,
    roomId,
    params.senderUserId || null,
    text,
  )
  if (!reply) return false
  const converted = mtalkCardFromLineReply(reply)
  await postStoreRoomLineStyleReply(supabase, params.groupId, converted)
  return true
}

function mtalkCardFromLineReply(reply: unknown): { text: string; card?: ChatCard } {
  if (typeof reply === 'string') return { text: reply }
  if (Array.isArray(reply)) {
    const first = reply.find((item) => item != null)
    return mtalkCardFromLineReply(first)
  }
  if (!reply || typeof reply !== 'object') return { text: '操作を受け付けました。' }
  const rec = reply as Record<string, unknown>
  const collected = {
    texts: [] as string[],
    fields: [] as { label: string; value: string }[],
    headings: [] as string[],
    actions: [] as NonNullable<ChatCard['actions']>,
  }
  walkLineFlex(rec, collected)
  const alt = String(rec.altText ?? '').trim()
  const text = alt || collected.texts[0] || '操作を受け付けました。'
  const used = new Set<string>([alt, ...collected.fields.flatMap((field) => [field.label, field.value])])
  const notes = collected.texts.filter((item) => item && !used.has(item))
  const sections: NonNullable<ChatCard['sections']> = []
  for (const heading of collected.headings) sections.push({ type: 'heading', text: heading })
  if (collected.fields.length) sections.push({ type: 'fields', rows: collected.fields })
  if (notes.length) sections.push({ type: 'note', text: notes.join('\n') })
  if (!sections.length && !collected.actions.length) return { text }
  const looksLikeSalesReport = /売上レポート/.test(alt)
  const title = (alt.split(' / ')[0] || alt || 'レシート').trim()
  return {
    text,
    card: {
      variant: looksLikeSalesReport ? 'line' : undefined,
      header: { title },
      sections,
      actions: collected.actions.length ? collected.actions : null,
    },
  }
}

function walkLineFlex(
  node: unknown,
  out: {
    texts: string[]
    fields: { label: string; value: string }[]
    headings: string[]
    actions: NonNullable<ChatCard['actions']>
  },
  ctx?: { inHeader?: boolean },
): void {
  if (!node || typeof node !== 'object') return
  const rec = node as Record<string, unknown>
  if (rec.layout === 'horizontal' && Array.isArray(rec.contents) && rec.contents.length === 2) {
    const left = rec.contents[0] as Record<string, unknown> | undefined
    const right = rec.contents[1] as Record<string, unknown> | undefined
    if (left?.type === 'text' && right?.type === 'text') {
      const label = String(left.text ?? '').trim()
      const value = String(right.text ?? '').trim()
      if (label && value) {
        out.fields.push({ label, value })
        return
      }
    }
  }
  if (rec.type === 'text' && rec.text) {
    const text = String(rec.text)
    if (ctx?.inHeader || (rec.weight === 'bold' && (text.startsWith('【') || text.startsWith('対象:')))) {
      out.headings.push(text)
    } else {
      out.texts.push(text)
    }
  }
  if (rec.type === 'button' && rec.action && typeof rec.action === 'object') {
    const action = rec.action as Record<string, unknown>
    const label = String(action.label || rec.label || '').trim()
    const command = String(action.text || action.displayText || '').trim()
    const url = action.type === 'uri' ? String(action.uri || '') : ''
    if (url) out.actions.push({ label: label || '開く', url })
    else if (command) out.actions.push({ label: label || command, command })
  }
  if (Array.isArray(rec.contents)) rec.contents.forEach((child) => walkLineFlex(child, out, ctx))
  else if (rec.contents) walkLineFlex(rec.contents, out, ctx)
  if (rec.body) walkLineFlex(rec.body, out, ctx)
  if (rec.footer) walkLineFlex(rec.footer, out, ctx)
  if (rec.header) walkLineFlex(rec.header, out, { inHeader: true })
}

export async function postStoreRoomLineStyleReply(
  supabase: DbClient,
  groupId: number,
  result: { text: string; card?: ChatCard },
): Promise<void> {
  const cardHasBody = !!(result.card && (
    (Array.isArray(result.card.sections) && result.card.sections.length > 0)
    || (Array.isArray(result.card.actions) && result.card.actions.length > 0)
    || result.card.action
  ))
  if (cardHasBody && result.card) {
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
