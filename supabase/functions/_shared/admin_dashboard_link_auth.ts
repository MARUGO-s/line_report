import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { mtalkUserCanAccessStore, resolveMtalkRoomStoreKey } from "./mtalk_room_settings.ts"

const TOKEN_TABLE = "admin_dashboard_auth_tokens"
const LOGIN_LINK_PREFIX = "lrlt_"
const SESSION_PREFIX = "lrst_"
// ルーム・セルフ設定スコープ（store スコープとは排他）。metadata.scope に入れる。
export const ROOM_CONFIG_SCOPE = "room_config"
// 既発行の旧M-talkメディア閲覧トークンを、期限まで通常の管理APIから遮断するためだけに残す。
export const CHAT_MEDIA_VIEW_SCOPE = "chat_media_view"
// 店舗リンクは用途ごとに分離する。store_partition_key だけの旧リンクは
// admin-api 側で拒否し、別画面・書込APIへの横展開を防ぐ。
export const RESERVATION_CALENDAR_SCOPE = "reservation_calendar"
export const PETTY_CASH_SCOPE = "petty_cash"
export const RECEIPT_ANALYTICS_SCOPE = "receipt_analytics"
export const FOODCOURT_DASHBOARD_SCOPE = "foodcourt_dashboard"
export const FOODCOURT_DAILY_LOG_SCOPE = "foodcourt_daily_log"
export const FOODCOURT_WEEKLY_VIEW_SCOPE = "foodcourt_weekly_view"
export const CHAT_JOURNAL_AI_SCOPE = "chat_journal_ai"

export const STORE_LINK_SCOPES = new Set<string>([
  RESERVATION_CALENDAR_SCOPE,
  PETTY_CASH_SCOPE,
  RECEIPT_ANALYTICS_SCOPE,
  FOODCOURT_DASHBOARD_SCOPE,
  FOODCOURT_DAILY_LOG_SCOPE,
  FOODCOURT_WEEKLY_VIEW_SCOPE,
  CHAT_JOURNAL_AI_SCOPE,
])
// M-talkから開く店舗Botメディア専用の、閲覧のみ・短命セッション。
// ログインリンク(lt)はLINEに平文配信されるため漏えい窓を短く。単一使用(used_at)と併用。
const LOGIN_LINK_TTL_SEC = 24 * 60 * 60
const SESSION_TTL_REMEMBER_SEC = 3 * 24 * 60 * 60
const SESSION_TTL_EPHEMERAL_SEC = 12 * 60 * 60
// 設定変更を伴わない「閲覧専用」リンク（例: フードコート週次レポート）向け。
// 毎週新しいリンクが発行されるため、漏えい時の窓を35日に制限する。
export const REUSABLE_VIEW_LINK_TTL_SEC = 35 * 24 * 60 * 60
const REUSABLE_VIEW_SESSION_TTL_SEC = 30 * 60

function toIsoAfterSeconds(seconds: number): string {
  return new Date(Date.now() + (seconds * 1000)).toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function generateOpaqueToken(prefix: string): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `${prefix}${base64UrlEncode(bytes)}`
}

