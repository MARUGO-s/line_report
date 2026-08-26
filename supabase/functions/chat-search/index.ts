import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { mtalkCardFromLineReply } from "../_shared/chat_flex_card.ts"
import { buildAllFeaturesGuideFlex } from "../_shared/search_help_guide.ts"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const FALLBACK_BOT_ID = "00000000-0000-4000-8000-00000000b071"
const PENDING_NOTICE = "※検索待ちは2分です。待ち中に送ったキーワード1通だけ会話に記録しません（検索ノイズ防止）。"

type SearchKind = "calendar" | "media" | "sales"
type ChatAction = { label: string; command: string; style: "primary" | "secondary" }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  })
}

function secureEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  if (aa.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i]
  return diff === 0
}

function commandKind(text: string): SearchKind | "menu" | "help" | "cancel" | "message" | null {
  const value = text.trim().replace(/\s+/g, "")
  if (["検索", "検索ヘルプ", "検索の仕方", "検索方法", "search"].includes(value) || value === "srch=menu") return "menu"
  if (["ヘルプ", "使い方", "help"].includes(value) || value === "srch=help") return "help"
  if (["キャンセル", "やめる", "cancel"].includes(value) || value === "srch=cancel") return "cancel"
  if (["会話検索", "トーク検索", "会話を検索", "srch=msg"].includes(value)) return "message"
  if (["予定検索", "カレンダー検索", "予定を検索", "srch=cal"].includes(value)) return "calendar"
  if (["メディア検索", "画像検索", "ファイル検索", "srch=med"].includes(value)) return "media"
  if (["売上検索", "売り上げ検索", "レシート検索", "srch=sal"].includes(value)) return "sales"
  return null
}

function menuCard(enabled: Record<SearchKind, boolean>) {
  const action = (label: string, command: string, on: boolean): ChatAction => ({
    label: on ? label : `${label}（未設定）`,
    command: on ? command : "srch=menu",
    style: on ? "primary" : "secondary",
  })
  return {
    text: "検索メニュー — 予定・メディア・売上を検索",
    card: {
      variant: "line",
      header: { title: "過去データの検索（1対1）" },
      sections: [
        { type: "note", text: "検索したい種類のボタンを押し、続けてキーワード（売上は日付8桁）を送ると結果が返ります。", size: "sm" },
        { type: "note", text: "予定・メディアは、招待されているグループ等で記録した過去データも横断して検索できます（直近1年）。", size: "xs", color: "#888888" },
        { type: "note", text: PENDING_NOTICE, size: "xs", color: "#888888" },
      ],
      actions: [
        action("予定検索", "srch=cal", enabled.calendar),
        action("メディア検索", "srch=med", enabled.media),
        action("売上検索", "srch=sal", enabled.sales),
        { label: "📖 使い方（全機能）", command: "srch=help", style: "secondary" },
      ],
    },
  }
}

function promptCard(kind: SearchKind) {
  const details = {
    calendar: ["予定検索", "招待されているグループ等も含め、予定機能がONのルームの予定・予定関連トークを横断して検索します（直近1年）。\n次のメッセージで、件名やメモに含まれそうな語句を送ってください。\n例: 面接 / 貸切"],
    media: ["メディア検索", "メディア閲覧がONのルームに保存された画像・動画・ファイルを横断して検索します（直近1年）。\n次のメッセージで、ファイル名やメモに含まれる語句を送ってください。"],
    sales: ["売上検索", "売上を日付または月で検索します。\n次のメッセージで日付8桁（例: 20260521）または月6桁（例: 202605）を送ってください。"],
  } as const
  const [title, description] = details[kind]
  return {
    text: `${title} — キーワード入力待ち`,
    card: {
      variant: "line",
      header: { title },
      sections: [
        { type: "note", text: `${description}\n${PENDING_NOTICE}`, size: "sm" },
      ],
      actions: [
        { label: "検索メニューに戻る", command: "srch=menu", style: "secondary" },
        { label: "キャンセル", command: "srch=cancel", style: "secondary" },
      ],
    },
  }
}

function helpCard() {
  return mtalkCardFromLineReply(buildAllFeaturesGuideFlex(false))
}

