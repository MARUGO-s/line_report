/**
 * mtalk-external-post — 外部アプリ（gourmet の AI分析）から M-talk の利用者へ
 * 「AI分析」Bot の1対1でレポートのカードとPDFを届ける。
 *
 *   GET  /recipients  有効な人間の利用者（id, username, stores）
 *   POST /send        { recipient_user_id, report_id, sender_label, title, card, pdf_base64, filename, dedupe_key }
 *   GET  /store-bots  店舗Bot（id, username, store_key）と、投稿できるルーム（参加しているグループ。1対1・ゴミ箱・管理者通知を除く）
 *   POST /alert       { bot_id, room_ids?, dedupe_key, store_name, score_changes[], reviews[], more_count, app_url }
 *                     gourmet の口コミ通知（新着口コミ・食べログ総合点の変化）を店舗Botとしてルームへ。カードはこの関数が組み立て、
 *                     リンクは許可したホストだけ。同じルームに同じ dedupe_key は1回だけ（chat_alert_dispatches、kind = gourmet_review_alert）。
 *                     旧形式 { recipient_user_id, ... }（「AI分析」Botとの1対1）も互換のため受け付ける。
 *   POST /store-post  { bot_id, room_ids?, dedupe_key, type: "weekly_report", store_name, title, subtitle?, sections[], note?, links?, files?[], dry_run? }
 *                     店舗Botとして要約カード1通＋PDF（最大3つ、静かに続ける）をルームへ（gourmet の週報）。/alert とは別の入口・別の kind
 *                     （カード gourmet_store_post、PDF gourmet_store_post_file。同じルームに同じ dedupe_key は1回だけ）。dry_run は投稿せず確認だけ。
 *   POST /chat-dispatch { message_id }  ← DBトリガー（pg_net）専用。「AI分析」Botとの1対1への質問に答える。
 *                     認証は chat-search と同じ chat_push_internal_config.dispatch_secret（Bearer、定数時間比較）。
 *                     gourmet ai-analyst POST /mtalk-chat へは GOURMET_MTALK_TOKEN + HMAC 署名（逆方向も同じ規則）。
 *                     答え・失敗の案内は chat_alert_dispatches.status を pending から1回だけ確定してから送る。
 *                     2分たっても pending のままなら pg_cron の chat_ai_analysis_reply_timeouts() が案内を送る。
 *                     データの質問にも gourmet はすぐ答える（取り込み済みのデータ＝毎日の確定値。答えにデータの取得日時と期間が付く）。
 *                     返事に links（取り込みが「ログイン情報の確認が必要」で止まっているサイト）があれば、答えのあとに
 *                     「ログイン情報を更新」のカード（URL は gourmet のアプリだけ）を1回だけ送る。
 *                     （「最新を調べる／今あるデータで答える」の選択と POST /chat-reply は 2026-10-01 に廃止）
 *   POST /chat-notice { notice_id, mtalk_user_id, mtalk_group_id, parts[], links? }  gourmet → お知らせ（例: 「再ログイン後の取得結果」）を
 *                     「AI分析」Botとして1対1へ。notice_id ごとに1回だけ（chat_alert_dispatches、kind = ai_chat_notice）。
 *
 * verify_jwt = false（呼び出し元は Supabase の利用者JWTを持たない）。認可は関数内で
 * GOURMET_MTALK_TOKEN の定数時間比較 + HMAC 署名（±5分）で行い、欠けたら常に 401。
 * ブラウザからは呼ばないため CORS ヘッダーは返さない。トークン・本文・PDFはログへ出さない。
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { postChatCardIndependent } from "../_shared/chat_bridge.ts"
import { constantTimeEqualSecret } from "../_shared/internal_cron_auth.ts"
import {
  activeRecipients,
  AI_ANALYSIS_BOT_ID,
  AI_CHAT_GENERIC_ERROR,
  AI_CHAT_LIMITS,
  AI_CHAT_PATH,
  AI_CHAT_REPLY_KIND,
  AI_CHAT_STATUS,
  aiChatEligibility,
  aiChatErrorMessage,
  aiChatReplyParts,
  aiChatRequestBody,
  type AiChatMessageRow,
  buildAiChatHistory,
  gourmetAiAnalystUrl,
  signExternalRequest,
  AI_ANALYSIS_BOT_USERNAME,
  AI_REPORT_CARD_KIND,
  AI_REPORT_FILE_KIND,
  buildAiReportCard,
  EXTERNAL_POST_LIMITS,
  ExternalPostError,
  validateSendInput,
  verifyExternalRequest,
  buildReviewAlertCards,
  REVIEW_ALERT_KIND,
  validateAlertInput,
  alertRooms,
  type BotRoomRow,
  storeBotList,
  AI_CHAT_LOGIN_LINKS_KIND,
  aiChatLinks,
  AI_CHAT_NOTICE_KIND,
  AI_CHAT_NOTICE_PATH,
  aiChatNoticeDedupeKey,
  buildLoginLinksCard,
  type LoginLink,
  validateChatNoticeInput,
  buildStorePostCard,
  STORE_POST_CARD_KIND,
  STORE_POST_FILE_KIND,
  STORE_POST_PATH,
  storePostFileDedupeKey,
  validateStorePostInput,
} from "../_shared/mtalk_external_post.ts"
import { loadMtalkStoreBot } from "../_shared/mtalk_room_settings.ts"

// deno-lint-ignore no-explicit-any
type DbClient = any

const STALE_FILE_CLAIM_MS = 120_000

function respond(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  })
}

async function readBodyLimited(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > max) throw new ExternalPostError("送信内容が大きすぎます", 413)
  if (!req.body) return ""
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new ExternalPostError("送信内容が大きすぎます", 413)
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) { all.set(c, offset); offset += c.byteLength }
  return new TextDecoder("utf-8", { fatal: true }).decode(all)
}

async function listRecipients(supabase: DbClient) {
  const [users, access, stores, catalog] = await Promise.all([
    supabase.from("chat_users").select("id, username, is_bot").eq("is_bot", false).limit(5000),
    supabase.from("chat_user_access").select("user_id, access_enabled, deleted_at, restricted_until").limit(5000),
    supabase.from("chat_user_stores").select("user_id, store_key").limit(20000),
    supabase.from("chat_store_catalog").select("store_key, display_name").limit(1000),
  ])
  for (const r of [users, access, stores, catalog]) if (r.error) throw new Error("recipient lookup failed")
  return activeRecipients(users.data ?? [], access.data ?? [], stores.data ?? [], catalog.data ?? [])
}

async function dispatchMessageId(supabase: DbClient, kind: string, groupId: number, dedupeKey: string) {
  const { data } = await supabase
    .from("chat_alert_dispatches")
    .select("message_id, created_at")
    .eq("kind", kind)
    .eq("chat_group_id", groupId)
    .eq("dedupe_key", dedupeKey)
    .maybeSingle()
  return data as { message_id: number | null; created_at: string } | null
}

type PdfPostOptions = {
  groupId: number
  dedupeKey: string
  pdf: Uint8Array<ArrayBuffer>
  fileName: string
  /** chat_alert_dispatches.kind（既定: 「AI分析」のPDF） */
  kind?: string
  /** 投稿者（既定: 「AI分析」Bot） */
  asUser?: { id: string; username: string }
  /** 保存先のフォルダ（groups/<group_id>/<folder>/<uuid>.pdf） */
  folder?: string
}

