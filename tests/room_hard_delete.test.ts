import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const root = new URL("..", import.meta.url)
const read = (relative: string) => readFile(new URL(relative, root), "utf8")

test("room hard delete only touches exact room_id or one chat group", async () => {
  const shared = await read("supabase/functions/_shared/room_hard_delete.ts")
  const sql = await read("supabase/migrations/20260820230000_room_hard_delete.sql")
  const api = await read("supabase/functions/admin-api/index.ts")
  const chat = await read("public/chat.html")
  const admin = await read("public/index.html")

  assert.match(shared, /const ROOM_ID_TABLES/)
  assert.match(shared, /\.eq\("room_id", roomId\)/)
  assert.match(shared, /\.eq\("id", id\)/)
  assert.match(shared, /\.eq\("created_by", actor\)/)
  assert.match(shared, /\.eq\("is_store_room", false\)/)
  assert.doesNotMatch(shared, /line_receipt__/)
  assert.doesNotMatch(shared, /tabelog_reservation_visit_events/)
  assert.doesNotMatch(shared, /ikyu_reservation_visit_events/)
  assert.doesNotMatch(shared, /manual_reservation_visit_events/)
  assert.doesNotMatch(shared, /store_knowledge/)
  assert.match(shared, /is_store_room/)
  assert.match(shared, /店舗固定ルームは削除できません/)
  assert.match(shared, /groups\/\$\{groupId\}\//)

  assert.match(sql, /drop_line_room_message_table/)
  assert.match(sql, /line_messages__r\[0-9a-f\]\{16\}/)
  assert.match(sql, /revoke all on function public\.drop_line_room_message_table/)
  assert.match(sql, /grant execute on function public\.drop_line_room_message_table\(text\) to service_role/)

  assert.match(api, /path === "\/chat-room-purge"/)
  assert.match(api, /path === "\/rooms\/purge"/)
  assert.match(api, /async function handleChatRoomPurge/)
  const purgeAt = api.indexOf('path === "/chat-room-purge"')
  const adminAuthAt = api.lastIndexOf("const authResult = await authenticate(")
  assert.ok(purgeAt > 0 && purgeAt < adminAuthAt)

  assert.match(chat, /id="talkCtxPurge"/)
  assert.match(chat, /function canPurgeTalk/)
  assert.match(chat, /function purgeTalk/)
  assert.match(chat, /\/chat-room-purge/)
  assert.match(chat, /confirm_name/)
  assert.match(chat, /店舗固定ルームは退出・削除できません/)
  assert.match(chat, /group\.created_by === currentUser\.id/)

  assert.match(admin, /webhook-room-purge/)
  assert.match(admin, /function purgeRoomRow/)
  assert.match(admin, /\/rooms\/purge/)
  assert.match(admin, /confirm_room_id/)
})
