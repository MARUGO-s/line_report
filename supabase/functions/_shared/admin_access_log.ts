export const ADMIN_ACCESS_HISTORY_KEEP = 50

export type AdminAccessClassification = {
  skip: boolean
  eventKind: "login" | "page_view" | "action"
  action: string
  page: string
}

const SKIP_GET_PREFIXES = [
  "/access/events",
  "/state",
  "/weather/",
  "/analytics/holidays",
  "/reservations/search",
  "/reservations/customer-suggest",
  "/pos-journals/product-search",
  "/pos-journals/ai-history",
  "/foodcourt/qa-history",
]

const READ_PATHS = new Set([
  "/pos-journals",
  "/receipts/sales",
  "/foodcourt/reports",
  "/reservations/calendar",
  "/petty-cash",
  "/media",
  "/message-search",
])

export function classifyAdminAccess(
  method: string,
  path: string,
): AdminAccessClassification {
  const verb = String(method || "GET").toUpperCase()
  const apiPath = String(path || "")
  const page = pageFromApiPath(apiPath)

  if (apiPath === "/access/events") {
    return { skip: true, eventKind: "action", action: "access_log", page }
  }
  if (apiPath === "/auth/verify") {
    return { skip: true, eventKind: "action", action: "verify", page }
  }
  if (apiPath === "/auth/session" || apiPath === "/auth/link-login" ||
    apiPath === "/auth/room-config-login") {
    return { skip: false, eventKind: "login", action: "login", page: "admin" }
  }
  if (apiPath === "/auth/logout") {
    return { skip: false, eventKind: "action", action: "logout", page: "admin" }
  }
  if (verb === "GET" && SKIP_GET_PREFIXES.some((prefix) => apiPath.startsWith(prefix))) {
    return { skip: true, eventKind: "action", action: "read", page }
  }
  if (verb === "GET" && /download/i.test(apiPath)) {
    return { skip: false, eventKind: "action", action: "download", page }
  }
  if (verb === "GET") {
    if (READ_PATHS.has(apiPath)) {
      return { skip: false, eventKind: "action", action: "read", page }
    }
    return { skip: true, eventKind: "action", action: "read", page }
  }
  if (/upload|import/i.test(apiPath)) {
    return { skip: false, eventKind: "action", action: "upload", page }
  }
  if (verb === "DELETE" || /\/file$|\/item$|delete/i.test(apiPath)) {
    return { skip: false, eventKind: "action", action: "delete", page }
  }
  if (/ai-|\/ask$|analyze|generate-insight|cohort-compare/i.test(apiPath)) {
    return { skip: false, eventKind: "action", action: "ai", page }
  }
  return { skip: false, eventKind: "action", action: "save", page }
}

export function pageFromApiPath(path: string): string {
  if (path.startsWith("/pos-journals")) return "pos-journal"
  if (path.startsWith("/receipts") || path.startsWith("/analytics")) return "analytics"
  if (path.startsWith("/foodcourt")) return "foodcourt"
  if (path.startsWith("/reservations")) return "reservation"
  if (path.startsWith("/petty-cash")) return "petty-cash"
  if (path.startsWith("/auth")) return "admin"
  return "admin"
}

export function actorFromAuth(auth: {
  storeScope?: string | null
  scopeKind?: string | null
  lineUserId?: string | null
  actorLabel?: string | null
}): { actorKind: string; actorLabel: string; lineUserId: string | null } {
  const lineUserId = String(auth.lineUserId || "").trim() || null
  if (lineUserId) {
    return {
      actorKind: "line_session",
      actorLabel: String(auth.actorLabel || "").trim() || lineUserId,
      lineUserId,
    }
  }
  const store = String(auth.storeScope || "").trim()
  if (store) {
    return {
      actorKind: "store_link",
      actorLabel: String(auth.actorLabel || "").trim() || store,
      lineUserId: null,
    }
  }
  return {
    actorKind: "admin_token",
    actorLabel: String(auth.actorLabel || "").trim() || "本部",
    lineUserId: null,
  }
}

export type AdminAccessInsert = {
  eventKind: string
  action: string
  page?: string | null
  method?: string | null
  apiPath?: string | null
  storeKey?: string | null
  actorKind: string
  actorLabel: string
  lineUserId?: string | null
  ip?: string | null
  userAgent?: string | null
  detail?: Record<string, unknown>
}

export async function insertAdminAccessEvent(
  supabase: { from: (table: string) => any },
  event: AdminAccessInsert,
): Promise<void> {
  const { error } = await supabase.from("admin_access_events").insert({
    event_kind: String(event.eventKind || "action").slice(0, 40),
    action: String(event.action || "save").slice(0, 40),
    page: event.page ? String(event.page).slice(0, 80) : null,
    method: event.method ? String(event.method).slice(0, 12) : null,
    api_path: event.apiPath ? String(event.apiPath).slice(0, 240) : null,
    store_partition_key: event.storeKey ? String(event.storeKey).slice(0, 80) : null,
    actor_kind: String(event.actorKind || "admin_token").slice(0, 40),
    actor_label: String(event.actorLabel || "本部").slice(0, 120),
    line_user_id: event.lineUserId ? String(event.lineUserId).slice(0, 80) : null,
    ip: event.ip ? String(event.ip).slice(0, 80) : null,
    user_agent: event.userAgent ? String(event.userAgent).slice(0, 240) : null,
    detail: event.detail && typeof event.detail === "object" ? event.detail : {},
  })
  if (error) {
    console.error("admin_access_events insert failed:", error.message)
    return
  }
  await pruneAdminAccessEvents(supabase)
}

export async function pruneAdminAccessEvents(
  supabase: { from: (table: string) => any },
): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("admin_access_events")
      .select("id")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(ADMIN_ACCESS_HISTORY_KEEP, ADMIN_ACCESS_HISTORY_KEEP + 499)
    if (error) {
      console.error("admin_access_events prune select failed:", error.message)
      return
    }
    const ids = (Array.isArray(data) ? data : [])
      .map((row) => Number((row as { id?: unknown }).id))
      .filter((id) => Number.isSafeInteger(id) && id > 0)
    if (!ids.length) return
    const { error: deleteError } = await supabase
      .from("admin_access_events")
      .delete()
      .in("id", ids)
    if (deleteError) {
      console.error("admin_access_events prune delete failed:", deleteError.message)
    }
  } catch (error) {
    console.error(
      "admin_access_events prune threw:",
      error instanceof Error ? error.message : String(error),
    )
  }
}