async function postPdfOnce(supabase: DbClient, options: PdfPostOptions): Promise<{ messageId: number; deduplicated: boolean }> {
  const { groupId, dedupeKey } = options
  const kind = options.kind ?? AI_REPORT_FILE_KIND
  const author = options.asUser ?? { id: AI_ANALYSIS_BOT_ID, username: AI_ANALYSIS_BOT_USERNAME }
  const claim = () => supabase.from("chat_alert_dispatches").insert({ kind, chat_group_id: groupId, dedupe_key: dedupeKey })
  const release = () => supabase.from("chat_alert_dispatches").delete()
    .eq("kind", kind).eq("chat_group_id", groupId).eq("dedupe_key", dedupeKey).is("message_id", null)
  let { error: claimError } = await claim()
  if (claimError && String(claimError.code ?? "") === "23505") {
    const existing = await dispatchMessageId(supabase, kind, groupId, dedupeKey)
    if (existing?.message_id) return { messageId: Number(existing.message_id), deduplicated: true }
    // 前回の試行が途中で止まった予約だけ取り消してやり直す（進行中の予約は触らない）。
    if (existing && Date.now() - Date.parse(existing.created_at) > STALE_FILE_CLAIM_MS) {
      await release()
      ;({ error: claimError } = await claim())
    } else {
      throw new ExternalPostError("同じ送信を処理中です。しばらくしてから再度お試しください", 409)
    }
  }
  if (claimError) throw new Error("file dispatch claim failed")

  const path = `groups/${groupId}/${options.folder ?? "ai-reports"}/${crypto.randomUUID()}.pdf`
  const bucket = supabase.storage.from("chat-images")
  const { error: uploadError } = await bucket.upload(path, new Blob([options.pdf], { type: "application/pdf" }), {
    contentType: "application/pdf",
    cacheControl: "3600",
    upsert: false,
  })
  if (uploadError) {
    await release()
    throw new Error("pdf upload failed")
  }
  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      group_id: groupId,
      user_id: author.id,
      username: author.username,
      content: `[${options.fileName}]`,
      kind: "file",
      payload: { v: 1, kind: "file", file: { path, name: options.fileName, mime: "application/pdf", size: options.pdf.byteLength } },
      // 通知はカードで1回だけ届ける。PDFは同じトークに静かに続ける。
      is_silent: true,
    })
    .select("id")
    .single()
  const messageId = Number(data?.id)
  if (error || !Number.isSafeInteger(messageId)) {
    await bucket.remove([path]).catch(() => {})
    await release()
    throw new Error("file message insert failed")
  }
  await supabase.from("chat_alert_dispatches").update({ message_id: messageId })
    .eq("kind", kind).eq("chat_group_id", groupId).eq("dedupe_key", dedupeKey)
  return { messageId, deduplicated: false }
}

