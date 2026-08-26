import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const root = new URL("..", import.meta.url)
const read = (relative) => readFile(new URL(relative, root), "utf8")

test("M-talk管理画面だけがルームのゴミ箱・復元・完全削除を操作できる", async () => {
  const [migration, api, admin, chat, shared] = await Promise.all([
    read("supabase/migrations/20260901020000_chat_admin_room_trash_and_bot_archive.sql"),
    read("supabase/functions/admin-api/index.ts"),
    read("public/chat-admin.html"),
    read("public/chat.html"),
    read("supabase/functions/_shared/room_hard_delete.ts"),
  ])

  for (const rpc of ["chat_admin_trash_group", "chat_admin_restore_group"]) {
    assert.match(migration, new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${rpc}`, "i"))
    assert.match(migration, new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${rpc}[^;]+from\\s+public,\\s*anon,\\s*authenticated`, "i"))
    assert.match(migration, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${rpc}[^;]+to\\s+service_role`, "i"))
  }
  assert.match(migration, /店舗固定ルームはゴミ箱へ移動できません/)
  assert.match(migration, /perform set_config\('chat\.allow_trash', '1', true\)/)
  assert.match(migration, /'room_trash'/)
  assert.match(migration, /'room_restore'/)

  assert.match(api, /roomActionMatch/)
  assert.match(api, /\/chat-admin\\\/rooms\\\/\(\\d\+\)\\\/\(trash\|restore\|purge\)/)
  assert.match(api, /trashChatAdminRoom/)
  assert.match(api, /restoreChatAdminRoom/)
  assert.match(api, /purgeChatAdminRoom/)
  assert.match(api, /purgeMtalkGroupAsAdmin/)
  assert.match(api, /確認用のルーム名が一致しません/)
  assert.match(api, /action:\s*"room_purge"/)
  const chatAdminGuard = api.indexOf('if (path === "/chat-admin" || path.startsWith("/chat-admin/"))')
  const roomRoute = api.indexOf("const roomActionMatch")
  assert.ok(chatAdminGuard > 0 && roomRoute > chatAdminGuard, "room admin routes must stay inside the headquarters-only chat-admin guard")

  assert.match(shared, /export async function purgeMtalkGroupAsAdmin/)
  assert.match(shared, /\.eq\("is_store_room", false\)/)
  assert.match(shared, /\.not\("trashed_at", "is", null\)/)
  assert.match(shared, /先にゴミ箱へ入れてから完全削除してください/)

  assert.match(admin, /data-room-tab="trash"/)
  assert.match(admin, /data-trash-room/)
  assert.match(admin, /data-restore-room/)
  assert.match(admin, /data-purge-room/)
  assert.match(admin, /function trashRoom/)
  assert.match(admin, /function restoreRoom/)
  assert.match(admin, /function purgeRoom/)
  assert.match(admin, /state\.selectedRoomId = rooms\.length \? Number\(rooms\[0\]\.id\) : null/)
  assert.match(admin, /完全削除すると、このルームのメッセージ・画像・予定は復元できません/)
  assert.match(admin, /店舗固定ルームは削除不可/)

  // 通常のM-talk側は従来どおり作成者・管理権限の経路だけ。管理者専用APIを追加しない。
  assert.doesNotMatch(chat, /\/chat-admin\/rooms\//)
})

test("Botは管理画面専用の論理削除で、通常画面からは削除できない", async () => {
  const [migration, api, admin, chat, bridge, storeBridge, roomSettings, search, knowledge] = await Promise.all([
    read("supabase/migrations/20260901020000_chat_admin_room_trash_and_bot_archive.sql"),
    read("supabase/functions/admin-api/index.ts"),
    read("public/chat-admin.html"),
    read("public/chat.html"),
    read("supabase/functions/_shared/chat_bridge.ts"),
    read("supabase/functions/_shared/chat_store_file_bridge.ts"),
    read("supabase/functions/_shared/mtalk_room_settings.ts"),
    read("supabase/functions/chat-search/index.ts"),
    read("supabase/functions/chat-knowledge/index.ts"),
  ])

  assert.match(migration, /add column if not exists bot_deleted_at/)
  assert.match(migration, /add column if not exists bot_deleted_by/)
  assert.match(migration, /create trigger chat_messages_reject_deleted_bot/)
  assert.match(migration, /削除済みBotからは送信できません/)
  assert.match(migration, /create or replace function public\.chat_admin_remove_bot/)
  assert.match(migration, /create or replace function public\.chat_admin_restore_bot/)
  assert.match(migration, /確認用のBot名が一致しません/)
  assert.match(migration, /'bot_remove'/)
  assert.match(migration, /'bot_restore'/)
  for (const rpc of ["chat_admin_remove_bot", "chat_admin_restore_bot"]) {
    assert.match(migration, new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${rpc}[^;]+from\\s+public,\\s*anon,\\s*authenticated`, "i"))
    assert.match(migration, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${rpc}[^;]+to\\s+service_role`, "i"))
  }
  assert.doesNotMatch(migration, /delete\s+from\s+public\.chat_users/i)
  assert.doesNotMatch(api, /auth\.admin\.deleteUser/)

  assert.match(api, /botActionMatch/)
  assert.match(api, /removeChatAdminBot/)
  assert.match(api, /restoreChatAdminBot/)
  assert.match(api, /bot_deleted_at, bot_deleted_by/)
  const chatAdminGuard = api.indexOf('if (path === "/chat-admin" || path.startsWith("/chat-admin/"))')
  const botRoute = api.indexOf("const botActionMatch")
  assert.ok(chatAdminGuard > 0 && botRoute > chatAdminGuard, "bot admin routes must stay inside the headquarters-only chat-admin guard")

  assert.match(admin, /data-remove-bot/)
  assert.match(admin, /data-restore-bot/)
  assert.match(admin, /function removeBot/)
  assert.match(admin, /function restoreBot/)
  assert.match(admin, /通常のM-talk画面からは削除できません/)
  assert.doesNotMatch(chat, /data-remove-bot/)
  assert.doesNotMatch(chat, /\/chat-admin\/bots\//)

  for (const source of [bridge, storeBridge, roomSettings, search]) {
    assert.match(source, /bot_deleted_at/)
  }
  assert.match(knowledge, /store bot deleted or missing/)
  assert.match(knowledge, /const activeStoreBot/)
})
