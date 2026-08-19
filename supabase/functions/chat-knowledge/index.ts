import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { hasKnowledgeMemoTag, stripKnowledgeMemoTag } from "../_shared/knowledge_memo_tag.ts"
import {
  processStoreRoomImageLikeLine,
  postStoreRoomLineStyleReply,
  handleStoreRoomReceiptCommand,
  removeStoreRoomMediaForChatMessage,
} from "../_shared/chat_store_file_bridge.ts"

const CHAT_BOT_USER_ID = "00000000-0000-4000-8000-00000000b071"
const CHAT_BOT_USERNAME = "予約通知"

type DbClient = any

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function secureEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  if (aa.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i]
  return diff === 0
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

function bearerToken(req: Request): string {
  return /^Bearer\s+(.+)$/i.exec(String(req.headers.get("authorization") ?? "").trim())?.[1]?.trim() ?? ""
}

async function internalDispatchAuthorized(supabase: DbClient, token: string): Promise<boolean> {
  if (!token) return false
  const { data, error } = await supabase
    .from("chat_push_internal_config")
    .select("dispatch_secret")
    .eq("id", true)
    .maybeSingle()
  if (error || !data?.dispatch_secret) return false
  return secureEqual(token, String(data.dispatch_secret))
}

async function replyInRoom(supabase: DbClient, groupId: number, text: string): Promise<void> {
  const { error } = await supabase.from("chat_messages").insert({
    group_id: groupId,
    user_id: CHAT_BOT_USER_ID,
    username: CHAT_BOT_USERNAME,
    content: text,
    kind: "text",
  })
  if (error) console.error("chat-knowledge bot reply failed:", error.message)
}

function imagePathFromPayload(payload: unknown): { path: string; w?: number; h?: number } | null {
  const raw = typeof payload === "string" ? (() => { try { return JSON.parse(payload) } catch { return null } })() : payload
  const image = raw && typeof raw === "object" ? (raw as { image?: { path?: string; w?: number; h?: number } }).image : null
  const path = String(image?.path ?? "").trim()
  if (!path) return null
  return { path, w: Number(image?.w) || undefined, h: Number(image?.h) || undefined }
}

