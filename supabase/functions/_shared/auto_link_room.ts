import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"

const STORE_KEY_PATTERN = /^[a-z0-9]{2,120}$/

export type AutoLinkRoomResult = {
  linked: boolean
  reason?: "already_linked" | "store_conflict" | "dismissed" | "invalid" | "disabled" | "error"
  message?: string
}

export type AutoLinkBatchSummary = {
  linked: number
  skipped: number
  errors: number
}

function isAutoLinkEnabled(): boolean {
  const raw = String(Deno.env.get("RECEIPT_ROOM_AUTO_LINK") ?? "").trim().toLowerCase()
  return raw !== "0" && raw !== "false" && raw !== "off"
}

function normalizeStoreKey(value: string): string {
  return String(value ?? "").trim().toLowerCase()
}

function normalizeRoomId(value: string): string {
  return String(value ?? "").trim()
}

/** 管理画面の新規ルーム既定（localStorage 未設定時）に合わせたサーバー側デフォルト */
export function buildAutoLinkRoomDefaults(storePartitionKey: string) {
  const key = normalizeStoreKey(storePartitionKey)
  const feature = {
    bot_reply_enabled: false,
    bot_reply_hard_mute_enabled: false,
    send_room_summary: false,
    receive_overall_summary_enabled: false,
    calendar_tomorrow_reminder_enabled: false,
    calendar_ai_auto_create_enabled: false,
    calendar_silent_auto_register_enabled: false,
    calendar_low_confidence_confirm_reply_enabled: false,
    calendar_registration_reply_enabled: false,
    message_search_enabled: false,
    message_search_library_enabled: false,
    media_file_access_enabled: true,
    image_analysis_reply_enabled: true,
    gmail_reservation_alert_enabled: false,
    receipt_midreport_enabled: true,
    receipt_monthend_report_enabled: true,
    receipt_report_store_partition_key: key,
    bot_access_approved: false,
  }
  const is_enabled = !!(
    feature.bot_reply_enabled ||
    feature.send_room_summary ||
    feature.receive_overall_summary_enabled ||
    feature.calendar_tomorrow_reminder_enabled ||
    feature.media_file_access_enabled ||
    feature.calendar_ai_auto_create_enabled ||
    feature.calendar_registration_reply_enabled ||
    feature.gmail_reservation_alert_enabled
  )
  return { ...feature, is_enabled }
}

async function isRoomDismissed(
  supabase: SupabaseClient,
  roomId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("line_room_dismissed")
    .select("room_id")
    .eq("room_id", roomId)
    .limit(1)
  if (error) {
    console.error(`auto_link isRoomDismissed failed (${roomId}):`, error.message)
    return false
  }
  return Array.isArray(data) && data.length > 0
}

async function clearRoomDismissed(
  supabase: SupabaseClient,
  roomId: string,
): Promise<void> {
  const { error } = await supabase
    .from("line_room_dismissed")
    .delete()
    .eq("room_id", roomId)
  if (error) {
    console.error(`auto_link clearRoomDismissed failed (${roomId}):`, error.message)
  }
}

async function nextRoomSortOrder(
  supabase: SupabaseClient,
  storeKey: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("room_summary_settings")
    .select("room_sort_order")
    .eq("receipt_report_store_partition_key", storeKey)
    .order("room_sort_order", { ascending: false, nullsFirst: false })
    .limit(1)
  if (error || !data?.length) return 0
  const current = Number((data[0] as { room_sort_order?: unknown }).room_sort_order)
  return Number.isFinite(current) && current >= 0 ? current + 1 : 0
}

/**
 * Webhook 受信店舗へルームを自動連携（確認ダイアログなし）。
 * 別店舗に既に紐づいているルームは上書きしない。
 */
