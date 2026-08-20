/**
 * M-talk ルーム専用の room_summary_settings。
 * LINE のセルフ設定と同じ列を使い、room_id は mtalk-group-{chat_groups.id}。
 */
import { mtalkSyntheticRoomId } from "./mtalk_room_id.ts"

// deno-lint-ignore no-explicit-any
type DbClient = any

export type MtalkStoreBot = { id: string; username: string }

export async function resolveMtalkRoomStoreKey(
  supabase: DbClient,
  groupId: number,
): Promise<{ storeKey: string | null; roomName: string; ambiguous?: boolean }> {
  const { data: group, error } = await supabase
    .from("chat_groups")
    .select("id, group_name, store_key, is_store_room")
    .eq("id", groupId)
    .maybeSingle()
  if (error || !group) {
    return { storeKey: null, roomName: "" }
  }
  const roomName = String((group as { group_name?: string }).group_name ?? "").trim()
  const fromGroup = String((group as { store_key?: string }).store_key ?? "").trim()
  if ((group as { is_store_room?: boolean }).is_store_room && fromGroup) {
    return { storeKey: fromGroup, roomName }
  }

  const { data: members, error: memberError } = await supabase
    .from("chat_group_members")
    .select("user_id")
    .eq("group_id", groupId)
  if (memberError) return { storeKey: fromGroup || null, roomName }

  const userIds = [...new Set(
    (Array.isArray(members) ? members : [])
      .map((row: { user_id?: string }) => String(row.user_id ?? "").trim())
      .filter(Boolean),
  )]
  if (!userIds.length) return { storeKey: fromGroup || null, roomName }

  const { data: users, error: userError } = await supabase
    .from("chat_users")
    .select("id, is_bot, store_key")
    .in("id", userIds)
  if (userError) return { storeKey: fromGroup || null, roomName }

  const keys = [...new Set(
    (Array.isArray(users) ? users : [])
      .filter((row: { is_bot?: boolean }) => row.is_bot)
      .map((row: { store_key?: string }) => String(row.store_key ?? "").trim())
      .filter(Boolean),
  )]
  if (keys.length === 1) return { storeKey: keys[0], roomName }
  if (keys.length > 1) return { storeKey: null, roomName, ambiguous: true }
  return { storeKey: fromGroup || null, roomName }
}

export async function loadMtalkStoreBot(
  supabase: DbClient,
  storeKey: string,
): Promise<MtalkStoreBot | null> {
  const key = String(storeKey || "").trim()
  if (!key) return null
  const { data, error } = await supabase
    .from("chat_users")
    .select("id, username")
    .eq("is_bot", true)
    .eq("store_key", key)
    .maybeSingle()
  if (error || !data) return null
  const id = String((data as { id?: string }).id ?? "").trim()
  const username = String((data as { username?: string }).username ?? "").trim()
  if (!id || !username) return null
  const base = username.replace(/[\s\u3000]*bot$/i, "").trim() || username
  return { id, username: `${base} bot` }
}

/**
 * 無ければ作る。既存行のトグルは上書きしない。
 * 名前・chat_group_id・空の店舗キーだけ同期する。
 */
