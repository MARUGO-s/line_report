import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"

// フードコート（MARUGO S）来客予測の「自己再学習型」モデル cron。
// 毎日、蓄積された全実績から係数を学習し直し（＝貯まるほど精度が上がる）、客数・売上を予測する。
//  - 学習: 売上=客数×客単価 を土台に、客数を「ベース × 曜日係数 × イベント係数(種別) × 天気係数」で表す乗算モデル。
//          各係数は実績の平均比から推定し、サンプルが少ない係数は1へ収縮(shrink)して過学習を防ぐ。
//  - 予測: 直近の特徴量(foodcourt_daily_features＝イベント＋天気＋曜日)から、当日〜+14日を予測。売上=予測客数×中央客単価。
//  - 自己採点: 拡張窓バックテスト（その日より前のデータだけで学習→当日を予測）で out-of-sample の MAPE(平均絶対誤差率) を算出。
//              過去日は out-of-sample 予測＋実績を forecast_predictions に保存し、画面/AIが「予測 vs 実績」で精度を確認できる。
// 冪等: forecast_predictions の (target_date, tenant_name, metric) 一意で upsert。verify_jwt=false で pg_cron から起動。

type DbClient = ReturnType<typeof createClient>
const BASE_TENANT = "MARUGO S"
const MODEL_VERSION = "mult-factor-v1"
const SHRINK_K = 4        // 係数のサンプルが少ないとき 1（影響なし）へ収縮する強さ
const MIN_TRAIN = 4       // バックテストで予測を始める最小学習日数
const HORIZON_DAYS = 14   // 何日先まで予測するか
const PAST_WINDOW = 28    // 何日前までの「予測 vs 実績」を保存するか