async function hashToken(value: string): Promise<string> {
  const input = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", input)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

// 定数時間比較（SHA-256 hex 同士の照合用・タイミングで内容を漏らさない）。
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// アクセスパスワードのハッシュ（保存・照合で同一関数を使う）。
export async function hashRoomConfigPassword(password: string): Promise<string> {
  return await hashToken(String(password ?? ""))
}

async function insertAuthTokenRow(
  supabase: SupabaseClient,
  tokenKind: "login_link" | "session",
  rawToken: string,
  expiresAt: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const tokenHash = await hashToken(rawToken)
  const { error } = await supabase
    .from(TOKEN_TABLE)
    .insert({
      token_kind: tokenKind,
      token_hash: tokenHash,
      expires_at: expiresAt,
      metadata: metadata ?? {},
    })
  if (error) {
    throw new Error(`Failed to store ${tokenKind} token: ${error.message}`)
  }
}

export async function issueAdminDashboardLoginLinkToken(
  supabase: SupabaseClient,
  metadata?: Record<string, unknown>,
  options?: { ttlSeconds?: number },
): Promise<{ token: string; expires_at: string }> {
  const token = generateOpaqueToken(LOGIN_LINK_PREFIX)
  const ttlSec = options?.ttlSeconds && options.ttlSeconds > 0 ? options.ttlSeconds : LOGIN_LINK_TTL_SEC
  const expiresAt = toIsoAfterSeconds(ttlSec)
  await insertAuthTokenRow(supabase, "login_link", token, expiresAt, metadata)
  return { token, expires_at: expiresAt }
}

export async function issueAdminDashboardSessionToken(
  supabase: SupabaseClient,
  options?: { rememberLogin?: boolean; metadata?: Record<string, unknown>; ttlSeconds?: number },
): Promise<{ token: string; expires_at: string }> {
  const ttlSec = options?.ttlSeconds && options.ttlSeconds > 0
    ? options.ttlSeconds
    : (options?.rememberLogin === false ? SESSION_TTL_EPHEMERAL_SEC : SESSION_TTL_REMEMBER_SEC)
  const token = generateOpaqueToken(SESSION_PREFIX)
  const expiresAt = toIsoAfterSeconds(ttlSec)
  await insertAuthTokenRow(supabase, "session", token, expiresAt, options?.metadata)
  return { token, expires_at: expiresAt }
}

export async function exchangeAdminDashboardLoginLinkToken(
  supabase: SupabaseClient,
  rawToken: string,
  options?: {
    rememberLogin?: boolean
    metadata?: Record<string, unknown>
    ttlSeconds?: number
    requiredScopes?: readonly string[]
  },
): Promise<{ token: string; expires_at: string }> {
  const token = String(rawToken ?? "").trim()
  if (!token.startsWith(LOGIN_LINK_PREFIX)) {
    throw new Error("Invalid login link token.")
  }
  const tokenHash = await hashToken(token)
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from(TOKEN_TABLE)
    .select("id, metadata")
    .eq("token_kind", "login_link")
    .eq("token_hash", tokenHash)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to exchange login link token: ${error.message}`)
  }
  if (!data) {
    throw new Error("Login link is invalid, already used, or expired.")
  }
  const existingMeta = normalizeMetadata(data.metadata)
  const existingScope = typeof existingMeta.scope === "string" ? existingMeta.scope : ""
  // 交換エンドポイントごとに受理できる用途を固定する。これが無いと、例えば
  // パスワード必須のroom_configリンクを汎用交換APIへ渡して迂回できてしまう。
  if (options?.requiredScopes && !options.requiredScopes.includes(existingScope)) {
    throw new Error("This login link cannot be used on this endpoint.")
  }
  // 設定変更を伴わない閲覧専用リンク（reusable===true。フードコート週次レポート等）は、
  // 単一使用にせず・何度でも・どの端末からでも開けるようにする（used_atを消費しない）。
  const isReusableViewLink = existingMeta.reusable === true
  if (!isReusableViewLink) {
    // 単一使用を原子的に保証: used_at が未設定の行だけを更新し、1行更新できたときのみ続行する
    // （並行交換・再利用での二重発行を防ぐ）。
    const { data: claimed, error: markUsedError } = await supabase
      .from(TOKEN_TABLE)
      .update({ used_at: nowIso })
      .eq("id", data.id)
      .is("used_at", null)
      .select("id")
      .maybeSingle()
    if (markUsedError) {
      throw new Error(`Failed to consume login link token: ${markUsedError.message}`)
    }
    if (!claimed) {
      throw new Error("Login link has already been used.")
    }
  }
  const mergedMetadata = {
    ...normalizeMetadata(options?.metadata),
    // Link metadata is the authority source. Exchange-time metadata is audit/UI
    // context only and must not replace scope, store, room, or user bindings.
    ...existingMeta,
    exchanged_at: nowIso,
  }
  return await issueAdminDashboardSessionToken(supabase, {
    rememberLogin: options?.rememberLogin,
    metadata: mergedMetadata,
    ttlSeconds: isReusableViewLink ? REUSABLE_VIEW_SESSION_TTL_SEC : options?.ttlSeconds,
  })
}

/**
 * Re-check a short-lived M-talk link on every privileged request.
 * Removing the member, stopping M-talk, or revoking Journal AI therefore takes
 * effect immediately instead of waiting for the exchanged session to expire.
 */
export async function validateChatScopedSessionAccess(
  supabase: SupabaseClient,
  metadata: Record<string, unknown>,
  options: { requireJournalAi?: boolean } = {},
): Promise<boolean> {
  const chatUserId = String(metadata.chat_user_id ?? "").trim()
  const groupId = Number(metadata.group_id)
  const storeKey = String(metadata.store_partition_key ?? "").trim()
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(chatUserId) ||
    !Number.isSafeInteger(groupId) ||
    groupId <= 0 ||
    !storeKey
  ) return false

  try {
    const [{ data: access, error: accessError }, { data: member, error: memberError }, { data: group, error: groupError }] =
      await Promise.all([
        supabase
          .from("chat_user_access")
          .select("access_enabled, can_use_journal_ai, restricted_until, deleted_at")
          .eq("user_id", chatUserId)
          .maybeSingle(),
        supabase
          .from("chat_group_members")
          .select("can_view")
          .eq("group_id", groupId)
          .eq("user_id", chatUserId)
          .maybeSingle(),
        supabase
          .from("chat_groups")
          .select("trashed_at")
          .eq("id", groupId)
          .maybeSingle(),
      ])
    if (accessError || memberError || groupError || !access || !member || !group) return false
    const restrictedUntil = access.restricted_until
      ? new Date(String(access.restricted_until)).getTime()
      : 0
    if (
      access.access_enabled !== true ||
      access.deleted_at ||
      (Number.isFinite(restrictedUntil) && restrictedUntil > Date.now()) ||
      member.can_view !== true ||
      group.trashed_at
    ) return false
    if (!await mtalkUserCanAccessStore(supabase, chatUserId, storeKey)) return false
    const currentRoomStore = await resolveMtalkRoomStoreKey(supabase, groupId)
    if (currentRoomStore.ambiguous || currentRoomStore.storeKey !== storeKey) return false
    return options.requireJournalAi !== true || access.can_use_journal_ai === true
  } catch {
    return false
  }
}

// ルーム・セルフ設定リンク(lt)をパスワード検証つきで交換する。
// 誤パスワードでは lt を「消費しない」（リトライ可）。総当たりはレート制限＋単一使用＋24h失効で抑止。
export async function exchangeRoomConfigLoginLink(
  supabase: SupabaseClient,
  rawToken: string,
  password: string,
  options?: { rememberLogin?: boolean; metadata?: Record<string, unknown> },
): Promise<{ token: string; expires_at: string }> {
  const token = String(rawToken ?? "").trim()
  if (!token.startsWith(LOGIN_LINK_PREFIX)) {
    throw new Error("Invalid login link token.")
  }
  const pw = String(password ?? "")
  if (!pw) throw new Error("Password is required.")
  const tokenHash = await hashToken(token)
  const nowIso = new Date().toISOString()
  // 1) lt を「消費せず」peek（未使用・期限内）。
  const { data, error } = await supabase
    .from(TOKEN_TABLE)
    .select("id, metadata")
    .eq("token_kind", "login_link")
    .eq("token_hash", tokenHash)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .maybeSingle()
  if (error) throw new Error(`Failed to read login link token: ${error.message}`)
  if (!data) throw new Error("Login link is invalid, already used, or expired.")
  const meta = normalizeMetadata((data as { metadata?: unknown }).metadata)
  const scope = typeof meta.scope === "string" ? meta.scope : ""
  const roomId = typeof meta.room_id === "string" ? meta.room_id.trim() : ""
  if (scope !== ROOM_CONFIG_SCOPE || !roomId) {
    throw new Error("This link is not a room-config link.")
  }
  // 2) ルーム個別パスワードのハッシュと定数時間照合（不一致なら lt 未消費で 401）。
  const { data: room, error: roomErr } = await supabase
    .from("room_summary_settings")
    .select("room_config_password_hash, room_config_access_enabled")
    .eq("room_id", roomId)
    .maybeSingle()
  if (roomErr) throw new Error(`Failed to load room: ${roomErr.message}`)
  const enabled = !!(room as { room_config_access_enabled?: boolean } | null)?.room_config_access_enabled
  const storedHash = String((room as { room_config_password_hash?: unknown } | null)?.room_config_password_hash ?? "")
  if (!enabled || !storedHash) {
    throw new Error("Room self-config is not enabled.")
  }
  const providedHash = await hashRoomConfigPassword(pw)
  if (!constantTimeEqualHex(providedHash, storedHash)) {
    throw new Error("Invalid password.")
  }
  // 3) パスワード一致 → 原子的に lt を claim（二重交換防止）→ room スコープ session 発行。
  const { data: claimed, error: claimErr } = await supabase
    .from(TOKEN_TABLE)
    .update({ used_at: nowIso })
    .eq("id", (data as { id: unknown }).id)
    .is("used_at", null)
    .select("id")
    .maybeSingle()
  if (claimErr) throw new Error(`Failed to consume login link token: ${claimErr.message}`)
  if (!claimed) throw new Error("Login link has already been used.")
  const mergedMetadata = {
    ...meta,
    ...normalizeMetadata(options?.metadata),
    scope: ROOM_CONFIG_SCOPE,
    room_id: roomId,
    exchanged_at: nowIso,
  }
  return await issueAdminDashboardSessionToken(supabase, {
    rememberLogin: options?.rememberLogin,
    metadata: mergedMetadata,
  })
}

export async function authenticateAdminDashboardSessionToken(
  supabase: SupabaseClient,
  rawToken: string,
): Promise<{
  ok: boolean
  storeScope: string | null
  roomScope: string | null
  scopeKind: string | null
  metadata: Record<string, unknown>
}> {
  const token = String(rawToken ?? "").trim()
  if (!token.startsWith(SESSION_PREFIX)) {
    return { ok: false, storeScope: null, roomScope: null, scopeKind: null, metadata: {} }
  }
  const tokenHash = await hashToken(token)
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from(TOKEN_TABLE)
    .select("id, metadata")
    .eq("token_kind", "session")
    .eq("token_hash", tokenHash)
    .gt("expires_at", nowIso)
    .maybeSingle()
  if (error) {
    console.error("authenticateAdminDashboardSessionToken failed:", error.message)
    return { ok: false, storeScope: null, roomScope: null, scopeKind: null, metadata: {} }
  }
  if (!data) return { ok: false, storeScope: null, roomScope: null, scopeKind: null, metadata: {} }
  // metadata.scope==='room_config' のときは「そのルームだけ」のスコープ（store スコープとは排他）。
  // それ以外で store_partition_key があれば「その店舗だけ」。/auth/session(生admin)由来は両方なし＝全店(null)。
  const meta = normalizeMetadata((data as { metadata?: unknown }).metadata)
  const scopeKind = typeof meta.scope === "string" && meta.scope ? meta.scope : null
  const storeRaw = typeof meta.store_partition_key === "string" ? meta.store_partition_key.trim() : ""
  const roomRaw = typeof meta.room_id === "string" ? meta.room_id.trim() : ""
  if (scopeKind === ROOM_CONFIG_SCOPE) {
    return { ok: true, storeScope: null, roomScope: roomRaw || null, scopeKind, metadata: meta }
  }
  if (scopeKind === CHAT_MEDIA_VIEW_SCOPE) {
    return { ok: true, storeScope: storeRaw || null, roomScope: roomRaw || null, scopeKind, metadata: meta }
  }
  return {
    ok: true,
    storeScope: storeRaw || null,
    roomScope: null,
    scopeKind,
    metadata: meta,
  }
}

export async function revokeAdminDashboardSessionToken(
  supabase: SupabaseClient,
  rawToken: string,
): Promise<boolean> {
  const token = String(rawToken ?? "").trim()
  if (!token.startsWith(SESSION_PREFIX)) return false
  const tokenHash = await hashToken(token)
  const { error, count } = await supabase
    .from(TOKEN_TABLE)
    .delete({ count: "exact" })
    .eq("token_kind", "session")
    .eq("token_hash", tokenHash)
  if (error) {
    throw new Error(`Failed to revoke session token: ${error.message}`)
  }
  return Number(count ?? 0) > 0
}

export async function revokeAllAdminDashboardAuthTokens(
  supabase: SupabaseClient,
): Promise<void> {
  const { error } = await supabase
    .from(TOKEN_TABLE)
    .delete()
    .in("token_kind", ["login_link", "session"])
  if (error) {
    throw new Error(`Failed to revoke dashboard auth tokens: ${error.message}`)
  }
}
