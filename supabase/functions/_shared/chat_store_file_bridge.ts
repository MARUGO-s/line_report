/**
 * M-talk 店舗ルームの画像／ファイル処理。
 * - #メモ なし: メディア閲覧へ保存し、画像ならレシート解析して内容を返す
 * - #メモ 引用: 知識ベース登録後にメディア閲覧の複製を消す
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
import { RECEIPT_ANALYSIS_CONFIDENCE_MIN, type LineImageAnalysisResult } from './receipt_types.ts'
import {
  alignReceiptStoreNameToRegistry,
  receiptStoreNameMatchesRegistry,
} from './receipt_store_name_match.ts'
import { attemptReceiptRegistration } from './receipt_save_flow.ts'
import {
  combineStoreReceiptPromptAdditions,
  fetchStoreReceiptAnalysisPromptAddition,
  resolveBuiltinStoreReceiptPrompt,
  STORE_RECEIPT_PROMPT_MAX_CHARS,
} from './receipt_prompt.ts'
import { loadReceiptReplyContext } from './receipt_reply_context.ts'
import { buildReceiptChatCard } from './receipt_flex_reply.ts'
import { handleStoreReceiptTextMessage } from './receipt_correction.ts'
import type { StoreRegistryRow } from './store_receipt.ts'
import { postChatCard, type ChatCard } from './chat_bridge.ts'
import { mtalkCardFromLineReply } from './chat_flex_card.ts'
import {
  buildKnowledgeCommonPromptBlock,
  buildStoreKnowledgeSpecializedPromptBlock,
  KNOWLEDGE_MENU_EXTRACTION_PROMPT_BLOCK,
} from './knowledge_menu_prompt.ts'
import {
  assessKnowledgeMenuQuality,
  buildStructuredKnowledgeMenuBody,
  normalizeKnowledgeMenuItems,
} from './knowledge_menu_extract.ts'
import {
  normalizeMtalkMenuKnowledgeAnalysis,
  type MtalkMenuKnowledgeAnalysis,
} from './mtalk_menu_knowledge.ts'

// deno-lint-ignore no-explicit-any
type DbClient = any

// M-talk画像のメディアIDは「送信元ルーム + chat_messages.id」で固定する。
// 画像解析の旧経路とchat.htmlのアーカイブ経路が同じ投稿を扱っても、
// line_message_media の一意制約で必ず1件になる。
export function mtalkMediaMessageId(groupId: number, chatMessageId: number): string {
  return `mtalk-${groupId}-${chatMessageId}`
}

function menuKnowledgeFromLineImageAnalysis(
  analyzedResult: LineImageAnalysisResult | null | undefined,
): MtalkMenuKnowledgeAnalysis | null {
  const menu = analyzedResult?.menu
  if (!menu || analyzedResult?.receipt) return null
  const menuItems = normalizeKnowledgeMenuItems(menu.menuItems.map((item) => ({
    section: item.section,
    name: item.name,
    price: item.price,
    description: item.description,
  })))
  const bodyText = buildStructuredKnowledgeMenuBody(
    menuItems,
    menu.bodyText || '',
    menu.extractionNotes || '',
  )
  const quality = assessKnowledgeMenuQuality({
    category: 'メニュー',
    menuItems,
    bodyText,
    requireStructuredItems: true,
  })
  return normalizeMtalkMenuKnowledgeAnalysis({
    title: menu.title || 'M-talk メニュー画像',
    category: 'メニュー',
    summary: menu.summary || analyzedResult?.summary,
    body_text: bodyText,
    tags: ['M-talk投稿', 'メニュー', ...menu.tags],
    menu_items: menuItems,
    menu_item_count: quality.menu_item_count,
    priced_item_count: quality.priced_item_count,
    unpriced_item_count: quality.unpriced_item_count,
    needs_review: quality.needs_review,
    warnings: quality.warnings,
  })
}

function preferMenuKnowledgeResult(
  current: MtalkMenuKnowledgeAnalysis,
  candidate: MtalkMenuKnowledgeAnalysis | null,
): MtalkMenuKnowledgeAnalysis {
  if (!candidate) return current
  if (current.needs_review !== candidate.needs_review) return candidate.needs_review ? current : candidate
  if (candidate.priced_item_count !== current.priced_item_count) {
    return candidate.priced_item_count > current.priced_item_count ? candidate : current
  }
  if (candidate.menu_item_count !== current.menu_item_count) {
    return candidate.menu_item_count > current.menu_item_count ? candidate : current
  }
  return candidate.body_text.length > current.body_text.length ? candidate : current
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

export type ChatStoreBot = {
  id: string
  username: string
  storeKey: string
}

export async function loadChatStoreBot(supabase: DbClient, storeKey: string): Promise<ChatStoreBot | null> {
  const key = String(storeKey || '').trim()
  if (!key) return null
  const { data, error } = await supabase
    .from('chat_users')
    .select('id, username, store_key')
    .eq('is_bot', true)
    .eq('store_key', key)
    .is('bot_deleted_at', null)
    .maybeSingle()
  if (error) {
    console.warn('loadChatStoreBot failed:', error.message)
    return null
  }
  const id = String((data as { id?: string } | null)?.id ?? '').trim()
  const username = String((data as { username?: string } | null)?.username ?? '').trim()
  if (!id || !username) return null
  const base = username.replace(/[\s\u3000]*bot$/i, '').trim() || username
  return { id, username: `${base} bot`, storeKey: key }
}

export async function resolveRoomStoreKey(
  supabase: DbClient,
  group: { store_key?: string | null; is_store_room?: boolean | null } | null,
  groupId: number,
): Promise<{ storeKey: string | null; ambiguous?: boolean }> {
  const fromGroup = String(group?.store_key ?? '').trim()
  if (group?.is_store_room && fromGroup) return { storeKey: fromGroup }

  const { data: members, error: memberError } = await supabase
    .from('chat_group_members')
    .select('user_id')
    .eq('group_id', groupId)
  if (memberError) {
    console.warn('resolveRoomStoreKey members failed:', memberError.message)
    return { storeKey: fromGroup || null }
  }
  const userIds = [...new Set(
    (Array.isArray(members) ? members : [])
      .map((row) => String((row as { user_id?: string }).user_id ?? '').trim())
      .filter(Boolean),
  )]
  if (!userIds.length) return { storeKey: fromGroup || null }

  const { data: users, error: userError } = await supabase
    .from('chat_users')
    .select('id, is_bot, store_key, bot_deleted_at')
    .in('id', userIds)
  if (userError) {
    console.warn('resolveRoomStoreKey users failed:', userError.message)
    return { storeKey: fromGroup || null }
  }
  const keys = [...new Set(
    (Array.isArray(users) ? users : [])
      .filter((row) => (
        (row as { is_bot?: boolean }).is_bot
        && !(row as { bot_deleted_at?: string | null }).bot_deleted_at
      ))
      .map((row) => String((row as { store_key?: string }).store_key ?? '').trim())
      .filter(Boolean),
  )]
  if (keys.length === 1) return { storeKey: keys[0] }
  if (keys.length > 1) return { storeKey: null, ambiguous: true }
  return { storeKey: fromGroup || null }
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
  // M-talkからの投稿を、同じ店舗の別のルーム（例: エリア会議）へ
  // 保存してはいけない。投稿元のM-talkルームを常に保存先にする。
  const roomId = `mtalk-group-${params.groupId}`
  const lineMessageId = mtalkMediaMessageId(params.groupId, params.chatMessageId)
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
  groupId: number,
  chatMessageId: number,
): Promise<boolean> {
  return await removeRoomMediaByMessageId(supabase, mtalkMediaMessageId(groupId, chatMessageId))
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
): Promise<{
  text: string
  card?: ChatCard
  kind: 'receipt' | 'media' | 'error'
  menuKnowledge?: MtalkMenuKnowledgeAnalysis | null
}> {
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

  const receiptPrompt = combineStoreReceiptPromptAdditions(
    resolveBuiltinStoreReceiptPrompt(registry.store_partition_key),
    await fetchStoreReceiptAnalysisPromptAddition(supabase, registry.store_partition_key),
  )
  // 画像を外部AIへ送る回数は従来どおり1回のまま。既存のレシート解析JSONへ
  // menu分岐を加え、Journal Report資料画面と同じ共通・メニュー・店舗専用規約を
  // 同じプロンプト内の独立ブロックとして渡す。
  const menuPrompt = [
    buildKnowledgeCommonPromptBlock({
      sourceLabel: 'M-talkへ投稿された画像',
      categoryHint: '自動判定',
      titleHint: '',
    }),
    KNOWLEDGE_MENU_EXTRACTION_PROMPT_BLOCK,
    buildStoreKnowledgeSpecializedPromptBlock(registry.store_partition_key),
  ].filter(Boolean).join('\n\n')
  // Keep both independent prompt blocks inside the receipt vision addition cap.
  // Receipt rules keep their leading/built-in priority; the complete menu block
  // (including the authenticated store specialization) is always retained.
  const receiptBudget = Math.max(0, STORE_RECEIPT_PROMPT_MAX_CHARS - menuPrompt.length - 2)
  const prompt = [receiptPrompt.slice(0, receiptBudget), menuPrompt].filter(Boolean).join('\n\n')
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

  const analyzedResult = analyzed.analysis
  if (!analyzedResult?.receipt) {
    let menuKnowledge = menuKnowledgeFromLineImageAnalysis(analyzedResult)
    // Journal資料画面と同じ品質ゲート。非メニュー画像には追加AIを
    // 呼ばず、1回目がメニューと判定された上で価格・商品が不足する時だけ
    // 同じGeminiに1回再確認させる。失敗時は初回結果を捨てない。
    if (menuKnowledge?.needs_review) {
      const retryPrompt = [
        menuPrompt,
        '【メニュー品質再確認】前回は価格付き商品が不足しました。画像を区画・セルごとに再走査し、読める全商品の商品名・価格種別・価格・説明をmenu_itemsへ対応付けてください。読めない値は推測せずnullとextraction_notesにしてください。',
      ].join('\n\n').slice(0, STORE_RECEIPT_PROMPT_MAX_CHARS)
      const retry = await analyzeLineImageWithGemini(
        params.bytes,
        params.contentType || 'image/jpeg',
        `${media.lineMessageId}-menu-retry`,
        geminiKey,
        retryPrompt,
        resolveReceiptGeminiFlashLiteModel(),
      )
      menuKnowledge = preferMenuKnowledgeResult(
        menuKnowledge,
        menuKnowledgeFromLineImageAnalysis(retry.analysis),
      )
    }
    if (menuKnowledge) {
      return {
        text: `メニュー画像を解析しました（${menuKnowledge.menu_item_count}品）。`,
        kind: 'media',
        menuKnowledge,
      }
    }
    const summary = String(analyzedResult?.summary ?? '').trim()
    return {
      text: summary ? `画像を確認しました。\n${summary}` : 'レシートとして読み取れる項目がありませんでした。',
      kind: 'media',
    }
  }

  const receiptRaw = analyzedResult.receipt
  const alignedStoreName = alignReceiptStoreNameToRegistry(receiptRaw.storeName, registry)
  const receiptAligned = String(alignedStoreName ?? '') !== String(receiptRaw.storeName ?? '')
    ? { ...receiptRaw, storeName: alignedStoreName }
    : receiptRaw
  const receipt = applySauvageNetSalesAsGrossSales(receiptAligned, registry.store_partition_key)
  const confidence = mergeReceiptConfidence(
    computeReceiptHeuristicConfidence(receipt),
    analyzedResult.receiptModelConfidence ?? null,
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
    summary_text: analyzedResult.summary ?? null,
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
  // 保留状態（重複確認・修正・店舗不一致）の会話キーは (room_id, user_id)。
  // 画像側は投稿元の M-talk ルームで保留を書くので、ここも同じ ID で引く。
  // 別のルームを優先すると保留が見つからず、「置き換え」等に無反応になる。
  const roomId = `mtalk-group-${params.groupId}`
  const reply = await handleStoreReceiptTextMessage(
    supabase,
    registry,
    roomId,
    params.senderUserId || null,
    text,
  )
  if (!reply) return false
  const converted = mtalkCardFromLineReply(reply)
  const bot = await loadChatStoreBot(supabase, params.storeKey)
  await postStoreRoomLineStyleReply(supabase, params.groupId, converted, bot)
  return true
}

export async function postStoreRoomLineStyleReply(
  supabase: DbClient,
  groupId: number,
  result: { text: string; card?: ChatCard },
  asUser?: { id: string; username: string } | null,
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
      asUser,
    })
    if (posted.ok) return
  }
  const { error } = await supabase.from('chat_messages').insert({
    group_id: groupId,
    user_id: asUser?.id || '00000000-0000-4000-8000-00000000b071',
    username: asUser?.username || '予約通知',
    content: result.text,
    kind: 'text',
  })
  if (error) console.error('store room M-talk reply failed:', error.message)
}
