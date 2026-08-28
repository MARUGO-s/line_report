import {
  exchangeAdminDashboardLoginLinkToken,
  RESERVATION_CALENDAR_SCOPE,
  ROOM_CONFIG_SCOPE,
  validateChatScopedSessionAccess,
} from "../supabase/functions/_shared/admin_dashboard_link_auth.ts"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test("login-link scope is checked before consumption and cannot be overwritten", async () => {
  const state = {
    metadata: { scope: ROOM_CONFIG_SCOPE, room_id: "room-1" } as Record<string, unknown>,
    updates: 0,
    inserts: [] as Array<Record<string, unknown>>,
  }
  const client = {
    from() {
      let operation = "read"
      const chain: Record<string, unknown> = {}
      for (const method of ["select", "eq", "is", "gt"]) {
        chain[method] = () => chain
      }
      chain.update = () => {
        operation = "update"
        state.updates += 1
        return chain
      }
      chain.insert = async (row: Record<string, unknown>) => {
        state.inserts.push(row)
        return { error: null }
      }
      chain.maybeSingle = async () => operation === "update"
        ? { data: { id: 1 }, error: null }
        : { data: { id: 1, metadata: state.metadata }, error: null }
      return chain
    },
  }

  let rejected = false
  try {
    await exchangeAdminDashboardLoginLinkToken(
      client as never,
      "lrlt_scope-test",
      { requiredScopes: [RESERVATION_CALENDAR_SCOPE] },
    )
  } catch (error) {
    rejected = error instanceof Error && /cannot be used/.test(error.message)
  }
  assert(rejected, "a room-config link must be rejected by a reservation endpoint")
  assert(state.updates === 0, "wrong-endpoint links must not be consumed")
  assert(state.inserts.length === 0, "wrong-endpoint links must not issue sessions")

  state.metadata = {
    scope: RESERVATION_CALENDAR_SCOPE,
    store_partition_key: "marugo",
  }
  await exchangeAdminDashboardLoginLinkToken(
    client as never,
    "lrlt_scope-test",
    {
      requiredScopes: [RESERVATION_CALENDAR_SCOPE],
      metadata: { scope: ROOM_CONFIG_SCOPE, store_partition_key: "other" },
    },
  )
  assert(state.updates === 1, "a correctly scoped one-time link must be consumed once")
  assert(state.inserts.length === 1, "a correctly scoped link must issue one session")
  const insertedMetadata = state.inserts[0]?.metadata as Record<string, unknown>
  assert(insertedMetadata.scope === RESERVATION_CALENDAR_SCOPE, "exchange metadata must not replace link scope")
  assert(insertedMetadata.store_partition_key === "marugo", "exchange metadata must not replace store scope")
})

Deno.test("M-talk scoped sessions are revoked immediately with user or membership access", async () => {
  const rows: Record<string, Record<string, unknown> | null> = {
    chat_user_access: {
      access_enabled: true,
      signup_status: "approved",
      can_use_journal_ai: true,
      restricted_until: null,
      deleted_at: null,
    },
    chat_group_members: { can_view: true },
    chat_groups: {
      trashed_at: null,
      group_name: "store bot room",
      store_key: null,
      is_store_room: false,
    },
    chat_user_stores: { store_key: "marugo" },
  }
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      for (const method of ["select", "eq", "in"]) chain[method] = () => chain
      chain.maybeSingle = async () => ({ data: rows[table] ?? null, error: null })
      chain.then = (resolve: (value: unknown) => unknown) => {
        const data = table === "chat_group_members"
          ? [
            { user_id: "11111111-1111-4111-8111-111111111111" },
            { user_id: "22222222-2222-4222-8222-222222222222" },
          ]
          : table === "chat_users"
          ? [{
            id: "22222222-2222-4222-8222-222222222222",
            is_bot: true,
            store_key: "marugo",
            bot_deleted_at: null,
          }]
          : []
        return resolve({ data, error: null })
      }
      return chain
    },
  }
  const metadata = {
    chat_user_id: "11111111-1111-4111-8111-111111111111",
    group_id: "42",
    store_partition_key: "marugo",
  }
  assert(
    await validateChatScopedSessionAccess(client as never, metadata, { requireJournalAi: true }),
    "active members with explicit Journal AI permission must be accepted",
  )
  rows.chat_user_access = { ...rows.chat_user_access, can_use_journal_ai: false }
  assert(
    !await validateChatScopedSessionAccess(client as never, metadata, { requireJournalAi: true }),
    "revoking Journal AI permission must invalidate an existing session",
  )
  rows.chat_user_access = { ...rows.chat_user_access, can_use_journal_ai: true }
  rows.chat_user_stores = null
  assert(
    !await validateChatScopedSessionAccess(client as never, metadata, { requireJournalAi: true }),
    "removing the approved store must invalidate an existing scoped session",
  )
  rows.chat_user_stores = { store_key: "marugo" }
  rows.chat_group_members = { can_view: false }
  assert(
    !await validateChatScopedSessionAccess(client as never, metadata),
    "removing room view access must invalidate an existing media session",
  )
})
