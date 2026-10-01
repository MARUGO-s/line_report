import assert from "node:assert/strict"
import test from "node:test"
import {
  activeRecipients,
  AI_ANALYSIS_BOT_ID,
  AI_CHAT_GENERIC_ERROR,
  AI_CHAT_LIMITS,
  AI_CHAT_PATH,
  AI_CHAT_STATUS,
  aiChatEligibility,
  aiChatErrorMessage,
  aiChatReplyParts,
  aiChatRequestBody,
  buildAiChatHistory,
  DEFAULT_GOURMET_AI_ANALYST_URL,
  gourmetAiAnalystUrl,
  buildAiReportCard,
  decodePdfBase64,
  EXTERNAL_POST_LIMITS,
  sanitizePdfFileName,
  signExternalRequest,
  validateSendInput,
  verifyExternalRequest,
  alertRooms,
  alertUrl,
  buildReviewAlertCards,
  storeBotList,
  REVIEW_ALERT_KIND,
  REVIEW_ALERT_LIMITS,
  validateAlertInput,
  AI_CHAT_CHOICE_KIND,
  AI_CHAT_LIVE_KIND,
  AI_CHAT_LIVE_LIMITS,
  AI_CHAT_LIVE_REPLY_PATH,
  AI_CHOICE_COMMANDS,
  AI_CHOICE_LABELS,
  aiChatChoice,
  aiChatLiveClose,
  aiChatLiveDedupeKey,
  aiChatLiveStart,
  buildAiChoiceCard,
  chatReplyDecision,
  validateChatReplyInput,
} from "../supabase/functions/_shared/mtalk_external_post.ts"

const SECRET = "s".repeat(48)
const NOW = 1_790_000_000_000
const pdfBytes = new TextEncoder().encode("%PDF-1.7\n" + "x".repeat(200) + "\n%%EOF")
const pdfB64 = btoa(String.fromCharCode(...pdfBytes))

async function signed(overrides: Partial<{ authorization: string | null; timestamp: string | null; signature: string | null; method: string; path: string; body: string }> = {}) {
  const timestamp = String(Math.floor(NOW / 1000))
  const base = { method: "POST", path: "/send", body: '{"a":1}', timestamp }
  const signature = await signExternalRequest(SECRET, base)
  return { authorization: `Bearer ${SECRET}`, signature, ...base, ...overrides }
}

test("external post auth requires token, fresh timestamp, and a matching HMAC", async () => {
  assert.equal(await verifyExternalRequest(await signed(), SECRET, NOW), true)
  assert.equal(await verifyExternalRequest(await signed({ authorization: null }), SECRET, NOW), false)
  assert.equal(await verifyExternalRequest(await signed({ authorization: `Bearer ${"t".repeat(48)}` }), SECRET, NOW), false)
  assert.equal(await verifyExternalRequest(await signed({ signature: null }), SECRET, NOW), false)
  // 本文・パス・メソッドの改ざん
  assert.equal(await verifyExternalRequest(await signed({ body: '{"a":2}' }), SECRET, NOW), false)
  assert.equal(await verifyExternalRequest(await signed({ path: "/recipients" }), SECRET, NOW), false)
  assert.equal(await verifyExternalRequest(await signed({ method: "GET" }), SECRET, NOW), false)
  // 5分を超える時刻ずれ
  assert.equal(await verifyExternalRequest(await signed(), SECRET, NOW + 301_000), false)
  assert.equal(await verifyExternalRequest(await signed(), SECRET, NOW - 301_000), false)
  assert.equal(await verifyExternalRequest(await signed(), SECRET, NOW + 299_000), true)
  // 未設定・短い秘密情報では常に拒否
  assert.equal(await verifyExternalRequest(await signed(), "", NOW), false)
  assert.equal(await verifyExternalRequest({ ...(await signed()), authorization: "Bearer short" }, "short", NOW), false)
})

test("signature matches the gourmet ai-analyst client (shared test vector)", async () => {
  // gourmet server/tests/mtalk-share.test.js が同じ値を検証する
  assert.equal(
    await signExternalRequest("t".repeat(40), { timestamp: "1790000000", method: "POST", path: "/send", body: '{"x":1}' }),
    "v1=3c1f2de63d53099311e5d2618d4349120bad3133005317b5810d823f885e8ca4",
  )
})

test("send input is validated and bounded", () => {
  const good = {
    recipient_user_id: "11111111-2222-4333-8444-555555555555",
    report_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    sender_label: "山田 太郎",
    title: "BISTRO CAVACAVA 分析レポート",
    dedupe_key: "gourmet:share:0123456789",
    card: {
      subtitle: "2026-07-01〜2026-09-29",
      fields: [{ label: "店舗", value: "BISTRO CAVACAVA" }, { label: "", value: "x" }, ...Array.from({ length: 20 }, (_, i) => ({ label: `L${i}`, value: "v" }))],
      highlights: Array.from({ length: 9 }, (_, i) => `要点${i}`.padEnd(400, "あ")),
      recommendations: ["口コミへ返信する"],
    },
    pdf_base64: pdfB64,
    filename: "BISTRO CAVACAVA レポート 2026-09.pdf",
  }
  const v = validateSendInput(good)
  assert.equal(v.card.fields.length, EXTERNAL_POST_LIMITS.fieldsMax - 1)
  assert.equal(v.card.highlights.length, EXTERNAL_POST_LIMITS.listItemsMax)
  assert.ok([...v.card.highlights[0]].length <= EXTERNAL_POST_LIMITS.listItemMax)
  assert.equal(v.fileName, "BISTRO CAVACAVA _ 2026-09.pdf")
  assert.equal(v.pdf.byteLength, pdfBytes.byteLength)
  assert.throws(() => validateSendInput({ ...good, recipient_user_id: "x" }), /送信先/)
  assert.throws(() => validateSendInput({ ...good, dedupe_key: "a b" }), /dedupe_key/)
  assert.throws(() => validateSendInput({ ...good, sender_label: " " }), /送信者/)
  assert.throws(() => validateSendInput({ ...good, pdf_base64: btoa("hello world, not a pdf at all".repeat(4)) }), /PDF/)
  assert.throws(() => validateSendInput({ ...good, pdf_base64: "@@@" }), /PDF/)
  assert.throws(() => decodePdfBase64(pdfB64, 10), /大きすぎ/)
})

