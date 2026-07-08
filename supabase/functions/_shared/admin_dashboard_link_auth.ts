import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"

const TOKEN_TABLE = "admin_dashboard_auth_tokens"
const LOGIN_LINK_PREFIX = "lrlt_"
const SESSION_PREFIX = "lrst_"
// ルーム・セルフ設定スコープ（store スコープとは排他）。metadata.scope に入れる。
export const ROOM_CONFIG_SCOPE = "room_config"
// ログインリンク(lt)はLINEに平文配信されるため漏えい窓を短く。単一使用(used_at)と併用。
const LOGIN_LINK_TTL_SEC = 24 * 60 * 60
const SESSION_TTL_REMEMBER_SEC = 3 * 24 * 60 * 60
const SESSION_TTL_EPHEMERAL_SEC = 12 * 60 * 60

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
): Promise<{ token: string; expires_at: string }> {
  const token = generateOpaqueToken(LOGIN_LINK_PREFIX)
  const expiresAt = toIsoAfterSeconds(LOGIN_LINK_TTL_SEC)
  await insertAuthTokenRow(supabase, "login_link", token, expiresAt, metadata)
  return { token, expires_at: expiresAt }
}

export async function issueAdminDashboardSessionToken(
  supabase: SupabaseClient,
  options?: { rememberLogin?: boolean; metadata?: Record<string, unknown> },
): Promise<{ token: string; expires_at: string }> {
  const ttlSec = options?.rememberLogin === false
    ? SESSION_TTL_EPHEMERAL_SEC
    : SESSION_TTL_REMEMBER_SEC
  const token = generateOpaqueToken(SESSION_PREFIX)
  const expiresAt = toIsoAfterSeconds(ttlSec)
  await insertAuthTokenRow(supabase, "session", token, expiresAt, options?.metadata)
  return { token, expires_at: expiresAt }
}

export async function exchangeAdminDashboardLoginLinkToken(
  supabase: SupabaseClient,
  rawToken: string,
  options?: { rememberLogin?: boolean; metadata?: Record<string, unknown> },
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
  const mergedMetadata = {
    ...normalizeMetadata(data.metadata),
    ...normalizeMetadata(options?.metadata),
    exchanged_at: nowIso,
  }
  return await issueAdminDashboardSessionToken(supabase, {
    rememberLogin: options?.rememberLogin,
    metadata: mergedMetadata,
  })
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
): Promise<{ ok: boolean; storeScope: string | null; roomScope: string | null; scopeKind: string | null }> {
  const token = String(rawToken ?? "").trim()
  if (!token.startsWith(SESSION_PREFIX)) return { ok: false, storeScope: null, roomScope: null, scopeKind: null }
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
    return { ok: false, storeScope: null, roomScope: null, scopeKind: null }
  }
  if (!data) return { ok: false, storeScope: null, roomScope: null, scopeKind: null }
  // metadata.scope==='room_config' のときは「そのルームだけ」のスコープ（store スコープとは排他）。
  // それ以外で store_partition_key があれば「その店舗だけ」。/auth/session(生admin)由来は両方なし＝全店(null)。
  const meta = normalizeMetadata((data as { metadata?: unknown }).metadata)
  const scopeKind = typeof meta.scope === "string" && meta.scope ? meta.scope : null
  const storeRaw = typeof meta.store_partition_key === "string" ? meta.store_partition_key.trim() : ""
  const roomRaw = typeof meta.room_id === "string" ? meta.room_id.trim() : ""
  if (scopeKind === ROOM_CONFIG_SCOPE) {
    return { ok: true, storeScope: null, roomScope: roomRaw || null, scopeKind }
  }
  return {
    ok: true,
    storeScope: storeRaw || null,
    roomScope: null,
    scopeKind,
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
