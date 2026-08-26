import {
  buildCasualSystemPrompt,
  clampReplyForMtalk,
  formatCasualReplyForMtalk,
  generateCasualReply,
  isSoloHumanRoom,
} from "../supabase/functions/_shared/mtalk_casual_chat.ts"
import {
  buildMtalkHelpReference,
  isMtalkHelpQuestion,
  selectMtalkHelpSections,
} from "../supabase/functions/_shared/mtalk_help_manual.ts"

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

Deno.test("画像の送り方には画像・ファイルのマニュアルを選ぶ", () => {
  const selected = selectMtalkHelpSections("PDFや画像はどうやって送ればいいですか？")
  assertEquals(selected[0]?.section.id, "image-file")
  const reference = buildMtalkHelpReference("PDFや画像はどうやって送ればいいですか？")
  if (!reference.includes("入力欄左の「＋」")) {
    throw new Error("画像・ファイルの具体的な操作手順が参照文へ入りませんでした")
  }
})

Deno.test("通知が来ない質問には通知マニュアルを選ぶ", () => {
  const selected = selectMtalkHelpSections("iPhoneで通知が来ないときはどうすればいい？")
  assertEquals(selected[0]?.section.id, "notifications")
  const reference = buildMtalkHelpReference("iPhoneで通知が来ないときはどうすればいい？")
  if (!reference.includes("ホーム画面に追加") || !reference.includes("通知テスト")) {
    throw new Error("iPhone通知の切り分け手順が参照文へ入りませんでした")
  }
})

Deno.test("一般的な使い方質問にはM-talk全体概要を渡す", () => {
  assertEquals(isMtalkHelpQuestion("M-talkでは何ができますか？"), true)
  const reference = buildMtalkHelpReference("M-talkでは何ができますか？")
  if (
    !reference.includes("M-talk全体概要") ||
    !reference.includes("M-talk機能索引") ||
    !reference.includes("LINE Report / Journal Report 区分索引") ||
    !reference.includes("予約配信") ||
    !reference.includes("Keepメモ") ||
    !reference.includes("権限・閲覧専用")
  ) {
    throw new Error("全体概要と統合索引が参照文へ入りませんでした")
  }
})

Deno.test("仕組み・全体像の質問を使い方質問として扱う", () => {
  for (
    const q of [
      "M-talkの仕組みを教えて",
      "M-talkとは何ですか",
      "雑談AIとジャーナルに聞くの違いは？",
      "なぜ参加前のメッセージは見えないの？",
    ]
  ) {
    assertEquals(isMtalkHelpQuestion(q), true, q)
  }
})

Deno.test("仕組みの質問には全体像セクションを根拠として渡す", () => {
  const reference = buildMtalkHelpReference("M-talkの仕組みを教えて")
  if (
    !reference.includes("M-talkの仕組み・全体像") ||
    !reference.includes("AIは2種類あります") ||
    !reference.includes("権限は、M-talk全体の利用可否")
  ) {
    throw new Error("仕組み・全体像の説明が参照文へ入りませんでした")
  }
})

Deno.test("具体的な質問でも仕組みと全機能索引を必ず添える", () => {
  const reference = buildMtalkHelpReference("画像はどうやって送りますか？")
  // 質問に直接関係する詳細
  if (!reference.includes("入力欄左の「＋」")) {
    throw new Error("画像送信の具体手順が入りませんでした")
  }
  // 背景（仕組み）と、他機能への案内に使える統合索引を常に添える
  if (
    !reference.includes("M-talkの仕組み・全体像") ||
    !reference.includes("M-talk機能索引") ||
    !reference.includes("LINE Report / Journal Report 区分索引")
  ) {
    throw new Error("仕組みと全機能索引が常時添付されていません")
  }
})

Deno.test("通常の雑談には使い方マニュアルを注入しない", () => {
  assertEquals(isMtalkHelpQuestion("今日は暑いですね"), false)
  const system = buildCasualSystemPrompt({
    storeName: "テスト店",
    question: "今日は暑いですね",
  })
  if (system.includes("マニュアル（質問に関連する抜粋）")) {
    throw new Error("通常の雑談へ使い方マニュアルが注入されました")
  }
})

Deno.test("M-talkの使い方質問には関連マニュアルをシステム指示として渡す", () => {
  const system = buildCasualSystemPrompt({
    storeName: "テスト店",
    question: "個人メモは他の人に見えますか？",
  })
  if (
    !system.includes("LINE Report / Journal Report / M-talk 統合マニュアル") ||
    !system.includes("他の参加者、Bot、管理画面、Web Pushには表示されません")
  ) {
    throw new Error("個人メモのマニュアルがシステム指示へ入りませんでした")
  }
  if (!system.includes("マニュアルに書かれていない機能・場所・手順は推測で作らず")) {
    throw new Error("マニュアル外を推測しない安全指示がありません")
  }
})