async function send(supabase: DbClient, bodyText: string) {
  let raw: unknown
  try {
    raw = JSON.parse(bodyText)
  } catch {
    throw new ExternalPostError("送信内容が不正です")
  }
  const input = validateSendInput(raw)

  const { data: gid, error: directError } = await supabase.rpc("chat_ensure_bot_direct", {
    p_bot: AI_ANALYSIS_BOT_ID,
    p_user: input.recipientUserId,
  })
  if (directError) {
    if (String(directError.code ?? "") === "22023") throw new ExternalPostError("送信先の利用者が見つからないか、利用停止中です", 404)
    throw new Error("direct room failed")
  }
  const groupId = Number(gid)
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error("direct room failed")

  const { text, cards } = buildAiReportCard(input)
  const posted = await postChatCardIndependent(supabase, {
    groupId,
    text,
    cards,
    kind: AI_REPORT_CARD_KIND,
    dedupeKey: input.dedupeKey,
    asUser: { id: AI_ANALYSIS_BOT_ID, username: AI_ANALYSIS_BOT_USERNAME },
  })
  if (!posted.ok) throw new Error("card post failed")
  let cardMessageId = posted.messageId ?? null
  if (posted.skipped) cardMessageId = (await dispatchMessageId(supabase, AI_REPORT_CARD_KIND, groupId, input.dedupeKey))?.message_id ?? null

  const file = await postPdfOnce(supabase, { groupId, dedupeKey: input.dedupeKey, pdf: input.pdf, fileName: input.fileName })
  return {
    ok: true,
    group_id: groupId,
    card_message_id: cardMessageId,
    file_message_id: file.messageId,
    deduplicated: Boolean(posted.skipped) && file.deduplicated,
  }
}

async function botDirectRoom(supabase: DbClient, recipientUserId: string): Promise<number> {
  const { data: gid, error } = await supabase.rpc("chat_ensure_bot_direct", { p_bot: AI_ANALYSIS_BOT_ID, p_user: recipientUserId })
  if (error) {
    if (String(error.code ?? "") === "22023") throw new ExternalPostError("送信先の利用者が見つからないか、利用停止中です", 404)
    throw new Error("direct room failed")
  }
  const groupId = Number(gid)
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new Error("direct room failed")
  return groupId
}

const ROOM_COLUMNS = "id, group_name, is_direct, trashed_at, is_admin_notice_room, is_store_room"