type EvType = "soccer_pv" | "japan" | "pro" | "live" | "sports" | "other" | "none"
type Feat = { date: string; dow: number; evType: EvType; rainy: boolean }
type Hist = Feat & { guests: number; sales: number; spend: number }
type Factors = {
  meanG: number
  wday: Record<number, number>
  evt: Record<string, number>
  weather: Record<string, number>
  spend: number
}

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing." }, 500)
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey) as unknown as DbClient
  const url = new URL(req.url)
  const dryRun = ["1", "true", "yes", "on"].includes((url.searchParams.get("dry_run") ?? "").toLowerCase())

  const todayJst = jstDate(new Date())
  const loDate = addDays(todayJst, -(PAST_WINDOW + 60))
  const hiDate = addDays(todayJst, HORIZON_DAYS)

  // 1) 特徴量（イベント＋天気＋曜日）を取得（過去〜未来）
  const { data: featRows, error: featErr } = await supabase
    .from("foodcourt_daily_features")
    .select("business_date, iso_dow, has_event, has_pro_baseball, has_live, has_sports_broadcast, has_japan_match, has_soccer_pv, is_rainy")
    .gte("business_date", loDate)
    .lte("business_date", hiDate)
    .order("business_date", { ascending: true })
  if (featErr) return json({ ok: false, error: `features load failed: ${featErr.message}` }, 500)
  const featByDate = new Map<string, Feat>()
  for (const r of (Array.isArray(featRows) ? featRows : [])) {
    const d = String((r as { business_date?: unknown }).business_date ?? "").slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
    featByDate.set(d, {
      date: d,
      dow: Number((r as { iso_dow?: unknown }).iso_dow ?? 0) || isoDow(d),
      evType: pickEvType(r as Record<string, unknown>),
      rainy: (r as { is_rainy?: unknown }).is_rainy === true,
    })
  }

  // 2) 実績（基準店 marugoS の日次 客数・売上）を「正本」ビューから取得。
  //    foodcourt_base_daily＝レシート集計(売上は税抜net・日報と一致)＋手入力客数。日報が無い日も含むため、
  //    日報未投稿で欠落していた日（例 6/14 等）も学習に入る。客単価は sales/guests で算出。
  const { data: factRows, error: factErr } = await supabase
    .from("foodcourt_base_daily")
    .select("business_date, guests, sales")
    .order("business_date", { ascending: true })
  if (factErr) return json({ ok: false, error: `facts load failed: ${factErr.message}` }, 500)

  const hist: Hist[] = []
  for (const r of (Array.isArray(factRows) ? factRows : [])) {
    const d = String((r as { business_date?: unknown }).business_date ?? "").slice(0, 10)
    const guests = num((r as { guests?: unknown }).guests)
    const sales = num((r as { sales?: unknown }).sales)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || guests == null || guests <= 0 || sales == null) continue
    const f = featByDate.get(d) ?? { date: d, dow: isoDow(d), evType: "none" as const, rainy: false }
    const spend = num((r as { avg_spend?: unknown }).avg_spend) ?? Math.round(sales / guests)
    hist.push({ ...f, guests, sales, spend })
  }
  hist.sort((a, b) => a.date.localeCompare(b.date))

  if (hist.length < 2) {
    return json({ ok: true, skipped: true, reason: "not_enough_history", history_days: hist.length }, 200)
  }

  // 3) 拡張窓バックテスト（out-of-sample）で自己採点
  const back: Array<{ date: string; gPred: number; gAct: number; sPred: number; sAct: number }> = []
  for (let i = MIN_TRAIN; i < hist.length; i++) {
    const train = hist.slice(0, i)
    const fac = fit(train)
    const p = predict(fac, hist[i])
    back.push({ date: hist[i].date, gPred: p.guests, gAct: hist[i].guests, sPred: p.sales, sAct: hist[i].sales })
  }
  const mapeG = mape(back.map((b) => [b.gPred, b.gAct]))
  const mapeS = mape(back.map((b) => [b.sPred, b.sAct]))
  const bandG = mapeG ?? 0.25 // 予測区間の幅（バックテスト誤差率。無ければ暫定±25%）
  const bandS = mapeS ?? 0.25

  // 4) 本予測: 全データで学習し、当日〜+14日を予測。過去日は out-of-sample 予測＋実績を保存。
  const facFull = fit(hist)
  const lastActual = hist[hist.length - 1].date
  const rows: Array<Record<string, unknown>> = []
  const backByDate = new Map(back.map((b) => [b.date, b]))
  const upcoming: Array<{ date: string; guests: number; sales: number; evType: string; rainy: boolean }> = []

  for (const [d, f] of Array.from(featByDate.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (d < addDays(todayJst, -PAST_WINDOW)) continue
    if (d > hiDate) continue
    const isPast = d <= lastActual
    let gPred: number, sPred: number, gAct: number | null = null, sAct: number | null = null
    if (isPast) {
      const b = backByDate.get(d)
      const h = hist.find((x) => x.date === d)
      if (!b || !h) continue // 学習初期(MIN_TRAIN未満)で out-of-sample 予測が無い日はスキップ
      gPred = b.gPred; sPred = b.sPred; gAct = h.guests; sAct = h.sales
    } else {
      const p = predict(facFull, f)
      gPred = p.guests; sPred = p.sales
      upcoming.push({ date: d, guests: gPred, sales: sPred, evType: f.evType, rainy: f.rainy })
    }
    const featJson = { dow: f.dow, evType: f.evType, rainy: f.rainy }
    rows.push({ target_date: d, tenant_name: BASE_TENANT, tenant_code: null, metric: "guests", predicted: gPred, predicted_low: Math.max(0, Math.round(gPred * (1 - bandG))), predicted_high: Math.round(gPred * (1 + bandG)), model_version: MODEL_VERSION, features: featJson, actual: gAct })
    rows.push({ target_date: d, tenant_name: BASE_TENANT, tenant_code: null, metric: "sales", predicted: sPred, predicted_low: Math.max(0, Math.round(sPred * (1 - bandS))), predicted_high: Math.round(sPred * (1 + bandS)), model_version: MODEL_VERSION, features: featJson, actual: sAct })
  }

  const summary = {
    history_days: hist.length,
    backtest_days: back.length,
    mape_guests: mapeG != null ? Math.round(mapeG * 1000) / 10 : null, // %
    mape_sales: mapeS != null ? Math.round(mapeS * 1000) / 10 : null,
    upcoming: upcoming.slice(0, HORIZON_DAYS),
    rows_to_upsert: rows.length,
  }

  if (dryRun) return json({ ok: true, dry_run: true, model_version: MODEL_VERSION, ...summary, factors: facFull }, 200)

  if (rows.length) {
    const { error: upErr } = await supabase
      .from("forecast_predictions")
      .upsert(rows, { onConflict: "target_date,tenant_name,metric" })
    if (upErr) return json({ ok: false, error: `forecast upsert failed: ${upErr.message}`, rows: rows.length }, 500)
  }
  return json({ ok: true, model_version: MODEL_VERSION, ...summary }, 200)
})