export async function ensureRoomAutoLinkedToStore(
  supabase: SupabaseClient,
  storePartitionKey: string,
  roomId: string,
  options: { undismissOnLink?: boolean; restoreIfDismissed?: boolean } = {},
): Promise<AutoLinkRoomResult> {
  if (!isAutoLinkEnabled()) {
    return { linked: false, reason: "disabled" }
  }

  const storeKey = normalizeStoreKey(storePartitionKey)
  const rid = normalizeRoomId(roomId)
  if (!storeKey || !STORE_KEY_PATTERN.test(storeKey) || !rid) {
    return { linked: false, reason: "invalid" }
  }

  if (await isRoomDismissed(supabase, rid)) {
    if (!options.restoreIfDismissed) {
      return { linked: false, reason: "dismissed" }
    }
  }

  const { data: existing, error: loadError } = await supabase
    .from("room_summary_settings")
    .select("room_id, receipt_report_store_partition_key")
    .eq("room_id", rid)
    .maybeSingle()

  if (loadError) {
    console.error(`auto_link load settings failed (${rid}):`, loadError.message)
    return { linked: false, reason: "error", message: loadError.message }
  }

  const existingKey = normalizeStoreKey(
    String((existing as { receipt_report_store_partition_key?: unknown } | null)
      ?.receipt_report_store_partition_key ?? ""),
  )

  if (existing && existingKey && existingKey !== storeKey) {
    return {
      linked: false,
      reason: "store_conflict",
      message: `room already linked to ${existingKey}`,
    }
  }

  if (existing && existingKey === storeKey) {
    return { linked: false, reason: "already_linked" }
  }

  const defaults = buildAutoLinkRoomDefaults(storeKey)
  const now = new Date().toISOString()
  const sortOrder = existing ? undefined : await nextRoomSortOrder(supabase, storeKey)

  const row: Record<string, unknown> = {
    room_id: rid,
    room_name: null,
    ...defaults,
    updated_at: now,
  }
  if (sortOrder != null) {
    row.room_sort_order = sortOrder
  }

  const { error: upsertError } = await supabase
    .from("room_summary_settings")
    .upsert(row, { onConflict: "room_id" })

  if (upsertError) {
    console.error(`auto_link upsert failed (${rid}@${storeKey}):`, upsertError.message)
    return { linked: false, reason: "error", message: upsertError.message }
  }

  if (options.undismissOnLink !== false) {
    await clearRoomDismissed(supabase, rid)
  }

  console.log(`[auto_link] linked room ${rid} -> store ${storeKey}`)
  return { linked: true }
}

export async function autoLinkDetectedRoomsForStore(
  supabase: SupabaseClient,
  storePartitionKey: string,
  detectedRoomIds: string[],
): Promise<AutoLinkBatchSummary> {
  const summary: AutoLinkBatchSummary = { linked: 0, skipped: 0, errors: 0 }
  if (!isAutoLinkEnabled() || !detectedRoomIds.length) return summary

  const storeKey = normalizeStoreKey(storePartitionKey)
  const { data: linkedRows, error } = await supabase
    .from("room_summary_settings")
    .select("room_id")
    .eq("receipt_report_store_partition_key", storeKey)

  if (error) {
    console.error(`auto_link list linked failed (${storeKey}):`, error.message)
    return summary
  }

  const linked = new Set(
    (Array.isArray(linkedRows) ? linkedRows : []).map((r) =>
      normalizeRoomId(String((r as { room_id?: unknown }).room_id ?? "")),
    ).filter(Boolean),
  )

  for (const rawId of detectedRoomIds) {
    const rid = normalizeRoomId(rawId)
    if (!rid || linked.has(rid)) {
      summary.skipped += 1
      continue
    }
    const result = await ensureRoomAutoLinkedToStore(supabase, storeKey, rid)
    if (result.linked) {
      summary.linked += 1
      linked.add(rid)
    } else if (result.reason === "error") {
      summary.errors += 1
    } else {
      summary.skipped += 1
    }
  }

  return summary
}

export function isReceiptRoomAutoLinkEnabled(): boolean {
  return isAutoLinkEnabled()
}
