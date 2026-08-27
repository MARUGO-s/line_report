import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const root = new URL("..", import.meta.url)
const read = (relative) => readFile(new URL(relative, root), "utf8")
const MIGRATION = "supabase/migrations/20260904010000_chat_user_stores.sql"

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

test("signup requires stores and applies them only after manager approval", async () => {
  const migration = await read(MIGRATION)
  assert.match(migration, /create table if not exists public\.chat_store_catalog/i)
  assert.match(migration, /create table if not exists public\.chat_user_stores/i)
  assert.match(migration, /create table if not exists public\.chat_store_change_requests/i)
  assert.match(migration, /chat_store_change_requests_one_pending/i)
  assert.match(migration, /\('marugo', 'マルゴ'/i)

  const complete = functionDefinition(migration, "chat_complete_signup")
  assert.match(complete, /chat_normalize_store_keys/i)
  assert.match(complete, /kind, requested_store_keys/i)
  assert.match(complete, /'signup-notify'/i)
  assert.doesNotMatch(functionDefinition(migration, "chat_create_default_user_access"), /signup-notify/)

  const review = functionDefinition(migration, "chat_review_signup")
  assert.match(review, /chat_apply_user_stores/i)
  assert.match(review, /kind = 'signup'/i)

  const change = functionDefinition(migration, "chat_request_store_change")
  assert.match(change, /chat_is_registered/i)
  assert.match(change, /'store-change-notify'/i)
  assert.match(change, /所属店舗が変わっていません/)

  const reviewChange = functionDefinition(migration, "chat_review_store_change")
  assert.match(reviewChange, /chat_apply_user_stores/i)
  assert.match(reviewChange, /kind is distinct from 'change'/i)
})

test("new 1:1 chats require overlapping affiliated stores", async () => {
  const openDirect = functionDefinition(await read(MIGRATION), "chat_open_direct")
  assert.match(openDirect, /if v_id is null then/i)
  assert.match(openDirect, /chat_shares_affiliation\(v_me, p_other\)/i)
  assert.match(openDirect, /所属店舗が同じ相手だけ始められます/)
})

test("new users join only affiliated store rooms as viewers", async () => {
  const migration = await read("supabase/migrations/20260905010000_chat_store_room_affiliation.sql")
  const join = functionDefinition(migration, "chat_join_store_rooms")
  assert.match(join, /人間は所属店舗の承認後に/i)
  assert.doesNotMatch(join, /where g\.is_store_room\s+on conflict/i)
  assert.match(functionDefinition(migration, "chat_sync_user_store_rooms"), /default_can_send = false/i)
  assert.match(functionDefinition(migration, "chat_apply_user_stores"), /chat_sync_user_store_rooms/i)
  assert.match(functionDefinition(migration, "chat_add_members"), /chat_user_can_join_group_by_store/i)
})

test("chat.html requires store pick, later change, and filters 1:1 candidates", async () => {
  const chat = await read("public/chat.html")
  const knowledge = await read("supabase/functions/chat-knowledge/index.ts")

  assert.match(chat, /id="profileStorePick"/)
  assert.match(chat, /id="profileSettingsOverlay"/)
  assert.match(chat, /rpc\('chat_complete_signup'/)
  assert.match(chat, /rpc\('chat_request_store_change'/)
  assert.match(chat, /rpc\('chat_review_store_change'/)
  assert.match(chat, /function sharesAffiliationWith/)
  assert.match(chat, /function openProfileSettings/)
  assert.match(chat, /所属店舗を1つ以上選んでください/)
  assert.match(chat, /sharesAffiliationWith\(u\)/)
  assert.match(chat, /mtalk-stores:\(approve\|deny\)/)
  assert.doesNotMatch(chat, /href="\.\/chat-admin\.html"/)
  assert.doesNotMatch(chat, /\.from\('chat_users'\)[\s\S]{0,120}?\.insert\(/)

  assert.match(knowledge, /action === "store-change-notify"/)
  assert.match(knowledge, /mtalk-stores:approve:/)
  assert.match(knowledge, /所属店舗の変更/)
})