test("pdf file names keep only characters M-talk accepts for uploads", () => {
  assert.equal(sanitizePdfFileName("../../etc/passwd"), "etc_passwd.pdf")
  assert.equal(sanitizePdfFileName("日本語だけ"), "ai-report.pdf")
  assert.match(sanitizePdfFileName("a".repeat(500)), /^a{116}\.pdf$/)
})

test("card shows sender, fields, key points and recommendations without actions", () => {
  const { text, cards } = buildAiReportCard({
    title: "BISTRO CAVACAVA 分析レポート",
    senderLabel: "山田 太郎",
    fileName: "report.pdf",
    card: { subtitle: "期間", fields: [{ label: "店舗", value: "BISTRO CAVACAVA" }], highlights: ["PVが増加"], recommendations: ["返信率を上げる"], note: "" },
  })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].header.eyebrow, "AI分析レポート")
  assert.deepEqual(cards[0].actions, [])
  const first = cards[0].sections[0] as { type: string; rows: { label: string; value: string }[] }
  assert.deepEqual(first.rows[0], { label: "送信者", value: "山田 太郎", weight: "bold" })
  assert.match(JSON.stringify(cards), /・PVが増加/)
  assert.match(JSON.stringify(cards), /1\. 返信率を上げる/)
  assert.match(JSON.stringify(cards), /report\.pdf/)
  assert.match(text, /^\[AI分析レポート\] BISTRO CAVACAVA/)
  assert.match(text, /送信者: 山田 太郎/)
  assert.ok(text.length <= 2000)
})

test("recipients are active non-bot users with store names", () => {
  const rows = activeRecipients(
    [
      { id: "u1", username: "佐藤", is_bot: false },
      { id: "u2", username: "鈴木", is_bot: false },
      { id: "u3", username: "停止中", is_bot: false },
      { id: "u4", username: "削除", is_bot: false },
      { id: AI_ANALYSIS_BOT_ID, username: "AI分析", is_bot: true },
      { id: "u5", username: "制限中", is_bot: false },
      { id: "u6", username: "アクセス行なし", is_bot: false },
    ],
    [
      { user_id: "u1", access_enabled: true, deleted_at: null, restricted_until: null },
      { user_id: "u2", access_enabled: true, deleted_at: null, restricted_until: new Date(NOW - 1000).toISOString() },
      { user_id: "u3", access_enabled: false, deleted_at: null, restricted_until: null },
      { user_id: "u4", access_enabled: true, deleted_at: new Date(NOW).toISOString(), restricted_until: null },
      { user_id: AI_ANALYSIS_BOT_ID, access_enabled: true, deleted_at: null, restricted_until: null },
      { user_id: "u5", access_enabled: true, deleted_at: null, restricted_until: new Date(NOW + 60_000).toISOString() },
    ],
    [{ user_id: "u1", store_key: "cavacava" }, { user_id: "u1", store_key: "unknown_key" }],
    [{ store_key: "cavacava", display_name: "BISTRO CAVACAVA" }],
    NOW,
  )
  assert.deepEqual(rows.map((r) => r.id).sort(), ["u1", "u2"])
  assert.deepEqual(rows.find((r) => r.id === "u1")?.stores, ["BISTRO CAVACAVA", "unknown_key"])
})

test("migration adds a store-less AI bot and a service_role-only direct RPC", async () => {
  const sql = await Deno.readTextFile(new URL("../supabase/migrations/20261001000000_chat_ai_analysis_bot.sql", import.meta.url))
  assert.match(sql, /00000000-0000-4000-8000-00000000b073/)
  assert.match(sql, /ai-analysis-bot@marugo\.invalid/)
  assert.match(sql, /'infinity'/)
  assert.match(sql, /values \('00000000-0000-4000-8000-00000000b073', 'AI分析', true\)/)
  assert.match(sql, /create or replace function public\.chat_ensure_bot_direct\(p_bot uuid, p_user uuid\)/)
  assert.match(sql, /security definer\s+set search_path = pg_catalog, public/)
  assert.match(sql, /chat_has_active_access\(p_user\)/)
  assert.match(sql, /bot_deleted_at is null/)
  assert.match(sql, /hidden_at = null/)
  assert.match(sql, /trashed_at = null/)
  assert.match(sql, /revoke all on function public\.chat_ensure_bot_direct\(uuid, uuid\)\s+from public, anon, authenticated/)
  assert.match(sql, /grant execute on function public\.chat_ensure_bot_direct\(uuid, uuid\) to service_role;/)
  assert.doesNotMatch(sql, /to authenticated/)
})

