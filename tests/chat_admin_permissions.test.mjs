import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const root = new URL("..", import.meta.url)
const read = (relative) => readFile(new URL(relative, root), "utf8")

function functionDefinition(sql, name) {
  const start = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "i"))
  assert.ok(start >= 0, `migration must redefine public.${name}`)
  const source = sql.slice(start)
  const marker = /\bas\s+(\$[a-z0-9_]*\$)/i.exec(source)
  assert.ok(marker, `public.${name} must have a dollar-quoted body`)
  const bodyStart = marker.index + marker[0].length
  const end = source.indexOf(`${marker[1]};`, bodyStart)
  assert.ok(end >= 0, `public.${name} body must terminate`)
  return source.slice(0, end + marker[1].length + 1)
}

function policyDefinition(sql, name) {
  const start = sql.search(new RegExp(`create\\s+policy\\s+${name}\\s+on\\s+`, "i"))
  assert.ok(start >= 0, `migration must create policy ${name}`)
  const end = sql.indexOf(";", start)
  assert.ok(end >= 0, `policy ${name} must terminate`)
  return sql.slice(start, end + 1)
}

test("chat-only access schema has global and four per-room permission boundaries", async () => {
  const migration = await read("supabase/migrations/20260824010000_chat_admin_permissions.sql")

  assert.match(migration, /create table if not exists public\.chat_user_access/i)
  assert.match(migration, /user_id\s+uuid\s+primary key\s+references public\.chat_users\s*\(id\)/i)
  assert.match(migration, /access_enabled\s+boolean\s+not null\s+default true/i)
  assert.match(migration, /can_start_direct\s+boolean\s+not null\s+default true/i)
  assert.match(migration, /can_create_group\s+boolean\s+not null\s+default true/i)
  assert.match(migration, /can_browse_users\s+boolean\s+not null\s+default true/i)
  assert.match(migration, /restricted_until\s+timestamptz/i)
  assert.match(migration, /deleted_at\s+timestamptz/i)
  assert.match(migration, /insert into public\.chat_user_access/i)
  assert.match(migration, /select\s+(?:cu\.)?id\s+from public\.chat_users(?:\s+cu)?/i)
  assert.match(migration, /after insert on public\.chat_users/i)
  assert.match(migration, /execute function public\.chat_create_default_user_access\(\)/i)

  for (const permission of ["can_view", "can_send", "can_invite", "can_manage"]) {
    assert.match(
      migration,
      new RegExp(`add\\s+column\\s+if\\s+not\\s+exists\\s+${permission}\\s+boolean`, "i"),
      `chat_group_members.${permission} must be added`,
    )
  }
  assert.match(migration, /constraint chat_group_members_view_required check/i)
  assert.match(migration, /can_view\s*=\s*true[\s\S]*can_send\s*=\s*false[\s\S]*can_invite\s*=\s*false[\s\S]*can_manage\s*=\s*false/i)
  assert.match(migration, /alter table public\.chat_user_access enable row level security/i)
  assert.match(migration, /revoke all on table public\.chat_user_access from public, anon, authenticated/i)
  assert.match(migration, /grant select on table public\.chat_user_access to authenticated/i)
  assert.match(policyDefinition(migration, "chat_user_access_select_self"), /user_id\s*=\s*\(select auth\.uid\(\)\)/i)
  assert.match(migration, /create table if not exists public\.chat_admin_audit_log/i)
  assert.match(migration, /alter table public\.chat_admin_audit_log enable row level security/i)
})