async function listStoreBots(supabase: DbClient) {
  const { data: bots, error } = await supabase.from("chat_users").select("id, username, store_key, is_bot, bot_deleted_at")
    .eq("is_bot", true).not("store_key", "is", null).is("bot_deleted_at", null).limit(500)
  if (error) throw new Error("store bots failed")
  const ids = (bots ?? []).map((b: { id: string }) => b.id)
  if (!ids.length) return []
  const { data: memberships, error: mError } = await supabase.from("chat_group_members").select("user_id, group_id").in("user_id", ids).limit(5000)
  if (mError) throw new Error("store bot rooms failed")
  const groupIds = [...new Set((memberships ?? []).map((m: { group_id: number }) => Number(m.group_id)))]
  const { data: groups, error: gError } = groupIds.length
    ? await supabase.from("chat_groups").select(ROOM_COLUMNS).in("id", groupIds)
    : { data: [], error: null }
  if (gError) throw new Error("store bot rooms failed")
  const roomIds = alertRooms((groups ?? []) as BotRoomRow[]).map((r) => r.id)
  const { data: members, error: cError } = roomIds.length
    ? await supabase.from("chat_group_members").select("group_id").in("group_id", roomIds).limit(20000)
    : { data: [], error: null }
  if (cError) throw new Error("room members failed")
  const counts = new Map<number, number>()
  for (const m of members ?? []) counts.set(Number(m.group_id), (counts.get(Number(m.group_id)) ?? 0) + 1)
  return storeBotList(bots ?? [], memberships ?? [], (groups ?? []) as BotRoomRow[], counts)
}

/** 店舗Bot（削除されていない・store_key あり）と、投稿してよいルーム（参加しているグループ。1対1・ゴミ箱・管理者通知を除く）。 */
async function storeBotRooms(supabase: DbClient, botId: string, roomIds: number[] | null) {
  const { data: bot, error: botError } = await supabase.from("chat_users").select("id, username, store_key")
    .eq("id", botId).eq("is_bot", true).not("store_key", "is", null).is("bot_deleted_at", null).maybeSingle()
  if (botError) throw new Error("store bot lookup failed")
  if (!bot) throw new ExternalPostError("店舗Botが見つからないか、削除されています", 404)
  const asUser = await loadMtalkStoreBot(supabase, String(bot.store_key))
  if (!asUser) throw new ExternalPostError("店舗Botが見つからないか、削除されています", 404)
  const { data: memberships, error: mError } = await supabase.from("chat_group_members").select("group_id").eq("user_id", botId).limit(1000)
  if (mError) throw new Error("store bot rooms failed")
  const groupIds = (memberships ?? []).map((m: { group_id: number }) => Number(m.group_id))
  const { data: groups, error: gError } = groupIds.length
    ? await supabase.from("chat_groups").select(ROOM_COLUMNS).in("id", groupIds)
    : { data: [], error: null }
  if (gError) throw new Error("store bot rooms failed")
  const rooms = alertRooms((groups ?? []) as BotRoomRow[], roomIds)
  if (!rooms.length) throw new ExternalPostError(roomIds ? "選んだルームにこの店舗Botが参加していません" : "この店舗Botが参加しているグループのルームがありません", 404)
  return { asUser, rooms }
}

