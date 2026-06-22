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
const MAX_TEXT_CHARS = 40000
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

  const debug = ["1", "true", "yes", "on"].includes((url.searchParams.get("debug") ?? "").toLowerCase())
  const text = htmlToText(html).slice(0, MAX_TEXT_CHARS)
  if (text.length < 40) {
    return json({ ok: false, error: "schedule text too short after strip", text_len: text.length }, 502)
  }

  // 2) Groq でイベント抽出
  const ex = await extractEvents(text, groqApiKey)
  const events = ex.events
  if (!events || events.length === 0) {
    return json({
      ok: false,
      error: "no events extracted",
      text_len: text.length,
      ...(debug || dryRun ? { groq_raw: (ex.raw ?? "").slice(0, 1500), text_sample: text.slice(1900, 3400) } : {}),
    }, 200)
  }

  if (dryRun || debug) {
    return json({ ok: true, dry_run: true, extracted: events.length, events, ...(debug ? { groq_raw: (ex.raw ?? "").slice(0, 1000) } : {}) }, 200)
  }

  // 3) upsert（冪等。主キー event_date+title）
  const supabase = createClient(supabaseUrl, serviceRoleKey) as unknown as DbClient
  // LLMフォールバックを使った場合のみ、実測トークンをAI使用料に記録（確定パース時は usage=null）。
  if (ex.usage) {
    try {
      await supabase.from("ai_usage_events").insert({
        store_partition_key: "marugoS",
        provider: "groq",
        model: ex.usage.model,
        input_tokens: ex.usage.inputTokens,
        output_tokens: ex.usage.outputTokens,
        thinking_tokens: null,
        total_tokens: ex.usage.totalTokens,
        line_message_id: null,
        surface: "foodcourt", // 用途タグ: フードコート分析(東京ドームイベント抽出)
      })
    } catch (e) {
      console.error("tokyo-dome ai_usage_events insert threw:", e instanceof Error ? e.message : String(e))
    }
  }
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
  // スマートクォート等（タイトルに含まれる）。シードと表記を揃えるため直線引用符へ寄せる。
  t = t.replace(/&lsquo;|&rsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&hellip;/g, "…").replace(/&middot;/g, "・").replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
  t = t.replace(/[ \t　]+/g, " ")
  t = t.replace(/\n{2,}/g, "\n").replace(/[ ]*\n[ ]*/g, "\n")
  return t.trim()
}

// 公式カレンダーを「日付ごと」に確定パースする（LLMの日付ズレを避ける主経路）。
// 構造: 「YYYY年MM月」見出し → 「DD」+「(曜)」のセル → セル内に「野球/コンサート等」の直後行がイベント名。
function parseScheduleDeterministic(text: string): ExtractedEvent[] {
  const lines = String(text ?? "").split("\n").map((s) => s.trim())
  const MONTH = /^(\d{4})年(\d{1,2})月$/
  const WD = /^[（(][日月火水木金土][）)]$/
  const isDay = (s: string) => /^\d{1,2}$/.test(s)
  const out: ExtractedEvent[] = []
  const seen = new Set<string>()
  let curY = 0, curM = 0
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    const mm = ln.match(MONTH)
    if (mm) { curY = Number(mm[1]); curM = Number(mm[2]); continue }
    if (curY && curM && isDay(ln) && i + 1 < lines.length && WD.test(lines[i + 1])) {
      const day = Number(ln)
      if (day < 1 || day > 31) continue
      // この日のセル内容を、次の日セル/月見出しまで収集
      const content: string[] = []
      let j = i + 2
      for (; j < lines.length; j++) {
        const c = lines[j]
        if (MONTH.test(c)) break
        if (isDay(c) && j + 1 < lines.length && WD.test(lines[j + 1])) break
        if (c) content.push(c)
      }
      const date = `${curY}-${String(curM).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      for (let k = 0; k < content.length; k++) {
        const cat = markerCategory(content[k])
        if (!cat) continue
        // マーカー直後で、時刻/連絡先/別マーカーでない最初の行をタイトルとみなす
        let title = ""
        for (let t = k + 1; t < content.length; t++) {
          const cc = content[t]
          if (markerCategory(cc)) break
          if (/^(開場|開始|開演|開門|終演|開催)/.test(cc)) continue
          if (cc.startsWith("【") || /TEL|電話|お?問い合わせ|チケット|発売/.test(cc)) continue
          title = cc; break
        }
        if (!title) continue
        if (/TOKYO\s*DOME\s*TOUR/i.test(title)) continue   // 毎日の館内ツアー（イベントではない）
        const category = cat === "野球"
          ? (/(大学|高校|社会人|選手権|リトル|シニア|ボーイズ|女子|クラブ選手権|アマチュア)/.test(title) ? "アマ野球" : "プロ野球")
          : cat === "コンサート" ? "ライブ" : "その他"
        const cleanTitle = title.replace(/\s+/g, " ").slice(0, 200)
        const key = `${date}__${cleanTitle}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ event_date: date, title: cleanTitle, category })
      }
      i = j - 1
    }
  }
  out.sort((a, b) => a.event_date.localeCompare(b.event_date) || a.title.localeCompare(b.title))
  return out
}

