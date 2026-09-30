import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import { normalizeInlineText } from './receipt_parse.ts'

const PENDING_TABLE = 'store_receipt_delete_pending'
const PENDING_TTL_MIN = 30

export type PendingReceiptDeletion = {
  receipt_table: string
  room_id: string
  user_id: string | null
  target_line_message_id: string | null
  target_receipt_row_id: number | null
}

function conversationKey(roomId: string, userId: string | null): string {
  return (roomId || '__unknown_room__') + '::' + (userId || '__anonymous__')
}

export function isReceiptDeletionConfirmation(rawText: string): boolean {
  return normalizeInlineText(String(rawText ?? '').normalize('NFKC')) === '削除'
}

export async function savePendingReceiptDeletion(
  supabase: SupabaseClient,
  payload: PendingReceiptDeletion,
): Promise<boolean> {
  if (!payload.target_line_message_id && payload.target_receipt_row_id == null) return false
  const expiresAt = new Date(Date.now() + PENDING_TTL_MIN * 60 * 1000).toISOString()
  const { error } = await supabase.from(PENDING_TABLE).upsert({
    conversation_key: conversationKey(payload.room_id, payload.user_id),
    receipt_table: payload.receipt_table,
    room_id: payload.room_id,
    user_id: payload.user_id,
    target_line_message_id: payload.target_line_message_id,
    target_receipt_row_id: payload.target_receipt_row_id,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'conversation_key' })
  if (error) {
    console.error('savePendingReceiptDeletion failed:', error.message)
    return false
  }
  return true
}

export async function loadPendingReceiptDeletion(
  supabase: SupabaseClient,
  roomId: string,
  userId: string | null,
): Promise<PendingReceiptDeletion | null> {
  const { data, error } = await supabase
    .from(PENDING_TABLE)
    .select('*')
    .eq('conversation_key', conversationKey(roomId, userId))
    .maybeSingle()
  if (error || !data) return null
  const expiresAt = String((data as { expires_at?: unknown }).expires_at ?? '')
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    await clearPendingReceiptDeletion(supabase, roomId, userId)
    return null
  }
  const targetLineMessageId = String((data as { target_line_message_id?: unknown }).target_line_message_id ?? '').trim() || null
  const rawRowId = (data as { target_receipt_row_id?: unknown }).target_receipt_row_id
  const parsedRowId = Number(rawRowId)
  const targetReceiptRowId = Number.isSafeInteger(parsedRowId) ? parsedRowId : null
  if (!targetLineMessageId && targetReceiptRowId == null) {
    await clearPendingReceiptDeletion(supabase, roomId, userId)
    return null
  }
  return {
    receipt_table: String((data as { receipt_table?: unknown }).receipt_table ?? ''),
    room_id: String((data as { room_id?: unknown }).room_id ?? roomId),
    user_id: (data as { user_id?: unknown }).user_id != null
      ? String((data as { user_id?: unknown }).user_id)
      : null,
    target_line_message_id: targetLineMessageId,
    target_receipt_row_id: targetReceiptRowId,
  }
}

export async function clearPendingReceiptDeletion(
  supabase: SupabaseClient,
  roomId: string,
  userId: string | null,
): Promise<void> {
  await supabase
    .from(PENDING_TABLE)
    .delete()
    .eq('conversation_key', conversationKey(roomId, userId))
}