// gourmet の口コミ通知（カードのみ・PDFなし）
async function alert(supabase: DbClient, bodyText: string) {
  let raw: unknown
  try {
    raw = JSON.parse(bodyText)
  } catch {
    throw new ExternalPostError("送信内容が不正です")
  }
  const input = validateAlertInput(raw)
  const { text, cards } = buildReviewAlertCards(input)

  if (input.target.kind === "user") {
    // 旧形式: 「AI分析」Botとの1対1
    const groupId = await botDirectRoom(supabase, input.target.recipientUserId)
    const posted = await postChatCardIndependent(supabase, {
      groupId, text, cards, kind: REVIEW_ALERT_KIND, dedupeKey: input.dedupeKey,
      asUser: { id: AI_ANALYSIS_BOT_ID, username: AI_ANALYSIS_BOT_USERNAME },
    })
    if (!posted.ok) throw new Error("card post failed")
    const messageId = posted.skipped ? (await dispatchMessageId(supabase, REVIEW_ALERT_KIND, groupId, input.dedupeKey))?.message_id ?? null : posted.messageId ?? null
    return { ok: true, group_id: groupId, message_id: messageId, deduplicated: Boolean(posted.skipped) }
  }

  // 店舗Botとして、Bot が参加しているグループのルームへ
  const { botId, roomIds } = input.target
  const { asUser, rooms } = await storeBotRooms(supabase, botId, roomIds)

  const results: { group_id: number; name: string; message_id: number | null; deduplicated: boolean }[] = []
  let failed = 0
  for (const room of rooms) {
    const posted = await postChatCardIndependent(supabase, { groupId: room.id, text, cards, kind: REVIEW_ALERT_KIND, dedupeKey: input.dedupeKey, asUser })
    if (!posted.ok) { failed++; continue }
    const messageId = posted.skipped ? (await dispatchMessageId(supabase, REVIEW_ALERT_KIND, room.id, input.dedupeKey))?.message_id ?? null : posted.messageId ?? null
    results.push({ group_id: room.id, name: room.name, message_id: messageId, deduplicated: Boolean(posted.skipped) })
  }
  // 1つでも失敗したら 502（gourmet は同じ dedupe_key でやり直す。投稿済みのルームは chat_alert_dispatches が飛ばす）
  if (failed) throw new Error("card post failed")
  return { ok: true, bot_id: botId, bot_name: asUser.username, rooms: results, deduplicated: results.every((r) => r.deduplicated) }
}

// ---------- 店舗Botの投稿（gourmet の週報: カード＋PDF） ----------
async function storePost(supabase: DbClient, bodyText: string) {
  let raw: unknown
  try {
    raw = JSON.parse(bodyText)
  } catch {
    throw new ExternalPostError("送信内容が不正です")
  }
  const input = validateStorePostInput(raw)
  const { text, cards } = buildStorePostCard(input)
  const { asUser, rooms } = await storeBotRooms(supabase, input.botId, input.roomIds)
  const files = input.files.map((f) => ({ filename: f.fileName, bytes: f.pdf.byteLength }))
  if (input.dryRun) {
    // 投稿しない（Bot・ルーム・カードの確認だけ）。送信済みかどうかも返す
    const preview = []
    for (const room of rooms) {
      const sent = await dispatchMessageId(supabase, STORE_POST_CARD_KIND, room.id, input.dedupeKey)
      preview.push({ group_id: room.id, name: room.name, is_store_room: room.isStoreRoom, already_sent: Boolean(sent?.message_id) })
    }
    return { ok: true, dry_run: true, bot_id: input.botId, bot_name: asUser.username, rooms: preview, text, cards, files }
  }

  const results: { group_id: number; name: string; card_message_id: number | null; file_message_ids: number[]; deduplicated: boolean }[] = []
  let failed = 0
  for (const room of rooms) {
    try {
      const posted = await postChatCardIndependent(supabase, { groupId: room.id, text, cards, kind: STORE_POST_CARD_KIND, dedupeKey: input.dedupeKey, asUser })
      if (!posted.ok) { failed++; continue }
      const cardMessageId = posted.skipped
        ? (await dispatchMessageId(supabase, STORE_POST_CARD_KIND, room.id, input.dedupeKey))?.message_id ?? null
        : posted.messageId ?? null
      let allFilesDeduplicated = true
      const fileIds: number[] = []
      for (const [i, f] of input.files.entries()) {
        const file = await postPdfOnce(supabase, {
          groupId: room.id, dedupeKey: storePostFileDedupeKey(input.dedupeKey, i), pdf: f.pdf, fileName: f.fileName,
          kind: STORE_POST_FILE_KIND, asUser, folder: "store-posts",
        })
        fileIds.push(file.messageId)
        if (!file.deduplicated) allFilesDeduplicated = false
      }
      results.push({ group_id: room.id, name: room.name, card_message_id: cardMessageId, file_message_ids: fileIds, deduplicated: Boolean(posted.skipped) && allFilesDeduplicated })
    } catch (error) {
      if (error instanceof ExternalPostError && error.status === 409) throw error
      console.error("[mtalk-external-post] store post room failed:", error instanceof Error ? error.message.slice(0, 80) : "unknown")
      failed++
    }
  }
  // 1つでも失敗したら 502（gourmet は同じ dedupe_key でやり直す。投稿済みのカード・PDFはルームごとに飛ばされる）
  if (failed) throw new Error("store post failed")
  return { ok: true, bot_id: input.botId, bot_name: asUser.username, rooms: results, deduplicated: results.every((r) => r.deduplicated) }
}