test("edge function is JWT-less but gated by the external token, without CORS", async () => {
  const src = await Deno.readTextFile(new URL("../supabase/functions/mtalk-external-post/index.ts", import.meta.url))
  const config = await Deno.readTextFile(new URL("../supabase/config.toml", import.meta.url))
  assert.match(config, /\[functions\.mtalk-external-post\]\s+verify_jwt = false/)
  assert.match(src, /verifyExternalRequest\(/)
  assert.match(src, /GOURMET_MTALK_TOKEN/)
  // 外部（gourmet）向けのルートは、DBクライアントを作る前に署名を検証する。
  // /chat-dispatch だけは DB の dispatch_secret で認証するため先に分岐し、秘密の照合前に他の表を読まない（下のテスト）。
  const serve = src.slice(src.indexOf("Deno.serve("))
  assert.ok(serve.indexOf("verifyExternalRequest(") < serve.lastIndexOf("createClient(Deno.env"), "auth must run before the external-route DB client is created")
  assert.ok(serve.indexOf('path === "/chat-dispatch"') < serve.indexOf("verifyExternalRequest("), "chat-dispatch is routed before the external HMAC check")
  assert.doesNotMatch(src, /Access-Control-Allow-Origin/)
  assert.match(src, /is_silent: true/)
  assert.match(src, /groups\/\$\{groupId\}\/ai-reports\//)
})

// ---------- 「AI分析」Bot への質問 ----------
const HUMAN = "3186a986-547f-41c0-81c2-56f9427e123c"
const OTHER = "f97f9658-bab0-4b3c-aea2-52a4d48e42e8"
const directKey = [HUMAN, AI_ANALYSIS_BOT_ID].sort().join(":")
const okInput = () => ({
  message: { id: 900, group_id: 44, user_id: HUMAN, content: "先月のPVは？", kind: "text" },
  group: { id: 44, is_direct: true, direct_key: directKey, trashed_at: null },
  sender: { id: HUMAN, is_bot: false },
  access: { access_enabled: true, deleted_at: null, restricted_until: null },
  botIsMember: true,
})

test("reverse direction (M-talk → gourmet /mtalk-chat) uses the same signature rule (shared test vector)", async () => {
  // gourmet server/tests/mtalk-chat.test.js が同じ値を検証する
  assert.equal(AI_CHAT_PATH, "/mtalk-chat")
  assert.equal(await signExternalRequest("t".repeat(40), { timestamp: "1790000000", method: "POST", path: "/mtalk-chat", body: '{"x":1}' }),
    "v1=7322a31eab25dfd2285f7d59eda5e40521e644ac5a90a22c2e9025b6425a5811")
})

test("AI chat answers only human text messages in the AI bot's own 1-to-1", () => {
  assert.deepEqual(aiChatEligibility(okInput(), NOW), { ok: true })
  const cases: [string, (i: ReturnType<typeof okInput>) => void][] = [
    ["self", (i) => { i.message.user_id = AI_ANALYSIS_BOT_ID }],
    ["kind", (i) => { i.message.kind = "card" }],
    ["kind", (i) => { i.message.kind = "file" }],
    ["empty", (i) => { i.message.content = "  " }],
    ["room", (i) => { i.group.is_direct = false }],
    ["room", (i) => { i.group.trashed_at = "2026-09-30T00:00:00Z" }],
    ["room", (i) => { i.group.direct_key = [HUMAN, OTHER].sort().join(":") }],
    ["room", (i) => { i.group.direct_key = [OTHER, AI_ANALYSIS_BOT_ID].sort().join(":") }],
    ["room", (i) => { i.botIsMember = false }],
    ["sender", (i) => { i.sender.is_bot = true }],
    ["access", (i) => { i.access.access_enabled = false }],
    ["access", (i) => { i.access.deleted_at = "2026-09-01T00:00:00Z" }],
    ["access", (i) => { i.access.restricted_until = new Date(NOW + 60_000).toISOString() }],
  ]
  for (const [reason, mutate] of cases) {
    const input = okInput()
    mutate(input)
    assert.deepEqual(aiChatEligibility(input, NOW), { ok: false, reason })
  }
  const expired = okInput()
  expired.access.restricted_until = new Date(NOW - 60_000).toISOString()
  assert.deepEqual(aiChatEligibility(expired, NOW), { ok: true })
})

test("AI chat history is chronological, role-mapped, bounded, and hides file contents", () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({
    id: 100 + i, group_id: 44, user_id: i % 2 ? AI_ANALYSIS_BOT_ID : HUMAN, kind: "text", content: `m${i}`,
  }))
  rows.push({ id: 200, group_id: 44, user_id: AI_ANALYSIS_BOT_ID, kind: "card", content: "[AI分析レポート] 店A\n送信者: X" })
  rows.push({ id: 201, group_id: 44, user_id: AI_ANALYSIS_BOT_ID, kind: "file", content: "[AI-report.pdf]" })
  rows.push({ id: 202, group_id: 44, user_id: HUMAN, kind: "image", content: "[画像]" })
  const h = buildAiChatHistory(rows.reverse())
  assert.equal(h.length, AI_CHAT_LIMITS.historyMessages)
  assert.deepEqual(h.at(-2), { role: "assistant", content: "[AI分析レポート] 店A\n送信者: X" })
  assert.deepEqual(h.at(-1), { role: "assistant", content: "[PDFなどのファイル] [AI-report.pdf]" })
  assert.ok(h.every((m) => m.role === "user" || m.role === "assistant"))
  assert.ok(!h.some((m) => m.content === "[画像]"), "images are not sent")
  const body = JSON.parse(aiChatRequestBody({ id: 900, group_id: 44, user_id: HUMAN, content: " 質問 ", kind: "text" }, h))
  assert.deepEqual(Object.keys(body).sort(), ["history", "message_id", "mtalk_group_id", "mtalk_user_id", "question"])
  assert.equal(body.question, "質問")
})

test("AI chat replies are bounded and failures become short friendly messages", () => {
  assert.deepEqual(aiChatReplyParts({ parts: ["a", "", "b".repeat(2500), "c", "d"] }).map((p) => p.length), [1, 2000, 1])
  assert.deepEqual(aiChatReplyParts(null), [])
  assert.match(aiChatErrorMessage(429, { error: "質問は1時間に60回までです。" }), /^すみません、質問は1時間に60回まで/)
  assert.equal(aiChatErrorMessage(500, { error: "SQL detail leak" }), AI_CHAT_GENERIC_ERROR)
  assert.equal(aiChatErrorMessage(401, { error: "unauthorized" }), AI_CHAT_GENERIC_ERROR)
  assert.equal(aiChatErrorMessage(504, null), AI_CHAT_GENERIC_ERROR)
  assert.equal(gourmetAiAnalystUrl(null), DEFAULT_GOURMET_AI_ANALYST_URL)
  assert.equal(gourmetAiAnalystUrl("http://evil.example/functions/v1/ai-analyst"), DEFAULT_GOURMET_AI_ANALYST_URL)
  assert.equal(gourmetAiAnalystUrl("https://evil.example/steal"), DEFAULT_GOURMET_AI_ANALYST_URL)
  assert.equal(gourmetAiAnalystUrl("https://x.supabase.co/functions/v1/ai-analyst/"), "https://x.supabase.co/functions/v1/ai-analyst")
})