export async function ensureMtalkRoomSettings(
  supabase: DbClient,
  groupId: number,
): Promise<{ roomId: string; storeKey: string | null; roomName: string } | null> {
  const id = Number(groupId)
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const roomId = mtalkSyntheticRoomId(id)
  if (!roomId) return null

  const resolved = await resolveMtalkRoomStoreKey(supabase, id)
  const storeKey = resolved.storeKey
  const roomName = resolved.roomName || `M-talk ${id}`

  const { data: existing, error: loadError } = await supabase
    .from("room_summary_settings")
    .select("room_id, receipt_report_store_partition_key, chat_group_id, room_name")
    .eq("room_id", roomId)
    .maybeSingle()
  if (loadError) {
    console.error("ensureMtalkRoomSettings load failed:", loadError.message)
    return null
  }

  const now = new Date().toISOString()
  if (existing) {
    const patch: Record<string, unknown> = { updated_at: now }
    if (!String((existing as { room_name?: string }).room_name ?? "").trim() && roomName) {
      patch.room_name = roomName
    }
    if (Number((existing as { chat_group_id?: number }).chat_group_id) !== id) {
      patch.chat_group_id = id
    }
    const existingStore = String(
      (existing as { receipt_report_store_partition_key?: string }).receipt_report_store_partition_key ?? "",
    ).trim()
    if (!existingStore && storeKey) patch.receipt_report_store_partition_key = storeKey
    if (Object.keys(patch).length > 1) {
      const { error: updateError } = await supabase
        .from("room_summary_settings")
        .update(patch)
        .eq("room_id", roomId)
      if (updateError) console.error("ensureMtalkRoomSettings update failed:", updateError.message)
    }
    return { roomId, storeKey: existingStore || storeKey, roomName }
  }

  const { error: insertError } = await supabase.from("room_summary_settings").insert({
    room_id: roomId,
    room_name: roomName,
    chat_group_id: id,
    receipt_report_store_partition_key: storeKey,
    is_enabled: true,
    room_config_access_enabled: true,
    bot_access_approved: true,
    bot_reply_enabled: false,
    bot_reply_hard_mute_enabled: false,
    message_search_enabled: false,
    message_search_library_enabled: false,
    send_room_summary: false,
    receive_overall_summary_enabled: false,
    media_file_access_enabled: true,
    media_save_enabled: true,
    image_analysis_reply_enabled: true,
    receipt_reply_executive_detail_enabled: true,
    receipt_correction_reply_enabled: true,
    non_receipt_image_reply_enabled: false,
    budget_entry_enabled: false,
    petty_receipt_analysis_enabled: true,
    receipt_midreport_enabled: false,
    receipt_monthend_report_enabled: false,
    gmail_reservation_alert_enabled: false,
    today_reservation_alert_enabled: false,
    today_reservation_alert_hour: 18,
    today_reservation_alert_minute: 0,
    calendar_tomorrow_reminder_enabled: false,
    calendar_ai_auto_create_enabled: false,
    calendar_silent_auto_register_enabled: false,
    calendar_low_confidence_confirm_reply_enabled: false,
    calendar_registration_reply_enabled: false,
    dome_weekly_enabled: false,
    review_alert_enabled: false,
    foodcourt_weekly_report_enabled: false,
    updated_at: now,
  })
  if (insertError) {
    console.error("ensureMtalkRoomSettings insert failed:", insertError.message)
    return null
  }
  return { roomId, storeKey, roomName }
}

export type MtalkRoomFlags = {
  bot_reply_hard_mute_enabled: boolean
  image_analysis_reply_enabled: boolean
  receipt_correction_reply_enabled: boolean
  media_save_enabled: boolean
  media_file_access_enabled: boolean
  petty_receipt_analysis_enabled: boolean
  calendar_ai_auto_create_enabled: boolean
  calendar_silent_auto_register_enabled: boolean
  calendar_registration_reply_enabled: boolean
}

export async function loadMtalkRoomFlags(
  supabase: DbClient,
  groupId: number,
): Promise<MtalkRoomFlags> {
  const roomId = mtalkSyntheticRoomId(groupId)
  const defaults: MtalkRoomFlags = {
    bot_reply_hard_mute_enabled: false,
    image_analysis_reply_enabled: true,
    receipt_correction_reply_enabled: true,
    media_save_enabled: true,
    media_file_access_enabled: true,
    petty_receipt_analysis_enabled: true,
    calendar_ai_auto_create_enabled: false,
    calendar_silent_auto_register_enabled: false,
    calendar_registration_reply_enabled: false,
  }
  if (!roomId) return defaults
  const { data } = await supabase
    .from("room_summary_settings")
    .select("bot_reply_hard_mute_enabled, image_analysis_reply_enabled, receipt_correction_reply_enabled, media_save_enabled, media_file_access_enabled, petty_receipt_analysis_enabled, calendar_ai_auto_create_enabled, calendar_silent_auto_register_enabled, calendar_registration_reply_enabled")
    .eq("room_id", roomId)
    .maybeSingle()
  if (!data) return defaults
  const row = data as Record<string, unknown>
  return {
    bot_reply_hard_mute_enabled: row.bot_reply_hard_mute_enabled === true,
    image_analysis_reply_enabled: row.image_analysis_reply_enabled !== false,
    receipt_correction_reply_enabled: row.receipt_correction_reply_enabled !== false,
    media_save_enabled: row.media_save_enabled !== false,
    media_file_access_enabled: row.media_file_access_enabled !== false,
    petty_receipt_analysis_enabled: row.petty_receipt_analysis_enabled !== false,
    calendar_ai_auto_create_enabled: row.calendar_ai_auto_create_enabled === true,
    calendar_silent_auto_register_enabled: row.calendar_silent_auto_register_enabled === true,
    calendar_registration_reply_enabled: row.calendar_registration_reply_enabled === true,
  }
}
