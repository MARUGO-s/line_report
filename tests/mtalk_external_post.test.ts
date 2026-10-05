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
  AI_CHAT_LOGIN_LINKS_KIND,
  aiChatLinks,
  AI_CHAT_NOTICE_KIND,
  AI_CHAT_NOTICE_PATH,
  aiChatNoticeDedupeKey,
  buildLoginLinksCard,
  gourmetCredentialUrl,
  loginLinksFrom,
  validateChatNoticeInput,
  INTERNAL_TERMS,
  buildStorePostCard,
  looksLikePersonalInfo,
  STORE_POST_CARD_KIND,
  STORE_POST_FILE_KIND,
  STORE_POST_LIMITS,
  STORE_POST_PATH,
  storePostFileDedupeKey,
  validateStorePostInput,
  SCRUBBED_FALLBACK,
  scrubInternalLines,
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
  assert.match(src, /groups\/\$\{groupId\}\/\$\{options\.folder \?\? "ai-reports"\}\//, "/send の PDF は従来どおり ai-reports へ")
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

// ---------- 「最新を調べる／今あるデータで答える」の選択は廃止（2026-10-01） ----------
const LOOKUP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const MUSER = "11111111-2222-4333-8444-555555555555"

test("mtalk-external-post: no choice card / live watch / /chat-reply; answers are posted as plain replies right away", async () => {
  const src = await Deno.readTextFile(new URL("../supabase/functions/mtalk-external-post/index.ts", import.meta.url))
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  for (const gone of ["ai_chat_choice", "AI_CHAT_CHOICE_KIND", "buildAiChoiceCard", "openLiveWatch", "closeLiveWatches", "AI_CHAT_LIVE_KIND", "/chat-reply", "AI_CHAT_LIVE_REPLY_PATH", "chatReply("]) {
    assert.ok(!code.includes(gone), gone)
  }
  const bg = src.slice(src.indexOf("async function answerInBackground"), src.indexOf("// 「ログイン情報を更新」のカード"))
  assert.match(bg, /const ok = parts\.length > 0\n/)
  assert.ok(bg.indexOf("finishDispatch(supabase, groupId, messageId, ok ? AI_CHAT_STATUS.answered") < bg.indexOf("postBotText("), "確定してから送る")
  assert.ok(bg.indexOf("postBotText(") < bg.indexOf("postLoginLinks(supabase, groupId, links, `msg:${messageId}`)"), "答えのあとにボタン")
  // gourmet の古い版の choice / live は無視して parts の文だけ送る
  assert.deepEqual(aiChatReplyParts({ parts: ["ご質問：「今月のPVは？」\n1. …\n2. …"], choice: { question: "今月のPVは？" }, live: { lookup_id: LOOKUP } }), ["ご質問：「今月のPVは？」\n1. …\n2. …"])
})

test("/mtalk-chat links: only gourmet credential buttons pass (relogin), others are dropped", () => {
  const url = "https://marugo-s.github.io/gourmet/?view=accounts&source=ikyu&store=112789"
  assert.deepEqual(aiChatLinks({ parts: ["a"], links: [{ kind: "relogin", source: "ikyu", store_name: "BISTRO CAVACAVA", url }, { kind: "relogin", source: "ikyu", url: "https://evil.example/" }] }),
    [{ kind: "relogin", source: "ikyu", storeName: "BISTRO CAVACAVA", url }])
  assert.deepEqual(aiChatLinks({ parts: ["a"] }), [])
  assert.deepEqual(aiChatLinks(null), [])
})

test("live watch migration: chat_ai_analysis_live_timeouts() becomes a no-op that only closes leftover watches; dispatcher untouched", async () => {
  const sql = await Deno.readTextFile(new URL("../supabase/migrations/20261001190000_chat_ai_analysis_live_watch_noop.sql", import.meta.url))
  assert.match(sql, /create or replace function public\.chat_ai_analysis_live_timeouts\(\)\nreturns integer/)
  assert.doesNotMatch(sql, /insert into public\.chat_messages/, "案内を投稿しない")
  assert.match(sql, /set status = 'failed'/)
  assert.match(sql, /return 0;/)
  assert.doesNotMatch(sql, /invoke_high_frequency_dispatcher_cron/, "毎分の見張りの定義は変えない（呼び出し先だけ置き換える）")
  assert.match(sql, /revoke all on function public\.chat_ai_analysis_live_timeouts\(\) from public, anon, authenticated/)
})

// ---------- 「ログイン情報を更新」のボタン・お知らせ（/chat-notice） ----------
const RETRY = "a9f5c78b-fb5d-4dfc-9125-47567ad83329"
const CRED_URL = `https://marugo-s.github.io/gourmet/?view=accounts&source=ikyu&store=112789&retry=${RETRY}`

test("login links: only gourmet's credential screen URL passes; labels are decided here", () => {
  assert.equal(gourmetCredentialUrl(CRED_URL), CRED_URL)
  assert.equal(gourmetCredentialUrl("https://marugo-s.github.io/gourmet/?view=accounts&source=tabelog&store="), "https://marugo-s.github.io/gourmet/?view=accounts&source=tabelog&store=")
  for (const bad of [
    "http://marugo-s.github.io/gourmet/?view=accounts&source=ikyu&store=112789",
    "https://evil.example/gourmet/?view=accounts&source=ikyu&store=112789",
    "https://marugo-s.github.io/line_report/?view=accounts&source=ikyu&store=112789",
    "https://marugo-s.github.io/gourmet/?view=dashboard&source=ikyu&store=112789",
    "https://marugo-s.github.io/gourmet/?view=accounts&source=ikyu&store=112789&password=x",
    "https://marugo-s.github.io/gourmet/?view=accounts&source=ikyu&store=112789&retry=nope",
    "https://user:pw@marugo-s.github.io/gourmet/?view=accounts&source=ikyu&store=1",
    "https://marugo-s.github.io/gourmet/?view=accounts&source=ikyu&store=1#x",
    "javascript:alert(1)", "",
  ]) assert.equal(gourmetCredentialUrl(bad), null, bad)
  const links = loginLinksFrom([
    { kind: "relogin", source: "ikyu", store_name: "BISTRO CAVACAVA", url: CRED_URL },
    { kind: "relogin", source: "ikyu", store_name: "dup", url: CRED_URL },
    { kind: "relogin", source: "tabelog", store_name: "x", url: CRED_URL },
    { kind: "needs_human_check", source: "ikyu", url: CRED_URL },
    { kind: "relogin", source: "ikyu", url: "https://evil.example/" },
    "x", null,
  ])
  assert.deepEqual(links, [{ kind: "relogin", source: "ikyu", storeName: "BISTRO CAVACAVA", url: CRED_URL }])
  assert.deepEqual(loginLinksFrom(undefined), [])
  assert.equal(loginLinksFrom(Array(20).fill(0).map((_, i) => ({ kind: "relogin", source: "tabelog", url: `https://marugo-s.github.io/gourmet/?view=accounts&source=tabelog&store=s${i}` }))).length, 6)
  const { text, cards } = buildLoginLinksCard(links)
  assert.match(text, /一休（BISTRO CAVACAVA）/)
  assert.match(text, /パスワードはこのトークに書かないでください/)
  assert.equal(cards[0].actions[0].label, "ログイン情報を更新（一休（BISTRO CAVACAVA））")
  assert.equal(cards[0].actions[0].url, CRED_URL)
  assert.equal(cards[0].actions[0].command, undefined, "押しても文は送らない（リンクを開くだけ）")
  assert.equal(AI_CHAT_LOGIN_LINKS_KIND, "ai_chat_login_links")
})

test("chat-notice validates the room, user, parts and links with its own id", () => {
  assert.deepEqual(validateChatNoticeInput({ notice_id: RETRY, mtalk_user_id: MUSER, mtalk_group_id: 42, parts: ["a"] }).links, [])
  assert.equal(validateChatNoticeInput({ notice_id: RETRY, mtalk_user_id: MUSER, mtalk_group_id: 42, parts: ["a"], links: [{ kind: "relogin", source: "ikyu", url: CRED_URL }] }).links.length, 1)
  const n = validateChatNoticeInput({ notice_id: RETRY.toUpperCase(), mtalk_user_id: MUSER, mtalk_group_id: 42, parts: ["【再ログイン後の取得結果】"] })
  assert.deepEqual([n.noticeId, n.groupId, n.parts.length, n.links.length], [RETRY, 42, 1, 0])
  assert.equal(validateChatNoticeInput({ notice_id: RETRY, mtalk_user_id: MUSER, mtalk_group_id: 42, parts: ["a", "b".repeat(3000)] }).parts[1].length, AI_CHAT_LIMITS.replyMax)
  for (const bad of [null, [], { mtalk_user_id: MUSER, mtalk_group_id: 42, parts: ["a"] }, { notice_id: "x", mtalk_user_id: MUSER, mtalk_group_id: 42, parts: ["a"] },
    { notice_id: RETRY, mtalk_user_id: "x", mtalk_group_id: 42, parts: ["a"] }, { notice_id: RETRY, mtalk_user_id: MUSER, mtalk_group_id: 0, parts: ["a"] },
    { notice_id: RETRY, mtalk_user_id: MUSER, mtalk_group_id: 42, parts: [] }, { notice_id: RETRY, mtalk_user_id: MUSER, mtalk_group_id: 42, parts: ["a", "b", "c", "d"] },
    { notice_id: RETRY, mtalk_user_id: MUSER, mtalk_group_id: 42, parts: "a" }]) assert.throws(() => validateChatNoticeInput(bad))
  assert.equal(aiChatNoticeDedupeKey(RETRY.toUpperCase()), `notice:${RETRY}`)
  assert.equal(AI_CHAT_NOTICE_KIND, "ai_chat_notice")
  assert.equal(AI_CHAT_NOTICE_PATH, "/chat-notice")
})

test("mtalk-external-post: /chat-notice is signed, DM-only, once per notice_id; links card after the answer", async () => {
  const src = await Deno.readTextFile(new URL("../supabase/functions/mtalk-external-post/index.ts", import.meta.url))
  const auth = src.indexOf("if (!authorized) return respond")
  assert.ok(src.indexOf("if (path === AI_CHAT_NOTICE_PATH") > auth, "署名の検証より後")
  const notice = src.slice(src.indexOf("async function chatNotice"), src.indexOf("Deno.serve("))
  assert.match(notice, /const groupId = await botDirectRoom\(supabase, input\.mtalkUserId\)\n  if \(groupId !== input\.groupId\) throw new ExternalPostError\("送信先のトークが見つかりません", 404\)/)
  assert.ok(notice.indexOf(".insert({ kind: AI_CHAT_NOTICE_KIND") < notice.indexOf("postBotText("), "先に1回だけを確保してから送る")
  assert.ok(notice.indexOf("postBotText(") < notice.indexOf("postLoginLinks(supabase, groupId, input.links, key)"), "答えのあとにボタン")
  assert.match(src, /kind: AI_CHAT_LOGIN_LINKS_KIND, dedupeKey/)
})

test("AI分析: gourmet の取得の内部の言葉（computerUse・サブエージェント・Shell・claim など）を含む行は M-talk へ出さない", () => {
  const leak = "最新のデータを取得できませんでした（一休（BISTRO CAVACAVA）: ブラウザ用computerUseサブエージェントがこの実行環境で利用できず、ルール上Shellからの操作も不可のため取得…）。前回までに取得したデータで答えます。"
  assert.equal(scrubInternalLines(`ご質問：「今月は？」\n${leak}\n\n予約は12件です`), "ご質問：「今月は？」\n\n予約は12件です")
  for (const t of ["subagent", "executor", "claimId 不一致", "Playwright", "--fail", "INGEST_TOKEN", "親エージェントで再実行"]) assert.ok(INTERNAL_TERMS.test(t), t)
  for (const t of ["今月の予約は12件です", "Shellfish platter", "シェルフィッシュ", "一休（BISTRO CAVACAVA）：ログイン情報の確認が必要です"]) assert.ok(!INTERNAL_TERMS.test(t), t)
  const reply = validateChatNoticeInput({ notice_id: LOOKUP, mtalk_user_id: MUSER, mtalk_group_id: 42, parts: [`ご質問\n${leak}`, "予約は12件です"] })
  assert.deepEqual(reply.parts, ["ご質問", "予約は12件です"])
  const all = validateChatNoticeInput({ notice_id: LOOKUP, mtalk_user_id: MUSER, mtalk_group_id: 42, parts: [leak] })
  assert.deepEqual(all.parts, [SCRUBBED_FALLBACK])
  const notice = validateChatNoticeInput({ notice_id: LOOKUP, mtalk_user_id: MUSER, mtalk_group_id: 42, parts: ["【再ログイン後の取得結果】", "claim not found"] })
  assert.deepEqual(notice.parts, ["【再ログイン後の取得結果】"])
  assert.deepEqual(aiChatReplyParts({ parts: ["予約は12件です", "executor failed"] }), ["予約は12件です"])
  assert.deepEqual(aiChatReplyParts({ parts: [] }), [])
})


// ---------- 店舗Botの投稿（POST /store-post、gourmet の週報） ----------
const STORE_BOT = "6b0b1f0e-3c1a-4d55-9a4e-2f7d8c9e0a11"
const tinyPdf = () => btoa("%PDF-1.7\n" + "x".repeat(80) + "\n%%EOF")
const storePostBody = (over: Record<string, unknown> = {}) => ({
  bot_id: STORE_BOT,
  dedupe_key: "gourmet-weekly:00000000-0000-4000-8000-000000000001:2026-10-05",
  type: "weekly_report",
  store_name: "BISTRO CAVA CAVA",
  title: "BISTRO CAVA CAVA 週報（食べログ・一休）",
  subtitle: "2026/10/05 作成 · 直近7日 9/28〜10/4",
  sections: [
    { heading: "食べログ", fields: [{ label: "直近7日のPV", value: "1,234 PV（前週比 +5.2%）" }, { label: "評価", value: "3.28（口コミ 50件）" }], items: ["ネット予約は前月比 +12.0%"] },
    { heading: "一休", fields: [{ label: "直近7日のPV", value: "456 PV" }, { label: "予約", value: "7件（受付日ベース）" }] },
  ],
  note: "数値は各サイトの管理画面・公開ページの取得値です。",
  links: [{ label: "アプリで見る", url: "https://marugo-s.github.io/gourmet/" }, { label: "外部", url: "https://evil.example/" }],
  files: [{ pdf_base64: tinyPdf(), filename: "BISTRO CAVA CAVA weekly 2026-10-05.pdf" }],
  ...over,
})

test("store post: separate path and kinds from the review alert", () => {
  assert.equal(STORE_POST_PATH, "/store-post")
  assert.equal(STORE_POST_CARD_KIND, "gourmet_store_post")
  assert.equal(STORE_POST_FILE_KIND, "gourmet_store_post_file")
  assert.notEqual(STORE_POST_CARD_KIND, REVIEW_ALERT_KIND)
  assert.equal(storePostFileDedupeKey("gourmet-weekly:abc:2026-10-05", 0), "gourmet-weekly:abc:2026-10-05:f1")
})

test("store post input: bot, dedupe key, type, title and at least one section are required", () => {
  const input = validateStorePostInput(storePostBody())
  assert.equal(input.botId, STORE_BOT)
  assert.equal(input.roomIds, null)
  assert.equal(input.type, "weekly_report")
  assert.equal(input.sections.length, 2)
  assert.equal(input.files.length, 1)
  assert.equal(input.files[0].fileName, "BISTRO CAVA CAVA weekly 2026-10-05.pdf")
  assert.deepEqual(input.links, [{ label: "アプリで見る", url: "https://marugo-s.github.io/gourmet/" }], "許可していないリンクは落とす")
  assert.equal(input.dryRun, false)
  assert.equal(validateStorePostInput(storePostBody({ dry_run: true })).dryRun, true)
  assert.equal(validateStorePostInput(storePostBody({ dry_run: "true" })).dryRun, false, "true だけ")
  assert.deepEqual(validateStorePostInput(storePostBody({ room_ids: [30, 5, 30] })).roomIds, [30, 5])
  assert.equal(validateStorePostInput(storePostBody({ files: undefined })).files.length, 0, "PDFは任意")
  assert.throws(() => validateStorePostInput(storePostBody({ bot_id: "x" })), /店舗Bot/)
  assert.throws(() => validateStorePostInput(storePostBody({ recipient_user_id: ALERT_RECIPIENT })), /\/alert/)
  assert.throws(() => validateStorePostInput(storePostBody({ reviews: [] })), /\/alert/, "口コミ通知の形式は受け付けない")
  assert.throws(() => validateStorePostInput(storePostBody({ dedupe_key: "short" })), /dedupe_key/)
  assert.throws(() => validateStorePostInput(storePostBody({ dedupe_key: "k".repeat(113) })), /dedupe_key/, "PDFの :fN を付けても120文字以内")
  assert.throws(() => validateStorePostInput(storePostBody({ type: "ad" })), /type/)
  assert.throws(() => validateStorePostInput(storePostBody({ type: "constructor" })), /type/)
  assert.throws(() => validateStorePostInput(storePostBody({ store_name: " " })), /店舗名/)
  assert.throws(() => validateStorePostInput(storePostBody({ title: "" })), /タイトル/)
  assert.throws(() => validateStorePostInput(storePostBody({ sections: [] })), /内容/)
  assert.throws(() => validateStorePostInput(storePostBody({ sections: [{ heading: "空", fields: [] }] })), /内容/)
  assert.throws(() => validateStorePostInput(storePostBody({ sections: Array.from({ length: STORE_POST_LIMITS.sectionsMax + 1 }, () => storePostBody().sections[0]) })), /sections/)
  assert.throws(() => validateStorePostInput(storePostBody({ room_ids: [] })), /room_ids/)
  assert.throws(() => validateStorePostInput(storePostBody({ room_ids: [0] })), /room_ids/)
  assert.throws(() => validateStorePostInput(storePostBody({ files: Array.from({ length: STORE_POST_LIMITS.filesMax + 1 }, () => ({ pdf_base64: tinyPdf() })) })), /files/)
  assert.throws(() => validateStorePostInput(storePostBody({ files: [{ pdf_base64: btoa("<html>" + "x".repeat(100)) }] })), /PDF/, "HTMLは添付できない")
  assert.throws(() => validateStorePostInput([]), /送信内容/)
})

test("store post input: rejects guest personal info (email / phone) in the card", () => {
  assert.equal(looksLikePersonalInfo("guest@example.com"), true)
  assert.equal(looksLikePersonalInfo("連絡先 090-1234-5678"), true)
  assert.equal(looksLikePersonalInfo("０３−１２３４−５６７８"), true, "全角も")
  assert.equal(looksLikePersonalInfo("+81 90 1234 5678"), true)
  assert.equal(looksLikePersonalInfo("1,234 PV（前週比 +5.2%）"), false)
  assert.equal(looksLikePersonalInfo("2026/10/05 作成 · 直近7日 9/28〜10/4"), false)
  assert.equal(looksLikePersonalInfo("予約金額 1234567円"), false)
  for (const bad of [
    { note: "山田様 090-1234-5678" },
    { sections: [{ heading: "食べログ", fields: [{ label: "予約", value: "guest@example.com" }] }] },
    { sections: [{ heading: "一休", items: ["03-1234-5678 から予約"] }] },
  ]) {
    assert.throws(() => validateStorePostInput(storePostBody(bad)), (e: Error & { status?: number }) => /個人情報/.test(e.message) && e.status === 422)
  }
})

test("store post card: heading → fields → points per site, note mentions the PDF, links as buttons", () => {
  const input = validateStorePostInput(storePostBody())
  const { text, cards } = buildStorePostCard(input)
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0].header, { eyebrow: "週報", title: "BISTRO CAVA CAVA 週報（食べログ・一休）", subtitle: "2026/10/05 作成 · 直近7日 9/28〜10/4" })
  assert.deepEqual(cards[0].sections.slice(0, 4), [
    { type: "heading", text: "食べログ" },
    { type: "fields", rows: [{ label: "直近7日のPV", value: "1,234 PV（前週比 +5.2%）" }, { label: "評価", value: "3.28（口コミ 50件）" }] },
    { type: "fields", rows: [{ label: "ポイント", value: "", paragraphs: ["・ネット予約は前月比 +12.0%"] }] },
    { type: "separator" },
  ])
  const note = cards[0].sections.at(-1) as { type: string; text: string }
  assert.equal(note.type, "note")
  assert.match(note.text, /^数値は各サイトの管理画面・公開ページの取得値です。\n詳しくはこのあとのPDF（BISTRO CAVA CAVA weekly 2026-10-05\.pdf）をご覧ください。$/)
  assert.deepEqual(cards[0].actions, [{ label: "アプリで見る", url: "https://marugo-s.github.io/gourmet/", style: "primary" }])
  assert.equal(text, "[週報] BISTRO CAVA CAVA 週報（食べログ・一休）\n2026/10/05 作成 · 直近7日 9/28〜10/4\n食べログ: 直近7日のPV 1,234 PV（前週比 +5.2%） / 評価 3.28（口コミ 50件）\n一休: 直近7日のPV 456 PV / 予約 7件（受付日ベース）")
  const other = buildStorePostCard(validateStorePostInput(storePostBody({ title: "今週のまとめ", files: [] })))
  assert.equal(other.cards[0].header.eyebrow, "週報 · BISTRO CAVA CAVA", "タイトルに店舗名が無ければ見出しに付ける")
  assert.equal((other.cards[0].sections.at(-1) as { text: string }).text, "数値は各サイトの管理画面・公開ページの取得値です。", "PDFなしなら案内しない")
})

