import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"

// 東京ドームの公式イベント予定を取得し、tokyo_dome_events へ upsert する cron。
// マルゴS（東京ドーム内フードコート）の客数・売上との相関分析に使う。分析専用・送信なし。
//
// 仕組み: 公式スケジュールHTMLを取得 → タグ除去でテキスト化 → Groq でイベント抽出(JSON) → upsert。
// HTMLレイアウト変更で壊れにくいよう、構造解析ではなくLLMにテキストから抽出させる。
// 冪等(主キー event_date+title の upsert)。verify_jwt=false で pg_cron から起動。

type DbClient = ReturnType<typeof createClient>

const DEFAULT_SCHEDULE_URL = "https://www.tokyo-dome.co.jp/dome/event/schedule.html"
const MAX_TEXT_CHARS = 14000
const VALID_CATEGORIES = new Set(["プロ野球", "アマ野球", "ライブ", "その他"])

type ExtractedEvent = { event_date: string; title: string; category: string }

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  const groqApiKey = (Deno.env.get("GROQ_API_KEY") ?? "").trim()
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing." }, 500)
  }
  if (!groqApiKey) {
    return json({ ok: false, error: "GROQ_API_KEY is missing." }, 500)
  }

  const url = new URL(req.url)
  const dryRun = ["1", "true", "yes", "on"].includes((url.searchParams.get("dry_run") ?? "").toLowerCase())
  const scheduleUrl = (Deno.env.get("TOKYO_DOME_SCHEDULE_URL") ?? "").trim() || DEFAULT_SCHEDULE_URL

  // 1) 公式スケジュールページを取得
  let html = ""
  try {
    const res = await fetch(scheduleUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; line-report-bot/1.0)" },
    })
    if (!res.ok) {
      return json({ ok: false, error: `fetch schedule failed (${res.status})`, url: scheduleUrl }, 502)
    }
    html = await res.text()
  } catch (e) {
    return json({ ok: false, error: `fetch error: ${e instanceof Error ? e.message : String(e)}`, url: scheduleUrl }, 502)
  }

  const text = htmlToText(html).slice(0, MAX_TEXT_CHARS)
  if (text.length < 40) {
    return json({ ok: false, error: "schedule text too short after strip", text_len: text.length }, 502)
  }

  // 2) Groq でイベント抽出
  const events = await extractEvents(text, groqApiKey)
  if (!events || events.length === 0) {
    return json({ ok: false, error: "no events extracted", text_len: text.length }, 200)
  }

  if (dryRun) {
    return json({ ok: true, dry_run: true, extracted: events.length, events }, 200)
  }

  // 3) upsert（冪等。主キー event_date+title）
  const supabase = createClient(supabaseUrl, serviceRoleKey) as unknown as DbClient
  const rows = events.map((e) => ({
    event_date: e.event_date,
    title: e.title,
    category: e.category,
    source: "tokyo-dome.co.jp",
    updated_at: new Date().toISOString(),
  }))
  const { error } = await supabase
    .from("tokyo_dome_events")
    .upsert(rows, { onConflict: "event_date,title" })
  if (error) {
    return json({ ok: false, error: `upsert failed: ${error.message}`, extracted: events.length }, 500)
  }

  return json({
    ok: true,
    extracted: events.length,
    upserted: rows.length,
    date_range: { min: rows[0]?.event_date ?? null, max: rows[rows.length - 1]?.event_date ?? null },
  }, 200)
})

// HTML→プレーンテキスト。script/style除去・タグをスペース化・主要エンティティ復号・空白圧縮。
function htmlToText(html: string): string {
  let t = String(html ?? "")
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ")
  t = t.replace(/<style[\s\S]*?<\/style>/gi, " ")
  t = t.replace(/<!--[\s\S]*?-->/g, " ")
  // 改行になりやすいブロック境界を改行に
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|section|article|td|th)>/gi, "\n")
  t = t.replace(/<br\s*\/?>(?=)/gi, "\n")
  t = t.replace(/<[^>]+>/g, " ")
  t = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  t = t.replace(/[ \t　]+/g, " ")
  t = t.replace(/\n{2,}/g, "\n").replace(/[ ]*\n[ ]*/g, "\n")
  return t.trim()
}

async function extractEvents(scheduleText: string, apiKey: string): Promise<ExtractedEvent[] | null> {
  const system = [
    "あなたは東京ドームのイベント日程表から、日付ごとのイベントを構造化抽出するアシスタントです。",
    "出力は JSON 配列のみ。前後に説明文やコードフェンスを付けないこと。",
    "各要素は { \"event_date\": \"YYYY-MM-DD\", \"title\": \"...\", \"category\": \"...\" }。",
    "ルール:",
    "- 日付範囲（例: 6/2〜6/4、6月13・14日）は、必ず1日ごとの個別要素に展開する。",
    "- title はイベント名（野球は『巨人ー中日』のようなカード名、ライブは公演名）。",
    "- category は次のいずれか1つ: プロ野球 / アマ野球 / ライブ / その他。",
    "  プロ野球=NPB(巨人・楽天・西武・ソフトバンク・中日・ロッテ・オリックス等の対戦), アマ野球=大学/高校/社会人野球, ライブ=コンサート/音楽公演, その他=それ以外。",
    "- 年が本文に無い日付は、最も近い文脈の年（基本は2026年、12→翌1月など年跨ぎは適切に）を補う。",
    "- 開催が確定していない/プレースホルダー/空き日は出力しない。",
  ].join("\n")
  const user = `次のテキストは東京ドーム公式のイベント日程表です。イベントを抽出してください。\n\n----\n${scheduleText}\n----`

  const primary = (Deno.env.get("GROQ_CHAT_MODEL") || "").trim() || "llama-3.3-70b-versatile"
  let raw = await groqChat([{ role: "system", content: system }, { role: "user", content: user }], apiKey, primary, 4000)
  if (!raw) raw = await groqChat([{ role: "system", content: system }, { role: "user", content: user }], apiKey, "meta-llama/llama-4-scout-17b-16e-instruct", 4000)
  if (!raw) return null

  const parsed = parseJsonArray(raw)
  if (!parsed) return null

  const seen = new Set<string>()
  const out: ExtractedEvent[] = []
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const date = normalizeIsoDate(rec.event_date ?? rec.date)
    const title = String(rec.title ?? rec.name ?? "").trim().replace(/\s+/g, " ").slice(0, 200)
    let category = String(rec.category ?? "").trim()
    if (!VALID_CATEGORIES.has(category)) category = "その他"
    if (!date || !title) continue
    const key = `${date}__${title}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ event_date: date, title, category })
  }
  out.sort((a, b) => a.event_date.localeCompare(b.event_date) || a.title.localeCompare(b.title))
  return out
}

function normalizeIsoDate(value: unknown): string | null {
  const s = String(value ?? "").trim()
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (y < 2024 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

function parseJsonArray(raw: string): unknown[] | null {
  let t = String(raw ?? "").trim()
  // コードフェンス除去
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
  // 配列部分を抽出
  const start = t.indexOf("[")
  const end = t.lastIndexOf("]")
  if (start >= 0 && end > start) t = t.slice(start, end + 1)
  try {
    const parsed = JSON.parse(t)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function groqChat(
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
  model: string,
  maxTokens = 800,
): Promise<string | null> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages }),
    })
    if (!res.ok) { console.error("groqChat http error:", model, res.status); return null }
    const data = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null
    const c = String(data?.choices?.[0]?.message?.content ?? "").trim()
    return c || null
  } catch (e) { console.error("groqChat failed:", e instanceof Error ? e.message : String(e)); return null }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}
