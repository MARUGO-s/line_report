/**
 * 1ルームだけの完全削除。
 * 指定した room_id / chat group_id の行だけを消し、店舗の予約・売上や他ルームには触れない。
 */
import { isMtalkSyntheticRoomId, mtalkSyntheticRoomId } from "./mtalk_room_id.ts"

// deno-lint-ignore no-explicit-any
type DbClient = any

const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/
const MESSAGE_TABLE_RE = /^line_messages__r[0-9a-f]{16}$/
const CHAT_IMAGE_BUCKET = "chat-images"

/** このリスト以外の業務テーブルは消さない。店舗台帳・予約取込は含めない。 */
const ROOM_ID_TABLES = [
  "line_messages",
  "line_room_calendar_events",
  "line_room_names",
  "line_room_messages_search",
  "line_room_media_search",
  "line_room_calendar_search",
  "line_room_document_search",
  "line_room_receipt_search",
  "line_room_search_pending",
  "line_room_search_excluded_messages",
  "calendar_tomorrow_reminder_logs",
  "reservation_today_alert_logs",
  "tokyo_dome_weekly_logs",
  "pv_japan_alert_logs",
  "line_receipt_mid_reports",
  "petty_cash_pending",
  "store_budget_entry_pending",
  "pending_reservation_imports",
] as const

const TARGET_ROOM_TABLES: Array<{ table: string; column: string }> = [
  { table: "gmail_reservation_alert_logs", column: "line_target_room_id" },
  { table: "line_webhook_delivery_logs", column: "target_room_id" },
  { table: "summary_delivery_logs", column: "target_room_id" },
]

export type RoomPurgeCounts = Record<string, number>

export function assertIsolatedRoomId(roomId: string): string {
  const id = String(roomId ?? "").trim()
  if (!id || !ROOM_ID_RE.test(id)) {
    throw { status: 400, message: "ルームIDが不正です。" }
  }
  return id
}

export async function purgeRoomScopedData(
  supabase: DbClient,
  roomId: string,
): Promise<RoomPurgeCounts> {
  const id = assertIsolatedRoomId(roomId)
  const counts: RoomPurgeCounts = {}

  counts.media_files = await removeStorageRows(
    supabase,
    "line_message_media",
    id,
    "storage_bucket",
    "storage_path",
  )
  counts.documents = await removeStorageRows(
    supabase,
    "line_search_documents",
    id,
    "storage_bucket",
    "storage_path",
  )

  for (const table of ROOM_ID_TABLES) {
    counts[table] = await deleteExact(supabase, table, "room_id", id)
  }
  for (const spec of TARGET_ROOM_TABLES) {
    counts[spec.table] = await deleteExact(supabase, spec.table, spec.column, id)
  }

  const dropped = await dropRoomMessageTable(supabase, id)
  if (dropped) counts.message_table_dropped = 1

  counts.room_summary_settings = await deleteExact(supabase, "room_summary_settings", "room_id", id)
  return counts
}

export async function purgeMtalkGroup(
  supabase: DbClient,
  groupId: number,
  actorUserId: string,
): Promise<{ group_id: number; room_id: string; counts: RoomPurgeCounts }> {
  const id = Number(groupId)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw { status: 400, message: "ルームが指定されていません。" }
  }
  const actor = String(actorUserId ?? "").trim()
  if (!actor) throw { status: 401, message: "ログインしてください。" }

  const { data: group, error } = await supabase
    .from("chat_groups")
    .select("id, group_name, created_by, is_store_room, is_direct")
    .eq("id", id)
    .maybeSingle()
  if (error) throw { status: 500, message: `ルームの確認に失敗しました: ${error.message}` }
  if (!group) throw { status: 404, message: "ルームが見つかりません。" }
  if (group.is_store_room) throw { status: 403, message: "店舗固定ルームは削除できません。" }
  if (String(group.created_by ?? "") !== actor) {
    throw { status: 403, message: "ルームを完全に削除できるのは作成者だけです。" }
  }

  const roomId = mtalkSyntheticRoomId(id)
  const counts: RoomPurgeCounts = {}
  counts.chat_images = await removeChatImagePrefix(supabase, id)
  Object.assign(counts, await purgeRoomScopedData(supabase, roomId))

  const { error: deleteGroupError, count } = await supabase
    .from("chat_groups")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("created_by", actor)
    .eq("is_store_room", false)
  if (deleteGroupError) {
    throw { status: 500, message: `ルームの削除に失敗しました: ${deleteGroupError.message}` }
  }
  if ((count ?? 0) !== 1) {
    throw { status: 409, message: "ルームを削除できませんでした。他のルームは変更していません。" }
  }
  counts.chat_groups = 1
  return { group_id: id, room_id: roomId, counts }
}