test("RLS replaces broad member policies with active-access capability checks", async () => {
  const migration = await read("supabase/migrations/20260824010000_chat_admin_permissions.sql")
  const broadPolicies = [
    "chat_users_select_registered",
    "chat_users_update_self",
    "chat_groups_select",
    "chat_groups_insert",
    "chat_groups_update_member",
    "chat_group_members_select",
    "chat_group_members_insert_self",
    "chat_group_members_insert_by_member",
    "chat_group_members_delete_self",
    "chat_group_invites_member_all",
    "chat_messages_select_member",
    "chat_messages_select_since_join",
    "chat_messages_insert_member",
    "chat_messages_delete_own",
    "chat_read_states_own",
    "chat_read_states_select_member",
    "chat_read_states_insert_self",
    "chat_read_states_update_self",
    "chat_read_states_delete_self",
    "chat_reactions_select_member",
    "chat_reactions_insert_self",
    "chat_reactions_update_self",
    "chat_reactions_delete_self",
    "chat_scheduled_messages_select_own",
    "chat_push_user_preferences_select_self",
  ]
  for (const policy of broadPolicies) {
    assert.match(
      migration,
      new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+${policy}\\s+on`, "i"),
      `${policy} must be explicitly removed before replacement`,
    )
  }

  const activeAccess = functionDefinition(migration, "chat_has_active_access")
  assert.match(activeAccess, /access_enabled/i)
  assert.match(activeAccess, /deleted_at\s+is\s+null/i)
  assert.match(activeAccess, /restricted_until\s+is\s+null[\s\S]*restricted_until\s*<=\s*now\(\)/i)

  for (const capability of ["view", "send", "invite", "manage"]) {
    const definition = functionDefinition(migration, `chat_can_${capability}_group`)
    assert.match(definition, /chat_has_active_access/i)
    assert.match(definition, new RegExp(`can_${capability}`, "i"))
  }
  assert.match(functionDefinition(migration, "chat_is_registered"), /chat_has_active_access/i)
  assert.match(functionDefinition(migration, "chat_is_member"), /chat_can_view_group/i)

  assert.match(policyDefinition(migration, "chat_groups_select"), /chat_can_view_group/i)
  assert.match(policyDefinition(migration, "chat_messages_select_since_join"), /chat_can_read_message/i)
  assert.match(policyDefinition(migration, "chat_messages_insert_member"), /chat_can_send_group/i)
  assert.match(policyDefinition(migration, "chat_group_invites_member_all"), /chat_can_invite_group/i)
  assert.doesNotMatch(migration, /\bto\s+anon\b/i)
})

test("direct rooms, invites, schedules, and management RPCs enforce their capability", async () => {
  const migration = await read("supabase/migrations/20260824010000_chat_admin_permissions.sql")

  const openDirect = functionDefinition(migration, "chat_open_direct")
  assert.match(openDirect, /chat_is_registered/i)
  assert.match(openDirect, /can_start_direct/i)
  assert.match(openDirect, /chat_has_active_access\(p_other\)/i)
  assert.match(openDirect, /count\(\*\)[\s\S]*<>\s*2/i)

  const createGroup = functionDefinition(migration, "chat_create_group")
  assert.match(createGroup, /chat_is_registered/i)
  assert.match(createGroup, /can_create_group/i)
  const addMembers = functionDefinition(migration, "chat_add_members")
  assert.match(addMembers, /chat_can_invite_group/i)
  assert.match(addMembers, /if v_direct/i)
  assert.match(functionDefinition(migration, "chat_ensure_invite"), /chat_can_invite_group/i)
  assert.match(functionDefinition(migration, "chat_rotate_invite"), /chat_can_invite_group/i)
  assert.match(functionDefinition(migration, "chat_join_by_invite"), /chat_is_registered/i)
  assert.match(functionDefinition(migration, "chat_kick_member"), /chat_can_manage_group/i)
  assert.match(functionDefinition(migration, "chat_trash_group"), /chat_can_manage_group/i)
  assert.match(functionDefinition(migration, "chat_restore_group"), /chat_can_manage_group/i)
  const scheduleMessage = functionDefinition(migration, "chat_schedule_message")
  assert.match(scheduleMessage, /chat_can_send_group/i)
  assert.match(scheduleMessage, /\^\[1-9\]\[0-9\]\{0,4\}\$/i)
  assert.match(scheduleMessage, /jsonb_strip_nulls\s*\(\s*jsonb_build_object/i)
  const cancelScheduled = functionDefinition(migration, "chat_cancel_scheduled_message")
  assert.match(cancelScheduled, /chat_has_active_access/i)
  assert.match(cancelScheduled, /user_id\s*=\s*auth\.uid\(\)/i)
  assert.match(cancelScheduled, /chat_can_send_group/i)
  assert.match(cancelScheduled, /chat_can_manage_group/i)
  const dispatchScheduled = functionDefinition(migration, "chat_dispatch_scheduled_messages")
  assert.match(dispatchScheduled, /chat_has_active_access\(r\.user_id\)/i)
  assert.match(dispatchScheduled, /can_view/i)
  assert.match(dispatchScheduled, /can_send/i)
  assert.match(dispatchScheduled, /v_payload\s*:=\s*jsonb_strip_nulls/i)
  assert.match(dispatchScheduled, /v_path\s+not\s+like\s+'groups\/'/i)
  assert.match(functionDefinition(migration, "chat_unread_counts"), /can_view/i)
  assert.match(functionDefinition(migration, "chat_push_unread_totals"), /can_view/i)

  const adminRpcs = [
    "chat_admin_update_user_access",
    "chat_admin_remove_user",
    "chat_admin_restore_user",
    "chat_admin_update_member_permissions",
    "chat_admin_remove_member",
  ]
  for (const rpc of adminRpcs) {
    assert.match(migration, new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${rpc}\\b[^;]*from\\s+public,\\s*anon,\\s*authenticated`, "i"))
    assert.match(migration, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${rpc}\\b[^;]*to\\s+service_role`, "i"))
  }
  const updateUserAccess = functionDefinition(migration, "chat_admin_update_user_access")
  assert.match(updateUserAccess, /where\s+user_id\s*=\s*p_user_id\s+for update/i)
  assert.match(updateUserAccess, /p_expected_updated_at/i)
  assert.match(updateUserAccess, /errcode\s*=\s*'40001'/i)
  const updateMemberPermissions = functionDefinition(migration, "chat_admin_update_member_permissions")
  assert.match(updateMemberPermissions, /where\s+group_id\s*=\s*p_group_id[\s\S]*for update/i)
  assert.match(updateMemberPermissions, /coalesce\s*\(p_can_view,\s*v_before\.can_view\)/i)
})

test("chat storage and push delivery do not bypass chat access", async () => {
  const [migration, push] = await Promise.all([
    read("supabase/migrations/20260824010000_chat_admin_permissions.sql"),
    read("supabase/functions/chat-push/index.ts"),
  ])

  for (const policy of [
    "chat_icons_select",
    "chat_icons_insert",
    "chat_icons_update",
    "chat_icons_delete",
    "chat_images_select",
    "chat_images_insert",
  ]) {
    assert.match(migration, new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+${policy}\\s+on\\s+storage\\.objects`, "i"))
  }
  assert.match(policyDefinition(migration, "chat_images_select"), /chat_can_view_path/i)
  assert.match(policyDefinition(migration, "chat_images_insert"), /chat_can_send_path/i)
  for (const policy of ["chat_icons_insert", "chat_icons_update", "chat_icons_delete"]) {
    const definition = policyDefinition(migration, policy)
    assert.match(definition, /chat_has_active_access|chat_is_registered/i)
    assert.match(definition, /chat_can_manage_path/i)
    assert.match(definition, /auth\.uid\(\)/i)
  }

  assert.match(push, /async function hasActiveChatAccess/)
  assert.match(push, /\.from\("chat_user_access"\)/)
  assert.match(push, /\.eq\("access_enabled", true\)/)
  assert.match(push, /\.is\("deleted_at", null\)/)
  assert.match(push, /restricted_until\.is\.null,restricted_until\.lte/)
  assert.match(push, /\.eq\("can_view", true\)/)
  assert.match(push, /\.in\("user_id", memberRecipientIds\)/)
  assert.match(push, /memberRecipientIds\.filter\(\(id\) => activeRecipientIds\.has\(id\)\)/)
})

