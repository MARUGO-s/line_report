import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const root = new URL("..", import.meta.url)
const read = (path) => readFile(new URL(path, root), "utf8")

test("delegation schema is service-role only and constrains scope plus capabilities", async () => {
  const sql = await read("supabase/migrations/20260910010000_chat_delegated_admin.sql")
  assert.match(sql, /create table if not exists public\.chat_admin_delegations/i)
  assert.match(sql, /scope_mode in \('all', 'stores', 'rooms'\)/i)
  assert.match(sql, /scope_mode = 'all'[\s\S]*cardinality\(store_keys\) = 0[\s\S]*cardinality\(room_ids\) = 0/i)
  assert.match(sql, /'manage_users' = any\(capabilities\)[\s\S]*scope_mode = 'all'/i)
  assert.match(sql, /'manage_bots' = any\(capabilities\)[\s\S]*scope_mode in \('all', 'stores'\)/i)
  assert.match(sql, /'revert_audit' = any\(capabilities\)[\s\S]*'audit_read' = any\(capabilities\)/i)
  assert.match(sql, /a\.action in \('user_access_update', 'user_remove'\)[\s\S]*'manage_users' = any\(d\.capabilities\)/i)
  assert.match(sql, /a\.action in \('member_permissions_update', 'member_remove'\)[\s\S]*'manage_members' = any\(d\.capabilities\)/i)
  assert.match(sql, /alter table public\.chat_admin_delegations enable row level security/i)
  assert.match(sql, /expires_at timestamptz not null default \(now\(\) \+ interval '30 days'\)/i)
  assert.match(sql, /session_version bigint not null default 1/i)
  assert.match(sql, /session_version > 0/i)
  assert.match(sql, /create trigger chat_admin_delegations_bump_session_version/i)
  assert.match(sql, /new\.session_version := old\.session_version \+ 1/i)
  assert.match(sql, /revoke all on table public\.chat_admin_delegations from public, anon, authenticated/i)
  assert.match(sql, /grant select, insert, update, delete on table public\.chat_admin_delegations to service_role/i)
  assert.doesNotMatch(sql, /grant\s+(?:select|insert|update|delete|all)[^;]*chat_admin_delegations[^;]*to\s+(?:anon|authenticated)/i)

  for (const signature of [
    "chat_admin_delegation_allows_room\\(uuid, bigint, text\\)",
    "chat_admin_delegation_allows_user_read\\(uuid, uuid\\)",
    "chat_admin_delegation_allows_user_global\\(uuid, uuid, text\\)",
    "chat_admin_delegation_allows_bot\\(uuid, uuid, text\\)",
    "chat_admin_delegation_allows_audit\\(uuid, bigint, text\\)",
    "chat_admin_delegated_execute\\(uuid, text, jsonb, text\\)",
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${signature}\\s+from public, anon, authenticated`, "i"))
    assert.match(sql, new RegExp(`grant execute on function public\\.${signature}\\s+to service_role`, "i"))
  }
  assert.match(sql, /security definer\s+set search_path = public/gi)
})

test("delegated session is reloaded from DB and fenced from every non-M-talk admin API", async () => {
  const [auth, authority, api] = await Promise.all([
    read("supabase/functions/_shared/admin_dashboard_link_auth.ts"),
    read("supabase/functions/_shared/chat_admin_delegation.ts"),
    read("supabase/functions/admin-api/index.ts"),
  ])
  assert.match(auth, /metadata:\s*Record<string, unknown>/)
  assert.match(auth, /metadata:\s*meta/)
  assert.match(authority, /\.from\("chat_admin_delegations"\)/)
  assert.match(authority, /row\.enabled !== true/)
  assert.match(authority, /chat_admin_delegation_version/)
  assert.match(authority, /sessionVersion !== currentVersion/)
  assert.match(authority, /new Date\(expiresAt\)\.getTime\(\) <= Date\.now\(\)/)
  assert.match(api, /session\.scopeKind === MTALK_ADMIN_SCOPE[\s\S]*loadMtalkAdminAuthority\(supabase, session\.metadata\)/)
  assert.match(api, /session\.scopeKind !== null[\s\S]{0,180}session\.scopeKind !== ROOM_CONFIG_SCOPE[\s\S]{0,180}!STORE_LINK_SCOPES\.has\(session\.scopeKind\)[\s\S]*この管理スコープは利用できません/)
  assert.match(api, /authResult\.scopeKind === MTALK_ADMIN_SCOPE[\s\S]*path !== "\/auth\/logout"[\s\S]*!path\.startsWith\("\/chat-admin\/"\)[\s\S]*403/)
  const storePaths = api.slice(api.indexOf("const STORE_SCOPED_ALLOWED_PATHS"), api.indexOf("if (!STORE_SCOPED_ALLOWED_PATHS.has(path))"))
  assert.doesNotMatch(storePaths, /chat-admin/i)
})

test("every delegated mutation has a capability and DB target assertion", async () => {
  const api = await read("supabase/functions/admin-api/index.ts")
  for (const [capability, assertion] of [
    ["manage_users", "assertChatAdminUserGlobalScope"],
    ["manage_members", "assertChatAdminRoomScope"],
    ["manage_rooms", "assertChatAdminRoomScope"],
    ["manage_bots", "assertChatAdminBotScope"],
    ["manage_templates", "assertChatAdminTemplateScope"],
    ["revert_audit", "assertChatAdminAuditScope"],
  ]) {
    assert.match(api, new RegExp(`chatAdminRequireCapability\\(chatAuthority, "${capability}"\\)[\\s\\S]*${assertion}`))
  }
  assert.match(api, /委任管理者は対象ルームを明示してください/)
  assert.match(api, /chat_admin_delegation_allows_room/)
  assert.match(api, /chat_admin_delegation_allows_user_global/)
  assert.match(api, /chat_admin_delegation_allows_bot/)
  assert.match(api, /chat_admin_delegation_allows_audit/)
  assert.match(api, /runChatAdminMutation[\s\S]*chat_admin_delegated_execute/)
  assert.match(api, /chatAdminRequireHeadquarters\(chatAuthority\)[\s\S]*purgeChatAdminRoom/)
  assert.match(api, /function chatAdminCanRevertAction[\s\S]*manage_users[\s\S]*manage_members/)
  const sql = await read("supabase/migrations/20260910010000_chat_delegated_admin.sql")
  assert.match(sql, /from public\.chat_admin_delegations[\s\S]*for share/i)
  assert.match(sql, /chat_admin_delegated_execute[\s\S]*chat_admin_update_user_access/i)
  assert.doesNotMatch(sql, /chat_admin_delegated_execute[\s\S]*purgeMtalkGroupAsAdmin/i)
})

test("delegated state is filtered before serialization and contains no messages or file paths", async () => {
  const api = await read("supabase/functions/admin-api/index.ts")
  const start = api.indexOf("async function fetchChatAdminState(")
  const end = api.indexOf("async function updateChatAdminUserAccess(", start)
  const source = api.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.match(source, /allGroupRows\.filter\(\(row\) => chatAdminAllowsRoom\(authority, row\)\)/)
  assert.match(source, /allUserRows\.filter[\s\S]*chatAdminAllowsUser/)
  assert.match(source, /allAuditRows\.filter\(\(row\) => chatAdminAllowsAudit/)
  assert.match(source, /store_keys:[\s\S]*\.filter\(\(storeKey\) => \([\s\S]*scopedStoreKeys/)
  assert.match(source, /admin_authority:\s*publicChatAdminAuthority\(authority\)/)
  assert.doesNotMatch(source, /chat_messages|storage_path|message_text|body_text|signedUrl/i)
  const authoritySource = await read("supabase/functions/_shared/chat_admin_delegation.ts")
  assert.match(authoritySource, /!authority\.isFullAdmin[\s\S]*startsWith\("delegation_"\)/)
})

test("headquarters can issue and immediately revoke one-use delegated login links", async () => {
  const [api, html, auth] = await Promise.all([
    read("supabase/functions/admin-api/index.ts"),
    read("public/chat-admin.html"),
    read("public/auth-session.js"),
  ])
  assert.match(api, /chatAdminRequireHeadquarters\(chatAuthority\)/)
  assert.match(api, /scope:\s*MTALK_ADMIN_SCOPE/)
  assert.match(api, /chat_admin_delegation_id:\s*delegationId/)
  assert.match(api, /chat_admin_delegation_version:\s*sessionVersion/)
  assert.match(api, /issueAdminDashboardLoginLinkToken/)
  assert.match(html, /M-talk委任管理者/)
  assert.match(html, /data-toggle-delegation/)
  assert.match(html, /保存済みセッションも次のAPI呼び出しから使えなくなります/)
  assert.match(html, /再開後は新しいリンクを発行してください/)
  assert.match(html, /完全削除は本部のみ/)
  assert.match(html, /renderDelegationCapabilities\(\['view'\]\)/)
  assert.match(html, /key === 'manage_bots' && roomScope/)
  assert.match(html, /scope_kind.*mtalk_admin/)
  assert.match(auth, /targetDelegationId/)
  assert.match(auth, /isDelegationMatched/)
  assert.match(auth, /stripUrlParams\(\['lt', 'scope_kind', 'delegation_id'\]\)/)
  assert.doesNotMatch(html, /SUPABASE_SERVICE_ROLE_KEY/)
})