Deno.test("数値質問はジャーナルに聞くを開くよう明確に案内する", () => {
  const system = buildCasualSystemPrompt({
    storeName: "テスト店",
    question: "先月の売上はいくらでしたか？",
  })
  if (!system.includes("「ジャーナルに聞く」を開いて確認してください")) {
    throw new Error("数値質問でジャーナルを開く明確な誘導が入りませんでした")
  }
  if (!system.includes("店舗の実データに基づく具体的な数字には絶対に答えないでください")) {
    throw new Error("数値を答えない安全指示がありません")
  }
})

Deno.test("AIへMarkdownを使わずM-talk向けプレーンテキストで答えるよう指示する", () => {
  const system = buildCasualSystemPrompt({
    storeName: "テスト店",
    question: "使用方法を教えてください",
  })
  if (
    !system.includes("Markdown記法") ||
    !system.includes("「- 項目名：説明」") ||
    !system.includes("空行を1行入れて")
  ) {
    throw new Error("M-talkの表示形式に合わせた出力指示がありません")
  }
  if (!system.includes("回答を文の途中で打ち切らないでください")) {
    throw new Error("使い方の説明を途中で切らない指示がありません")
  }
})

Deno.test("長すぎる返信は文の途中で切らず、句点までで止める", () => {
  const body = "一つ目の文です。二つ目の文です。三つ目の文です。"
  const clamped = clampReplyForMtalk(body, 14)
  // 14文字目は「二つ目の文」の途中だが、直前の句点までで止める。
  assertEquals(clamped, "一つ目の文です。")
  // 上限以内ならそのまま返す。
  assertEquals(clampReplyForMtalk(body, 999), body)
})

Deno.test("AIのMarkdown回答を読みやすいM-talk用テキストへ整形する", () => {
  const formatted = formatCasualReplyForMtalk([
    "M-talk の基本的な使い方は以下の通りです。",
    "",
    "- **ログイン／新規登録**：メールアドレスとパスワードでサインイン。",
    "- **画像・ファイル・スタンプ**：入力欄左の **「＋」** を押します。",
    "  - 「画像・ファイル」から写真や書類を選択",
    "  - 顔マーク **「☺」** からスタンプを選択",
    "## 検索",
    "[トーク検索](https://example.com)を利用できます。",
  ].join("\n"))

  assertEquals(formatted, [
    "M-talk の基本的な使い方は以下の通りです。",
    "",
    "▶ ログイン／新規登録",
    "　メールアドレスとパスワードでサインイン。",
    "",
    "▶ 画像・ファイル・スタンプ",
    "　入力欄左の「＋」を押します。",
    "　・「画像・ファイル」から写真や書類を選択",
    "　・顔マーク「☺」からスタンプを選択",
    "",
    "■ 検索",
    "トーク検索（https://example.com）を利用できます。",
  ].join("\n"))
})

Deno.test("Markdown表・コードフェンス・水平区切りをプレーンテキスト化する", () => {
  const formatted = formatCasualReplyForMtalk([
    "| 項目 | 操作 |",
    "|---|---|",
    "| 送信 | 紙飛行機を押す |",
    "---",
    "```",
    "Shift+Enterで改行",
    "```",
  ].join("\n"))

  assertEquals(formatted, [
    "項目：操作",
    "送信：紙飛行機を押す",
    "",
    "────────",
    "",
    "　Shift+Enterで改行",
  ].join("\n"))
})

Deno.test("GroqのMarkdown回答はgenerateCasualReplyの保存前経路で整形される", async () => {
  const originalFetch = globalThis.fetch
  Deno.env.set("GROQ_API_KEY", "test-key")
  let requestBody: Record<string, unknown> | null = null
  globalThis.fetch = (_input, init) => {
    requestBody = JSON.parse(String(init?.body || "{}"))
    return Promise.resolve(new Response(JSON.stringify({
      choices: [{
        message: {
          content: [
            "M-talkの使い方です。",
            "- **メッセージ送信**：入力欄へ文字を入力します。",
            "- **画像送信**：左の **「＋」** を押します。",
          ].join("\n"),
        },
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
  }

  const chain = {
    select: () => chain,
    eq: () => chain,
    lt: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: [], error: null }),
  }
  const sb = { from: () => chain }

  try {
    const result = await generateCasualReply(sb, {
      groupId: 1,
      messageId: 100,
      storeName: "テスト店",
      botUserId: "bot1",
      question: "使い方を教えて",
    })
    assertEquals(result, [
      "M-talkの使い方です。",
      "",
      "▶ メッセージ送信",
      "　入力欄へ文字を入力します。",
      "",
      "▶ 画像送信",
      "　左の「＋」を押します。",
    ].join("\n"))
    assertEquals(requestBody?.max_tokens, 2000, "gpt-ossの推論込み出力枠")
    assertEquals(requestBody?.max_completion_tokens, 2000, "gpt-ossの完了トークン枠")
    assertEquals(requestBody?.reasoning_effort, "low", "推論を抑えて本文枠を確保")
    assertEquals(requestBody?.reasoning_format, "hidden", "内部思考を本文へ出さない")
  } finally {
    globalThis.fetch = originalFetch
    Deno.env.delete("GROQ_API_KEY")
  }
})