test("AI chat trigger ignores bot messages and dispatches with the internal secret only", async () => {
  const sql = await Deno.readTextFile(new URL("../supabase/migrations/20261001010000_chat_ai_analysis_bot_replies.sql", import.meta.url))
  assert.match(sql, /new\.user_id = v_bot then\s+return new/)
  assert.match(sql, /u\.is_bot\) then\s+return new/)
  assert.match(sql, /coalesce\(new\.kind, 'text'\) <> 'text'/)
  assert.match(sql, /g\.direct_key in \(v_bot::text \|\| ':' \|\| new\.user_id::text, new\.user_id::text \|\| ':' \|\| v_bot::text\)/)
  assert.match(sql, /chat_push_internal_config/)
  assert.match(sql, /mtalk-external-post\/chat-dispatch/)
  assert.match(sql, /exception when others then\s+return new/)
  assert.match(sql, /revoke all on function public\.chat_enqueue_ai_analysis_reply\(\) from public, anon, authenticated/)
  assert.match(sql, /after insert on public\.chat_messages/)
  assert.doesNotMatch(sql, /GOURMET_MTALK_TOKEN|OPENAI/)
})

test("chat-dispatch checks the internal secret first, dedupes, answers in background, and never holds the OpenAI key", async () => {
  const src = await Deno.readTextFile(new URL("../supabase/functions/mtalk-external-post/index.ts", import.meta.url))
  const fn = src.slice(src.indexOf("async function chatDispatch"), src.indexOf("async function answerInBackground"))
  const auth = fn.indexOf("constantTimeEqualSecret(token, secret)")
  assert.ok(auth > 0)
  assert.ok(auth < fn.indexOf('from("chat_messages")'), "secret is checked before reading messages")
  assert.ok(fn.indexOf("aiChatEligibility(") < fn.indexOf('from("chat_alert_dispatches")'))
  assert.match(fn, /dedupe_key: `msg:\$\{messageId\}`/)
  assert.match(fn, /waitUntil\(work\)/)
  assert.match(src, /signExternalRequest\(token, \{ timestamp, method: "POST", path: AI_CHAT_PATH, body \}\)/)
  assert.doesNotMatch(src, /OPENAI_API_KEY|api\.openai\.com/)
  assert.doesNotMatch(src, /console\.\w+\([^)]*(token|secret|content|question|history)/i)
})