export async function purgeLineAdminRoom(
  supabase: DbClient,
  roomId: string,
  confirmRoomId: string,
): Promise<{ room_id: string; counts: RoomPurgeCounts }> {
  const id = assertIsolatedRoomId(roomId)
  if (id !== String(confirmRoomId ?? "").trim()) {
    throw { status: 400, message: "確認用のルームIDが一致しません。" }
  }
  if (isMtalkSyntheticRoomId(id)) {
    throw { status: 400, message: "M-talkのルームはトーク画面から作成者が削除してください。" }
  }

  const counts = await purgeRoomScopedData(supabase, id)
  const now = new Date().toISOString()
  const { error: dismissError } = await supabase
    .from("line_room_dismissed")
    .upsert({
      room_id: id,
      admin_surface: "line_report",
      dismissed_at: now,
    }, { onConflict: "room_id,admin_surface" })
  if (dismissError) {
    throw { status: 500, message: `再連携防止の記録に失敗しました: ${dismissError.message}` }
  }
  counts.dismissed = 1
  return { room_id: id, counts }
}

async function deleteExact(
  supabase: DbClient,
  table: string,
  column: string,
  value: string,
): Promise<number> {
  const { error, count } = await supabase.from(table).delete({ count: "exact" }).eq(column, value)
  if (!error) return count ?? 0
  if (isMissingRelation(error)) return 0
  throw { status: 500, message: `${table} の削除に失敗しました: ${error.message}` }
}

async function removeStorageRows(
  supabase: DbClient,
  table: string,
  roomId: string,
  bucketCol: string,
  pathCol: string,
): Promise<number> {
  const { data, error } = await supabase.from(table).select(`id, ${bucketCol}, ${pathCol}`).eq("room_id", roomId)
  if (error) {
    if (isMissingRelation(error)) return 0
    throw { status: 500, message: `${table} の取得に失敗しました: ${error.message}` }
  }
  const rows = Array.isArray(data) ? data : []
  let deleted = 0
  const byBucket = new Map<string, string[]>()
  for (const row of rows) {
    const bucket = String(row?.[bucketCol] ?? "").trim()
    const path = String(row?.[pathCol] ?? "").trim()
    if (!bucket || !path || path.includes("..")) continue
    const list = byBucket.get(bucket) ?? []
    list.push(path)
    byBucket.set(bucket, list)
  }
  for (const [bucket, paths] of byBucket.entries()) {
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100)
      const { error: removeError } = await supabase.storage.from(bucket).remove(chunk)
      if (removeError) {
        throw { status: 500, message: `${bucket} のファイル削除に失敗しました: ${removeError.message}` }
      }
      deleted += chunk.length
    }
  }
  return deleted
}

async function removeChatImagePrefix(supabase: DbClient, groupId: number): Promise<number> {
  const prefix = `groups/${groupId}/`
  const paths: string[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await supabase.storage.from(CHAT_IMAGE_BUCKET).list(`groups/${groupId}`, {
      limit: 1000,
      offset,
    })
    if (error) {
      if (/not found|does not exist/i.test(String(error.message ?? ""))) break
      throw { status: 500, message: `トーク画像の一覧取得に失敗しました: ${error.message}` }
    }
    const rows = Array.isArray(data) ? data : []
    if (!rows.length) break
    for (const row of rows) {
      const name = String(row?.name ?? "").trim()
      if (!name) continue
      const path = `${prefix}${name}`
      if (!path.startsWith(prefix) || path.includes("..")) continue
      paths.push(path)
    }
    if (rows.length < 1000) break
    offset += rows.length
  }

  const { data: messages } = await supabase
    .from("chat_messages")
    .select("payload")
    .eq("group_id", groupId)
    .eq("kind", "image")
    .limit(5000)
  for (const row of (Array.isArray(messages) ? messages : [])) {
    const path = String(row?.payload?.image?.path ?? "").trim()
    if (path.startsWith(prefix) && !path.includes("..") && !paths.includes(path)) paths.push(path)
  }

  let deleted = 0
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100)
    const { error } = await supabase.storage.from(CHAT_IMAGE_BUCKET).remove(chunk)
    if (error) throw { status: 500, message: `トーク画像の削除に失敗しました: ${error.message}` }
    deleted += chunk.length
  }
  return deleted
}

async function dropRoomMessageTable(supabase: DbClient, roomId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("drop_line_room_message_table", { p_room_id: roomId })
  if (error) {
    if (isMissingRelation(error) || /function .* does not exist/i.test(String(error.message ?? ""))) {
      return null
    }
    throw { status: 500, message: `ルーム専用メッセージ表の削除に失敗しました: ${error.message}` }
  }
  const table = String(data ?? "").trim()
  if (table && !MESSAGE_TABLE_RE.test(table)) {
    throw { status: 500, message: "想定外のメッセージ表名のため中止しました。" }
  }
  return table || null
}

function isMissingRelation(error: { message?: string; code?: string } | null): boolean {
  const code = String(error?.code ?? "")
  const message = String(error?.message ?? "")
  return code === "42P01" || code === "PGRST205" || /schema cache|does not exist|could not find/i.test(message)
}
