export const MTALK_ADMIN_SCOPE = "mtalk_admin"

export const CHAT_ADMIN_CAPABILITIES = [
  "view",
  "audit_read",
  "manage_members",
  "manage_rooms",
  "manage_bots",
  "manage_templates",
  "manage_users",
  "revert_audit",
] as const

export type ChatAdminCapability = typeof CHAT_ADMIN_CAPABILITIES[number]
export type ChatAdminScopeMode = "all" | "stores" | "rooms"

export type ChatAdminAuthority = {
  isFullAdmin: boolean
  delegationId: string | null
  label: string
  scopeMode: ChatAdminScopeMode
  storeKeys: string[]
  roomIds: number[]
  capabilities: ChatAdminCapability[]
  expiresAt: string | null
}

type DbClient = {
  from: (table: string) => any
}

type DelegationRow = {
  id?: unknown
  label?: unknown
  enabled?: unknown
  scope_mode?: unknown
  store_keys?: unknown
  room_ids?: unknown
  capabilities?: unknown
  expires_at?: unknown
  session_version?: unknown
}

const CAPABILITY_SET = new Set<string>(CHAT_ADMIN_CAPABILITIES)

function uniqueStrings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, max)
}

function uniqueRoomIds(value: unknown, max: number): number[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(Number).filter((item) => Number.isSafeInteger(item) && item > 0))].slice(0, max)
}

function normalizeCapabilities(value: unknown): ChatAdminCapability[] {
  return uniqueStrings(value, CHAT_ADMIN_CAPABILITIES.length)
    .filter((item): item is ChatAdminCapability => CAPABILITY_SET.has(item))
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function headquartersChatAdminAuthority(): ChatAdminAuthority {
  return {
    isFullAdmin: true,
    delegationId: null,
    label: "本部",
    scopeMode: "all",
    storeKeys: [],
    roomIds: [],
    capabilities: [...CHAT_ADMIN_CAPABILITIES],
    expiresAt: null,
  }
}

export async function loadMtalkAdminAuthority(
  supabase: DbClient,
  metadata: Record<string, unknown>,
): Promise<{ ok: true; authority: ChatAdminAuthority } | { ok: false; message: string }> {
  const delegationId = String(metadata.chat_admin_delegation_id ?? "").trim().toLowerCase()
  if (!isUuid(delegationId)) {
    return { ok: false, message: "M-talk管理権限が無効です。" }
  }
  const { data, error } = await supabase
    .from("chat_admin_delegations")
    .select("id, label, enabled, scope_mode, store_keys, room_ids, capabilities, expires_at, session_version")
    .eq("id", delegationId)
    .maybeSingle()
  if (error) {
    console.error("loadMtalkAdminAuthority failed:", error.message)
    return { ok: false, message: "M-talk管理権限を確認できませんでした。" }
  }
  const row = (data ?? null) as DelegationRow | null
  if (!row || row.enabled !== true) {
    return { ok: false, message: "M-talk管理権限は停止されています。" }
  }
  const sessionVersion = Number(metadata.chat_admin_delegation_version)
  const currentVersion = Number(row.session_version)
  if (
    !Number.isSafeInteger(sessionVersion) || sessionVersion <= 0 ||
    !Number.isSafeInteger(currentVersion) || currentVersion <= 0 ||
    sessionVersion !== currentVersion
  ) {
    return { ok: false, message: "M-talk管理権限が変更されました。新しいログインリンクを使用してください。" }
  }
  const expiresAt = row.expires_at ? String(row.expires_at) : null
  if (expiresAt && (!Number.isFinite(new Date(expiresAt).getTime()) || new Date(expiresAt).getTime() <= Date.now())) {
    return { ok: false, message: "M-talk管理権限の有効期限が切れています。" }
  }
  const scopeMode = String(row.scope_mode ?? "") as ChatAdminScopeMode
  const storeKeys = uniqueStrings(row.store_keys, 50)
  const roomIds = uniqueRoomIds(row.room_ids, 500)
  const capabilities = normalizeCapabilities(row.capabilities)
  const scopeValid = scopeMode === "all"
    ? storeKeys.length === 0 && roomIds.length === 0
    : scopeMode === "stores"
    ? storeKeys.length > 0 && roomIds.length === 0
    : scopeMode === "rooms" && roomIds.length > 0 && storeKeys.length === 0
  if (!scopeValid || !capabilities.includes("view")) {
    return { ok: false, message: "M-talk管理権限の設定が不正です。" }
  }
  return {
    ok: true,
    authority: {
      isFullAdmin: false,
      delegationId,
      label: String(row.label ?? "").trim().slice(0, 80) || "M-talk委任管理者",
      scopeMode,
      storeKeys,
      roomIds,
      capabilities,
      expiresAt,
    },
  }
}

export function hasChatAdminCapability(
  authority: ChatAdminAuthority,
  capability: ChatAdminCapability,
): boolean {
  return authority.capabilities.includes(capability)
}

export function chatAdminAllowsRoom(
  authority: ChatAdminAuthority,
  room: { id?: unknown; store_key?: unknown },
): boolean {
  if (authority.scopeMode === "all") return true
  if (authority.scopeMode === "stores") {
    const storeKey = String(room.store_key ?? "").trim()
    return !!storeKey && authority.storeKeys.includes(storeKey)
  }
  const roomId = Number(room.id)
  return Number.isSafeInteger(roomId) && authority.roomIds.includes(roomId)
}

export function chatAdminAllowsUser(
  authority: ChatAdminAuthority,
  user: { id?: unknown; is_bot?: unknown; store_key?: unknown },
  userStoreKeys: string[],
  memberRoomIds: number[],
): boolean {
  if (authority.scopeMode === "all") return true
  if (authority.scopeMode === "stores") {
    const botStore = user.is_bot === true ? String(user.store_key ?? "").trim() : ""
    return (!!botStore && authority.storeKeys.includes(botStore))
      || userStoreKeys.some((key) => authority.storeKeys.includes(key))
  }
  return memberRoomIds.some((id) => authority.roomIds.includes(id))
}

export function chatAdminAllowsAudit(
  authority: ChatAdminAuthority,
  audit: { group_id?: unknown; action?: unknown },
  roomById: Map<number, { id?: unknown; store_key?: unknown }>,
): boolean {
  if (!hasChatAdminCapability(authority, "audit_read")) return false
  if (!authority.isFullAdmin && String(audit.action ?? "").startsWith("delegation_")) return false
  if (authority.scopeMode === "all") return true
  const groupId = Number(audit.group_id)
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return false
  const room = roomById.get(groupId)
  return !!room && chatAdminAllowsRoom(authority, room)
}

export function publicChatAdminAuthority(authority: ChatAdminAuthority): Record<string, unknown> {
  return {
    is_full_admin: authority.isFullAdmin,
    delegation_id: authority.delegationId,
    label: authority.label,
    scope_mode: authority.scopeMode,
    store_keys: authority.storeKeys,
    room_ids: authority.roomIds,
    capabilities: authority.capabilities,
    expires_at: authority.expiresAt,
  }
}
