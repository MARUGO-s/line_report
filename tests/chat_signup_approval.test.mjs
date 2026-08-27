import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { readChatPageSource } from "./helpers/chat-page-source.mjs"

const root = new URL("..", import.meta.url)
const read = (relative) => relative === "public/chat.html"
  ? readChatPageSource()
  : readFile(new URL(relative, root), "utf8")
const MIGRATION = "supabase/migrations/20260903010000_chat_signup_approval.sql"

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

test("new signups start pending and view-only after approval", async () => {
  const migration = await read(MIGRATION)

  assert.match(migration, /add column if not exists signup_status text not null default 'approved'/i)
  assert.match(migration, /add column if not exists default_can_send boolean not null default true/i)
  assert.match(migration, /check \(signup_status in \('pending', 'approved', 'denied'\)\)/i)

  const createAccess = functionDefinition(migration, "chat_create_default_user_access")
  assert.match(createAccess, /if coalesce\(new\.is_bot, false\) then/i)
  assert.match(createAccess, /'pending', '管理者の承認待ち'/i)
  assert.match(createAccess, /false, false, false, false, false, 'pending'/i)
  assert.match(createAccess, /chat_enqueue_signup_dispatch\(\s*'signup-notify'/i)
  assert.match(createAccess, /true, true, true, true, true, 'approved'/i)

  const review = functionDefinition(migration, "chat_review_signup")
  assert.match(review, /chat_is_signup_manager/i)
  assert.match(review, /signup_status = 'approved'/i)
  assert.match(review, /default_can_send = false/i)
  assert.match(review, /can_start_direct = false/i)
  assert.match(review, /can_create_group = false/i)
  assert.match(review, /can_browse_users = false/i)
  assert.match(review, /signup_status = 'denied'/i)
  assert.match(migration, /grant execute on function public\.chat_review_signup/i)

  const perms = functionDefinition(migration, "chat_new_member_permissions")
  assert.match(perms, /coalesce\(a\.default_can_send, true\)/i)

  assert.match(functionDefinition(migration, "chat_add_members"), /chat_new_member_permissions/i)
  assert.match(functionDefinition(migration, "chat_join_by_invite"), /chat_new_member_permissions/i)
  assert.match(functionDefinition(migration, "chat_create_group"), /chat_new_member_permissions/i)
  assert.match(functionDefinition(migration, "chat_create_group"), /v_group_id, v_me, true, true, true, true/i)

  assert.match(migration, /action=' \|\| v_action/i)
  assert.match(migration, /chat-knowledge\?action=/i)
})

test("managers get allow/deny cards and the SPA intercepts the command", async () => {
  const chat = await read("public/chat.html")
  const knowledge = await read("supabase/functions/chat-knowledge/index.ts")
  const help = await read("supabase/functions/_shared/mtalk_help_manual.ts")

  assert.match(chat, /signup_status/)
  assert.match(chat, /function parseSignupReviewCommand/)
  assert.match(chat, /function reviewSignupFromCard/)
  assert.match(chat, /rpc\('chat_review_signup'/)
  assert.match(chat, /function authEmailRedirectUrl/)
  assert.match(chat, /emailRedirectTo: authEmailRedirectUrl\(\)/)
  assert.match(chat, /marugo-s\.github\.io\/line_report\/chat\.html/)
  assert.match(chat, /mtalk-signup:\(approve\|deny\)/)
  assert.match(chat, /管理者の承認待ちです/)
  assert.match(chat, /閲覧だけできる状態で使い始められます/)
  assert.doesNotMatch(chat.slice(chat.indexOf("async function sendCardCommand"), chat.indexOf("async function sendChatText")), /requireCurrentRoomSend\(\) return;[\s\S]*parseSignupReviewCommand/)

  assert.match(knowledge, /action === "signup-notify"/)
  assert.match(knowledge, /action === "signup-reviewed"/)
  assert.match(knowledge, /mtalk-signup:approve:/)
  assert.match(knowledge, /許可（閲覧のみ）/)
  assert.match(knowledge, /kind: "signup_approval"/)
  assert.match(knowledge, /postAdminNoticeToManagers/)
  assert.doesNotMatch(knowledge, /listSignupManagerGroupIds/)

  assert.match(help, /管理権限を持つ人が許可するまで/)
  assert.match(help, /閲覧だけできる状態/)
})