// セル内の「カテゴリ見出し」行を判定（タイトル行と区別）。該当しなければ null。
function markerCategory(s: string): "野球" | "コンサート" | "その他" | null {
  const t = String(s ?? "").trim()
  if (t === "野球") return "野球"
  if (t === "コンサート") return "コンサート"
  if (t === "イベント" || t === "その他" || t === "展示会" || t === "展示" || t === "格闘技" || t === "プロレス" || t === "式典") return "その他"
  return null
}

async function extractEvents(scheduleText: string, apiKey: string): Promise<{ events: ExtractedEvent[] | null; raw: string | null; usage: DomeAiUsage | null }> {
  // 主経路: コードで日付ごとに確定パース（LLMの日付ズレを排除）。十分な件数が取れたらこれを採用（＝AIトークン消費なし）。
  const deterministic = parseScheduleDeterministic(scheduleText)
  if (deterministic.length >= 3) {
    return { events: deterministic, raw: `deterministic:${deterministic.length}`, usage: null }
  }
  // フォールバック: レイアウト変更等で確定パースが取れない場合のみ LLM 抽出。
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
  const r1 = await groqChat([{ role: "system", content: system }, { role: "user", content: user }], apiKey, primary, 4000)
  let raw = r1.content
  let usage = r1.usage
  if (!raw) {
    const r2 = await groqChat([{ role: "system", content: system }, { role: "user", content: user }], apiKey, "meta-llama/llama-4-scout-17b-16e-instruct", 4000)
    raw = r2.content
    if (r2.usage) usage = r2.usage
  }
  if (!raw) return { events: null, raw: null, usage }

  const parsed = parseJsonArray(raw)
  if (!parsed) return { events: null, raw, usage }

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
  return { events: out, raw, usage }
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

interface DomeAiUsage { model: string; inputTokens: number; outputTokens: number; totalTokens: number }
function domeUsageFrom(json: unknown, model: string): DomeAiUsage | null {
  const u = (json && typeof json === "object") ? (json as { usage?: unknown }).usage : null
  if (!u || typeof u !== "object") return null
  const m = u as Record<string, unknown>
  const inp = Number(m.prompt_tokens ?? 0) || 0
  const out = Number(m.completion_tokens ?? 0) || 0
  const tot = Number(m.total_tokens ?? 0) || (inp + out)
  if (!inp && !out && !tot) return null
  return { model, inputTokens: inp, outputTokens: out, totalTokens: tot }
}

async function groqChat(
  messages: Array<{ role: string; content: string }>,
  apiKey: string,
  model: string,
  maxTokens = 800,
): Promise<{ content: string | null; usage: DomeAiUsage | null }> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages }),
    })
    if (!res.ok) { console.error("groqChat http error:", model, res.status); return { content: null, usage: null } }
    const data = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown } | null
    const c = String(data?.choices?.[0]?.message?.content ?? "").trim()
    return { content: c || null, usage: domeUsageFrom(data, model) }
  } catch (e) { console.error("groqChat failed:", e instanceof Error ? e.message : String(e)); return { content: null, usage: null } }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}
