import {
  chatAdminAllowsAudit,
  chatAdminAllowsRoom,
  chatAdminAllowsUser,
  hasChatAdminCapability,
  headquartersChatAdminAuthority,
  loadMtalkAdminAuthority,
  type ChatAdminAuthority,
} from "../supabase/functions/_shared/chat_admin_delegation.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function delegated(overrides: Partial<ChatAdminAuthority>): ChatAdminAuthority {
  return {
    isFullAdmin: false,
    delegationId: "11111111-1111-4111-8111-111111111111",
    label: "委任テスト",
    scopeMode: "rooms",
    storeKeys: [],
    roomIds: [10],
    capabilities: ["view", "audit_read", "manage_members"],
    expiresAt: null,
    ...overrides,
  }
}

Deno.test("headquarters authority stays inside M-talk but has every M-talk capability", () => {
  const authority = headquartersChatAdminAuthority()
  assert(authority.isFullAdmin, "headquarters must be full admin")
  for (const capability of [
    "view",
    "audit_read",
    "manage_members",
    "manage_rooms",
    "manage_bots",
    "manage_templates",
    "manage_users",
    "revert_audit",
  ] as const) {
    assert(hasChatAdminCapability(authority, capability), `missing ${capability}`)
  }
})

Deno.test("store scope only exposes matching store rooms, affiliated users, and store bots", () => {
  const authority = delegated({ scopeMode: "stores", storeKeys: ["bistrocavacava"], roomIds: [] })
  assert(chatAdminAllowsRoom(authority, { id: 10, store_key: "bistrocavacava" }), "matching room denied")
  assert(!chatAdminAllowsRoom(authority, { id: 11, store_key: "marugo" }), "other store room leaked")
  assert(!chatAdminAllowsRoom(authority, { id: 12, store_key: null }), "unscoped room leaked")
  assert(
    chatAdminAllowsUser(authority, { id: "u1", is_bot: false }, ["bistrocavacava"], []),
    "affiliated user denied",
  )
  assert(
    !chatAdminAllowsUser(authority, { id: "u2", is_bot: false }, ["marugo"], [10]),
    "other-store user leaked through room membership",
  )
  assert(
    chatAdminAllowsUser(authority, { id: "b1", is_bot: true, store_key: "bistrocavacava" }, [], []),
    "matching store bot denied",
  )
  assert(
    !chatAdminAllowsUser(authority, { id: "b2", is_bot: true, store_key: "marugo" }, [], []),
    "other store bot leaked",
  )
})

Deno.test("room scope and audit scope never expand beyond explicit room ids", () => {
  const authority = delegated({ roomIds: [10, 20] })
  assert(chatAdminAllowsRoom(authority, { id: 10, store_key: "marugo" }), "explicit room denied")
  assert(!chatAdminAllowsRoom(authority, { id: 11, store_key: "marugo" }), "same-store unlisted room leaked")
  assert(chatAdminAllowsUser(authority, { id: "u1" }, [], [20]), "member of explicit room denied")
  assert(!chatAdminAllowsUser(authority, { id: "u2" }, [], [11]), "member of other room leaked")
  const rooms = new Map<number, { id: number; store_key: string }>([
    [10, { id: 10, store_key: "marugo" }],
    [11, { id: 11, store_key: "marugo" }],
  ])
  assert(chatAdminAllowsAudit(authority, { group_id: 10 }, rooms), "scoped audit denied")
  assert(!chatAdminAllowsAudit(authority, { group_id: 11 }, rooms), "other-room audit leaked")
  assert(!chatAdminAllowsAudit(authority, { group_id: null }, rooms), "global audit leaked")
})

Deno.test("delegates never receive headquarters delegation audit records", () => {
  const authority = delegated({ scopeMode: "all", roomIds: [], capabilities: ["view", "audit_read"] })
  const rooms = new Map<number, { id: number; store_key: string }>()
  assert(
    !chatAdminAllowsAudit(authority, { action: "delegation_update", group_id: null }, rooms),
    "headquarters delegation audit leaked",
  )
  assert(
    chatAdminAllowsAudit(authority, { action: "user_access_update", group_id: null }, rooms),
    "M-talk-wide user audit was unexpectedly hidden",
  )
})

Deno.test("audit-only capability cannot become writable through scope helpers", () => {
  const authority = delegated({ capabilities: ["view", "audit_read"] })
  assert(hasChatAdminCapability(authority, "audit_read"), "audit read missing")
  assert(!hasChatAdminCapability(authority, "manage_members"), "member write unexpectedly granted")
  assert(!hasChatAdminCapability(authority, "manage_users"), "global user write unexpectedly granted")
})

Deno.test("permission changes permanently invalidate older delegated sessions", async () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    label: "委任テスト",
    enabled: true,
    scope_mode: "stores",
    store_keys: ["bistrocavacava"],
    room_ids: [],
    capabilities: ["view"],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    session_version: 4,
  }
  const query: Record<string, unknown> = {}
  query.select = () => query
  query.eq = () => query
  query.maybeSingle = async () => ({ data: row, error: null })
  const db = { from: () => query } as never
  const current = await loadMtalkAdminAuthority(db, {
    chat_admin_delegation_id: row.id,
    chat_admin_delegation_version: 4,
  })
  assert(current.ok, "current session generation was rejected")
  const stale = await loadMtalkAdminAuthority(db, {
    chat_admin_delegation_id: row.id,
    chat_admin_delegation_version: 3,
  })
  assert(!stale.ok, "stale session generation was accepted")
})