// --- model ---
function fit(h: Hist[]): Factors {
  const meanG = avg(h.map((x) => x.guests)) ?? 0
  const wday: Record<number, number> = {}
  for (let d = 1; d <= 7; d++) {
    const xs = h.filter((x) => x.dow === d).map((x) => x.guests)
    wday[d] = shrink(meanG > 0 && xs.length ? (avg(xs)! / meanG) : 1, xs.length)
  }
  const evt: Record<string, number> = {}
  for (const t of ["soccer_pv", "japan", "pro", "live", "sports", "other", "none"]) {
    const xs = h.filter((x) => x.evType === t).map((x) => x.guests)
    evt[t] = shrink(meanG > 0 && xs.length ? (avg(xs)! / meanG) : 1, xs.length)
  }
  const weather: Record<string, number> = {}
  for (const w of ["rainy", "dry"]) {
    const xs = h.filter((x) => (w === "rainy" ? x.rainy : !x.rainy)).map((x) => x.guests)
    weather[w] = shrink(meanG > 0 && xs.length ? (avg(xs)! / meanG) : 1, xs.length)
  }
  const spend = median(h.map((x) => x.spend)) ?? 0
  return { meanG, wday, evt, weather, spend }
}
function predict(f: Factors, feat: Feat): { guests: number; sales: number } {
  const g = f.meanG * (f.wday[feat.dow] ?? 1) * (f.evt[feat.evType] ?? 1) * (f.weather[feat.rainy ? "rainy" : "dry"] ?? 1)
  const guests = Math.max(0, Math.round(g))
  const sales = Math.max(0, Math.round(guests * (f.spend || 0)))
  return { guests, sales }
}
function shrink(rawFactor: number, n: number, k = SHRINK_K): number {
  if (!isFinite(rawFactor) || rawFactor <= 0) return 1
  return (n * rawFactor + k * 1) / (n + k)
}
function pickEvType(r: Record<string, unknown>): EvType {
  // 当店(marugoS)の売上ドライバー順で種別を決める。ドーム野球は当店の最強ドライバー＝PVより優先。
  // サッカーPVは「全体は大集客だが客はバーガー/ビールへ→当店への売上寄与は間接的・波及的」なので独立の控えめ係数として学習させる。
  if (r.has_pro_baseball === true) return "pro"            // ドーム野球＝当店の最強ドライバー（同日にPVが重なってもこちらを優先）
  if (r.has_soccer_pv === true) return "soccer_pv"          // サッカーPV＝高集客でも当店売上は間接的・波及的（過大評価を避け別係数で学習）
  if (r.has_japan_match === true) return "japan"            // サッカー以外の日本戦PV（WBC/世界ボクシング/五輪 等）
  if (r.has_live === true) return "live"
  if (r.has_sports_broadcast === true) return "sports"     // 日本以外の世界スポーツ放映
  if (r.has_event === true) return "other"
  return "none"
}

// --- helpers ---
function mape(pairs: Array<[number, number]>): number | null {
  const xs = pairs.filter(([, a]) => a > 0).map(([p, a]) => Math.abs(p - a) / a)
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null
}
function avg(a: number[]): number | null { const x = a.filter((v) => v != null && isFinite(v)); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null }
function median(a: number[]): number | null { const x = a.filter((v) => v != null && isFinite(v)).slice().sort((p, q) => p - q); if (!x.length) return null; const m = Math.floor(x.length / 2); return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2 }
function num(v: unknown): number | null { if (v == null) return null; const n = Number(v); return isFinite(n) ? n : null }
function jstDate(base: Date): string { const j = new Date(base.getTime() + 9 * 3600 * 1000); return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, "0")}-${String(j.getUTCDate()).padStart(2, "0")}` }
function addDays(ymd: string, n: number): string { const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return ymd; const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}` }
function isoDow(ymd: string): number { const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return 0; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(); return d === 0 ? 7 : d }
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
}
