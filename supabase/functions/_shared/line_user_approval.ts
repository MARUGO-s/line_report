import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import { fetchLineDisplayNameByUserId } from './line_display_names.ts'
import { pushLineText, replyLineText, resolveChannelAccessToken } from './line_client.ts'

export const ADMIN_STORE_PARTITION_KEY = 'admin'

const DEFAULT_APPROVAL_ADMIN_USER_IDS = ['U58f77497071ad47faedd0375615300f4']

type LineEvent = {
  type?: string
  replyToken?: string
  source?: { type?: string; userId?: string }
  message?: { type?: string; text?: string }
}

export type LineUserPermissionGate = {
  exists: boolean
  isActive: boolean
}

export function resolveApprovalAdminUserIds(): string[] {
  const raw = String(Deno.env.get('LINE_USER_APPROVAL_ADMIN_USER_IDS') ?? '').trim()
  const source = raw || DEFAULT_APPROVAL_ADMIN_USER_IDS.join(',')
  return Array.from(new Set(
    source.split(/[,\s]+/)
      .map((id) => id.trim())
      .filter((id) => id.startsWith('U')),
  ))
}

export function isApprovalAdminUserId(userId: string): boolean {
  const uid = String(userId ?? '').trim()
  return resolveApprovalAdminUserIds().includes(uid)
}

export async function loadLineUserPermissionGate(
  supabase: SupabaseClient,
  userId: string,
): Promise<LineUserPermissionGate> {
  const uid = String(userId ?? '').trim()
  if (!uid.startsWith('U')) return { exists: false, isActive: false }

  const { data, error } = await supabase
    .from('line_user_permissions')
    .select('line_user_id, is_active')
    .eq('line_user_id', uid)
    .maybeSingle()

  if (error) {
    console.error(`line_user_permissions lookup failed (${uid}):`, error.message)
    return { exists: false, isActive: false }
  }
  if (!data) return { exists: false, isActive: false }

  const row = data as Record<string, unknown>
  return { exists: true, isActive: row.is_active === true }
}

/** follow 以外の 1対1で未許可ユーザーをブロックするか */
export function shouldBlockUnapprovedDirectMessage(
  event: LineEvent,
  gate: LineUserPermissionGate,
): boolean {
  if (event.type === 'follow') return false
  if (gate.isActive) return false
  return true
}

async function upsertPendingLineUser(
  supabase: SupabaseClient,
  lineUserId: string,
  displayName: string | null,
  sourceStoreKey: string,
): Promise<{ created: boolean; alreadyActive: boolean }> {
  const uid = String(lineUserId ?? '').trim()
  const { data: existing, error: selErr } = await supabase
    .from('line_user_permissions')
    .select('line_user_id, is_active')
    .eq('line_user_id', uid)
    .maybeSingle()
  if (selErr) {
    console.error(`upsertPendingLineUser select failed (${uid}):`, selErr.message)
    return { created: false, alreadyActive: false }
  }

  if (existing?.line_user_id && (existing as { is_active?: boolean }).is_active === true) {
    return { created: false, alreadyActive: true }
  }

  const now = new Date().toISOString()
  const row: Record<string, unknown> = {
    line_user_id: uid,
    display_name: displayName,
    is_active: false,
    can_message_search: false,
    can_library_search: false,
    can_calendar_create: false,
    can_calendar_update: false,
    can_calendar_view: false,
    can_media_access: false,
    registration_source_store: sourceStoreKey,
    updated_at: now,
  }

  if (existing?.line_user_id) {
    const { error: upErr } = await supabase
      .from('line_user_permissions')
      .update({
        display_name: displayName,
        registration_source_store: sourceStoreKey,
        updated_at: now,
      })
      .eq('line_user_id', uid)
    if (upErr) console.error(`upsertPendingLineUser update failed (${uid}):`, upErr.message)
    return { created: false, alreadyActive: false }
  }

  const { error: insErr } = await supabase
    .from('line_user_permissions')
    .insert(row)
  if (insErr && String(insErr.code) !== '23505') {
    console.error(`upsertPendingLineUser insert failed (${uid}):`, insErr.message)
    return { created: false, alreadyActive: false }
  }
  return { created: true, alreadyActive: false }
}