test("store post route: signed like the others, posts as the store bot, PDFs silent, dedupe per room, dry run posts nothing", async () => {
  const src = await Deno.readTextFile(new URL("../supabase/functions/mtalk-external-post/index.ts", import.meta.url))
  assert.match(src, /path === STORE_POST_PATH && req\.method === "POST"\) return respond\(await storePost\(supabase, bodyText\)\)/)
  // 署名の確認より後（/chat-dispatch 以外はすべて verifyExternalRequest を通る）
  assert.ok(src.indexOf("verifyExternalRequest({") < src.indexOf("path === STORE_POST_PATH"))
  const fn = src.slice(src.indexOf("async function storePost("), src.indexOf("// ---------- 「AI分析」Bot への質問"))
  assert.match(fn, /storeBotRooms\(supabase, input\.botId, input\.roomIds\)/)
  assert.match(fn, /kind: STORE_POST_CARD_KIND, dedupeKey: input\.dedupeKey, asUser/)
  assert.match(fn, /kind: STORE_POST_FILE_KIND, asUser, folder: "store-posts"/)
  assert.match(fn, /storePostFileDedupeKey\(input\.dedupeKey, i\)/)
  assert.doesNotMatch(fn, /AI_ANALYSIS_BOT_ID|REVIEW_ALERT_KIND/)
  const dry = fn.slice(fn.indexOf("if (input.dryRun)"), fn.indexOf("const results"))
  assert.doesNotMatch(dry, /postChatCard|postPdfOnce|insert\(/, "dry_run は投稿・予約をしない")
  assert.match(fn, /if \(failed\) throw new Error\("store post failed"\)/)
  const pdf = src.slice(src.indexOf("async function postPdfOnce("), src.indexOf("async function send("))
  assert.match(pdf, /is_silent: true/)
  assert.match(pdf, /user_id: author\.id/)
  assert.match(pdf, /groups\/\$\{groupId\}\/\$\{options\.folder \?\? "ai-reports"\}\//)
  // /send（「AI分析」のPDF）は従来どおり
  assert.match(pdf, /options\.kind \?\? AI_REPORT_FILE_KIND/)
  assert.match(pdf, /options\.asUser \?\? \{ id: AI_ANALYSIS_BOT_ID, username: AI_ANALYSIS_BOT_USERNAME \}/)
})
