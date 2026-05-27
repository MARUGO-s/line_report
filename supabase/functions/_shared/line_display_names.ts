import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'

export async function fetchLineDisplayNameByUserId(
  lineUserId: string,
  roomId: string,
  lineAccessToken: string,
): Promise<string | null> {
  const userId = String(lineUserId ?? '').trim()
  const rid = String(roomId ?? '').trim()
  if (!userId || !lineAccessToken) return null

  if (rid.startsWith('C')) {
    const byGroupMember = await fetchLineDisplayNameByUrl(
      `https://api.line.me/v2/bot/group/${encodeURIComponent(rid)}/member/${encodeURIComponent(userId)}`,
      lineAccessToken,
    )
    if (byGroupMember) return byGroupMember
  } else if (rid.startsWith('R')) {
    const byRoomMember = await fetchLineDisplayNameByUrl(
      `https://api.line.me/v2/bot/room/${encodeURIComponent(rid)}/member/${encodeURIComponent(userId)}`,
      lineAccessToken,
    )
    if (byRoomMember) return byRoomMember
  }

  return await fetchLineDisplayNameByUrl(
    `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`,
    lineAccessToken,
  )
}

async function fetchLineDisplayNameByUrl(
  url: string,
  lineAccessToken: string,
): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${lineAccessToken}` },
    })
    if (!response.ok) return null
    const body = await response.json()
    const displayName = String(body?.displayName ?? '').trim()
    return displayName || null
  } catch {
    return null
  }
}

export async function fetchLineConversationNameByRoomId(
  roomId: string,
  lineAccessToken: string,
): Promise<string | null> {
  const normalizedRoomId = String(roomId ?? '').trim()
  if (!normalizedRoomId || !lineAccessToken) return null

  if (normalizedRoomId.startsWith('C')) {
    return await fetchLineConversationNameByUrl(
      `https://api.line.me/v2/bot/group/${encodeURIComponent(normalizedRoomId)}/summary`,
      lineAccessToken,
      'groupName',
    )
  }
  if (normalizedRoomId.startsWith('R')) {
    return await fetchLineConversationNameByUrl(
      `https://api.line.me/v2/bot/room/${encodeURIComponent(normalizedRoomId)}/summary`,
      lineAccessToken,
      'roomName',
    )
  }
  if (normalizedRoomId.startsWith('U')) {
    return await fetchLineConversationNameByUrl(
      `https://api.line.me/v2/bot/profile/${encodeURIComponent(normalizedRoomId)}`,
      lineAccessToken,
      'displayName',
    )
  }
  return null
}