test("dedicated admin API uses chat-only soft removal and exposes direct-room controls", async () => {
  const [migration, api, adminUi, chat] = await Promise.all([
    read("supabase/migrations/20260824010000_chat_admin_permissions.sql"),
    read("supabase/functions/admin-api/index.ts"),
    read("public/chat-admin.html"),
    read("public/chat.html"),
  ])

  assert.match(api, /path === "\/chat-admin\/state"/)
  assert.match(api, /const memberMatch =/)
  assert.match(api, /const userActionMatch =/)
  assert.match(api, /const userMatch =/)
  assert.match(api, /storeScope \|\| roomScope \|\| authResult\.scopeKind !== null/)
  assert.match(api, /chat_admin_update_user_access/)
  assert.match(api, /chat_admin_remove_user/)
  assert.match(api, /chat_admin_restore_user/)
  assert.match(api, /chat_admin_update_member_permissions/)
  assert.match(api, /chat_admin_remove_member/)
  assert.match(api, /p_expected_updated_at:\s*chatAdminExpectedTimestamp/)
  assert.match(api, /status:\s*conflict\s*\?\s*409\s*:\s*400/)
  assert.match(api, /chatAdminOptionalBoolean\(body\.can_view/)
  assert.match(api, /direct_rooms/)
  for (const permission of ["can_view", "can_send", "can_invite", "can_manage"]) {
    assert.match(api, new RegExp(permission))
  }
  assert.doesNotMatch(migration, /delete\s+from\s+(?:public\.)?chat_users\b/i)
  assert.doesNotMatch(migration, /delete\s+from\s+auth\.users\b/i)
  assert.doesNotMatch(api, /auth\.admin\.deleteUser\s*\(/)
  assert.doesNotMatch(api, /\.from\("chat_users"\)[\s\S]{0,160}?\.delete\s*\(/)
  assert.match(api, /history_preserved:\s*true/)
  assert.match(api, /auth_user_preserved:\s*true/)

  assert.match(adminUi, /chat-admin\/state/)
  assert.match(adminUi, /access_enabled/)
  assert.match(adminUi, /restricted_until/)
  assert.match(adminUi, /can_start_direct/)
  assert.match(adminUi, /can_create_group/)
  assert.match(adminUi, /can_browse_users/)
  assert.match(adminUi, /can_view/)
  assert.match(adminUi, /can_send/)
  assert.match(adminUi, /can_invite/)
  assert.match(adminUi, /can_manage/)
  assert.match(adminUi, /\/remove/)
  assert.match(adminUi, /\/restore/)
  assert.match(adminUi, /confirm_username/)
  assert.match(adminUi, /ダイレクト|1対1/)
  assert.match(adminUi, /data-room-tab="direct"/)
  assert.match(adminUi, /x-admin-token/)
  assert.match(adminUi, /Botは変更できません/)
  assert.match(adminUi, /if\s*\(window\.top\s*!==\s*window\.self\)/)
  assert.match(adminUi, /function clearSensitiveState\(\)/)
  assert.match(adminUi, /state\.rooms\s*=\s*\[\]/)
  assert.match(adminUi, /roomDetail['"]\)\.innerHTML/)
  assert.match(adminUi, /\.side-foot\s*\{\s*margin-top:0;\s*display:flex/i)
  assert.match(adminUi, /expected_updated_at:user\.access\?\.updated_at/)
  assert.match(adminUi, /const payload = \{\[permission\]:target\.checked\}/)
  assert.match(adminUi, /document\.querySelector\('\.app'\)\.inert = state\.loading/)
  assert.doesNotMatch(adminUi, /SUPABASE_SERVICE_ROLE_KEY/)

  assert.match(chat, /const CHAT_ACCESS_COLUMNS = 'user_id, access_enabled, can_start_direct, can_create_group, can_browse_users, restriction_reason, restricted_until, deleted_at'/)
  assert.match(chat, /async function loadCurrentChatAccess\(\)/)
  assert.match(chat, /\.from\('chat_user_access'\)/)
  assert.match(chat, /function chatAccessIsBlocked\(access\)/)
  assert.match(chat, /function canCurrentUserSend/)
  assert.match(chat, /function canCurrentUserInvite/)
  assert.match(chat, /function canCurrentUserManage/)
  assert.match(chat, /function requireCurrentRoomSend/)
  assert.match(chat, /function safeImageDimension\(value\)/)
  assert.match(chat, /imageElement\.style\.aspectRatio\s*=/)
  assert.doesNotMatch(chat, /aspect-ratio:\$\{image\.w\}/)
  assert.match(chat, /function syncComposerForGroup\(group\)/)
  assert.match(chat, /id="readOnlyNotice"/)
  assert.match(chat, /pinned_at, muted_at, hidden_at, can_view, can_send, can_invite, can_manage/)
  assert.match(chat, /event: 'UPDATE', schema: 'public', table: 'chat_user_access'/)
  assert.match(chat, /event: 'UPDATE', schema: 'public', table: 'chat_group_members'/)
  assert.match(chat, /sb\.rpc\('chat_create_group'/)
  assert.match(chat, /sb\.rpc\('chat_add_members'/)
  assert.doesNotMatch(chat, /\.from\('chat_groups'\)[\s\S]{0,160}?\.insert\s*\(/)
  assert.doesNotMatch(chat, /\.from\('chat_group_members'\)[\s\S]{0,160}?\.(?:insert|upsert)\s*\(/)
})
