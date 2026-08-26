import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { hasKnowledgeMemoTag, stripKnowledgeMemoTag } from "../_shared/knowledge_memo_tag.ts"
import {
  processStoreRoomImageLikeLine,
  postStoreRoomLineStyleReply,
  handleStoreRoomReceiptCommand,
  removeStoreRoomMediaForChatMessage,
  loadChatStoreBot,
  resolveRoomStoreKey,
} from "../_shared/chat_store_file_bridge.ts"
import { postChatCard, type ChatCardSection } from "../_shared/chat_bridge.ts"
import { ensureMtalkRoomSettings, loadMtalkRoomFlags } from "../_shared/mtalk_room_settings.ts"
import { mtalkSyntheticRoomId } from "../_shared/mtalk_room_id.ts"
import { tryAutoRegisterRoomSchedule } from "../_shared/mtalk_schedule_register.ts"
import { handleMtalkSearchText } from "../_shared/mtalk_search.ts"
import { loadStoreRegistryRow } from "../_shared/chat_store_file_bridge.ts"
import { generateCasualReply, isSoloHumanRoom } from "../_shared/mtalk_casual_chat.ts"

const SETTINGS_TRIGGER_WORDS = new Set(["設定", "権限設定", "せってい", "ルーム設定"])
const ROOM_SETTINGS_PAGE = "https://marugo-s.github.io/line_report/mtalk_room_settings.html"
// 「M-talkに貼る」でジャーナルレポートAIの回答を貼り付けた投稿の目印。
// jnl2txt.html の postAiAnswerToMtalk が本文の先頭へ付ける。
const JOURNAL_PASTE_PREFIX_RE = /^\[電子ジャーナル\]/

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