// ---------- 「AI分析」Bot への質問 → gourmet の AI分析 → Bot の返信 ----------
async function postBotText(supabase: DbClient, groupId: number, text: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("chat_messages")
    .insert({ group_id: groupId, user_id: AI_ANALYSIS_BOT_ID, username: AI_ANALYSIS_BOT_USERNAME, content: text, kind: "text" })
    .select("id")
    .single()
  if (error) throw new Error("reply insert failed")
  return Number(data?.id) || null
}

async function askGourmet(body: string): Promise<{ status: number; data: unknown }> {
  const token = String(Deno.env.get("GOURMET_MTALK_TOKEN") ?? "").trim()
  if (token.length < 32) return { status: 503, data: null }
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = await signExternalRequest(token, { timestamp, method: "POST", path: AI_CHAT_PATH, body })
  try {
    const res = await fetch(`${gourmetAiAnalystUrl(Deno.env.get("GOURMET_AI_ANALYST_URL"))}${AI_CHAT_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Mtalk-Timestamp": timestamp, "X-Mtalk-Signature": signature, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(AI_CHAT_LIMITS.timeoutMs),
    })
    return { status: res.status, data: await res.json().catch(() => null) }
  } catch {
    return { status: 504, data: null }
  }
}

async function chatDispatch(req: Request, supabase: DbClient): Promise<Response> {
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim() ?? ""
  const { data: config } = await supabase.from("chat_push_internal_config").select("dispatch_secret").eq("id", true).maybeSingle()
  const secret = String(config?.dispatch_secret ?? "")
  if (!secret || !token || !constantTimeEqualSecret(token, secret)) return respond({ error: "unauthorized" }, 401)

  const raw = await readBodyLimited(req, 4_096)
  let messageId = 0
  try { messageId = Number((JSON.parse(raw) as { message_id?: unknown }).message_id) } catch { messageId = 0 }
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return respond({ error: "message_id is required" }, 400)

  const { data: message } = await supabase.from("chat_messages")
    .select("id, group_id, user_id, content, kind").eq("id", messageId).maybeSingle()
  const row = message as AiChatMessageRow | null
  const groupId = Number(row?.group_id)
  const [{ data: group }, { data: sender }, { data: access }, { data: botMember }] = row
    ? await Promise.all([
      supabase.from("chat_groups").select("id, is_direct, direct_key, trashed_at").eq("id", groupId).maybeSingle(),
      supabase.from("chat_users").select("id, is_bot").eq("id", row.user_id).maybeSingle(),
      supabase.from("chat_user_access").select("access_enabled, deleted_at, restricted_until").eq("user_id", row.user_id).maybeSingle(),
      supabase.from("chat_group_members").select("user_id").eq("group_id", groupId).eq("user_id", AI_ANALYSIS_BOT_ID).maybeSingle(),
    ])
    : [{ data: null }, { data: null }, { data: null }, { data: null }]
  const eligible = aiChatEligibility({ message: row, group, sender, access, botIsMember: Boolean(botMember) })
  if (!eligible.ok) return respond({ ok: true, skipped: eligible.reason })

  // 同じ発言には1回だけ答える（pg_net の再送・二重起動に備える）
  const { error: claimError } = await supabase.from("chat_alert_dispatches")
    .insert({ kind: AI_CHAT_REPLY_KIND, chat_group_id: groupId, dedupe_key: `msg:${messageId}`, status: AI_CHAT_STATUS.pending })
  if (claimError) {
    if (String(claimError.code ?? "") === "23505") return respond({ ok: true, skipped: "duplicate" })
    throw new Error("reply claim failed")
  }

  // gourmet の回答には数十秒かかることがあるため、受け付けたら先に 202 を返し、続きはバックグラウンドで行う。
  const work = answerInBackground(supabase, row!, groupId, messageId)
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(value: Promise<unknown>): void } }).EdgeRuntime
  if (runtime?.waitUntil) {
    runtime.waitUntil(work)
    return respond({ ok: true, accepted: true }, 202)
  }
  await work
  return respond({ ok: true, accepted: true }, 202)
}

/**
 * pending → answered / failed を1回だけ確定する。見張り（chat_ai_analysis_reply_timeouts）が先に
 * timed_out にしていれば false（案内は送信済みなので、遅れて届いた答えは送らない）。
 */
async function finishDispatch(supabase: DbClient, groupId: number, messageId: number, status: string): Promise<boolean> {
  const { data, error } = await supabase.from("chat_alert_dispatches")
    .update({ status, finished_at: new Date().toISOString() })
    .eq("kind", AI_CHAT_REPLY_KIND).eq("chat_group_id", groupId).eq("dedupe_key", `msg:${messageId}`)
    .eq("status", AI_CHAT_STATUS.pending)
    .select("id")
  if (error) throw new Error("reply finish failed")
  return Array.isArray(data) && data.length > 0
}

async function recordReply(supabase: DbClient, groupId: number, messageId: number, replyId: number | null): Promise<void> {
  if (replyId == null) return
  await supabase.from("chat_alert_dispatches").update({ message_id: replyId })
    .eq("kind", AI_CHAT_REPLY_KIND).eq("chat_group_id", groupId).eq("dedupe_key", `msg:${messageId}`)
}

async function answerInBackground(supabase: DbClient, row: AiChatMessageRow, groupId: number, messageId: number): Promise<void> {
  let replyId: number | null = null
  let finished = false
  try {
    const { data: recent } = await supabase.from("chat_messages")
      .select("id, group_id, user_id, content, kind")
      .eq("group_id", groupId).lt("id", messageId)
      .order("id", { ascending: false }).limit(AI_CHAT_LIMITS.historyMessages)
    const history = buildAiChatHistory((recent ?? []) as AiChatMessageRow[])
    const answer = await askGourmet(aiChatRequestBody(row, history))
    const parts = answer.status === 200 ? aiChatReplyParts(answer.data) : []
    const links = answer.status === 200 ? aiChatLinks(answer.data) : []
    const ok = parts.length > 0
    if (!ok) console.error("[mtalk-external-post] chat answer failed:", answer.status)
    if (!await finishDispatch(supabase, groupId, messageId, ok ? AI_CHAT_STATUS.answered : AI_CHAT_STATUS.failed)) {
      console.error("[mtalk-external-post] chat answer arrived after the timeout notice; dropped")
      return
    }
    finished = true
    for (const part of parts.length ? parts : [aiChatErrorMessage(answer.status, answer.data)]) {
      const id = await postBotText(supabase, groupId, part)
      if (replyId == null) {
        replyId = id
        // 1通目を送ったらすぐ記録する（ここで止まっても、見張りが重ねて案内を出さないように）。
        await recordReply(supabase, groupId, messageId, replyId)
      }
    }
    // 取り込みがログイン情報の問題で止まっているサイトがあれば「ログイン情報を更新」のボタン（答えのあと・1回だけ）
    if (ok) await postLoginLinks(supabase, groupId, links, `msg:${messageId}`)
  } catch (error) {
    console.error("[mtalk-external-post] chat dispatch failed:", error instanceof Error ? error.message.slice(0, 80) : "unknown")
    // まだ確定していなければ failed にしてから案内を出す（見張りと二重にならないように）。
    const mayPost = finished || await finishDispatch(supabase, groupId, messageId, AI_CHAT_STATUS.failed).catch(() => false)
    if (mayPost && replyId == null) {
      replyId = await postBotText(supabase, groupId, AI_CHAT_GENERIC_ERROR).catch(() => null)
      await recordReply(supabase, groupId, messageId, replyId).catch(() => undefined)
    }
  }
}

// 「ログイン情報を更新」のカード（答えのあと・同じ dedupe ごとに1回だけ）。送れなくても答えは届いているので失敗にしない
async function postLoginLinks(supabase: DbClient, groupId: number, links: LoginLink[], dedupeKey: string): Promise<void> {
  if (!links.length) return
  const { text, cards } = buildLoginLinksCard(links)
  const posted = await postChatCardIndependent(supabase, {
    groupId, text, cards, kind: AI_CHAT_LOGIN_LINKS_KIND, dedupeKey,
    asUser: { id: AI_ANALYSIS_BOT_ID, username: AI_ANALYSIS_BOT_USERNAME },
  }).catch(() => ({ ok: false }))
  if (!posted.ok) console.error("[mtalk-external-post] login links card failed")
}

// ---------- gourmet からのお知らせ（「再ログイン後の取得結果」など） ----------
async function chatNotice(supabase: DbClient, bodyText: string) {
  let raw: unknown
  try {
    raw = JSON.parse(bodyText)
  } catch {
    throw new ExternalPostError("送信内容が不正です")
  }
  const input = validateChatNoticeInput(raw)
  // 送り先は、その利用者と「AI分析」Botの1対1だけ
  const groupId = await botDirectRoom(supabase, input.mtalkUserId)
  if (groupId !== input.groupId) throw new ExternalPostError("送信先のトークが見つかりません", 404)
  const key = aiChatNoticeDedupeKey(input.noticeId)
  const { error: claimError } = await supabase.from("chat_alert_dispatches")
    .insert({ kind: AI_CHAT_NOTICE_KIND, chat_group_id: groupId, dedupe_key: key })
  if (claimError) {
    if (String(claimError.code ?? "") !== "23505") throw new Error("notice claim failed")
    const { data } = await supabase.from("chat_alert_dispatches").select("message_id")
      .eq("kind", AI_CHAT_NOTICE_KIND).eq("chat_group_id", groupId).eq("dedupe_key", key).maybeSingle()
    return { ok: true, group_id: groupId, message_id: (data as { message_id: number | null } | null)?.message_id ?? null, deduplicated: true }
  }
  let first: number | null = null
  try {
    for (const part of input.parts) {
      const id = await postBotText(supabase, groupId, part)
      if (first == null) {
        first = id
        await supabase.from("chat_alert_dispatches").update({ message_id: first })
          .eq("kind", AI_CHAT_NOTICE_KIND).eq("chat_group_id", groupId).eq("dedupe_key", key)
      }
    }
  } catch (error) {
    // 1通も送れていなければ取り消す（gourmet がやり直す）
    if (first == null) {
      await supabase.from("chat_alert_dispatches").delete().eq("kind", AI_CHAT_NOTICE_KIND).eq("chat_group_id", groupId).eq("dedupe_key", key)
    }
    throw error
  }
  await postLoginLinks(supabase, groupId, input.links, key)
  return { ok: true, group_id: groupId, message_id: first, deduplicated: false }
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^.*\/mtalk-external-post/, "") || "/"
  try {
    if (req.method !== "GET" && req.method !== "POST") return respond({ error: "method not allowed" }, 405)
    if (path === "/chat-dispatch") {
      if (req.method !== "POST") return respond({ error: "method not allowed" }, 405)
      const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      return await chatDispatch(req, service)
    }
    const bodyText = req.method === "POST" ? await readBodyLimited(req, EXTERNAL_POST_LIMITS.bodyMaxBytes) : ""
    const authorized = await verifyExternalRequest({
      authorization: req.headers.get("authorization"),
      timestamp: req.headers.get("x-mtalk-timestamp"),
      signature: req.headers.get("x-mtalk-signature"),
      method: req.method,
      path,
      body: bodyText,
    }, Deno.env.get("GOURMET_MTALK_TOKEN") ?? "")
    if (!authorized) return respond({ error: "unauthorized" }, 401)

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    if (path === "/recipients" && req.method === "GET") return respond({ recipients: await listRecipients(supabase) })
    if (path === "/store-bots" && req.method === "GET") return respond({ bots: await listStoreBots(supabase) })
    if (path === "/send" && req.method === "POST") return respond(await send(supabase, bodyText))
    if (path === "/alert" && req.method === "POST") return respond(await alert(supabase, bodyText))
    if (path === STORE_POST_PATH && req.method === "POST") return respond(await storePost(supabase, bodyText))
    if (path === AI_CHAT_NOTICE_PATH && req.method === "POST") return respond(await chatNotice(supabase, bodyText))
    return respond({ error: "not found" }, 404)
  } catch (error) {
    if (error instanceof ExternalPostError) return respond({ error: error.message }, error.status)
    // 本文・PDF・トークン・DBの詳細は出さない（種類だけ）
    console.error("[mtalk-external-post] failed:", error instanceof Error ? error.message.slice(0, 80) : "unknown")
    return respond({ error: "M-talkへの送信を完了できませんでした" }, 502)
  }
})
