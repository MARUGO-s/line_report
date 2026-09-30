/**
 * mtalk-external-post — 外部アプリ（gourmet の AI分析）から M-talk の利用者へ
 * 「AI分析」Bot の1対1でレポートのカードとPDFを届ける。
 *
 *   GET  /recipients  有効な人間の利用者（id, username, stores）
 *   POST /send        { recipient_user_id, report_id, sender_label, title, card, pdf_base64, filename, dedupe_key }
 *
 * verify_jwt = false（呼び出し元は Supabase の利用者JWTを持たない）。認可は関数内で
 * GOURMET_MTALK_TOKEN の定数時間比較 + HMAC 署名（±5分）で行い、欠けたら常に 401。
 * ブラウザからは呼ばないため CORS ヘッダーは返さない。トークン・本文・PDFはログへ出さない。
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { postChatCardIndependent } from "../_shared/chat_bridge.ts"
import {
  activeRecipients,
  AI_ANALYSIS_BOT_ID,
  AI_ANALYSIS_BOT_USERNAME,
  AI_REPORT_CARD_KIND,
  AI_REPORT_FILE_KIND,
  buildAiReportCard,
  EXTERNAL_POST_LIMITS,
  ExternalPostError,
  validateSendInput,
  verifyExternalRequest,
} from "../_shared/mtalk_external_post.ts"

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

async function postPdfOnce(
  supabase: DbClient,
  options: { groupId: number; dedupeKey: string; pdf: Uint8Array<ArrayBuffer>; fileName: string },
): Promise<{ messageId: number; deduplicated: boolean }> {
  const { groupId, dedupeKey } = options
  const claim = () => supabase.from("chat_alert_dispatches").insert({ kind: AI_REPORT_FILE_KIND, chat_group_id: groupId, dedupe_key: dedupeKey })
  const release = () => supabase.from("chat_alert_dispatches").delete()
    .eq("kind", AI_REPORT_FILE_KIND).eq("chat_group_id", groupId).eq("dedupe_key", dedupeKey).is("message_id", null)
  let { error: claimError } = await claim()
  if (claimError && String(claimError.code ?? "") === "23505") {
    const existing = await dispatchMessageId(supabase, AI_REPORT_FILE_KIND, groupId, dedupeKey)
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

  const path = `groups/${groupId}/ai-reports/${crypto.randomUUID()}.pdf`
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
      user_id: AI_ANALYSIS_BOT_ID,
      username: AI_ANALYSIS_BOT_USERNAME,
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
    .eq("kind", AI_REPORT_FILE_KIND).eq("chat_group_id", groupId).eq("dedupe_key", dedupeKey)
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

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^.*\/mtalk-external-post/, "") || "/"
  try {
    if (req.method !== "GET" && req.method !== "POST") return respond({ error: "method not allowed" }, 405)
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
    if (path === "/send" && req.method === "POST") return respond(await send(supabase, bodyText))
    return respond({ error: "not found" }, 404)
  } catch (error) {
    if (error instanceof ExternalPostError) return respond({ error: error.message }, error.status)
    // 本文・PDF・トークン・DBの詳細は出さない（種類だけ）
    console.error("[mtalk-external-post] failed:", error instanceof Error ? error.message.slice(0, 80) : "unknown")
    return respond({ error: "M-talkへの送信を完了できませんでした" }, 502)
  }
})
