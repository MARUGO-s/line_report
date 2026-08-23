import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const root = new URL("..", import.meta.url)
const read = (relative) => readFile(new URL(relative, root), "utf8")
const MIGRATION = "supabase/migrations/20260826050000_chat_private_notes.sql"

test("chat_private_notes is author-only: RLS enabled, no update policy, ownership enforced", async () => {
  const migration = await read(MIGRATION)

  assert.match(migration, /create table if not exists public\.chat_private_notes/i)
  assert.match(migration, /group_id\s+bigint\s+not null\s+references public\.chat_groups\s*\(id\)\s+on delete cascade/i)
  assert.match(migration, /user_id\s+uuid\s+not null\s+references public\.chat_users\s*\(id\)\s+on delete cascade/i)
  assert.match(migration, /constraint chat_private_notes_content_length check \(char_length\(content\) between 1 and 500\)/i)
  assert.match(migration, /alter table public\.chat_private_notes enable row level security/i)

  // select/insert/delete はすべて (select auth.uid()) 経由の本人限定。update ポリシーは無い(編集不可)。
  assert.match(migration, /create policy chat_private_notes_select_own on public\.chat_private_notes\s*\n\s*for select to authenticated\s*\n\s*using \(user_id = \(select auth\.uid\(\)\)\)/i)
  assert.match(migration, /create policy chat_private_notes_insert_own on public\.chat_private_notes\s*\n\s*for insert to authenticated\s*\n\s*with check \(\s*\n\s*user_id = \(select auth\.uid\(\)\)\s*\n\s*and public\.chat_can_view_group\(group_id\)/i)
  assert.match(migration, /create policy chat_private_notes_delete_own on public\.chat_private_notes\s*\n\s*for delete to authenticated\s*\n\s*using \(user_id = \(select auth\.uid\(\)\)\)/i)
  assert.doesNotMatch(migration, /create policy [a-z_]+ on public\.chat_private_notes\s*\n\s*for update/i)

  // anon にはポリシーを一切与えない(既存のchat_messages/chat_read_states と同じ全拒否パターン)。
  assert.doesNotMatch(migration, /to (anon|public)\b[\s\S]{0,40}chat_private_notes/i)
  for (const line of migration.split("\n")) {
    if (/create policy .* on public\.chat_private_notes/i.test(line)) continue
  }
  const policyBlocks = [...migration.matchAll(/create policy [a-z_]+ on public\.chat_private_notes[\s\S]*?;/gi)]
  assert.equal(policyBlocks.length, 3, "exactly select/insert/delete policies, no update")
  for (const block of policyBlocks) {
    assert.match(block[0], /to authenticated/i, "every policy scopes to authenticated only")
  }
})

test("private notes are added to Realtime so the author's own devices stay in sync", async () => {
  const migration = await read(MIGRATION)
  assert.match(migration, /alter publication supabase_realtime add table public\.chat_private_notes/i)
  // 既存の実装(chat_reactions等)と同じ、冪等な追加パターンを踏襲している。
  assert.match(migration, /if not exists \(\s*select 1 from pg_publication_tables\s*\n\s*where pubname = 'supabase_realtime' and schemaname = 'public'\s*\n\s*and tablename = 'chat_private_notes'/i)
})

test("the UI names this feature distinctly from the existing #メモ hashtag feature", async () => {
  const chat = await read("public/chat.html")
  // 「#メモ」(店舗ルームでJournal Reportの資料へ登録する既存機能)とは別物であることが
  // わかるよう、composer上の新機能は「個人メモ」と表示する。
  assert.match(chat, /id="composerNoteBtn"[^>]*>個人メモ</)
  assert.match(chat, /id="privateNoteOverlay"/)
  assert.match(chat, /個人メモを書く/)
})

test("the private-note composer states plainly that it never sends", async () => {
  const chat = await read("public/chat.html")
  assert.match(chat, /送信されません。ここに書いた内容は、このルームの自分のトーク履歴にだけ残ります。/)
})

test("saving and deleting a note goes through chat_private_notes only, never chat_messages", async () => {
  const chat = await read("public/chat.html")

  const saveFn = /async function savePrivateNote\(\)[\s\S]*?\n    \}/.exec(chat)
  assert.ok(saveFn, "savePrivateNote must be defined")
  assert.match(saveFn[0], /\.from\('chat_private_notes'\)\s*\n\s*\.insert\(\{ group_id: currentGroupId, user_id: currentUser\.id, content \}\)/)
  assert.doesNotMatch(saveFn[0], /chat_messages/)
  assert.doesNotMatch(saveFn[0], /chat-push/)

  const deleteFn = /async function deletePrivateNote\(noteId\)[\s\S]*?\n    \}/.exec(chat)
  assert.ok(deleteFn, "deletePrivateNote must be defined")
  assert.match(deleteFn[0], /\.from\('chat_private_notes'\)\.delete\(\)\.eq\('id', id\)/)
})

