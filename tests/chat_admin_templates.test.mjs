import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"

const root = new URL("..", import.meta.url)
const read = (relative) => readFile(new URL(relative, root), "utf8")
const MIGRATION = "supabase/migrations/20260825010000_chat_admin_templates_access_revert.sql"
const SEARCH_PATH_FIX = "supabase/migrations/20260825020000_chat_admin_normalize_search_path.sql"

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

test("permission templates are service-role only and keep the view-required rule", async () => {
  const migration = await read(MIGRATION)

  assert.match(migration, /create table if not exists public\.chat_permission_templates/i)
  assert.match(migration, /constraint chat_permission_templates_view_required check \(\s*can_view = true\s*or \(can_send = false and can_invite = false and can_manage = false\)/i)
  assert.match(migration, /alter table public\.chat_permission_templates enable row level security/i)
  assert.match(migration, /revoke all on table public\.chat_permission_templates from public, anon, authenticated/i)
  assert.match(migration, /grant select, insert, update, delete on table public\.chat_permission_templates to service_role/i)
  // ブラウザから直接読めるpolicyを作らない（管理APIのservice_role経由だけ）。
  assert.doesNotMatch(migration, /create policy [a-z_]+ on public\.chat_permission_templates/i)

  for (const key of ["viewer", "member", "room_admin"]) {
    assert.match(migration, new RegExp(`'${key}'`), `builtin template ${key} must be seeded`)
  }
})

test("the four room permissions are normalized in a single shared function", async () => {
  const migration = await read(MIGRATION)
  const normalize = functionDefinition(migration, "chat_admin_normalize_member_permissions")

  // can_view=false なら他3権限もfalse。1対1は招待・管理を常にfalse。
  assert.match(normalize, /case when coalesce\(p_can_view, false\) then coalesce\(p_can_send, false\) else false end/i)
  assert.match(normalize, /not coalesce\(p_is_direct, false\)[\s\S]*coalesce\(p_can_invite, false\)[\s\S]*else false/i)
  assert.match(normalize, /not coalesce\(p_is_direct, false\)[\s\S]*coalesce\(p_can_manage, false\)[\s\S]*else false/i)

  // 既存の単体更新RPCも同じ正規化関数を通す。
  const update = functionDefinition(migration, "chat_admin_update_member_permissions")
  assert.match(update, /public\.chat_admin_normalize_member_permissions\(/i)
  assert.match(update, /if v_is_bot then raise exception/i)
  assert.match(update, /for update/i)
  assert.match(update, /'member_permissions_update'/)
})

test("template apply previews without writing, caps targets, and delegates each change", async () => {
  const migration = await read(MIGRATION)
  const apply = functionDefinition(migration, "chat_admin_apply_room_template")

  assert.match(apply, /v_max_targets constant integer := 100/i)
  assert.match(apply, /raise exception '一括適用は%件までです/)
  assert.match(apply, /if cardinality\(v_groups\) = 0 and cardinality\(v_users\) = 0 then/i)

  // Botと論理削除済みユーザーには触れない。
  assert.match(apply, /if v_row\.is_bot then[\s\S]*'reason', 'bot'[\s\S]*continue;/i)
  assert.match(apply, /if v_row\.user_deleted_at is not null then[\s\S]*'reason', 'user_deleted'[\s\S]*continue;/i)

  // 正規化は共通関数、書き込みは既存の単体更新RPCへ委譲（行ロック・監査を1本化）。
  assert.match(apply, /public\.chat_admin_normalize_member_permissions\(/i)
  assert.match(apply, /if not v_dry then[\s\S]*perform public\.chat_admin_update_member_permissions\(/i)

  // dry_run は書き込まない。
  const dryGuardCount = (apply.match(/if not v_dry/g) || []).length
  assert.ok(dryGuardCount >= 2, "writes must be guarded by `if not v_dry`")
  assert.match(apply, /'template_apply'/)
  assert.match(apply, /'dry_run', v_dry/)
  assert.match(apply, /order by gm\.group_id, gm\.user_id/i)
})

test("every chat_admin function pins its search_path", async () => {
  const sources = [await read(MIGRATION), await read(SEARCH_PATH_FIX)].join("\n")

  // 最終的な定義が search_path を固定していること。Advisors の
  // function_search_path_mutable を再発させない。
  for (const fn of [
    "chat_admin_normalize_member_permissions",
    "chat_admin_apply_room_template",
    "chat_admin_user_effective_access",
    "chat_admin_revert_audit",
    "chat_admin_update_member_permissions",
  ]) {
    const defs = [...sources.matchAll(
      new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\([\\s\\S]*?\\bas\\s+\\$[a-z0-9_]*\\$`, "gi"),
    )].map((m) => m[0])
    assert.ok(defs.length > 0, `${fn} must be defined`)
    const last = defs[defs.length - 1]
    assert.match(last, /set\s+search_path\s*=\s*public/i, `${fn} must pin search_path`)
  }
})

test("the search_path fix keeps the normalization logic identical", async () => {
  const before = await read(MIGRATION)
  const after = await read(SEARCH_PATH_FIX)
  const body = (sql) => {
    const m = /create\s+or\s+replace\s+function\s+public\.chat_admin_normalize_member_permissions[\s\S]*?\bas\s+\$fn\$([\s\S]*?)\$fn\$/i.exec(sql)
    assert.ok(m, "normalize function body must be found")
    return m[1].replace(/\s+/g, " ").trim()
  }
  assert.equal(body(after), body(before), "the fix must not change the permission logic")
  assert.match(after, /revoke all on function public\.chat_admin_normalize_member_permissions[\s\S]*from public, anon, authenticated/i)
  assert.match(after, /grant execute on function public\.chat_admin_normalize_member_permissions[\s\S]*to service_role/i)
})

test("the bulk-apply cap is the same number in SQL and in the admin API", async () => {
  const migration = await read(MIGRATION)
  const api = await read("supabase/functions/admin-api/index.ts")

  const sqlCap = /v_max_targets constant integer := (\d+)/i.exec(migration)
  assert.ok(sqlCap, "the migration must declare v_max_targets")
  const apiCap = /CHAT_ADMIN_TEMPLATE_MAX_TARGETS = (\d+)/.exec(api)
  assert.ok(apiCap, "admin-api must declare CHAT_ADMIN_TEMPLATE_MAX_TARGETS")

  assert.equal(
    Number(apiCap[1]),
    Number(sqlCap[1]),
    "the API cap must match the SQL cap, otherwise the UI shows a limit the DB does not enforce",
  )
})

test("effective access mirrors the runtime gate and names the denial reason", async () => {
  const migration = await read(MIGRATION)
  const effective = functionDefinition(migration, "chat_admin_user_effective_access")

  // chat_has_active_access と同じ判定（停止・削除・期限）。
  assert.match(effective, /v_deleted := v_access\.deleted_at is not null/i)
  assert.match(effective, /v_disabled := v_access\.user_id is not null and v_access\.access_enabled = false/i)
  assert.match(effective, /v_restricted := v_access\.restricted_until is not null and v_access\.restricted_until > now\(\)/i)
  assert.match(effective, /v_global_ok := not \(v_deleted or v_disabled or v_restricted\)/i)

  for (const code of [
    "user_deleted", "user_disabled", "user_restricted",
    "room_view_denied", "room_send_denied", "room_invite_denied",
    "room_manage_denied", "room_direct_locked", "room_trashed",
  ]) {
    assert.match(effective, new RegExp(`'${code}'`), `denial reason ${code} must be reported`)
  }

  // 1対1では招待・管理を実効不可として扱う。
  assert.match(effective, /'can_invite', v_global_ok and gm\.can_view and gm\.can_invite and not coalesce\(g\.is_direct, false\)/i)
  assert.match(effective, /'can_manage', v_global_ok and gm\.can_view and gm\.can_manage and not coalesce\(g\.is_direct, false\)/i)

  // 管理一覧に本文や顧客情報を混ぜない。
  assert.doesNotMatch(effective, /chat_messages/i)
  assert.match(effective, /limit v_limit/i)
  assert.match(effective, /offset v_offset/i)
})

test("audit revert is whitelisted, conflict-checked, single-use, and itself audited", async () => {
  const migration = await read(MIGRATION)
  const revert = functionDefinition(migration, "chat_admin_revert_audit")

  assert.match(migration, /alter table public\.chat_admin_audit_log\s*\n\s*add column if not exists source_audit_id bigint references public\.chat_admin_audit_log\(id\)/i)

  // 復元可能な操作だけ。ルーム完全削除やメッセージ消去は対象外。
  assert.match(revert, /v_log\.action not in \(\s*'user_access_update', 'user_remove', 'member_permissions_update', 'member_remove'\s*\)/i)
  assert.doesNotMatch(revert, /'room_hard_delete'|'message_delete'|'user_restore'\s*,/i)

  // 同じログの二重復元を防ぐ。
  assert.match(revert, /where source_audit_id = v_log\.id[\s\S]*raise exception 'この監査ログは既に復元済みです'/i)

  // 現在値が after_state と一致しないときは 40001（APIで409）。
  const conflicts = (revert.match(/errcode = '40001'/g) || []).length
  assert.equal(conflicts, 2, "both the user and member branches must detect conflicts")
  assert.match(revert, /v_access\.updated_at is distinct from nullif\(v_log\.after_state->>'updated_at', ''\)::timestamptz/i)
  assert.match(revert, /v_member\.can_view is distinct from \(v_log\.after_state->>'can_view'\)::boolean/i)

  // 削除状態へ戻す方向の復元は行わない。
  assert.match(revert, /if \(v_log\.before_state->>'deleted_at'\) is not null then\s*\n\s*raise exception/i)

  // 既存RPCへ委譲して重複実装しない。
  assert.match(revert, /perform public\.chat_admin_restore_user\(/i)
  assert.match(revert, /perform public\.chat_admin_update_user_access\(/i)
  assert.match(revert, /perform public\.chat_admin_update_member_permissions\(/i)

  // dry_run は書き込まず差分だけ返す。
  const dryReturns = (revert.match(/'dry_run', true/g) || []).length
  assert.equal(dryReturns, 2, "both branches must support a preview-only response")

  // 復元操作そのものも監査へ残し、元ログIDを関連付ける。
  assert.match(revert, /insert into public\.chat_admin_audit_log \([\s\S]*source_audit_id[\s\S]*'audit_revert'[\s\S]*v_log\.id/i)
})

test("every new admin RPC stays service-role only", async () => {
  const migration = await read(MIGRATION)
  const signatures = [
    "chat_admin_normalize_member_permissions\\(boolean, boolean, boolean, boolean, boolean\\)",
    "chat_admin_apply_room_template\\(bigint\\[\\], uuid\\[\\], text, boolean, text\\)",
    "chat_admin_user_effective_access\\(uuid, integer, integer\\)",
    "chat_admin_revert_audit\\(bigint, boolean, text\\)",
  ]
  for (const signature of signatures) {
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${signature}\\s*\\n?\\s*from public, anon, authenticated`, "i"),
      `${signature} must be revoked from anon/authenticated`,
    )
    assert.match(
      migration,
      new RegExp(`grant execute on function public\\.${signature}\\s*\\n?\\s*to service_role`, "i"),
      `${signature} must be granted to service_role only`,
    )
  }
  assert.doesNotMatch(migration, /grant execute on function public\.chat_admin_[a-z_]+\([^)]*\)\s*\n?\s*to authenticated/i)
})

test("new admin API routes stay inside the isolated capability-checked chat-admin block", async () => {
  const api = await read("supabase/functions/admin-api/index.ts")

  const guard = api.indexOf('if (path === "/chat-admin" || path.startsWith("/chat-admin/"))')
  const notFound = api.indexOf('throw { status: 404, message: "M-talk管理APIが見つかりません。" } satisfies AppError')
  assert.ok(guard > 0 && notFound > guard, "the chat-admin block must be bounded by its scope guard and 404")

  const routes = [
    'req.method === "GET" && path === "/chat-admin/templates"',
    'req.method === "POST" && path === "/chat-admin/templates/apply"',
    "/^\\/chat-admin\\/users\\/([0-9a-f-]{36})\\/access$/i",
    "/^\\/chat-admin\\/audit\\/(\\d{1,18})\\/revert$/",
  ]
  for (const route of routes) {
    const at = api.indexOf(route)
    assert.ok(at > guard && at < notFound, `${route} must live inside the isolated chat-admin block`)
  }

  // 通常の店舗・ルームスコープからは到達させず、M-talk委任スコープも他APIへ出さない。
  const storeScoped = api.slice(api.indexOf("const STORE_SCOPED_ALLOWED_PATHS"), api.indexOf("if (!STORE_SCOPED_ALLOWED_PATHS.has(path))"))
  assert.doesNotMatch(storeScoped, /chat-admin/i)
  assert.match(api, /authResult\.scopeKind === MTALK_ADMIN_SCOPE[\s\S]*!path\.startsWith\("\/chat-admin\/"\)[\s\S]*この権限はM-talk管理だけに利用できます/)
  assert.match(api, /chatAdminRequireCapability\(chatAuthority, "manage_templates"\)/)
  assert.match(api, /assertChatAdminTemplateScope\(supabase, chatAuthority, body\)/)

  // 書き込みは dry_run:false を明示したときだけ。
  assert.match(api, /const dryRun = body\.dry_run !== false[\s\S]*chat_admin_apply_room_template/)
  assert.match(api, /const dryRun = body\.dry_run !== false[\s\S]*chat_admin_revert_audit/)
  // 競合は409、委任の停止・期限切れ・範囲外は403で返す。
  assert.match(api, /const conflict = code === "40001"[\s\S]*const forbidden = code === "42501"[\s\S]*status: conflict \? 409 : forbidden \? 403 : 400/)
  // UIへ渡す復元可否はサーバ側で判定する。
  assert.match(api, /CHAT_ADMIN_REVERTIBLE_ACTIONS = new Set<string>\(\[\s*"user_access_update",\s*"user_remove",\s*"member_permissions_update",\s*"member_remove",\s*\]\)/)
  assert.match(api, /revertible: chatAdminCanRevertAction\(authority, String\(row\.action \?\? ""\)\)[\s\S]*CHAT_ADMIN_REVERTIBLE_ACTIONS\.has\(String\(row\.action \?\? ""\)\)/)
})

test("admin UI previews before applying and escapes every rendered value", async () => {
  const html = await read("public/chat-admin.html")

  // 3機能の入口。
  assert.match(html, /id="templateDialog"/)
  assert.match(html, /id="accessDialog"/)
  assert.match(html, /id="revertDialog"/)
  assert.match(html, /data-user-access=/)
  assert.match(html, /data-revert-audit=/)
  assert.match(html, /id="templatePreviewBtn"/)

  // 適用・復元は必ずプレビュー(dry_run:true)を経由し、確認後に dry_run:false を送る。
  assert.match(html, /async function previewTemplate\(\)[\s\S]*dry_run:true[\s\S]*templateDialog'\)\.showModal\(\)/)
  assert.match(html, /async function applyTemplate\(\)[\s\S]*confirm\([\s\S]*dry_run:false/)

  // 複数ルームへの一括適用。APIはもともと group_ids 配列対応。UIがチェックしたルームを渡す。
  assert.match(html, /data-room-select=/)
  assert.match(html, /id="templateRoomScope"/)
  assert.match(html, /function selectedApplyGroupIds\(\)[\s\S]*templateRoomScope === 'checked'[\s\S]*selectedRoomIds/)
  assert.match(html, /const payload = \{template_key:key, group_ids:groupIds, user_ids:userIds\}/)
  assert.doesNotMatch(html, /group_ids:\[Number\(room\.id\)\]/)
  assert.match(html, /async function openRevertDialog\([\s\S]*dry_run:true[\s\S]*revertDialog'\)\.showModal\(\)/)
  assert.match(html, /async function applyRevert\(\)[\s\S]*confirm\([\s\S]*dry_run:false/)

  // ユーザー別アクセスはルーム名・店舗・種別・権限状態で絞り込める。
  assert.match(html, /id="accessSearch"/)
  assert.match(html, /id="accessKind"/)
  assert.match(html, /id="accessStatus"/)
  assert.match(html, /function filteredAccessRooms\(\)[\s\S]*state\.accessKind[\s\S]*state\.accessStatus[\s\S]*store_key/)

  // 拒否理由は表示するが、メッセージ本文は扱わない。
  assert.match(html, /REASON_LABELS = \{user_deleted:/)
  for (const fragment of [
    "escapeHtml(row.username",
    "escapeHtml(room.group_name",
    "escapeHtml(REASON_LABELS[code] || code)",
  ]) {
    assert.ok(html.includes(fragment), `${fragment} must be escaped before rendering`)
  }
  assert.doesNotMatch(html, /chat_messages/i)
})

test("admin UI inline script still compiles", async () => {
  const html = await read("public/chat-admin.html")
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  assert.ok(blocks.length > 0, "chat-admin.html must keep its inline script")
  for (const block of blocks) {
    // 実行はせず構文解析だけ行う。巨大なinline JSの破損を検知する。
    assert.doesNotThrow(() => new vm.Script(block), "inline script must parse")
  }
})