test("AI chat: failures and timeouts always end in a reply, answered/timed_out decided once", async () => {
  // gourmet への問い合わせは Edge Function の実行時間の上限（150秒）と2分の見張りより前に打ち切る
  assert.equal(AI_CHAT_LIMITS.timeoutMs, 100_000)
  assert.ok(AI_CHAT_LIMITS.timeoutMs < AI_CHAT_LIMITS.replyDeadlineSeconds * 1000)
  assert.equal(AI_CHAT_GENERIC_ERROR, "すみません、返事に時間がかかっています。エラーが起きた可能性があるので、もう一度送ってください。")
  assert.equal(aiChatErrorMessage(504, null), AI_CHAT_GENERIC_ERROR)
  assert.deepEqual({ ...AI_CHAT_STATUS }, { pending: "pending", answered: "answered", failed: "failed", timedOut: "timed_out" })

  const src = await Deno.readTextFile(new URL("../supabase/functions/mtalk-external-post/index.ts", import.meta.url))
  const dispatch = src.slice(src.indexOf("async function chatDispatch"), src.indexOf("async function finishDispatch"))
  assert.match(dispatch, /dedupe_key: `msg:\$\{messageId\}`, status: AI_CHAT_STATUS\.pending/)
  const finish = src.slice(src.indexOf("async function finishDispatch"), src.indexOf("async function recordReply"))
  assert.match(finish, /\.update\(\{ status, finished_at:/)
  assert.match(finish, /\.eq\("status", AI_CHAT_STATUS\.pending\)/)
  assert.match(finish, /\.select\("id"\)/)
  const answer = src.slice(src.indexOf("async function answerInBackground"), src.indexOf("Deno.serve("))
  // 確定してから送る。確定できなければ（見張りが案内済み）答えを捨てる
  assert.ok(answer.indexOf("finishDispatch(") < answer.indexOf("postBotText("))
  assert.match(answer, /if \(!await finishDispatch\([^)]*\)\) \{\s+console\.error\([^)]*\)\s+return\s+\}/)
  // 1通目を送ったらすぐ記録（見張りの二重送信を防ぐ）
  assert.match(answer, /replyId = id\s+\/\/[^\n]*\n\s+await recordReply\(/)
  // 例外時: 未確定なら failed に確定してから案内
  assert.match(answer, /finished \|\| await finishDispatch\(supabase, groupId, messageId, AI_CHAT_STATUS\.failed\)/)
  assert.match(answer, /postBotText\(supabase, groupId, AI_CHAT_GENERIC_ERROR\)/)
  assert.match(src, /signal: AbortSignal\.timeout\(AI_CHAT_LIMITS\.timeoutMs\)/)
})

test("AI chat timeout sweep: pg_cron via the high-frequency dispatcher posts one notice per stuck question", async () => {
  const sql = await Deno.readTextFile(new URL("../supabase/migrations/20261001030000_chat_ai_analysis_reply_timeouts.sql", import.meta.url))
  assert.match(sql, /add column if not exists status text/)
  assert.match(sql, /check \(status is null or status in \('pending', 'answered', 'failed', 'timed_out'\)\)/)
  // 既存の行は見張りの対象外
  assert.match(sql, /set status = case when message_id is null then 'timed_out' else 'answered' end/)
  const fn = sql.slice(sql.indexOf("create or replace function public.chat_ai_analysis_reply_timeouts"), sql.indexOf("revoke all on function public.chat_ai_analysis_reply_timeouts"))
  assert.match(fn, /security definer\s+set search_path = public/)
  assert.match(fn, /d\.status = 'pending' and d\.created_at < now\(\) - interval '2 minutes'/)
  assert.match(fn, /d\.status in \('answered', 'failed'\) and d\.finished_at < now\(\) - interval '2 minutes'/)
  assert.match(fn, /d\.message_id is null/)
  assert.match(fn, /for update skip locked/)
  assert.match(fn, /set status = 'timed_out'/)
  assert.match(fn, /values \(r\.chat_group_id, v_bot, 'AI分析', v_text, 'text'\)/)
  assert.match(fn, /v_bot constant uuid := '00000000-0000-4000-8000-00000000b073'/)
  assert.ok(fn.includes(`v_text constant text := '${AI_CHAT_GENERIC_ERROR}'`))
  assert.match(fn, /exception when others then/)
  assert.match(sql, /revoke all on function public\.chat_ai_analysis_reply_timeouts\(\) from public, anon, authenticated/)
  // 既存ジョブへの組み込み。以前の呼び出しはすべて残す
  const dispatcher = sql.slice(sql.indexOf("create or replace function public.invoke_high_frequency_dispatcher_cron"))
  const previous = await Deno.readTextFile(new URL("../supabase/migrations/20260826010000_chat_schedule_cron_dispatch_integration.sql", import.meta.url))
  assert.match(dispatcher, /perform public\.chat_ai_analysis_reply_timeouts\(\);/)
  for (const call of previous.match(/perform public\.\w+\(\);/g) ?? []) assert.ok(dispatcher.includes(call), call)
  assert.doesNotMatch(sql, /cron\.schedule\(/)
  assert.match(sql, /revoke all on function public\.invoke_high_frequency_dispatcher_cron\(\) from public, anon, authenticated/)
})

// ---------- 口コミ通知（POST /alert） ----------
const ALERT_RECIPIENT = "3186a986-547f-41c0-81c2-56f9427e123c"
const PUBLIC_URL = "https://tabelog.com/tokyo/A1309/A130903/13245351/"
const alertBody = (over: Record<string, unknown> = {}) => ({
  recipient_user_id: ALERT_RECIPIENT,
  dedupe_key: "gourmet-alert:00000000-0000-4000-8000-000000000001",
  store_name: "BISTRO CAVA CAVA",
  score_changes: [{ site: "食べログ", from: "3.26", to: "3.28", diff: "+0.02", date: "2026-10-01", review_count_from: 49, review_count_to: 50, url: PUBLIC_URL }],
  reviews: [{ site: "食べログ", rating: "3.6", posted_date: "2026-09-30", visit: "2026-09", title: "また行きたい", text: "前菜が美味しかった。\n\nワインも良い。", text_note: null, url: `${PUBLIC_URL}dtlrvwlst/B123/`, url_label: "口コミを見る" }],
  more_count: 0,
  app_url: "https://marugo-s.github.io/gourmet/",
  ...over,
})

test("alert input: recipient, dedupe key, store name and at least one item are required", () => {
  const input = validateAlertInput(alertBody())
  assert.deepEqual(input.target, { kind: "user", recipientUserId: ALERT_RECIPIENT }, "旧形式（個人宛て）も受け付ける")
  assert.equal(input.scoreChanges[0].from, "3.26")
  assert.equal(input.reviews[0].text, "前菜が美味しかった。\n\nワインも良い。")
  assert.throws(() => validateAlertInput(alertBody({ recipient_user_id: "x" })), /送信先/)
  assert.throws(() => validateAlertInput(alertBody({ dedupe_key: "short" })), /dedupe_key/)
  assert.throws(() => validateAlertInput(alertBody({ store_name: " " })), /店舗名/)
  assert.throws(() => validateAlertInput(alertBody({ score_changes: [], reviews: [] })), /内容/)
  assert.throws(() => validateAlertInput(alertBody({ reviews: Array.from({ length: REVIEW_ALERT_LIMITS.reviewsMax + 1 }, () => ({})) })), /10件/)
  assert.throws(() => validateAlertInput(alertBody({ score_changes: [{ from: "abc", to: "3.28" }] })), /総合点/)
  assert.throws(() => validateAlertInput(alertBody({ more_count: -1 })), /more_count/)
  assert.throws(() => validateAlertInput([]), /送信内容/)
})

test("alert links: only https on the allowed hosts", () => {
  assert.equal(alertUrl(PUBLIC_URL), PUBLIC_URL)
  assert.equal(alertUrl("https://restaurant.ikyu.com/rsOwner/v2/112789/legacy?path=/scriptO/rsOwnImpressions.asp")?.startsWith("https://restaurant.ikyu.com/"), true)
  for (const bad of ["http://tabelog.com/x/", "https://tabelog.com.evil.example/", "https://evil.example/", "javascript:alert(1)", "https://user:pw@tabelog.com/", "https://tabelog.com:8443/", "", null]) {
    assert.equal(alertUrl(bad), null, String(bad))
  }
  const input = validateAlertInput(alertBody({ reviews: [{ site: "食べログ", rating: "4", text: "x", url: "https://evil.example/" }] }))
  assert.equal(input.reviews[0].url, null, "許可していないリンクは出さない（送信は続ける）")
  assert.equal(input.reviews[0].rating, "4")
})

test("alert cards: score change first, then each review, then ほか N件 with the app link", () => {
  const input = validateAlertInput(alertBody({ more_count: 3, reviews: [alertBody().reviews[0], { site: "一休", rating: "4.5", posted_date: "2026-09-29", text: "", text_note: "本文は取り込まれていません（評価だけ）", url: "https://restaurant.ikyu.com/rsOwner/v2/112789/legacy?path=/scriptO/rsOwnImpressions.asp", url_label: "管理画面で見る" }] }))
  const { text, cards } = buildReviewAlertCards(input)
  assert.equal(REVIEW_ALERT_KIND, "gourmet_review_alert")
  assert.equal(cards.length, 4)
  assert.equal(cards[0].header.eyebrow, "食べログ 総合点が変わりました")
  assert.equal(cards[0].header.subtitle, "3.26 → 3.28（+0.02）")
  assert.deepEqual(cards[0].sections[0], { type: "fields", rows: [{ label: "総合点", value: "3.26 → 3.28（+0.02）", weight: "bold" }, { label: "口コミ数", value: "49 → 50件" }, { label: "確認日", value: "2026-10-01" }] })
  assert.deepEqual(cards[0].actions, [{ label: "食べログで見る", url: PUBLIC_URL, style: "secondary" }])
  assert.equal(cards[1].header.eyebrow, "食べログ 新着口コミ")
  assert.equal(cards[1].header.subtitle, "また行きたい")
  assert.deepEqual(cards[1].sections[2], { type: "fields", rows: [{ label: "本文", value: "", paragraphs: ["前菜が美味しかった。", "ワインも良い。"] }] })
  assert.equal(cards[1].actions[0].url, `${PUBLIC_URL}dtlrvwlst/B123/`)
  assert.equal(cards[2].sections.length, 2, "本文なし＋注記")
  assert.equal(cards[2].actions[0].label, "管理画面で見る")
  assert.equal(cards[3].header.title, "ほか 3件")
  assert.deepEqual(cards[3].actions, [{ label: "アプリで見る", url: "https://marugo-s.github.io/gourmet/", style: "primary" }])
  assert.match(text, /^\[口コミ通知\] BISTRO CAVA CAVA\n食べログ 総合点 3\.26 → 3\.28\n新着口コミ 5件\n食べログ ★3\.6 また行きたい$/)
  const scoreOnly = buildReviewAlertCards(validateAlertInput(alertBody({ reviews: [] })))
  assert.equal(scoreOnly.cards.length, 1)
  assert.equal(scoreOnly.text, "[口コミ通知] BISTRO CAVA CAVA\n食べログ 総合点 3.26 → 3.28")
})

test("mtalk-external-post routes POST /alert through the bot direct room with dedupe", () => {
  const source = Deno.readTextFileSync(new URL("../supabase/functions/mtalk-external-post/index.ts", import.meta.url))
  assert.match(source, /path === "\/alert" && req\.method === "POST"\) return respond\(await alert\(supabase, bodyText\)\)/)
  assert.match(source, /kind: REVIEW_ALERT_KIND,\s*dedupeKey: input\.dedupeKey/)
  // 署名の確認より前に /alert を処理しない
  assert.ok(source.indexOf("if (!authorized)") < source.indexOf('path === "/alert"'))
})

// ---------- 店舗Bot として グループのルームへ ----------
const CAVA_BOT = "285666af-5fbb-43a9-88e2-998740b0e042"
const botBody = (over: Record<string, unknown> = {}) => {
  const { recipient_user_id: _r, ...rest } = alertBody()
  return { ...rest, bot_id: CAVA_BOT, ...over }
}

test("alert input: bot_id with optional room_ids; not both bot and recipient", () => {
  assert.deepEqual(validateAlertInput(botBody()).target, { kind: "bot", botId: CAVA_BOT, roomIds: null })
  assert.deepEqual(validateAlertInput(botBody({ room_ids: [5, 30, 5] })).target, { kind: "bot", botId: CAVA_BOT, roomIds: [5, 30] })
  assert.throws(() => validateAlertInput(botBody({ bot_id: "x" })), /店舗Bot/)
  assert.throws(() => validateAlertInput(botBody({ recipient_user_id: ALERT_RECIPIENT })), /店舗Bot/)
  for (const bad of [[], [0], [1.5], "5", Array.from({ length: REVIEW_ALERT_LIMITS.roomsMax + 1 }, (_, i) => i + 1)]) {
    assert.throws(() => validateAlertInput(botBody({ room_ids: bad })), /room_ids/, JSON.stringify(bad))
  }
})

const ROOMS = [
  { id: 34, group_name: "bot", is_direct: false, trashed_at: null, is_store_room: false },
  { id: 5, group_name: "Bistro CAVACAVA", is_direct: false, trashed_at: null, is_store_room: true },
  { id: 32, group_name: "Bistro CAVACAVA・itagawa yoshito", is_direct: true, trashed_at: null },
  { id: 30, group_name: "BistroCAVACAVA", is_direct: false, trashed_at: null },
  { id: 8, group_name: "ゴミ箱のルーム", is_direct: false, trashed_at: "2026-09-01T00:00:00Z" },
  { id: 38, group_name: "管理者通知", is_direct: false, trashed_at: null, is_admin_notice_room: true },
]

test("alert rooms: groups the bot is in, without 1:1 / trashed / admin notice; room_ids narrows", () => {
  assert.deepEqual(alertRooms(ROOMS).map((r) => [r.id, r.name, r.isStoreRoom]), [[5, "Bistro CAVACAVA", true], [30, "BistroCAVACAVA", false], [34, "bot", false]])
  assert.deepEqual(alertRooms(ROOMS, [30, 32, 8, 999]).map((r) => r.id), [30], "1対1・ゴミ箱・参加していないルームは選んでも送らない")
  assert.deepEqual(alertRooms(ROOMS, [32]), [])
})

test("store bot list: live store bots only, with their postable rooms and member counts", () => {
  const list = storeBotList(
    [
      { id: CAVA_BOT, username: "Bistro CAVACAVA", store_key: "bistrocavacava", is_bot: true, bot_deleted_at: null },
      { id: "b2", username: "予約通知", store_key: null, is_bot: true, bot_deleted_at: null },
      { id: "b3", username: "消したBot", store_key: "gone", is_bot: true, bot_deleted_at: "2026-09-01T00:00:00Z" },
      { id: "b4", username: "バルぺロタ", store_key: "barpelota", is_bot: true, bot_deleted_at: null },
    ],
    [...ROOMS.map((r) => ({ user_id: CAVA_BOT, group_id: r.id })), { user_id: "b2", group_id: 5 }],
    ROOMS,
    new Map([[5, 6], [30, 5], [34, 4]]),
  )
  assert.deepEqual(list.map((b) => b.store_key), ["bistrocavacava", "barpelota"])
  assert.deepEqual(list[0].rooms, [
    { id: 5, name: "Bistro CAVACAVA", is_store_room: true, members: 6 },
    { id: 30, name: "BistroCAVACAVA", is_store_room: false, members: 5 },
    { id: 34, name: "bot", is_store_room: false, members: 4 },
  ])
  assert.deepEqual(list[1].rooms, [])
})

test("mtalk-external-post: /store-bots and bot /alert are behind the signature; posts as the store bot per room with dedupe", () => {
  const source = Deno.readTextFileSync(new URL("../supabase/functions/mtalk-external-post/index.ts", import.meta.url))
  assert.match(source, /path === "\/store-bots" && req\.method === "GET"\) return respond\(\{ bots: await listStoreBots\(supabase\) \}\)/)
  assert.ok(source.indexOf("if (!authorized)") < source.indexOf('path === "/store-bots"'))
  assert.match(source, /for \(const room of rooms\)[\s\S]*postChatCardIndependent\(supabase, \{ groupId: room\.id, text, cards, kind: REVIEW_ALERT_KIND, dedupeKey: input\.dedupeKey, asUser \}\)/)
  assert.match(source, /loadMtalkStoreBot\(supabase, String\(bot\.store_key\)\)/, "既存の店舗Botの投稿と同じ名前（〜 bot）")
  assert.match(source, /\.eq\("is_bot", true\)\.not\("store_key", "is", null\)\.is\("bot_deleted_at", null\)\.maybeSingle\(\)/, "店舗Bot以外（AI分析・予約通知・利用者）では投稿しない")
  assert.match(source, /if \(failed\) throw new Error\("card post failed"\)/)
})

