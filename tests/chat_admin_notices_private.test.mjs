import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { readChatPageSource } from "./helpers/chat-page-source.mjs"

const root = new URL("..", import.meta.url)
const read = (relative) => relative === "public/chat.html"
  ? readChatPageSource()
  : readFile(new URL(relative, root), "utf8")
const MIGRATION = "supabase/migrations/20260907010000_chat_admin_notices_private.sql"
const SELF_SCOPE_MIGRATION = "supabase/migrations/20260909070000_self_scope_admin_notice_gate.sql"
const EXPLICIT_ROOM_PERMISSION_MIGRATION = "supabase/migrations/20260910060000_chat_admin_notice_explicit_permissions.sql"

function functionDefinition(sql, name) {
  const start = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "i"))
  assert.ok(start >= 0, `migration must define public.${name}`)
  const source = sql.slice(start)
  const marker = /\bas\s+(\$[a-z0-9_]*\$)/i.exec(source)
  assert.ok(marker, `public.${name} must have a dollar-quoted body`)
  const bodyStart = marker.index + marker[0].length
  const end = source.indexOf(`${marker[1]};`, bodyStart)
  assert.ok(end >= 0, `public.${name} body must terminate`)
  return source.slice(0, end + marker[1].length + 1)
}

test("admin notice cards are readable only by managers", async () => {
  const migration = await read(MIGRATION)
  assert.match(functionDefinition(migration, "chat_is_admin_notice_message"), /signup_approval/)
  assert.match(functionDefinition(migration, "chat_is_admin_notice_message"), /store_change_reviewed/)
  assert.match(functionDefinition(migration, "chat_can_see_admin_notice"), /chat_is_signup_manager/)
  assert.match(functionDefinition(migration, "chat_can_see_admin_notice"), /is_direct/)
  assert.match(migration, /chat_messages_select_since_join/)
  assert.match(migration, /chat_can_see_admin_notice\(group_id\)/)
  assert.match(functionDefinition(migration, "chat_unread_counts"), /chat_is_admin_notice_message/)
  assert.match(functionDefinition(migration, "chat_push_unread_totals"), /chat_can_see_admin_notice/)
  assert.match(functionDefinition(migration, "chat_ensure_manager_notice_direct"), /chat_is_signup_manager/)
  assert.match(functionDefinition(migration, "chat_ensure_manager_notice_direct"), /00000000-0000-4000-8000-00000000b071/)
  assert.match(functionDefinition(migration, "chat_add_members"), /on conflict \(group_id, user_id\) do update/i)
  assert.match(migration, /default_can_send = false/)
  assert.match(migration, /can_invite = false/)
})

test("authenticated callers cannot probe another user's admin-notice access", async () => {
  const migration = await read(SELF_SCOPE_MIGRATION)
  const gate = functionDefinition(migration, "chat_can_see_admin_notice")
  assert.match(gate, /p_user_id\s*=\s*auth\.uid\(\)/i)
  assert.match(gate, /auth\.role\(\)[\s\S]*service_role/i)
  assert.match(gate, /chat_has_active_access\(p_user_id\)/i)
  assert.match(
    migration,
    /revoke all on function public\.chat_can_see_admin_notice\(bigint, uuid\)[\s\S]*from public, anon/i,
  )
  assert.match(
    migration,
    /grant execute on function public\.chat_can_see_admin_notice\(bigint, uuid\)[\s\S]*to authenticated, service_role/i,
  )
})

test("chat-knowledge posts signup notices to manager DMs, not store rooms", async () => {
  const knowledge = await read("supabase/functions/chat-knowledge/index.ts")
  assert.match(knowledge, /postAdminNoticeToManagers/)
  assert.match(knowledge, /chat_ensure_manager_notice_room/)
  assert.doesNotMatch(knowledge, /chat_ensure_manager_notice_direct/)
  assert.match(knowledge, /kind: "signup_approval"/)
  assert.match(knowledge, /kind: "store_change"/)
  assert.doesNotMatch(knowledge, /listSignupManagerGroupIds/)
})

test("admin notices use a dedicated room, not the reservation-bot DM", async () => {
  const migration = await read("supabase/migrations/20260908010000_chat_admin_notice_room.sql")
  assert.match(migration, /is_admin_notice_room/)
  assert.match(functionDefinition(migration, "chat_ensure_manager_notice_room"), /00000000-0000-4000-8000-00000000b072/)
  assert.doesNotMatch(functionDefinition(migration, "chat_ensure_manager_notice_room"), /00000000-0000-4000-8000-00000000b071/)
  assert.match(functionDefinition(migration, "chat_ensure_manager_notice_direct"), /chat_ensure_manager_notice_room/)
  assert.match(functionDefinition(migration, "chat_protect_admin_notice_room"), /管理者通知ルームは削除できません/)
  const chat = await read("public/chat.html")
  assert.match(chat, /is_admin_notice_room/)
  assert.match(chat, /!group\.is_admin_notice_room/)
})

test("admin notice synchronization preserves explicitly granted room administration", async () => {
  const migration = await read(EXPLICIT_ROOM_PERMISSION_MIGRATION)
  const ensureRoom = functionDefinition(migration, "chat_ensure_manager_notice_room")
  const reviewerUpsert = ensureRoom.slice(
    ensureRoom.indexOf("select v_id, u.id"),
    ensureRoom.indexOf("delete from public.chat_group_members"),
  )
  assert.match(reviewerUpsert, /can_invite = chat_group_members\.can_invite/)
  assert.match(reviewerUpsert, /can_manage = chat_group_members\.can_manage/)
  assert.doesNotMatch(reviewerUpsert, /can_manage = false/)
})

test("chat.html hides admin notices and bot invite for viewers", async () => {
  const chat = await read("public/chat.html")
  assert.match(chat, /function shouldHideAdminNotice/)
  assert.match(chat, /function currentUserIsSignupManager/)
  assert.match(chat, /signup_approval/)
  assert.match(chat, /store_change_reviewed/)
  assert.match(chat, /isStoreBot\(user\) && sharesAffiliationWith\(user\)/)
  assert.match(chat, /canInviteSomewhere/)
  assert.match(chat, /if \(shouldHideAdminNotice\(msg\)\) return/)
})