test("realtime note sync is scoped to the author's own user_id, not the whole room", async () => {
  const chat = await read("public/chat.html")
  assert.match(chat, /table: 'chat_private_notes', filter: `user_id=eq\.\$\{currentUser\.id\}` \},\s*\n\s*\(payload\) => handleIncomingNote/)
  assert.match(chat, /table: 'chat_private_notes', filter: `user_id=eq\.\$\{currentUser\.id\}` \},\s*\n\s*\(payload\) => handleDeletedNote/)
})

test("notes render as a distinct timeline item, separate from the message array and its side effects", async () => {
  const chat = await read("public/chat.html")

  // メッセージ配列とは別の状態を持ち、既存の返信/引用/削除/転送のロジックへ混ざらない。
  assert.match(chat, /let currentPrivateNotes = \[\];/)
  assert.match(chat, /function buildTimeline\(\)[\s\S]*?currentMessages\.map\(\(m\) => \(\{ ts: m\.created_at, kind: 'message', data: m \}\)\)/)
  assert.match(chat, /currentPrivateNotes\.forEach\(\(n\) => items\.push\(\{ ts: n\.created_at, kind: 'note', data: n \}\)\)/)

  // renderMessageList はマージ済みタイムラインを描画する。
  assert.match(chat, /function renderMessageList\(\)[\s\S]{0,200}buildTimeline\(\)\.forEach/)

  // 表示は buildMessageNode と区別された専用のノード。
  assert.match(chat, /function buildNoteNode\(note\)/)
  assert.match(chat, /item\.kind === 'note' \? buildNoteNode\(item\.data\) : buildMessageNode\(item\.data\)/)
})

test("private notes are excluded from message-only flows: reply, mention, search, forward", async () => {
  const chat = await read("public/chat.html")

  // resolveQuoted/loadQuotedMessages/openMessageMenu/openForward はいずれも currentMessages
  // だけを見る。個人メモをこれらに混ぜていないことを、buildNoteNode がメニュー用の
  // data-menu-for 属性を持たないことで確認する。
  const noteNodeFn = /function buildNoteNode\(note\)[\s\S]*?\n    \}/.exec(chat)
  assert.ok(noteNodeFn)
  assert.doesNotMatch(noteNodeFn[0], /data-menu-for/)
  assert.doesNotMatch(noteNodeFn[0], /reply_to_id/)
  assert.doesNotMatch(noteNodeFn[0], /mentions/)
})

test("state view cache (fast room switching) carries private notes alongside messages", async () => {
  const chat = await read("public/chat.html")
  assert.match(chat, /notes: \(currentPrivateNotes \|\| \[\]\)\.slice\(\),/)
  assert.match(chat, /currentPrivateNotes = cached\.notes \? cached\.notes\.slice\(\) : \[\];/)
})

test("chat.html inline script still compiles", async () => {
  const html = await read("public/chat.html")
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  assert.ok(blocks.length > 0)
  const vm = await import("node:vm")
  for (const block of blocks) {
    assert.doesNotThrow(() => new vm.default.Script(block), "inline script must parse")
  }
})