export async function notifyApprovalAdminOfNewFollower(
  supabase: SupabaseClient,
  targetUserId: string,
  sourceStoreKey: string,
  sourceStoreDisplayName: string,
  storeAccessToken: string,
): Promise<void> {
  const adminToken = resolveChannelAccessToken(ADMIN_STORE_PARTITION_KEY)
  const adminUserIds = resolveApprovalAdminUserIds()
  if (!adminToken || !adminUserIds.length) {
    console.error('notifyApprovalAdmin: missing admin token or admin user ids')
    return
  }

  const displayName = await fetchLineDisplayNameByUserId(
    targetUserId,
    targetUserId,
    storeAccessToken,
  )
  await upsertPendingLineUser(supabase, targetUserId, displayName, sourceStoreKey)

  const label = String(sourceStoreDisplayName || sourceStoreKey).trim() || sourceStoreKey
  const nameLine = displayName ? `表示名: ${displayName}` : '表示名: （未取得）'
  const text = [
    '【新規友だち登録・承認待ち】',
    `店舗Bot: ${label}`,
    nameLine,
    `ユーザーID: ${targetUserId}`,
    '',
    `許可: 許可 ${targetUserId}`,
    `不許可: 不許可 ${targetUserId}`,
  ].join('\n')

  for (const adminUserId of adminUserIds) {
    const result = await pushLineText(adminUserId, text, adminToken)
    if (!result.ok) {
      console.error(`notifyApprovalAdmin push failed (${adminUserId}):`, result.error)
    }
  }
}

export async function handleStoreFollowForUserApproval(
  supabase: SupabaseClient,
  targetUserId: string,
  sourceStoreKey: string,
  sourceStoreDisplayName: string,
  storeAccessToken: string,
): Promise<void> {
  const gate = await loadLineUserPermissionGate(supabase, targetUserId)
  if (gate.isActive) return

  await notifyApprovalAdminOfNewFollower(
    supabase,
    targetUserId,
    sourceStoreKey,
    sourceStoreDisplayName,
    storeAccessToken,
  )
}

type ApprovalCommand = { action: 'approve' | 'reject'; targetUserId: string }

function parseApprovalCommand(text: string): ApprovalCommand | null {
  const raw = String(text ?? '').trim()
  const approve = /^(?:許可|承認)\s+(U[a-f0-9]{32})$/i.exec(raw)
  if (approve) return { action: 'approve', targetUserId: approve[1] }
  const reject = /^(?:不許可|拒否|却下)\s+(U[a-f0-9]{32})$/i.exec(raw)
  if (reject) return { action: 'reject', targetUserId: reject[1] }
  return null
}

async function loadRegistrationSourceStore(
  supabase: SupabaseClient,
  lineUserId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('line_user_permissions')
    .select('registration_source_store')
    .eq('line_user_id', lineUserId)
    .maybeSingle()
  if (error) {
    console.error(`registration_source_store lookup failed (${lineUserId}):`, error.message)
    return null
  }
  const store = String((data as { registration_source_store?: unknown })?.registration_source_store ?? '').trim()
  return store || null
}

async function applyUserApproval(
  supabase: SupabaseClient,
  command: ApprovalCommand,
): Promise<{ ok: boolean; message: string; notifyStoreKey: string | null }> {
  const uid = command.targetUserId
  const now = new Date().toISOString()

  if (command.action === 'approve') {
    const { data, error } = await supabase
      .from('line_user_permissions')
      .update({
        is_active: true,
        can_message_search: true,
        can_library_search: true,
        can_calendar_create: true,
        can_calendar_update: true,
        can_calendar_view: true,
        can_media_access: true,
        updated_at: now,
      })
      .eq('line_user_id', uid)
      .select('line_user_id, registration_source_store')
      .maybeSingle()

    if (error) {
      return { ok: false, message: `許可の保存に失敗しました: ${error.message}`, notifyStoreKey: null }
    }
    if (!data?.line_user_id) {
      return {
        ok: false,
        message: `ユーザー ${uid} は未登録です。先に店舗Botへ友だち追加してもらってください。`,
        notifyStoreKey: null,
      }
    }
    const storeKey = String((data as { registration_source_store?: unknown }).registration_source_store ?? '').trim() || null
    return { ok: true, message: `許可しました: ${uid}`, notifyStoreKey: storeKey }
  }

  const { data, error } = await supabase
    .from('line_user_permissions')
    .update({
      is_active: false,
      can_message_search: false,
      can_library_search: false,
      can_calendar_create: false,
      can_calendar_update: false,
      can_calendar_view: false,
      can_media_access: false,
      updated_at: now,
    })
    .eq('line_user_id', uid)
    .select('line_user_id')
    .maybeSingle()

  if (error) {
    return { ok: false, message: `不許可の保存に失敗しました: ${error.message}`, notifyStoreKey: null }
  }
  if (!data?.line_user_id) {
    return { ok: false, message: `ユーザー ${uid} は見つかりません。`, notifyStoreKey: null }
  }
  return { ok: true, message: `不許可にしました: ${uid}`, notifyStoreKey: null }
}

