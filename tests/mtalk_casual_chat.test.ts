import { generateCasualReply, isSoloHumanRoom } from "../supabase/functions/_shared/mtalk_casual_chat.ts"

function assertEquals(actual: unknown, expected: unknown, label = ""): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`assertEquals failed ${label}\nactual: ${a}\nexpected: ${e}`)
}

function fakeSupabase(members: Array<{ user_id: string; is_bot: boolean }>) {
  return {
    from(table: string) {
      if (table !== "chat_group_members") throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: () =>
            Promise.resolve({
              data: members.map((m) => ({ user_id: m.user_id, chat_users: { is_bot: m.is_bot } })),
              error: null,
            }),
        }),
      }
    },
  }
}

Deno.test("人間が本人1人だけなら true", async () => {
  const sb = fakeSupabase([
    { user_id: "me", is_bot: false },
    { user_id: "bot1", is_bot: true },
  ])
  assertEquals(await isSoloHumanRoom(sb, 1, "me"), true)
})

Deno.test("人間が2人いれば false（本人が含まれていても）", async () => {
  const sb = fakeSupabase([
    { user_id: "me", is_bot: false },
    { user_id: "other", is_bot: false },
    { user_id: "bot1", is_bot: true },
  ])
  assertEquals(await isSoloHumanRoom(sb, 1, "me"), false)
})

Deno.test("人間1人だが本人でなければ false（なりすまし防止）", async () => {
  const sb = fakeSupabase([
    { user_id: "someone-else", is_bot: false },
    { user_id: "bot1", is_bot: true },
  ])
  assertEquals(await isSoloHumanRoom(sb, 1, "me"), false)
})

Deno.test("GROQ_API_KEY が無ければ null を返し例外を投げない", async () => {
  Deno.env.delete("GROQ_API_KEY")
  const sb = {
    from: () => {
      throw new Error("呼ばれてはいけない")
    },
  }
  const result = await generateCasualReply(sb, {
    groupId: 1,
    messageId: 100,
    storeName: "テスト店",
    botUserId: "bot1",
    question: "こんにちは",
  })
  assertEquals(result, null)
})

Deno.test("質問が空文字なら null を返す", async () => {
  const sb = {
    from: () => {
      throw new Error("呼ばれてはいけない")
    },
  }
  const result = await generateCasualReply(sb, {
    groupId: 1,
    messageId: 100,
    storeName: "テスト店",
    botUserId: "bot1",
    question: "   ",
  })
  assertEquals(result, null)
})