async function replyInRoom(
  supabase: DbClient,
  groupId: number,
  text: string,
  asUser?: { id: string; username: string } | null,
): Promise<void> {
  let userId = String(asUser?.id ?? "").trim()
  let username = String(asUser?.username ?? "").trim()
  if (!userId) {
    const { data: defaultBot, error: defaultBotError } = await supabase
      .from("chat_users")
      .select("id, username")
      .eq("id", CHAT_BOT_USER_ID)
      .eq("is_bot", true)
      .is("bot_deleted_at", null)
      .maybeSingle()
    if (defaultBotError || !defaultBot?.id) {
      console.warn("chat-knowledge default bot is deleted or missing:", defaultBotError?.message ?? "")
      return
    }
    userId = String(defaultBot.id)
    username = String(defaultBot.username || CHAT_BOT_USERNAME)
  }
  const { error } = await supabase.from("chat_messages").insert({
    group_id: groupId,
    user_id: userId,
    username: username || CHAT_BOT_USERNAME,
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

/** payload から添付ファイル情報を取り出す。 */
function filePayload(payload: unknown): { path: string; name: string; mime: string } | null {
  const file = (payload as { file?: Record<string, unknown> } | null)?.file
  if (!file) return null
  const path = String(file.path ?? "").trim()
  if (!path) return null
  return {
    path,
    name: String(file.name ?? "").trim() || "journal.lzh",
    mime: String(file.mime ?? "").trim(),
  }
}

function isJournalArchiveName(name: string): boolean {
  return /\.lzh$/i.test(String(name || "").trim())
}

function yen(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? `¥${Math.round(n).toLocaleString("ja-JP")}` : "-"
}

/**
 * 店舗ルームへ落とされた .lzh を、そのルームの店舗として電子ジャーナルへ取り込む。
 * 保管も解析も /pos-journals/upload に任せる（店舗コード検証・重複スキップ・
 * 対象月判定・保存レポート再作成まで、管理画面から入れたときと同じ処理が走る）。
 */
async function processStoreRoomJournalArchive(
  supabase: DbClient,
  params: {
    groupId: number
    storeKey: string
    path: string
    fileName: string
    asUser?: { id: string; username: string } | null
  },
): Promise<boolean> {
  const { data: file, error: downloadError } = await supabase.storage
    .from("chat-images")
    .download(params.path)
  if (downloadError || !file) {
    console.warn("journal archive download failed:", downloadError?.message)
    await postStoreRoomLineStyleReply(supabase, params.groupId, {
      text: "電子ジャーナルのファイルを読み込めませんでした。",
    }, params.asUser)
    return false
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "https://hocbnifuactbvmyjraxy.supabase.co"
  const internalKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  const form = new FormData()
  form.append("files", new Blob([await file.arrayBuffer()]), params.fileName)
  form.append("store_key", params.storeKey)

  let result: Record<string, unknown> = {}
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/admin-api/pos-journals/upload`, {
      method: "POST",
      headers: {
        "x-internal-key": internalKey,
        "x-admin-surface": "line_report",
        "x-store-key": params.storeKey,
      },
      body: form,
    })
    result = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg = String((result as { error?: unknown }).error ?? `HTTP ${res.status}`)
      await postStoreRoomLineStyleReply(supabase, params.groupId, {
        text: `電子ジャーナルを取り込めませんでした: ${msg}`,
      }, params.asUser)
      return false
    }
  } catch (err) {
    console.error("journal upload threw:", err instanceof Error ? err.message : String(err))
    await postStoreRoomLineStyleReply(supabase, params.groupId, {
      text: "電子ジャーナルの取込に失敗しました。時間をおいて試してください。",
    }, params.asUser)
    return false
  }

  const successes = Array.isArray(result.successes) ? result.successes : []
  const repaired = Array.isArray(result.repaired) ? result.repaired : []
  const duplicates = Array.isArray(result.duplicates) ? result.duplicates : []
  const failures = Array.isArray(result.failures) ? result.failures : []

  const rows: { label: string; value: string }[] = []
  const applied = [...successes, ...repaired]
  for (const row of applied) {
    const r = row as Record<string, unknown>
    rows.push({ label: String(r.business_date ?? "営業日"), value: yen(r.gross_sales) })
  }

  let headline = ""
  if (applied.length) {
    headline = repaired.length ? "電子ジャーナルを登録・修復しました" : "電子ジャーナルを登録しました"
  } else if (duplicates.length) {
    headline = "同じ内容が登録済みのため取り込みませんでした"
  } else if (failures.length) {
    const first = failures[0] as Record<string, unknown>
    const reason = String(first?.error ?? first?.message ?? "取込に失敗しました")
    await postStoreRoomLineStyleReply(supabase, params.groupId, {
      text: `電子ジャーナルを取り込めませんでした: ${reason}`,
    }, params.asUser)
    return false
  } else {
    headline = "取り込む対象がありませんでした"
  }

  const sections: ChatCardSection[] = []
  if (rows.length) sections.push({ type: "fields", rows })
  const notes: string[] = []
  if (duplicates.length) notes.push(`重複スキップ ${duplicates.length}件`)
  if (failures.length) notes.push(`失敗 ${failures.length}件`)
  notes.push("Journal Report の日別・月間レポートも更新されます。")
  sections.push({ type: "note", text: notes.join(" / "), size: "xs" })

  await postStoreRoomLineStyleReply(supabase, params.groupId, {
    text: `${headline}（${params.fileName}）`,
    card: {
      variant: "line",
      header: { title: headline, subtitle: params.fileName },
      sections,
    },
  }, params.asUser)
  return true
}

async function handleDispatch(req: Request, supabase: DbClient): Promise<Response> {
  const body = await req.json().catch(() => ({})) as { message_id?: unknown; store_key?: unknown }
  const messageId = Number(body.message_id)
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return json({ ok: false, error: "message_id is required" }, 400)
  }

  const { data: message, error } = await supabase
    .from("chat_messages")
    .select("id, group_id, user_id, username, content, kind, payload, reply_to_id, created_at, chat_groups!group_id(store_key, is_store_room)")
    .eq("id", messageId)
    .maybeSingle()
  if (error) return json({ ok: false, error: error.message }, 500)
  if (!message) return json({ ok: true, skipped: true, reason: "missing" }, 200)
  const { data: sender } = await supabase
    .from("chat_users")
    .select("is_bot")
    .eq("id", message.user_id)
    .maybeSingle()
  if (String(message.user_id) === CHAT_BOT_USER_ID || sender?.is_bot) {
    return json({ ok: true, skipped: true, reason: "bot" }, 200)
  }

  const group = Array.isArray(message.chat_groups) ? message.chat_groups[0] : message.chat_groups
  const groupId = Number(message.group_id)
  const fromDispatch = String(body.store_key ?? "").trim()
  const resolved = await resolveRoomStoreKey(supabase, group, groupId)
  const text = String(message.content ?? "").trim()
  // 「M-talkに貼る」で貼り付けたジャーナルレポートAIの回答（本文が
  // 「[電子ジャーナル]」で始まる）には、雑談AIも含めBotが一切反応しない。
  // 貼り付けた分析へさらにAIが返信すると会話が二重になり紛らわしいため。
  if (JOURNAL_PASTE_PREFIX_RE.test(text)) {
    return json({ ok: true, skipped: true, reason: "journal paste" }, 200)
  }
  const candidateStoreKey = fromDispatch || String(resolved.storeKey ?? "").trim()
  const activeStoreBot = candidateStoreKey
    ? await loadChatStoreBot(supabase, candidateStoreKey)
    : null
  if (candidateStoreKey && !activeStoreBot) {
    return json({ ok: true, skipped: true, reason: "store bot deleted or missing" }, 200)
  }

  const calendarRoomId = mtalkSyntheticRoomId(groupId)
  const calendarFlags = await loadMtalkRoomFlags(supabase, groupId)
  if (calendarRoomId && text && message.kind !== "image") {
    const registered = await tryAutoRegisterRoomSchedule(supabase, {
      roomId: calendarRoomId,
      text,
      source: "mtalk",
      autoCreate: calendarFlags.calendar_ai_auto_create_enabled,
      silent: calendarFlags.calendar_silent_auto_register_enabled,
      replyEnabled: calendarFlags.calendar_registration_reply_enabled,
      hardMute: calendarFlags.bot_reply_hard_mute_enabled,
    })
    if (registered.handled) {
      if (registered.replyText) {
        await replyInRoom(supabase, groupId, registered.replyText, activeStoreBot)
      }
      return json({ ok: true, processed: true, kind: "schedule" }, 200)
    }
  }

  if (SETTINGS_TRIGGER_WORDS.has(text)) {
    const ensured = await ensureMtalkRoomSettings(supabase, groupId)
    const url = `${ROOM_SETTINGS_PAGE}?from=chat&group_id=${groupId}&v=202608201340`
    if (!ensured) {
      await replyInRoom(supabase, groupId, "このルームの設定を開けませんでした。少し時間をおいて、もう一度「設定」と送ってください。", activeStoreBot)
      return json({ ok: false, error: "ensure settings failed" }, 500)
    }
    await postChatCard(supabase, {
      groupId,
      kind: "room_config",
      text: "このルームの設定ページを開いて、Bot機能を ON/OFF できます。",
      cards: [{
        header: { title: "このルームの設定" },
        sections: [{
          type: "note",
          text: "下のボタンから開き、このルームの機能を切り替えられます。変更はその場で保存されます。",
        }],
        action: { label: "設定ページを開く", url, style: "primary" },
      }],
      asUser: activeStoreBot,
    })
    return json({ ok: true, processed: true, kind: "room-config" }, 200)
  }

  if (!fromDispatch && resolved.ambiguous) {
    await replyInRoom(supabase, groupId, "このルームには複数の店舗Botがいるため処理できません。店舗Botは1つにしてください。")
    return json({ ok: true, skipped: true, reason: "ambiguous store bot" }, 200)
  }
  const storeKey = candidateStoreKey
  if (!storeKey) {
    return json({ ok: true, skipped: true, reason: "not store room" }, 200)
  }
  const storeBot = activeStoreBot
  const flags = await loadMtalkRoomFlags(supabase, groupId)
  const senderName = String(message.username || "M-talk")
  const lineTimestamp = Date.parse(String(message.created_at || "")) || Date.now()

  const registry = await loadStoreRegistryRow(supabase, storeKey)
  if (registry && message.kind !== "image" && !imagePathFromPayload(message.payload)) {
    const searched = await handleMtalkSearchText(supabase, {
      groupId,
      senderUserId: String(message.user_id || ""),
      text,
      registry,
      asUser: storeBot,
    })
    if (searched) return json({ ok: true, processed: true, kind: "search" }, 200)
  }

  // .lzh は電子ジャーナルの原本。ルームの店舗として取り込む。
  const attachment = filePayload(message.payload)
  if (message.kind === "file" && attachment && isJournalArchiveName(attachment.name)) {
    const done = await processStoreRoomJournalArchive(supabase, {
      groupId,
      storeKey,
      path: attachment.path,
      fileName: attachment.name,
      asUser: storeBot,
    })
    return json({ ok: done, processed: true, kind: "journal-archive" }, 200)
  }

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
    if (flags.image_analysis_reply_enabled === false) {
      return json({ ok: true, processed: true, kind: result.kind, reply: false }, 200)
    }
    await postStoreRoomLineStyleReply(supabase, groupId, result, storeBot)
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

    // ここまでの既存コマンドに一致しなかった発言。自分以外の人間がいない
    // 部屋（店舗Botとの1対1、または自分でBotを招待して作った部屋）でだけ、
    // 雑談・簡単な相談として oss-120b で返す。グループでは黙って無視する
    // （他のスタッフの雑談を勝手にAIへ送らないため）。
    if (text && await isSoloHumanRoom(supabase, groupId, String(message.user_id || ""))) {
      const casualReply = await generateCasualReply(supabase, {
        groupId,
        messageId,
        storeName: registry?.display_name || storeBot?.username || "",
        botUserId: storeBot?.id || "",
        question: text,
      })
      if (casualReply) {
        await replyInRoom(supabase, groupId, casualReply, storeBot)
        return json({ ok: true, processed: true, kind: "casual-chat" }, 200)
      }
    }
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
        try { await removeStoreRoomMediaForChatMessage(supabase, groupId, Number(quoted.id)) } catch (_) { /* ignore */ }
      }
      await replyInRoom(
        supabase,
        groupId,
        ok
          ? "✅ 引用元のファイルを店舗ナレッジ（資料）に登録しました。Journal Report の「資料」タブから確認できます。"
          : "⚠️ 引用元のファイルを登録できませんでした。少し時間をおいて、登録したい画像にリプライで #メモ と送ってください。",
        storeBot,
      )
      return json({ ok, processed: ok, kind: "image" }, 200)
    }
  }

  if (!clean) {
    await replyInRoom(
      supabase,
      groupId,
      "📝 #メモ の使い方\n・画像やファイルを登録する場合: 登録したい画像を長押し（PCでは右クリック）→「リプライ」を選び、#メモ と返信してください。\n・テキストメモの場合: #メモ に続けて本文を書いて送信してください。\n※画像を送っただけ、#メモ 単体を送っただけでは登録されません。",
      storeBot,
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
    storeBot,
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