// ---------- 「最新を調べる／今あるデータで答える」 ----------
const LOOKUP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const MUSER = "11111111-2222-4333-8444-555555555555"

test("choice card: two command buttons with fixed commands (not taken from gourmet) + text fallback", () => {
  assert.equal(aiChatChoice({ parts: ["x"] }), null)
  const choice = aiChatChoice({ parts: ["どちらで…"], choice: { question: "今月のPVは？" + "あ".repeat(300), options: [{ value: 1, label: "<script>" }] } })
  assert.ok(choice && choice.question.length <= 100)
  const { text, cards } = buildAiChoiceCard(choice!, "ご質問：「今月のPVは？」\n1. …\n2. …")
  assert.match(text, /^ご質問：「今月のPVは？」/)
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0].actions.map((a) => [a.command, a.style]), [[AI_CHOICE_COMMANDS.live, "primary"], [AI_CHOICE_COMMANDS.now, "secondary"]])
  assert.equal(AI_CHOICE_COMMANDS.live, "1：サイトにログインして最新を調べる")
  assert.equal(AI_CHOICE_COMMANDS.now, "2：今あるデータですぐ答える")
  assert.match(AI_CHOICE_LABELS.live, /サイトにログインして最新を調べる（時間がかかります：5〜10分ほど）/)
  assert.match(AI_CHOICE_LABELS.now, /今あるデータですぐ答える（少し正確性が落ちることがあります）/)
  assert.doesNotMatch(JSON.stringify(cards), /<script>/)
  assert.match(buildAiChoiceCard({ question: "" }, "").text, /番号（1 または 2）/, "gourmet の文が無くても選べる")
  assert.equal(cards[0].header.subtitle, `ご質問：「${choice!.question}」`)
})

