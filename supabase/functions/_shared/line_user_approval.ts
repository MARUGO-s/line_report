import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import { fetchLineConversationNameByRoomId, fetchLineDisplayNameByUserId } from './line_display_names.ts'
import { RECEIPT_SHEETS_STORE_CATALOG } from './receipt_sheets_store_catalog.ts'
import {
  pushLineMessages,
  replyLineFlex,
  replyLineMessages,
  resolveChannelAccessToken,
} from './line_client.ts'
import { buildFlexInfoCard, type FlexButtonSpec } from './line_flex_messages.ts'

export const ADMIN_STORE_PARTITION_KEY = 'admin'

// 承認管理者IDは必ず Edge シークレット LINE_USER_APPROVAL_ADMIN_USER_IDS から解決する。
// 以前はここに実IDをハードコードしていたが、公開リポジトリでの露出＝偽造承認の足がかりになるため撤去。
// env 未設定時は空配列＝誰も承認できないフェイルセーフ（権限を勝手に付与しない）。
const DEFAULT_APPROVAL_ADMIN_USER_IDS: string[] = []

type LineEvent = {
  type?: string
  replyToken?: string
  source?: { type?: string; userId?: string }
  postback?: { data?: string }
  message?: { type?: string; text?: string }
}

/** postback data（LINE 300文字以内）: u_apr=U… / u_rej=U… / r_apr=C… / r_rej=R… */
export function buildUserApprovalPostbackData(
  action: 'approve' | 'reject',
  targetUserId: string,
): string {
  const uid = String(targetUserId ?? '').trim()
  return action === 'approve' ? `u_apr=${uid}` : `u_rej=${uid}`
}

export function buildRoomApprovalPostbackData(
  action: 'approve' | 'reject',
  roomId: string,
): string {
  const rid = String(roomId ?? '').trim()
  return action === 'approve' ? `r_apr=${rid}` : `r_rej=${rid}`
}

const ADMIN_MENU_POSTBACK = {
  idcheck: 'adm_act=idcheck',
  help: 'adm_act=help',
} as const

export const STORE_REG_POSTBACK_CONFIRM = 'reg_act=confirm'

function adminHelpButton(): FlexButtonSpec {
  return {
    label: '使い方',
    style: 'secondary',
    action: { type: 'postback', data: ADMIN_MENU_POSTBACK.help, displayText: '使い方' },
  }
}

function storeRegistrationButton(): FlexButtonSpec {
  return {
    label: '登録確認',
    style: 'primary',
    color: '#1DB446',
    action: { type: 'postback', data: STORE_REG_POSTBACK_CONFIRM, displayText: '登録確認' },
  }
}

function parseAdminMenuPostback(data: string): 'idcheck' | 'help' | null {
  const raw = String(data ?? '').trim()
  if (raw === ADMIN_MENU_POSTBACK.idcheck) return 'idcheck'
  if (raw === ADMIN_MENU_POSTBACK.help) return 'help'
  return null
}

function parseStoreRegistrationPostback(data: string): boolean {
  return String(data ?? '').trim() === STORE_REG_POSTBACK_CONFIRM
}

function isStoreRegistrationText(text: string): boolean {
  return /^(登録確認|ID確認|id確認|id)$/i.test(String(text ?? '').trim())
}

function buildApprovalRequestFlex(params: {
  altText: string
  title: string
  lines: string[]
  approveData: string
  rejectData: string
  approveDisplayText: string
  rejectDisplayText: string
}): Record<string, unknown> {
  return buildFlexInfoCard({
    altText: params.altText,
    title: params.title,
    lines: params.lines,
    footerNote: '下のボタンで許可／不許可できます。',
    buttons: [
      {
        label: '許可',
        style: 'primary',
        color: '#1DB446',
        action: { type: 'postback', data: params.approveData, displayText: params.approveDisplayText },
      },
      {
        label: '不許可',
        action: { type: 'postback', data: params.rejectData, displayText: params.rejectDisplayText },
      },
    ],
  })
}