async function postReply(supabase: any, groupId: number, bot: { id: string; username: string } | null, reply: { text: string; card?: unknown }) {
  const payload = reply.card ? { v: 1, kind: "search", cards: [reply.card] } : null
  let asBot = bot
  if (!asBot) {
    const { data: fallback } = await supabase
      .from("chat_users")
      .select("id, username")
      .eq("id", FALLBACK_BOT_ID)
      .eq("is_bot", true)
      .is("bot_deleted_at", null)
      .maybeSingle()
    if (!fallback?.id) throw new Error("返信に使えるBotがありません。")
    asBot = { id: String(fallback.id), username: String(fallback.username || "予約通知") }
  }
  const { error } = await supabase.from("chat_messages").insert({
    group_id: groupId,
    user_id: asBot.id,
    username: asBot.username,
    content: reply.text,
    // chat_messages.kind は表示形式、payload.kind はカードの用途。
    // DB制約で許可されるカード形式は必ず "card" にする。
    kind: reply.card ? "card" : "text",
    payload,
  })
  if (error) throw new Error(error.message)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405)

  const url = Deno.env.get("SUPABASE_URL") || ""
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } })
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "")?.[1]?.trim() || ""
  const { data: config } = await supabase.from("chat_push_internal_config").select("dispatch_secret").eq("id", true).maybeSingle()
  if (!config?.dispatch_secret || !secureEqual(token, String(config.dispatch_secret))) return json({ ok: false, error: "unauthorized" }, 401)

  const body = await req.json().catch(() => ({})) as { message_id?: unknown; store_key?: unknown }
  const messageId = Number(body.message_id)
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return json({ ok: false, error: "message_id is required" }, 400)
  const { data: message, error } = await supabase.from("chat_messages")
    .select("id, group_id, user_id, content")
    .eq("id", messageId).maybeSingle()
  if (error || !message) return json({ ok: false, error: error?.message || "message missing" }, 404)

  const command = commandKind(String(message.content || ""))
  if (!command) return json({ ok: true, skipped: true }, 200)
  const groupId = Number(message.group_id)
  const userId = String(message.user_id || "")
  const storeKey = String(body.store_key || "").trim()
  const roomId = `mtalk-dm-${groupId}`

  const [{ data: botRow }, { data: settings }, { data: personalSettings }] = await Promise.all([
    supabase.from("chat_users").select("id, username").eq("is_bot", true).eq("store_key", storeKey).is("bot_deleted_at", null).maybeSingle(),
    supabase.from("room_summary_settings").select("calendar_ai_auto_create_enabled, calendar_silent_auto_register_enabled, media_file_access_enabled, receipt_midreport_enabled, receipt_monthend_report_enabled"),
    supabase.from("room_summary_settings").select("bot_reply_hard_mute_enabled").eq("room_id", roomId).maybeSingle(),
  ])
  if (personalSettings?.bot_reply_hard_mute_enabled === true) return json({ ok: true, skipped: true, reason: "hard mute" }, 200)
  const bot = botRow?.id ? { id: String(botRow.id), username: `${String(botRow.username || "店舗").replace(/[\s\u3000]*bot$/i, "").trim()} bot` } : null
  const rows = Array.isArray(settings) ? settings : []
  const enabled: Record<SearchKind, boolean> = {
    calendar: rows.some((row: any) => row.calendar_ai_auto_create_enabled === true || row.calendar_silent_auto_register_enabled === true),
    media: rows.some((row: any) => row.media_file_access_enabled === true),
    sales: rows.length === 0 || rows.some((row: any) => row.receipt_midreport_enabled !== false || row.receipt_monthend_report_enabled !== false),
  }

  if (command === "menu") await postReply(supabase, groupId, bot, menuCard(enabled))
  else if (command === "message") await postReply(supabase, groupId, bot, { text: "M-talkの会話検索は、トーク一覧上部の「トークルームとメッセージ検索」を使ってください。" })
  else if (command === "cancel") {
    await supabase.from("line_room_search_pending").delete().eq("room_id", roomId).eq("user_id", userId)
    await postReply(supabase, groupId, bot, { text: "検索をキャンセルしました。" })
  } else if (command === "help") {
    await postReply(supabase, groupId, bot, helpCard())
  } else if (!enabled[command]) {
    await postReply(supabase, groupId, bot, { text: `${command === "calendar" ? "予定" : command === "media" ? "メディア" : "売上"}検索は現在この店舗で利用できません。` })
  } else {
    await supabase.from("line_room_search_pending").upsert({ room_id: roomId, user_id: userId, search_kind: command, updated_at: new Date().toISOString() })
    await postReply(supabase, groupId, bot, promptCard(command))
  }
  return json({ ok: true, processed: true, kind: command }, 200)
})
