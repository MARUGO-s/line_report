import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"

const TOKEN_TABLE = "admin_dashboard_auth_tokens"
const LOGIN_LINK_PREFIX = "lrlt_"
const SESSION_PREFIX = "lrst_"
const LOGIN_LINK_TTL_SEC = 10 * 60
const SESSION_TTL_REMEMBER_SEC = 30 * 24 * 60 * 60
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
    .update({ used_at: nowIso })
    .eq("token_kind", "login_link")
    .eq("token_hash", tokenHash)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .select("metadata")
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to exchange login link token: ${error.message}`)
  }
  if (!data) {
    throw new Error("Login link is invalid, expired, or already used.")
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

export async function authenticateAdminDashboardSessionToken(
  supabase: SupabaseClient,
  rawToken: string,
): Promise<boolean> {
  const token = String(rawToken ?? "").trim()
  if (!token.startsWith(SESSION_PREFIX)) return false
  const tokenHash = await hashToken(token)
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from(TOKEN_TABLE)
    .select("id")
    .eq("token_kind", "session")
    .eq("token_hash", tokenHash)
    .gt("expires_at", nowIso)
    .maybeSingle()
  if (error) {
    console.error("authenticateAdminDashboardSessionToken failed:", error.message)
    return false
  }
  return !!data
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