async function fetchLineConversationNameByUrl(
  url: string,
  lineAccessToken: string,
  key: 'groupName' | 'roomName' | 'displayName',
): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${lineAccessToken}` },
    })
    if (!response.ok) return null
    const body = await response.json()
    const value = String(body?.[key] ?? '').trim()
    return value || null
  } catch {
    return null
  }
}

function isAutoDisplayNamesEnabled(): boolean {
  const raw = String(Deno.env.get('LINE_AUTO_DISPLAY_NAMES') ?? '').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

/** メッセージ等の Webhook から、未設定のユーザー表示名だけ LINE API で補完する */
export async function ensureLineUserDisplayNameFromWebhook(
  supabase: SupabaseClient,
  lineUserId: string,
  roomId: string | null,
  lineAccessToken: string,
): Promise<'inserted' | 'updated' | 'skipped'> {
  const userId = String(lineUserId ?? '').trim()
  if (!userId.startsWith('U') || !lineAccessToken) return 'skipped'

  const { data: existing, error: selErr } = await supabase
    .from('line_user_permissions')
    .select('line_user_id, display_name')
    .eq('line_user_id', userId)
    .maybeSingle()
  if (selErr) {
    console.error(`ensureLineUserDisplayName select failed (${userId}):`, selErr.message)
    return 'skipped'
  }

  const existingName = String(existing?.display_name ?? '').trim()
  if (existingName) return 'skipped'

  const displayName = await fetchLineDisplayNameByUserId(
    userId,
    roomId ? String(roomId).trim() : '',
    lineAccessToken,
  )
  const now = new Date().toISOString()

  if (existing?.line_user_id) {
    if (!displayName) return 'skipped'
    const { error: upErr } = await supabase
      .from('line_user_permissions')
      .update({ display_name: displayName, updated_at: now })
      .eq('line_user_id', userId)
    if (upErr) {
      console.error(`ensureLineUserDisplayName update failed (${userId}):`, upErr.message)
      return 'skipped'
    }
    return 'updated'
  }

  const { error: insErr } = await supabase
    .from('line_user_permissions')
    .insert({
      line_user_id: userId,
      display_name: displayName,
      // 新規友だちは管理者が有効化するまで利用不可（既存ユーザー行には影響しない）
      is_active: false,
      can_message_search: false,
      can_library_search: false,
      can_calendar_create: false,
      can_calendar_update: false,
      can_calendar_view: false,
      can_media_access: false,
      assigned_store: null,
      assigned_job_title: null,
      updated_at: now,
    }, { defaultToNull: false, ignoreDuplicates: true })
  if (insErr && String(insErr.code) !== '23505') {
    console.error(`ensureLineUserDisplayName insert failed (${userId}):`, insErr.message)
    return 'skipped'
  }
  return 'inserted'
}

/** ルーム名キャッシュが空のときだけ LINE から取得して保存する */
export async function ensureLineRoomDisplayNameFromWebhook(
  supabase: SupabaseClient,
  roomId: string,
  lineAccessToken: string,
): Promise<'refreshed' | 'skipped'> {
  const id = String(roomId ?? '').trim()
  if (!id || !lineAccessToken) return 'skipped'
  if (!id.startsWith('C') && !id.startsWith('R') && !id.startsWith('U')) return 'skipped'

  const { data: cache, error: cacheErr } = await supabase
    .from('line_room_names')
    .select('room_name')
    .eq('room_id', id)
    .maybeSingle()
  if (cacheErr) {
    console.error(`ensureLineRoomDisplayName cache read failed (${id}):`, cacheErr.message)
    return 'skipped'
  }
  if (String(cache?.room_name ?? '').trim()) return 'skipped'

  const { data: settings, error: settingsErr } = await supabase
    .from('room_summary_settings')
    .select('room_name')
    .eq('room_id', id)
    .maybeSingle()
  if (settingsErr) {
    console.error(`ensureLineRoomDisplayName settings read failed (${id}):`, settingsErr.message)
    return 'skipped'
  }
  if (String(settings?.room_name ?? '').trim()) {
    const cachedName = String(settings.room_name).trim()
    const now = new Date().toISOString()
    await supabase.from('line_room_names').upsert({
      room_id: id,
      room_name: cachedName,
      updated_at: now,
    }, { onConflict: 'room_id' })
    return 'skipped'
  }

  const name = await fetchLineConversationNameByRoomId(id, lineAccessToken)
  if (!name) return 'skipped'

  const now = new Date().toISOString()
  const { error: cacheUpErr } = await supabase.from('line_room_names').upsert({
    room_id: id,
    room_name: name,
    updated_at: now,
  }, { onConflict: 'room_id' })
  if (cacheUpErr) {
    console.error(`ensureLineRoomDisplayName cache upsert failed (${id}):`, cacheUpErr.message)
    return 'skipped'
  }

  const { data: linked } = await supabase
    .from('room_summary_settings')
    .select('room_id')
    .eq('room_id', id)
    .maybeSingle()
  if (linked?.room_id) {
    const { error: settingsUpErr } = await supabase
      .from('room_summary_settings')
      .update({ room_name: name, updated_at: now })
      .eq('room_id', id)
    if (settingsUpErr) {
      console.error(`ensureLineRoomDisplayName settings update failed (${id}):`, settingsUpErr.message)
    }
  }

  return 'refreshed'
}

export type WebhookDisplayNameSyncSummary = {
  users_inserted: number
  users_updated: number
  users_skipped: number
  rooms_refreshed: number
  rooms_skipped: number
}

export async function runWebhookDisplayNameSync(
  supabase: SupabaseClient,
  lineAccessToken: string,
  users: Iterable<{ userId: string; roomId: string | null }>,
  roomIds: Iterable<string>,
): Promise<WebhookDisplayNameSyncSummary> {
  const summary: WebhookDisplayNameSyncSummary = {
    users_inserted: 0,
    users_updated: 0,
    users_skipped: 0,
    rooms_refreshed: 0,
    rooms_skipped: 0,
  }
  if (!isAutoDisplayNamesEnabled()) return summary

  for (const { userId, roomId } of users) {
    const result = await ensureLineUserDisplayNameFromWebhook(
      supabase,
      userId,
      roomId,
      lineAccessToken,
    )
    if (result === 'inserted') summary.users_inserted += 1
    else if (result === 'updated') summary.users_updated += 1
    else summary.users_skipped += 1
  }

  for (const roomId of roomIds) {
    const result = await ensureLineRoomDisplayNameFromWebhook(
      supabase,
      roomId,
      lineAccessToken,
    )
    if (result === 'refreshed') summary.rooms_refreshed += 1
    else summary.rooms_skipped += 1
  }

  return summary
}