test("live start / close: only well-formed lookup ids", () => {
  assert.deepEqual(aiChatLiveStart({ live: { lookup_id: LOOKUP.toUpperCase(), deadline_seconds: 1200 } }), { lookupId: LOOKUP })
  assert.equal(aiChatLiveStart({ live: { lookup_id: "x" } }), null)
  assert.equal(aiChatLiveStart({ parts: ["a"] }), null)
  assert.deepEqual(aiChatLiveClose({ live_close: [LOOKUP, "nope", 3] }), [LOOKUP])
  assert.equal(aiChatLiveClose({ live_close: Array(20).fill(LOOKUP) }).length, AI_CHAT_LIVE_LIMITS.closeMax)
  assert.equal(aiChatLiveDedupeKey(LOOKUP.toUpperCase()), `live:${LOOKUP}`)
  assert.equal(AI_CHAT_LIVE_LIMITS.deadlineSeconds, 1200)
})

test("chat-reply input: lookup id, user, room, 1..3 parts each clipped to 2000", () => {
  const ok = validateChatReplyInput({ lookup_id: LOOKUP, mtalk_user_id: MUSER, mtalk_group_id: 42, parts: ["a", "b".repeat(3000)] })
  assert.deepEqual([ok.lookupId, ok.mtalkUserId, ok.groupId, ok.parts.length, ok.parts[1].length], [LOOKUP, MUSER, 42, 2, AI_CHAT_LIMITS.replyMax])
  for (const bad of [
    null, [], { mtalk_user_id: MUSER, mtalk_group_id: 1, parts: ["a"] },
    { lookup_id: LOOKUP, mtalk_user_id: "x", mtalk_group_id: 1, parts: ["a"] },
    { lookup_id: LOOKUP, mtalk_user_id: MUSER, mtalk_group_id: 0, parts: ["a"] },
    { lookup_id: LOOKUP, mtalk_user_id: MUSER, mtalk_group_id: 1, parts: [] },
    { lookup_id: LOOKUP, mtalk_user_id: MUSER, mtalk_group_id: 1, parts: ["a", "b", "c", "d"] },
    { lookup_id: LOOKUP, mtalk_user_id: MUSER, mtalk_group_id: 1, parts: "a" },
  ]) assert.throws(() => validateChatReplyInput(bad))
})