type PostbackApprovalCommand =
  | { kind: 'user'; action: 'approve' | 'reject'; targetUserId: string }
  | { kind: 'room'; action: 'approve' | 'reject'; roomId: string }

function parseApprovalPostback(data: string): PostbackApprovalCommand | null {
  const raw = String(data ?? '').trim()
  const userApprove = /^u_apr=(U[a-zA-Z0-9]+)$/i.exec(raw)
  if (userApprove) return { kind: 'user', action: 'approve', targetUserId: userApprove[1] }
  const userReject = /^u_rej=(U[a-zA-Z0-9]+)$/i.exec(raw)
  if (userReject) return { kind: 'user', action: 'reject', targetUserId: userReject[1] }
  const roomApprove = /^r_apr=((?:C|R)[a-zA-Z0-9]+)$/i.exec(raw)
  if (roomApprove) return { kind: 'room', action: 'approve', roomId: roomApprove[1] }
  const roomReject = /^r_rej=((?:C|R)[a-zA-Z0-9]+)$/i.exec(raw)
  if (roomReject) return { kind: 'room', action: 'reject', roomId: roomReject[1] }
  return null
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

async function fetchLineBotProfile(
  userId: string,
  channelAccessToken: string,
): Promise<{ displayName: string } | null> {
  const uid = String(userId ?? '').trim()
  if (!uid.startsWith('U') || !channelAccessToken) return null
  try {
    const response = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(uid)}`, {
      headers: { Authorization: `Bearer ${channelAccessToken}` },
    })
    if (!response.ok) return null
    const data = await response.json() as { displayName?: string }
    const displayName = String(data?.displayName ?? '').trim()
    return displayName ? { displayName } : { displayName: '（名称なし）' }
  } catch {
    return null
  }
}

/** 招待グループ（C）／複数人トーク（R） */
export function isInvitedChatRoomId(roomId: string): boolean {
  const id = String(roomId ?? '').trim()
  return id.startsWith('C') || id.startsWith('R')
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
    .select('line_user_id, is_active, assigned_store')
    .eq('line_user_id', uid)
    .maybeSingle()
  if (selErr) {
    console.error(`upsertPendingLineUser select failed (${uid}):`, selErr.message)
    return { created: false, alreadyActive: false }
  }

  if (existing?.line_user_id && (existing as { is_active?: boolean }).is_active === true) {
    return { created: false, alreadyActive: true }
  }

  // 所属店舗(assigned_store)を発言店舗(sourceStoreKey)から自動設定する。
  // admin（承認専用チャネル）は所属店舗にしない。表示名は store_webhook_tables から解決（UIの選択肢と一致）。
  let assignedStoreName: string | null = null
  if (sourceStoreKey && sourceStoreKey !== ADMIN_STORE_PARTITION_KEY) {
    const { data: storeRow } = await supabase
      .from('store_webhook_tables')
      .select('display_name')
      .eq('store_partition_key', sourceStoreKey)
      .maybeSingle()
    const dn = String((storeRow as { display_name?: unknown } | null)?.display_name ?? '').trim()
    if (dn) assignedStoreName = dn
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
    assigned_store: assignedStoreName,
    updated_at: now,
  }

  if (existing?.line_user_id) {
    const updatePayload: Record<string, unknown> = {
      display_name: displayName,
      registration_source_store: sourceStoreKey,
      updated_at: now,
    }
    // 所属店舗は空欄のときだけ自動設定（既存の手動値は尊重）。
    const existingAssigned = String((existing as { assigned_store?: unknown }).assigned_store ?? '').trim()
    if (!existingAssigned && assignedStoreName) {
      updatePayload.assigned_store = assignedStoreName
    }
    const { error: upErr } = await supabase
      .from('line_user_permissions')
      .update(updatePayload)
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
  // 管理者ユーザーへの push は LINE_CHANNEL_ACCESS_TOKEN（デフォルト）を使う。
  // 管理者が友だち追加しているのはデフォルト Bot のため。
  const adminToken = resolveChannelAccessToken('')
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
  const nameLine = displayName || '（未取得）'
  const flex = buildApprovalRequestFlex({
    altText: `新規友だち登録・承認待ち ${displayName || targetUserId}`,
    title: '【新規友だち登録・承認待ち】',
    lines: [
      `店舗Bot: ${label}`,
      `表示名: ${nameLine}`,
      `ユーザーID: ${targetUserId}`,
    ],
    approveData: buildUserApprovalPostbackData('approve', targetUserId),
    rejectData: buildUserApprovalPostbackData('reject', targetUserId),
    approveDisplayText: `許可 ${targetUserId}`,
    rejectDisplayText: `不許可 ${targetUserId}`,
  })

  for (const adminUserId of adminUserIds) {
    const result = await pushLineMessages(adminUserId, [flex], adminToken)
    if (!result.ok) {
      console.error(`notifyApprovalAdmin push failed (${adminUserId}):`, result.error)
    }
  }
}

function buildAdminIdCheckFlex(
  senderId: string,
  profile: { displayName: string } | null,
  isAdmin: boolean,
): Record<string, unknown> {
  return buildFlexInfoCard({
    altText: '管理者情報',
    title: '【管理者情報】',
    lines: [
      `表示名: ${profile?.displayName ?? '（未取得）'}`,
      `ユーザーID: ${senderId}`,
      `承認操作: ${isAdmin ? '利用できます' : '利用できません（運用担当へID登録を依頼してください）'}`,
    ],
    buttons: isAdmin ? [adminHelpButton()] : [],
  })
}

function buildAdminHelpFlex(): Record<string, unknown> {
  return buildFlexInfoCard({
    altText: '承認操作のしかた',
    title: '【承認操作のしかた】',
    lines: [
      '届いた承認待ちカードの「許可」「不許可」ボタンで操作できます。',
      'テキストでも操作できます:',
      '・新規友だち: 許可 U… / 不許可 U…',
      '・グループ等: 許可ルーム C… / 不許可ルーム R…',
    ],
  })
}

function buildAdminResultFlex(message: string, ok: boolean): Record<string, unknown> {
  return buildFlexInfoCard({
    altText: message.slice(0, 40),
    title: ok ? '処理完了' : '処理できませんでした',
    lines: [message],
    buttons: ok ? [] : [adminHelpButton()],
  })
}

function buildAdminNonOperatorFlex(senderId: string): Record<string, unknown> {
  const uid = String(senderId ?? '').trim() || '（取得できませんでした）'
  return buildFlexInfoCard({
    altText: '承認管理者専用',
    title: '【承認管理者専用】',
    lines: [
      'このBotは承認担当者専用です。',
      '操作できない場合は、運用担当に次のユーザーIDの登録を依頼してください。',
      `ユーザーID: ${uid}`,
    ],
  })
}

function buildStoreWelcomeFlex(storeLabel: string): Record<string, unknown> {
  return buildFlexInfoCard({
    altText: '友だち登録ありがとうございます',
    title: '【友だち登録ありがとうございます】',
    lines: [
      `店舗: ${storeLabel}`,
      '利用開始には管理者の承認が必要です。',
      'まず「登録確認」ボタンを押して、表示名を登録してください。',
    ],
    footerNote: '承認が完了するまで、検索・レシートなどの機能は使えません。',
    buttons: [storeRegistrationButton()],
  })
}

function buildStoreRegistrationResultFlex(params: {
  lineUserId: string
  displayName: string | null
  storeLabel: string
  isActive: boolean
}): Record<string, unknown> {
  const name = params.displayName?.trim() || '（未取得）'
  return buildFlexInfoCard({
    altText: '登録確認完了',
    title: params.isActive ? '【登録済み・利用可】' : '【登録確認完了】',
    lines: [
      `店舗: ${params.storeLabel}`,
      `表示名: ${name}`,
      `ユーザーID: ${params.lineUserId}`,
      params.isActive
        ? 'すでに利用許可されています。'
        : '管理者の承認をお待ちください。承認後に機能が使えるようになります。',
    ],
    buttons: [storeRegistrationButton()],
  })
}

function buildStorePermissionPendingFlex(): Record<string, unknown> {
  return buildFlexInfoCard({
    altText: '利用許可待ち',
    title: '【利用許可待ち】',
    lines: [
      '管理者が有効化するまで、検索・レシートなどの機能は使えません。',
      'まだの方は「登録確認」で表示名を登録してください。',
    ],
    buttons: [storeRegistrationButton()],
  })
}

function buildUserApprovedPushFlex(): Record<string, unknown> {
  return buildFlexInfoCard({
    altText: '利用許可が完了しました',
    title: '【利用許可が完了しました】',
    lines: [
      '店舗Botで検索などの機能が使えるようになりました。',
    ],
  })
}

async function performStoreRegistrationConfirm(
  supabase: SupabaseClient,
  lineUserId: string,
  sourceStoreKey: string,
  sourceStoreDisplayName: string,
  storeAccessToken: string,
): Promise<{ displayName: string | null; isActive: boolean }> {
  const displayName = await fetchLineDisplayNameByUserId(lineUserId, lineUserId, storeAccessToken)
  await upsertPendingLineUser(supabase, lineUserId, displayName, sourceStoreKey)
  const gate = await loadLineUserPermissionGate(supabase, lineUserId)
  return { displayName, isActive: gate.isActive }
}

/** 店舗Bot: 登録確認（テキスト／postback）。承認待ちでも処理する */
export async function tryHandleStoreRegistrationInteraction(
  supabase: SupabaseClient,
  event: LineEvent,
  sourceStoreKey: string,
  sourceStoreDisplayName: string,
  storeAccessToken: string,
): Promise<{ handled: boolean; replied: boolean }> {
  const replyToken = String(event.replyToken ?? '').trim()
  const senderId = String(event.source?.userId ?? '').trim()
  if (!replyToken || !senderId.startsWith('U')) {
    return { handled: false, replied: false }
  }

  let shouldConfirm = false
  if (event.type === 'postback') {
    shouldConfirm = parseStoreRegistrationPostback(String(event.postback?.data ?? ''))
  } else if (event.type === 'message' && event.message?.type === 'text') {
    shouldConfirm = isStoreRegistrationText(String(event.message?.text ?? ''))
  }
  if (!shouldConfirm) return { handled: false, replied: false }

  const label = String(sourceStoreDisplayName || sourceStoreKey).trim() || sourceStoreKey
  const { displayName, isActive } = await performStoreRegistrationConfirm(
    supabase,
    senderId,
    sourceStoreKey,
    label,
    storeAccessToken,
  )
  const flex = buildStoreRegistrationResultFlex({
    lineUserId: senderId,
    displayName,
    storeLabel: label,
    isActive,
  })
  const result = await replyLineFlex(replyToken, flex, storeAccessToken)
  return { handled: true, replied: result.ok }
}

export async function handleStoreFollowForUserApproval(
  supabase: SupabaseClient,
  targetUserId: string,
  sourceStoreKey: string,
  sourceStoreDisplayName: string,
  storeAccessToken: string,
  event?: LineEvent,
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

  const replyToken = String(event?.replyToken ?? '').trim()
  if (!replyToken) return
  const label = String(sourceStoreDisplayName || sourceStoreKey).trim() || sourceStoreKey
  const flex = buildStoreWelcomeFlex(label)
  await replyLineFlex(replyToken, flex, storeAccessToken)
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

function resolveAssignedStoreLabelFromPartitionKey(storePartitionKey: string): string | null {
  const normalized = String(storePartitionKey ?? '').trim().toLowerCase()
  if (!normalized) return null
  for (const [key, label] of Object.entries(RECEIPT_SHEETS_STORE_CATALOG)) {
    if (key.toLowerCase() === normalized) {
      return String(label).trim() || null
    }
  }
  return null
}

/** 承認時に店舗Botトークンで表示名を取得（管理画面カード用） */
async function resolveDisplayNameForUserApproval(
  lineUserId: string,
  storePartitionKey: string | null,
  currentDisplayName: string | null,
): Promise<string | null> {
  const existing = String(currentDisplayName ?? '').trim()
  const storeKey = String(storePartitionKey ?? '').trim()
  if (storeKey) {
    const token = resolveChannelAccessToken(storeKey)
    if (token) {
      const fetched = await fetchLineDisplayNameByUserId(lineUserId, lineUserId, token)
      if (fetched) return fetched
    }
  }
  return existing || null
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
    const { data: existing, error: selErr } = await supabase
      .from('line_user_permissions')
      .select('line_user_id, display_name, assigned_store, registration_source_store')
      .eq('line_user_id', uid)
      .maybeSingle()

    if (selErr) {
      return { ok: false, message: `許可前の確認に失敗しました: ${selErr.message}`, notifyStoreKey: null }
    }
    if (!existing?.line_user_id) {
      return {
        ok: false,
        message: `ユーザー ${uid} は未登録です。先に店舗Botへ友だち追加してもらってください。`,
        notifyStoreKey: null,
      }
    }

    const storeKey = String(
      (existing as { registration_source_store?: unknown }).registration_source_store ?? '',
    ).trim() || null
    const displayName = await resolveDisplayNameForUserApproval(
      uid,
      storeKey,
      String((existing as { display_name?: unknown }).display_name ?? ''),
    )
    const currentAssignedStore = String((existing as { assigned_store?: unknown }).assigned_store ?? '').trim()
    const assignedStore = currentAssignedStore
      || resolveAssignedStoreLabelFromPartitionKey(storeKey ?? '')
      || null

    const updateRow: Record<string, unknown> = {
      is_active: true,
      can_message_search: true,
      can_library_search: true,
      can_calendar_create: true,
      can_calendar_update: true,
      can_calendar_view: true,
      can_media_access: true,
      updated_at: now,
    }
    if (displayName) updateRow.display_name = displayName
    if (assignedStore && !currentAssignedStore) updateRow.assigned_store = assignedStore

    const { data, error } = await supabase
      .from('line_user_permissions')
      .update(updateRow)
      .eq('line_user_id', uid)
      .select('line_user_id')
      .maybeSingle()

    if (error) {
      return { ok: false, message: `許可の保存に失敗しました: ${error.message}`, notifyStoreKey: null }
    }
    if (!data?.line_user_id) {
      return { ok: false, message: `許可の保存に失敗しました。`, notifyStoreKey: null }
    }

    const label = displayName || uid
    return { ok: true, message: `許可しました: ${label}`, notifyStoreKey: storeKey }
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

export async function loadRoomBotAccessApproved(
  supabase: SupabaseClient,
  roomId: string,
): Promise<boolean> {
  const rid = String(roomId ?? '').trim()
  if (!isInvitedChatRoomId(rid)) return true

  const { data, error } = await supabase
    .from('room_summary_settings')
    .select('bot_access_approved')
    .eq('room_id', rid)
    .maybeSingle()

  if (error) {
    console.error(`loadRoomBotAccessApproved failed (${rid}):`, error.message)
    return false
  }
  if (!data) return false
  return (data as { bot_access_approved?: boolean }).bot_access_approved === true
}

async function notifyApprovalAdminOfNewRoom(
  supabase: SupabaseClient,
  roomId: string,
  sourceStoreKey: string,
  sourceStoreDisplayName: string,
  storeAccessToken: string,
): Promise<void> {
  const rid = String(roomId ?? '').trim()
  if (!isInvitedChatRoomId(rid)) return

  const { data: settings, error: selErr } = await supabase
    .from('room_summary_settings')
    .select('bot_access_approved, bot_access_notify_sent_at')
    .eq('room_id', rid)
    .maybeSingle()
  if (selErr) {
    console.error(`notifyApprovalAdminOfNewRoom select failed (${rid}):`, selErr.message)
    return
  }
  if ((settings as { bot_access_approved?: boolean } | null)?.bot_access_approved === true) return
  if ((settings as { bot_access_notify_sent_at?: string } | null)?.bot_access_notify_sent_at) return

  // 管理者ユーザーへの push は LINE_CHANNEL_ACCESS_TOKEN（デフォルト）を使う。
  const adminToken = resolveChannelAccessToken('')
  const adminUserIds = resolveApprovalAdminUserIds()
  if (!adminToken || !adminUserIds.length) return

  const roomName = await fetchLineConversationNameByRoomId(rid, storeAccessToken)
  const label = String(sourceStoreDisplayName || sourceStoreKey).trim() || sourceStoreKey
  const roomLabel = roomName ? `ルーム名: ${roomName}` : 'ルーム名: （未取得）'
  const kind = rid.startsWith('C') ? '招待グループ' : '複数人トーク'
  const flex = buildApprovalRequestFlex({
    altText: `${kind}・Bot参加・承認待ち ${roomName || rid}`,
    title: `【${kind}・Bot参加・承認待ち】`,
    lines: [
      `店舗Bot: ${label}`,
      roomLabel,
      `ルームID: ${rid}`,
    ],
    approveData: buildRoomApprovalPostbackData('approve', rid),
    rejectData: buildRoomApprovalPostbackData('reject', rid),
    approveDisplayText: `許可ルーム ${rid}`,
    rejectDisplayText: `不許可ルーム ${rid}`,
  })

  for (const adminUserId of adminUserIds) {
    const result = await pushLineMessages(adminUserId, [flex], adminToken)
    if (!result.ok) {
      console.error(`notifyApprovalAdminOfNewRoom push failed (${adminUserId}):`, result.error)
    }
  }

  const now = new Date().toISOString()
  const { error: upErr } = await supabase
    .from('room_summary_settings')
    .update({ bot_access_notify_sent_at: now, updated_at: now })
    .eq('room_id', rid)
  if (upErr) {
    console.error(`notifyApprovalAdminOfNewRoom mark sent failed (${rid}):`, upErr.message)
  }
}

/** 招待ルームで未承認なら処理を止め、必要なら管理Botへ通知 */
export async function gateInvitedRoomBotAccess(
  supabase: SupabaseClient,
  roomId: string,
  sourceStoreKey: string,
  sourceStoreDisplayName: string,
  storeAccessToken: string,
  event: LineEvent,
): Promise<{ allowed: boolean; replied: boolean }> {
  const rid = String(roomId ?? '').trim()
  if (!isInvitedChatRoomId(rid)) return { allowed: true, replied: false }

  const approved = await loadRoomBotAccessApproved(supabase, rid)
  if (approved) return { allowed: true, replied: false }

  await notifyApprovalAdminOfNewRoom(
    supabase,
    rid,
    sourceStoreKey,
    sourceStoreDisplayName,
    storeAccessToken,
  )

  const replyToken = String(event.replyToken ?? '').trim()
  if (
    replyToken
    && (event.type === 'message' || event.type === 'postback')
  ) {
    const accessToken = resolveChannelAccessToken(sourceStoreKey)
    if (!accessToken) return { allowed: false, replied: false }
    const flex = buildFlexInfoCard({
      altText: 'ルーム承認待ち',
      title: '【ルーム承認待ち】',
      lines: [
        'このルームは管理者の承認待ちです。',
        '承認されるまでBotは機能しません。',
      ],
    })
    const result = await replyLineFlex(replyToken, flex, accessToken)
    return { allowed: false, replied: result.ok }
  }

  return { allowed: false, replied: false }
}

type RoomApprovalCommand = { action: 'approve' | 'reject'; roomId: string }

function parseRoomApprovalCommand(text: string): RoomApprovalCommand | null {
  const raw = String(text ?? '').trim()
  const approve = /^(?:許可ルーム|ルーム許可)\s+((?:C|R)[a-zA-Z0-9]+)$/i.exec(raw)
  if (approve) return { action: 'approve', roomId: approve[1] }
  const reject = /^(?:不許可ルーム|ルーム不許可)\s+((?:C|R)[a-zA-Z0-9]+)$/i.exec(raw)
  if (reject) return { action: 'reject', roomId: reject[1] }
  return null
}

async function applyRoomApproval(
  supabase: SupabaseClient,
  command: RoomApprovalCommand,
): Promise<{ ok: boolean; message: string }> {
  const rid = command.roomId
  const now = new Date().toISOString()

  const { data: existing, error: selErr } = await supabase
    .from('room_summary_settings')
    .select('room_id')
    .eq('room_id', rid)
    .maybeSingle()
  if (selErr) {
    return { ok: false, message: `ルーム確認に失敗しました: ${selErr.message}` }
  }
  if (!existing?.room_id) {
    return {
      ok: false,
      message: `ルーム ${rid} は未登録です。先にそのルームでBotへ何か送ってください。`,
    }
  }

  const approved = command.action === 'approve'
  const { error } = await supabase
    .from('room_summary_settings')
    .update({
      bot_access_approved: approved,
      updated_at: now,
    })
    .eq('room_id', rid)

  if (error) {
    return { ok: false, message: `ルーム許可の保存に失敗しました: ${error.message}` }
  }
  return {
    ok: true,
    message: approved ? `ルームを許可しました: ${rid}` : `ルームを不許可にしました: ${rid}`,
  }
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
  const flex = approved
    ? buildUserApprovedPushFlex()
    : buildFlexInfoCard({
      altText: '利用許可なし',
      title: '【利用許可】',
      lines: ['利用許可は付与されていません。管理者にお問い合わせください。'],
    })
  const result = await pushLineMessages(targetUserId, [flex], token)
  if (!result.ok) {
    console.error(`notifyUserApprovalResult push failed (${targetUserId}):`, result.error)
  }
}

/**
 * ID確認時に取得できた LINE 表示名を line_user_permissions に保存する。
 * 表示名が空のときだけ埋める（手動命名済みの名前は尊重して上書きしない）。
 * 未登録ユーザーは表示名付きの保留行（権限OFF）を作成する。
 */
async function persistDisplayNameFromIdCheck(
  supabase: SupabaseClient,
  lineUserId: string,
  displayName: string | null,
): Promise<void> {
  const uid = String(lineUserId ?? '').trim()
  const name = String(displayName ?? '').trim()
  if (!uid.startsWith('U') || !name || name === '（名称なし）') return

  const now = new Date().toISOString()
  const { data: existing, error: selErr } = await supabase
    .from('line_user_permissions')
    .select('line_user_id, display_name')
    .eq('line_user_id', uid)
    .maybeSingle()
  if (selErr) {
    console.error(`persistDisplayNameFromIdCheck select failed (${uid}):`, selErr.message)
    return
  }

  if (existing?.line_user_id) {
    const current = String((existing as { display_name?: unknown }).display_name ?? '').trim()
    if (current && current !== uid) return // 既に名前あり → 尊重して何もしない
    const { error: upErr } = await supabase
      .from('line_user_permissions')
      .update({ display_name: name, updated_at: now })
      .eq('line_user_id', uid)
    if (upErr) console.error(`persistDisplayNameFromIdCheck update failed (${uid}):`, upErr.message)
    return
  }

  const { error: insErr } = await supabase
    .from('line_user_permissions')
    .insert({
      line_user_id: uid,
      display_name: name,
      is_active: false,
      can_message_search: false,
      can_library_search: false,
      can_calendar_create: false,
      can_calendar_update: false,
      can_calendar_view: false,
      can_media_access: false,
      updated_at: now,
    })
  if (insErr && String(insErr.code) !== '23505') {
    console.error(`persistDisplayNameFromIdCheck insert failed (${uid}):`, insErr.message)
  }
}

async function replyAdminIdCheck(
  supabase: SupabaseClient,
  replyToken: string,
  senderId: string,
  adminToken: string,
): Promise<boolean> {
  const profile = await fetchLineBotProfile(senderId, adminToken)
  // ID確認で取得できた表示名をDBに保存（抜き取り）
  await persistDisplayNameFromIdCheck(supabase, senderId, profile?.displayName ?? null)
  const flex = buildAdminIdCheckFlex(senderId, profile, isApprovalAdminUserId(senderId))
  const result = await replyLineFlex(replyToken, flex, adminToken)
  return result.ok
}

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

    if (event.type !== 'message' && event.type !== 'postback') continue
    if (!replyToken || !senderId) continue

    if (event.type === 'postback') {
      const postbackData = String(event.postback?.data ?? '').trim()
      const menu = parseAdminMenuPostback(postbackData)
      if (menu === 'idcheck') {
        if (await replyAdminIdCheck(supabase, replyToken, senderId, adminToken)) replies += 1
        continue
      }
      if (menu === 'help') {
        const result = await replyLineFlex(replyToken, buildAdminHelpFlex(), adminToken)
        if (result.ok) replies += 1
        continue
      }
      const pb = parseApprovalPostback(postbackData)
      if (pb && isApprovalAdminUserId(senderId)) {
        let message = ''
        let ok = false
        if (pb.kind === 'user') {
          const applied = await applyUserApproval(supabase, {
            action: pb.action,
            targetUserId: pb.targetUserId,
          })
          if (applied.ok && pb.action === 'approve') {
            const storeKey = applied.notifyStoreKey
              ?? await loadRegistrationSourceStore(supabase, pb.targetUserId)
            await notifyUserApprovalResult(pb.targetUserId, true, storeKey)
          }
          message = applied.message
          ok = applied.ok
        } else {
          const applied = await applyRoomApproval(supabase, {
            action: pb.action,
            roomId: pb.roomId,
          })
          message = applied.message
          ok = applied.ok
        }
        const result = await replyLineFlex(replyToken, buildAdminResultFlex(message, ok), adminToken)
        if (result.ok) replies += 1
        else if (message) errors.push(String(result.error || 'reply failed').slice(0, 160))
        continue
      }

      if (!isApprovalAdminUserId(senderId)) {
        const result = await replyLineFlex(replyToken, buildAdminNonOperatorFlex(senderId), adminToken)
        if (result.ok) replies += 1
        continue
      }
      const result = await replyLineFlex(replyToken, buildAdminHelpFlex(), adminToken)
      if (result.ok) replies += 1
      continue
    }

    if (event.message?.type === 'text') {
      const text = String(event.message?.text ?? '').trim()
      if (/^(管理者情報|ID確認|id確認)$/i.test(text)) {
        if (await replyAdminIdCheck(supabase, replyToken, senderId, adminToken)) replies += 1
        continue
      }
      if (/^(使い方|ヘルプ|help)$/i.test(text)) {
        const result = await replyLineFlex(replyToken, buildAdminHelpFlex(), adminToken)
        if (result.ok) replies += 1
        continue
      }
    }

    if (!isApprovalAdminUserId(senderId)) {
      const result = await replyLineFlex(replyToken, buildAdminNonOperatorFlex(senderId), adminToken)
      if (result.ok) replies += 1
      continue
    }

    if (event.message?.type !== 'text') {
      const result = await replyLineFlex(replyToken, buildAdminHelpFlex(), adminToken)
      if (result.ok) replies += 1
      continue
    }

    const text = String(event.message?.text ?? '').trim()
    if (!text) continue

    const roomCommand = parseRoomApprovalCommand(text)
    if (roomCommand) {
      const applied = await applyRoomApproval(supabase, roomCommand)
      const result = await replyLineFlex(
        replyToken,
        buildAdminResultFlex(applied.message, applied.ok),
        adminToken,
      )
      if (result.ok) replies += 1
      else if (applied.message) errors.push(String(result.error || 'reply failed').slice(0, 160))
      continue
    }

    const userCommand = parseApprovalCommand(text)
    if (!userCommand) {
      const result = await replyLineFlex(replyToken, buildAdminHelpFlex(), adminToken)
      if (result.ok) replies += 1
      continue
    }

    const applied = await applyUserApproval(supabase, userCommand)
    if (applied.ok && userCommand.action === 'approve') {
      const storeKey = applied.notifyStoreKey
        ?? await loadRegistrationSourceStore(supabase, userCommand.targetUserId)
      await notifyUserApprovalResult(userCommand.targetUserId, true, storeKey)
    }

    const result = await replyLineFlex(
      replyToken,
      buildAdminResultFlex(applied.message, applied.ok),
      adminToken,
    )
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
  const result = await replyLineFlex(replyToken, buildStorePermissionPendingFlex(), accessToken)
  return result.ok
}
