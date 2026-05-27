import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import {
  extractLineMessageTextContent,
  isLineRoomMessageRecordingEnabled,
  type LineMessageEvent,
} from './line_room_messages.ts'

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file'])

export async function persistLineRoomSearchArchivesFromWebhook(
  supabase: SupabaseClient,
  event: LineMessageEvent,
  roomId: string,
): Promise<{ savedKinds: string[] }> {
  if (!isLineRoomMessageRecordingEnabled()) {
    return { savedKinds: [] }
  }
  if (event.type !== 'message' || !event.message) {
    return { savedKinds: [] }
  }

  const savedKinds: string[] = []
  const msg = event.message
  const messageType = String(msg.type || '').trim().toLowerCase()
  const lineMessageId = String(msg.id || '').trim() || null
  const userId = event.source?.userId ? String(event.source.userId).trim() : null

  if (messageType === 'text') {
    const text = String(msg.text || '').trim()
    if (text) {
      const { error } = await supabase.rpc('insert_line_room_calendar_search', {
        p_room_id: roomId,
        p_line_message_id: lineMessageId,
        p_event_title: text.slice(0, 120),
        p_event_description: text,
        p_starts_at: null,
        p_source: 'line_talk',
      })
      if (error) {
        console.error(`insert_line_room_calendar_search failed (${roomId}):`, error.message)
      } else {
        savedKinds.push('calendar')
      }
    }
    return { savedKinds }
  }

  if (MEDIA_TYPES.has(messageType)) {
    const fileName = String(msg.fileName || '').trim()
    const preview = extractLineMessageTextContent(event)
    const { error } = await supabase.rpc('insert_line_room_media_search', {
      p_room_id: roomId,
      p_line_message_id: lineMessageId,
      p_user_id: userId,
      p_media_type: messageType,
      p_original_file_name: fileName || null,
      p_content_preview: preview,
    })
    if (error) {
      console.error(`insert_line_room_media_search failed (${roomId}):`, error.message)
    } else {
      savedKinds.push('media')
    }

    if (messageType === 'file' && (fileName || preview)) {
      const { error: docError } = await supabase.rpc('insert_line_room_document_search', {
        p_room_id: roomId,
        p_line_message_id: lineMessageId,
        p_original_file_name: fileName || preview,
        p_extracted_text: '',
        p_mime_type: null,
      })
      if (docError) {
        console.error(`insert_line_room_document_search failed (${roomId}):`, docError.message)
      } else {
        savedKinds.push('document')
      }
    }
  }

  return { savedKinds }
}

export async function indexLineRoomReceiptSearch(
  supabase: SupabaseClient,
  params: {
    roomId: string
    storePartitionKey?: string | null
    lineMessageId?: string | null
    receiptDate: string | null
    receiptDateText?: string | null
    storeName?: string | null
    taxAmountYen: number | null
    partyCount: number | null
    guestCount: number | null
    unitPriceYen: number | null
    summaryText: string
    grossSalesYen: number | null
    netSalesYen: number | null
    receiptTable: string
    receiptRowId: number
  },
): Promise<void> {
  const { error } = await supabase.rpc('upsert_line_room_receipt_search', {
    p_room_id: params.roomId,
    p_store_partition_key: params.storePartitionKey ?? null,
    p_line_message_id: params.lineMessageId ?? null,
    p_receipt_date: params.receiptDate,
    p_receipt_date_text: params.receiptDateText ?? null,
    p_store_name: params.storeName ?? null,
    p_summary_text: params.summaryText,
    p_gross_sales_yen: params.grossSalesYen,
    p_net_sales_yen: params.netSalesYen,
    p_tax_amount_yen: params.taxAmountYen,
    p_party_count: params.partyCount,
    p_guest_count: params.guestCount,
    p_unit_price_yen: params.unitPriceYen,
    p_receipt_table: params.receiptTable,
    p_receipt_row_id: params.receiptRowId,
  })
  if (error) {
    console.error(`upsert_line_room_receipt_search failed (${params.roomId}):`, error.message)
  }
}