test("chat-reply decision: pending → post, missing → claim, answered → duplicate, timed_out / closed → reject (409)", () => {
  assert.deepEqual(chatReplyDecision(null), { action: "claim" })
  assert.deepEqual(chatReplyDecision({ status: "pending", message_id: null }), { action: "post" })
  assert.deepEqual(chatReplyDecision({ status: "answered", message_id: 9 }), { action: "duplicate" })
  assert.deepEqual(chatReplyDecision({ status: "timed_out", message_id: 9 }), { action: "reject", reason: "timed_out" })
  assert.deepEqual(chatReplyDecision({ status: "failed", message_id: null }), { action: "reject", reason: "closed" })
})

test("mtalk-external-post: choice/ack close the 2-minute watch, live watch before the ack, /chat-reply is signed and DM-only", async () => {
  const src = await Deno.readTextFile(new URL("../supabase/functions/mtalk-external-post/index.ts", import.meta.url))
  const bg = src.slice(src.indexOf("async function answerInBackground"), src.indexOf("// ---------- 「最新を調べる」"))
  assert.match(bg, /const ok = parts\.length > 0 \|\| choice != null/)
  assert.ok(bg.indexOf("finishDispatch(supabase, groupId, messageId, ok ? AI_CHAT_STATUS.answered") < bg.indexOf("openLiveWatch("), "確定してから見張りを作る")
  assert.ok(bg.indexOf("openLiveWatch(") < bg.indexOf("postBotText("), "見張りを作ってから「調べています」を送る")
  assert.match(bg, /kind: AI_CHAT_CHOICE_KIND, dedupeKey: `msg:\$\{messageId\}`/)
  assert.match(bg, /closeLiveWatches\(supabase, groupId, closes\)/)
  assert.equal(AI_CHAT_CHOICE_KIND, "ai_chat_choice")
  assert.equal(AI_CHAT_LIVE_KIND, "ai_chat_live")
  assert.equal(AI_CHAT_LIVE_REPLY_PATH, "/chat-reply")
  // /chat-reply は署名の検証より後（/chat-dispatch だけが署名の前）
  const auth = src.indexOf("if (!authorized) return respond")
  assert.ok(src.indexOf("if (path === AI_CHAT_LIVE_REPLY_PATH") > auth)
  const reply = src.slice(src.indexOf("async function chatReply"), src.indexOf("Deno.serve("))
  assert.match(reply, /const groupId = await botDirectRoom\(supabase, input\.mtalkUserId\)\n  if \(groupId !== input\.groupId\) throw new ExternalPostError\("送信先のトークが見つかりません", 404\)/)
  assert.ok(reply.indexOf("setLiveWatch(supabase, groupId, key, AI_CHAT_STATUS.pending, answered)") < reply.indexOf("postBotText("), "確定してから送る")
  assert.match(reply, /409\)/)
  assert.match(reply, /if \(first == null\) await setLiveWatch\(supabase, groupId, key, AI_CHAT_STATUS\.answered, \{ status: AI_CHAT_STATUS\.pending/)
  assert.doesNotMatch(reply, /console\.\w+\([^)]*(parts|bodyText|token)/)
})

test("live timeout migration: 20 minutes pending → timed_out + card with the 「2」 button; wired into the per-minute dispatcher", async () => {
  const sql = await Deno.readTextFile(new URL("../supabase/migrations/20261001050000_chat_ai_analysis_live_timeouts.sql", import.meta.url))
  assert.match(sql, /create or replace function public\.chat_ai_analysis_live_timeouts\(\)/)
  assert.match(sql, /d\.kind = 'ai_chat_live'/)
  assert.match(sql, /d\.status = 'pending' and d\.created_at < now\(\) - interval '20 minutes'/)
  assert.match(sql, /d\.status = 'answered' and d\.finished_at < now\(\) - interval '2 minutes'/)
  assert.match(sql, /for update skip locked/)
  assert.match(sql, /'command', '2：今あるデータですぐ答える'/)
  assert.match(sql, /今あるデータですぐ答える場合は「2」を送ってください/)
  assert.match(sql, /revoke all on function public\.chat_ai_analysis_live_timeouts\(\) from public, anon, authenticated/)
  const fn = sql.slice(sql.indexOf("create or replace function public.invoke_high_frequency_dispatcher_cron()"))
  for (const call of ["chat_ai_analysis_reply_timeouts", "chat_ai_analysis_live_timeouts", "chat_dispatch_scheduled_messages", "invoke_gmail_alert_cron", "invoke_receipt_midreport_cron",
    "invoke_reservation_today_cron", "invoke_review_alert_cron", "invoke_tokyo_dome_weekly_cron", "invoke_foodcourt_weekly_report_cron", "invoke_pv_japan_alert_cron"]) {
    assert.match(fn, new RegExp(`perform public\\.${call}\\(\\)`), call)
  }
  assert.equal(AI_CHOICE_COMMANDS.now, "2：今あるデータですぐ答える", "SQL のボタンと同じ文")
})
