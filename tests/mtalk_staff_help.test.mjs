import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const root = new URL("..", import.meta.url)
const read = (relative) => readFile(new URL(relative, root), "utf8")

const FORBIDDEN = [
  "chat_messages",
  "chat_groups",
  "chat_user_access",
  "service_role",
  "admin-api",
  "x-admin-token",
  "RLS",
  "pg_trgm",
  "supabase.co",
  "migration",
  "Edge Function",
  "RPC",
]

test("staff help page covers usage only and is linked from M-talk", async () => {
  const help = await read("public/mtalk-help.html")
  const chat = await read("public/chat.html")

  assert.match(help, /<h1>M-talk 使い方<\/h1>/)
  for (const heading of [
    "始める",
    "メッセージを送る",
    "画像・ファイル",
    "個人メモ・Keep・アルバム",
    "店舗Botとの1対1で使えるAI",
    "困ったとき",
  ]) {
    assert.ok(help.includes(heading), `missing heading: ${heading}`)
  }

  for (const word of FORBIDDEN) {
    assert.equal(help.toLowerCase().includes(word.toLowerCase()), false, `staff page must not mention ${word}`)
  }

  assert.match(chat, /href="\.\/mtalk-help\.html"/)
  assert.match(chat, />使い方</)
})
