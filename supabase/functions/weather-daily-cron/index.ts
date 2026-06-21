import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"

// 東京ドーム周辺の日次天気を取得し weather_daily へ upsert する cron。
// マルゴS（東京ドーム内フードコート）の客数・売上との相関分析に使う。分析専用・送信なし。
// データ元: Open-Meteo（APIキー不要）。過去92日＋予報16日を1回で取得し冪等に upsert。

type DbClient = ReturnType<typeof createClient>

// 東京ドーム（文京区）の緯度経度。
const LAT = 35.7056
const LON = 139.7519
const LOCATION = "tokyo_dome"

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing." }, 500)
  }

  const url = new URL(req.url)
  const dryRun = ["1", "true", "yes", "on"].includes((url.searchParams.get("dry_run") ?? "").toLowerCase())
  const pastDays = clampInt(url.searchParams.get("past_days"), 92, 1, 92)
  const forecastDays = clampInt(url.searchParams.get("forecast_days"), 14, 0, 16)

  const api = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max`
    + `&timezone=Asia%2FTokyo&past_days=${pastDays}&forecast_days=${forecastDays}`

  let data: OpenMeteoResp | null = null
  try {
    const res = await fetch(api, { headers: { "User-Agent": "line-report-bot/1.0" } })
    if (!res.ok) return json({ ok: false, error: `open-meteo fetch failed (${res.status})` }, 502)
    data = await res.json() as OpenMeteoResp
  } catch (e) {
    return json({ ok: false, error: `fetch error: ${e instanceof Error ? e.message : String(e)}` }, 502)
  }

  const d = data?.daily
  if (!d || !Array.isArray(d.time) || !d.time.length) {
    return json({ ok: false, error: "no daily weather in response" }, 200)
  }

  const rows = d.time.map((date, i) => ({
    weather_date: String(date).slice(0, 10),
    location: LOCATION,
    weather_code: numOrNull(d.weather_code?.[i]),
    temp_max: numOrNull(d.temperature_2m_max?.[i]),
    temp_min: numOrNull(d.temperature_2m_min?.[i]),
    precipitation_mm: numOrNull(d.precipitation_sum?.[i]),
    precip_prob: numOrNull(d.precipitation_probability_max?.[i]),
    summary: wmoSummary(numOrNull(d.weather_code?.[i])),
    source: "open-meteo",
    updated_at: new Date().toISOString(),
  })).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.weather_date))

  if (dryRun) {
    return json({ ok: true, dry_run: true, count: rows.length, range: { min: rows[0]?.weather_date, max: rows[rows.length - 1]?.weather_date }, sample: rows.slice(0, 5) }, 200)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey) as unknown as DbClient
  const { error } = await supabase.from("weather_daily").upsert(rows, { onConflict: "weather_date,location" })
  if (error) return json({ ok: false, error: `upsert failed: ${error.message}`, count: rows.length }, 500)

  return json({ ok: true, upserted: rows.length, range: { min: rows[0]?.weather_date, max: rows[rows.length - 1]?.weather_date } }, 200)
})

type OpenMeteoResp = {
  daily?: {
    time?: string[]
    weather_code?: number[]
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
    precipitation_sum?: number[]
    precipitation_probability_max?: number[]
  }
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function clampInt(raw: string | null, def: number, lo: number, hi: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

// WMO weather code → 日本語ラベル。
function wmoSummary(code: number | null): string {
  if (code == null) return "—"
  if (code === 0) return "快晴"
  if (code === 1) return "晴れ"
  if (code === 2) return "晴れ時々曇り"
  if (code === 3) return "曇り"
  if (code === 45 || code === 48) return "霧"
  if (code >= 51 && code <= 57) return "霧雨"
  if (code >= 61 && code <= 67) return code === 65 ? "大雨" : "雨"
  if (code >= 71 && code <= 77) return code === 75 ? "大雪" : "雪"
  if (code >= 80 && code <= 82) return code === 82 ? "激しいにわか雨" : "にわか雨"
  if (code === 85 || code === 86) return "にわか雪"
  if (code >= 95) return "雷雨"
  return "—"
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}