async function registerQuotedImage(
  supabase: DbClient,
  storeKey: string,
  quoted: { id: number; payload?: unknown; kind?: string },
  memoText: string,
  senderName: string,
  lineTimestamp: number | null,
): Promise<boolean> {
  const image = imagePathFromPayload(quoted.payload)
  if (!image) return false
  const { data: file, error } = await supabase.storage.from("chat-images").download(image.path)
  if (error || !file) {
    console.warn("chat-knowledge image download failed:", error?.message)
    return false
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!bytes.length) return false
  const contentType = file.type || "image/jpeg"
  const fileName = `mtalk_${quoted.id}.jpg`
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hocbnifuactbvmyjraxy.supabase.co"
  const internalKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  const bridgeHeaders = {
    "x-internal-key": internalKey,
    "x-admin-surface": "line_report",
    "x-store-key": storeKey,
  }
  const blob = new Blob([bytes], { type: contentType })

  const analyzeData = new FormData()
  analyzeData.append("file", blob, fileName)
  analyzeData.append("store_key", storeKey)
  const analyzeRes = await fetch(`${supabaseUrl}/functions/v1/admin-api/pos-journals/knowledge/analyze-image`, {
    method: "POST",
    headers: bridgeHeaders,
    body: analyzeData,
  })
  if (!analyzeRes.ok) {
    console.warn("chat-knowledge analyze failed:", analyzeRes.status, await analyzeRes.text())
    return false
  }
  const analyzeJson = await analyzeRes.json()
  const result = analyzeJson.result || {}

  const uploadData = new FormData()
  uploadData.append("file", blob, fileName)
  uploadData.append("store_key", storeKey)
  const uploadRes = await fetch(`${supabaseUrl}/functions/v1/admin-api/pos-journals/knowledge/upload`, {
    method: "POST",
    headers: bridgeHeaders,
    body: uploadData,
  })
  if (!uploadRes.ok) {
    console.warn("chat-knowledge upload failed:", uploadRes.status)
    return false
  }
  const uploadJson = await uploadRes.json()
  const storagePath = String(uploadJson.storage_path || "").trim()
  if (!storagePath) return false

  const recordPayload = {
    store_key: storeKey,
    category: result.category || "メニュー",
    title: result.title || `M-talkメモ_${quoted.id}`,
    summary: result.summary || "M-talkより投稿された資料メモ",
    body_text: result.body_text || memoText || "",
    tags: Array.isArray(result.tags) ? ["M-talk投稿", "資料メモ", ...result.tags] : ["M-talk投稿", "資料メモ"],
    storage_bucket: "store-knowledge",
    storage_path: storagePath,
    original_file_name: fileName,
    mime_type: contentType,
    file_size_bytes: bytes.length,
    source_type: "line_post",
    created_by: senderName || "M-talk",
    line_timestamp: lineTimestamp,
  }
  const saveRes = await fetch(`${supabaseUrl}/functions/v1/admin-api/pos-journals/knowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bridgeHeaders },
    body: JSON.stringify(recordPayload),
  })
  if (!saveRes.ok) {
    console.warn("chat-knowledge save failed:", saveRes.status, await saveRes.text())
    return false
  }
  return true
}

async function handleDispatch(req: Request, supabase: DbClient): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { message_id?: unknown }
  const messageId = Number(body.message_id)
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return json({ ok: false, error: "message_id is required" }, 400)
  }

  const { data: message, error } = await supabase
    .from("chat_messages")
    .select("id, group_id, user_id, username, content, kind, payload, reply_to_id, created_at, chat_groups(store_key, is_store_room)")
    .eq("id", messageId)
    .maybeSingle()
  if (error) return json({ ok: false, error: error.message }, 500)
  if (!message) return json({ ok: true, skipped: true, reason: "missing" }, 200)
  if (String(message.user_id) === CHAT_BOT_USER_ID) {
    return json({ ok: true, skipped: true, reason: "bot" }, 200)
  }

  const group = Array.isArray(message.chat_groups) ? message.chat_groups[0] : message.chat_groups
  const storeKey = String(group?.store_key ?? "").trim()
  if (!group?.is_store_room || !storeKey) {
    return json({ ok: true, skipped: true, reason: "not store room" }, 200)
  }

  const text = String(message.content ?? "").trim()
  const groupId = Number(message.group_id)
  const senderName = String(message.username || "M-talk")
  const lineTimestamp = Date.parse(String(message.created_at || "")) || Date.now()

  // LINE と同じ: #メモ が無い画像はメディア閲覧へ保存し、レシートなら解析して返す。
  if (message.kind === "image" || imagePathFromPayload(message.payload)) {
    const image = imagePathFromPayload(message.payload)
    if (!image) {
      return json({ ok: true, skipped: true, reason: "no image path" }, 200)
    }
    const { data: file, error: downloadError } = await supabase.storage.from("chat-images").download(image.path)
    if (downloadError || !file) {
      console.warn("chat-knowledge image download failed:", downloadError?.message)
      return json({ ok: false, error: "image download failed" }, 500)
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const result = await processStoreRoomImageLikeLine(supabase, {
      storeKey,
      groupId,
      chatMessageId: messageId,
      senderName,
      senderUserId: String(message.user_id || ""),
      contentType: file.type || "image/jpeg",
      bytes,
    })
    await postStoreRoomLineStyleReply(supabase, groupId, result)
    return json({ ok: true, processed: true, kind: result.kind }, 200)
  }

  if (!hasKnowledgeMemoTag(text)) {
    const handled = await handleStoreRoomReceiptCommand(supabase, {
      storeKey,
      groupId,
      senderUserId: String(message.user_id || ""),
      text,
    })
    if (handled) return json({ ok: true, processed: true, kind: "receipt-command" }, 200)
    return json({ ok: true, skipped: true, reason: "no memo tag" }, 200)
  }

  const clean = stripKnowledgeMemoTag(text)

  if (message.reply_to_id) {
    const { data: quoted } = await supabase
      .from("chat_messages")
      .select("id, kind, payload, content")
      .eq("id", message.reply_to_id)
      .maybeSingle()
    if (quoted && (quoted.kind === "image" || imagePathFromPayload(quoted.payload))) {
      const ok = await registerQuotedImage(supabase, storeKey, quoted, text, senderName, lineTimestamp)
      if (ok) {
        try { await removeStoreRoomMediaForChatMessage(supabase, Number(quoted.id)) } catch (_) { /* ignore */ }
      }
      await replyInRoom(
        supabase,
        groupId,
        ok
          ? "✅ 引用元のファイルを店舗ナレッジ（資料）に登録しました。Journal Report の「資料」タブから確認できます。"
          : "⚠️ 引用元のファイルを登録できませんでした。少し時間をおいて、登録したい画像にリプライで #メモ と送ってください。",
      )
      return json({ ok, processed: ok, kind: "image" }, 200)
    }
  }

  if (!clean) {
    await replyInRoom(
      supabase,
      groupId,
      "📝 #メモ の使い方\n・画像やファイルを登録する場合: 登録したい画像を長押し（PCでは右クリック）→「リプライ」を選び、#メモ と返信してください。\n・テキストメモの場合: #メモ に続けて本文を書いて送信してください。\n※画像を送っただけ、#メモ 単体を送っただけでは登録されません。",
    )
    return json({ ok: true, processed: false, reason: "usage" }, 200)
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hocbnifuactbvmyjraxy.supabase.co"
  const res = await fetch(`${supabaseUrl}/functions/v1/admin-api/pos-journals/knowledge/process-line-post`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-key": Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      "x-admin-surface": "line_report",
      "x-store-key": storeKey,
    },
    body: JSON.stringify({
      store_key: storeKey,
      text,
      sender_name: senderName,
      line_timestamp: lineTimestamp,
    }),
  })
  const resJson = res.ok ? await res.json().catch(() => ({})) : {}
  const processed = !!(res.ok && resJson.processed)
  await replyInRoom(
    supabase,
    groupId,
    processed
      ? "✅ メモを店舗ナレッジ（資料）に登録しました。Journal Report の「資料」タブから確認できます。"
      : "⚠️ メモを登録できませんでした。本文を確認して、少し時間をおいてからもう一度送信してください。",
  )
  return json({ ok: processed, processed, kind: "text" }, processed ? 200 : 500)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS })
  const supabaseUrl = String(Deno.env.get("SUPABASE_URL") ?? "").trim()
  const serviceRoleKey = String(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim()
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Supabase server configuration is missing." }, 500)
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as DbClient
  const url = new URL(req.url)
  const action = String(url.searchParams.get("action") ?? "").trim().toLowerCase()
  const token = bearerToken(req)
  if (req.method === "POST" && action === "dispatch" && await internalDispatchAuthorized(supabase, token)) {
    try {
      return await handleDispatch(req, supabase)
    } catch (error) {
      console.error("chat-knowledge dispatch error:", error)
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }
  return json({ ok: false, error: "Unauthorized." }, 401)
})
