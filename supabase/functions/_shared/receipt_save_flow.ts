import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { LineImageReceiptAnalysis, LineReplyPayload } from './receipt_types.ts'
import { buildReceiptFlexMessage } from './receipt_flex_reply.ts'
import {
  buildReceiptDuplicateConfirmationFlexReply,
  clearPendingReceiptDuplicate,
  savePendingReceiptDuplicate,
} from './receipt_duplicate.ts'
import { loadReceiptReplyContext } from './receipt_reply_context.ts'
import {
  hasExistingReceiptForDate,
  saveStoreReceiptEntry,
  type StoreRegistryRow,
} from './store_receipt.ts'

export type ReceiptRegistrationPayload = {
  line_message_id: string
  room_id: string
  user_id: string | null
  receipt_date: string
  receipt_payload: LineImageReceiptAnalysis
  summary_text: string | null
  store_display_name: string
  sender_display_name: string | null
}

export type ReceiptRegistrationResult = {
  saved: boolean
  reply: LineReplyPayload
}

export async function attemptReceiptRegistration(
  supabase: SupabaseClient,
  registry: StoreRegistryRow,
  payload: ReceiptRegistrationPayload,
): Promise<ReceiptRegistrationResult> {
  const sameDateExists = await hasExistingReceiptForDate(
    supabase,
    registry.receipt_table,
    payload.receipt_date,
  )
  if (sameDateExists) {
    const dupSaved = await savePendingReceiptDuplicate(supabase, {
      store_partition_key: registry.store_partition_key,
      receipt_table: registry.receipt_table,
      room_id: payload.room_id,
      user_id: payload.user_id,
      line_message_id: payload.line_message_id,
      receipt_date: payload.receipt_date,
      receipt_payload: payload.receipt_payload,
      summary_text: payload.summary_text,
      store_display_name: payload.store_display_name,
      sender_display_name: payload.sender_display_name,
    })
    if (!dupSaved) {
      return {
        saved: false,
        reply: '確認状態の保存に失敗しました。少し時間を置いて同じ画像を再送してください。',
      }
    }
    return {
      saved: false,
      reply: buildReceiptDuplicateConfirmationFlexReply(
        payload.receipt_payload,
        payload.receipt_date,
      ),
    }
  }

  const saveResult = await saveStoreReceiptEntry(supabase, registry.receipt_table, {
    lineMessageId: payload.line_message_id,
    roomId: payload.room_id,
    userId: payload.user_id,
    senderDisplayName: payload.sender_display_name,
    storeDisplayName: payload.store_display_name,
    storePartitionKey: registry.store_partition_key,
    receipt: payload.receipt_payload,
    summary: payload.summary_text ?? '',
  })
  if (saveResult.duplicate) {
    return { saved: false, reply: 'このレシートは既に登録済みです。' }
  }
  if (!saveResult.ok) {
    return { saved: false, reply: 'レシートの保存に失敗しました。' }
  }

  // 通常保存できたら、この会話に残っている重複確認の保留をクリア（残骸の持ち越し防止）
  await clearPendingReceiptDuplicate(supabase, payload.room_id, payload.user_id)

  const replyContext = await loadReceiptReplyContext(supabase, {
    storePartitionKey: registry.store_partition_key,
    storeDisplayName: payload.store_display_name,
    receiptTable: registry.receipt_table,
    receipt: payload.receipt_payload,
    receiptDateIso: payload.receipt_date,
    lineMessageId: payload.line_message_id,
  })
  return { saved: true, reply: buildReceiptFlexMessage(replyContext) }
}