async function notifyUserApprovalResult(
  targetUserId: string,
  approved: boolean,
  sourceStoreKey: string | null,
): Promise<void> {
  const storeKey = String(sourceStoreKey ?? '').trim()
  if (!storeKey || storeKey === ADMIN_STORE_PARTITION_KEY) return
  const token = resolveChannelAccessToken(storeKey)
  if (!token) return
  const text = approved
    ? '利用許可が完了しました。店舗Botで検索などの機能が使えるようになりました。'
    : '利用許可は付与されていません。管理者にお問い合わせください。'
  const result = await pushLineText(targetUserId, text, token)
  if (!result.ok) {
    console.error(`notifyUserApprovalResult push failed (${targetUserId}):`, result.error)
  }
}

const ADMIN_NON_OPERATOR_TEXT =
  'このアカウントは利用許可の承認専用です。承認操作はできません。'
const ADMIN_OPERATOR_HELP_TEXT =
  '【利用許可Bot】\n' +
  '店舗Botの新規友だち登録が届いたら、次の形式で返信してください。\n\n' +
  '許可 Uxxxxxxxx…\n' +
  '不許可 Uxxxxxxxx…'
const ADMIN_OPERATOR_NON_TEXT_TEXT =
  '承認はテキストで送ってください。\n例: 許可 Uxxxxxxxx…'

/** 管理Bot専用: 許可／不許可のみ（記録・レシート・検索は行わない） */
export async function handleAdminApprovalEvents(
  supabase: SupabaseClient,
  events: LineEvent[],
): Promise<{ replies: number; errors: string[] }> {
  let replies = 0
  const errors: string[] = []
  const adminToken = resolveChannelAccessToken(ADMIN_STORE_PARTITION_KEY)
  if (!adminToken) {
    errors.push('LINE_CHANNEL_ACCESS_TOKEN__ADMIN is not set')
    return { replies, errors }
  }

  for (const event of events) {
    const replyToken = String(event.replyToken ?? '').trim()
    const senderId = String(event.source?.userId ?? '').trim()

    // follow / unfollow / その他: 返信も記録もしない
    if (event.type !== 'message' && event.type !== 'postback') continue
    if (!replyToken || !senderId) continue

    if (!isApprovalAdminUserId(senderId)) {
      const result = await replyLineText(replyToken, ADMIN_NON_OPERATOR_TEXT, adminToken)
      if (result.ok) replies += 1
      continue
    }

    if (event.type === 'postback') {
      const result = await replyLineText(replyToken, ADMIN_OPERATOR_HELP_TEXT, adminToken)
      if (result.ok) replies += 1
      continue
    }

    if (event.message?.type !== 'text') {
      const result = await replyLineText(replyToken, ADMIN_OPERATOR_NON_TEXT_TEXT, adminToken)
      if (result.ok) replies += 1
      continue
    }

    const text = String(event.message?.text ?? '').trim()
    if (!text) continue

    const command = parseApprovalCommand(text)
    if (!command) {
      const result = await replyLineText(replyToken, ADMIN_OPERATOR_HELP_TEXT, adminToken)
      if (result.ok) replies += 1
      continue
    }

    const applied = await applyUserApproval(supabase, command)
    if (applied.ok && command.action === 'approve') {
      const storeKey = applied.notifyStoreKey
        ?? await loadRegistrationSourceStore(supabase, command.targetUserId)
      await notifyUserApprovalResult(command.targetUserId, true, storeKey)
    }

    const result = await replyLineText(replyToken, applied.message, adminToken)
    if (result.ok) replies += 1
    else if (applied.message) errors.push(String(result.error || 'reply failed').slice(0, 160))
  }

  return { replies, errors }
}

export async function replyLinePermissionBlocked(
  event: LineEvent,
  storePartitionKey: string,
): Promise<boolean> {
  const replyToken = String(event.replyToken ?? '').trim()
  if (!replyToken) return false
  const accessToken = resolveChannelAccessToken(storePartitionKey)
  if (!accessToken) return false
  const result = await replyLineText(
    replyToken,
    'このアカウントは利用許可待ちです。管理者が有効化するまで機能は使えません。',
    accessToken,
  )
  return result.ok
}
