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

// 会場規模を区別する: "live"=東京ドーム本体コンサート(大)、"dome"=ドーム本体のアマ野球/その他(大)、
// "hall"=小ホール(カナデビア/後楽園 等)のみの日(小)。pro=ドーム野球。
type EvType = "soccer_pv" | "japan" | "pro" | "live" | "dome" | "sports" | "hall" | "none"
type Feat = { date: string; dow: number; evType: EvType; rainy: boolean }
type Hist = Feat & { guests: number; sales: number; spend: number }
type Factors = {
  meanG: number
  wday: Record<number, number>
  evt: Record<string, number>
  weather: Record<string, number>
  spend: number
  wdayN: Record<number, number>
  evtN: Record<string, number>
  weatherN: Record<string, number>
}

// --- 統計拡張(stats-ext-v1)の型 ---
// 予測には使わない。AI解説が係数をどこまで信じてよいかを判断するための解釈コンテキスト。
type CiEntry = { factor: number; lo: number; hi: number; n: number }          // 収縮前の生係数と95%CI
type QuantEntry = { n: number; min: number; q25: number; med: number; q75: number; max: number }
type InteractionEntry = { label: string; n: number; actual: number; expected: number; ratio: number } // 実測倍率 vs 独立仮定倍率
type ResidualBiasEntry = { label: string; n: number; bias: number }           // 符号付き平均誤差率(+=過大予測)
type EffectSizeEntry = { label: string; d: number; n1: number; n2: number; magnitude: string }
type AdvancedStats = {
  version: string
  factor_ci: { wday: Record<string, CiEntry>; evt: Record<string, CiEntry>; weather: Record<string, CiEntry> }
  quantiles: Record<string, QuantEntry>
  interactions: InteractionEntry[]
  residual_bias: ResidualBiasEntry[]
  effect_sizes: EffectSizeEntry[]
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
    .select("business_date, iso_dow, has_event, has_pro_baseball, has_live, has_sports_broadcast, has_japan_match, has_soccer_pv, has_dome_main, is_rainy")
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

  // 統計拡張(stats-ext-v1): 予測には使わない。AI解説の解釈精度を上げる材料を毎晩まとめて再計算。
  const advStats = computeAdvancedStats(hist, back)

  const summary = {
    history_days: hist.length,
    backtest_days: back.length,
    mape_guests: mapeG != null ? Math.round(mapeG * 1000) / 10 : null, // %
    mape_sales: mapeS != null ? Math.round(mapeS * 1000) / 10 : null,
    upcoming: upcoming.slice(0, HORIZON_DAYS),
    rows_to_upsert: rows.length,
  }

  if (dryRun) return json({ ok: true, dry_run: true, model_version: MODEL_VERSION, ...summary, factors: facFull, advanced_stats: advStats }, 200)

  if (rows.length) {
    const { error: upErr } = await supabase
      .from("forecast_predictions")
      .upsert(rows, { onConflict: "target_date,tenant_name,metric" })
    if (upErr) return json({ ok: false, error: `forecast upsert failed: ${upErr.message}`, rows: rows.length }, 500)
  }

  // フィット済み係数(バックテスト自己採点つき)をAI解説側からも参照できるよう保存する。
  // AI解説(foodcourt_compare.ts)の「統計的パターン」は、この唯一のモデル結果を使う（単変量の別集計と二重化しない）。
  const { error: factorsErr } = await supabase
    .from("foodcourt_forecast_factors")
    .upsert({
      tenant_name: BASE_TENANT,
      model_version: MODEL_VERSION,
      mean_guests: facFull.meanG,
      wday_factors: facFull.wday,
      wday_counts: facFull.wdayN,
      event_factors: facFull.evt,
      event_counts: facFull.evtN,
      weather_factors: facFull.weather,
      weather_counts: facFull.weatherN,
      median_spend: facFull.spend,
      history_days: hist.length,
      backtest_days: back.length,
      mape_guests: mapeG,
      mape_sales: mapeS,
      advanced_stats: advStats,
      updated_at: new Date().toISOString(),
    }, { onConflict: "tenant_name" })
  if (factorsErr) console.error("foodcourt_forecast_factors upsert failed:", factorsErr.message)

  // 学習の進化トラッキング: 今日の学習結果を1行追記（同日再実行は上書き＝冪等）。
  // factors は最新1行を上書きするため、「賢くなっているか」の時系列証拠はこちらが正本。
  const { error: histErr } = await supabase
    .from("foodcourt_forecast_history")
    .upsert({
      tenant_name: BASE_TENANT,
      log_date: todayJst,
      model_version: MODEL_VERSION,
      history_days: hist.length,
      backtest_days: back.length,
      mape_guests: mapeG,
      mape_sales: mapeS,
      mean_guests: facFull.meanG,
    }, { onConflict: "tenant_name,log_date" })
  if (histErr) console.error("foodcourt_forecast_history upsert failed:", histErr.message)
  return json({ ok: true, model_version: MODEL_VERSION, ...summary }, 200)
})

// --- model ---
function fit(h: Hist[]): Factors {
  const meanG = avg(h.map((x) => x.guests)) ?? 0
  const wday: Record<number, number> = {}
  const wdayN: Record<number, number> = {}
  for (let d = 1; d <= 7; d++) {
    const xs = h.filter((x) => x.dow === d).map((x) => x.guests)
    wday[d] = shrink(meanG > 0 && xs.length ? (avg(xs)! / meanG) : 1, xs.length)
    wdayN[d] = xs.length
  }
  const evt: Record<string, number> = {}
  const evtN: Record<string, number> = {}
  for (const t of ["soccer_pv", "japan", "pro", "live", "dome", "sports", "hall", "none"]) {
    const xs = h.filter((x) => x.evType === t).map((x) => x.guests)
    evt[t] = shrink(meanG > 0 && xs.length ? (avg(xs)! / meanG) : 1, xs.length)
    evtN[t] = xs.length
  }
  const weather: Record<string, number> = {}
  const weatherN: Record<string, number> = {}
  for (const w of ["rainy", "dry"]) {
    const xs = h.filter((x) => (w === "rainy" ? x.rainy : !x.rainy)).map((x) => x.guests)
    weather[w] = shrink(meanG > 0 && xs.length ? (avg(xs)! / meanG) : 1, xs.length)
    weatherN[w] = xs.length
  }
  const spend = median(h.map((x) => x.spend)) ?? 0
  return { meanG, wday, evt, weather, spend, wdayN, evtN, weatherN }
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

// --- 統計拡張(stats-ext-v1) ---
// fit()/predict()には一切影響しない純粋な追加計算。AI解説が「係数をどこまで信じてよいか」を
// 判断するための材料（信頼区間・分布・交互作用・モデルの弱点・効果量）をまとめて算出する。
function computeAdvancedStats(
  h: Hist[],
  back: Array<{ date: string; gPred: number; gAct: number }>,
): AdvancedStats {
  const meanG = avg(h.map((x) => x.guests)) ?? 0
  const histByDate = new Map(h.map((x) => [x.date, x]))
  const isWeekend = (x: Hist) => x.dow === 6 || x.dow === 7
  const isBigEvent = (x: Hist) => x.evType === "pro" || x.evType === "live" || x.evType === "dome"

  // ① 係数の95%信頼区間（収縮前の生の比率に対して）。
  //    CIが1をまたぐ＝「効果が偶然でない」とは言い切れない、をAIが判定できるようにする。
  const ciOf = (xs: number[]): CiEntry | null => {
    if (meanG <= 0 || xs.length < 3) return null
    const m = avg(xs)!
    const s = sampleSd(xs)
    if (s == null) return null
    const se = s / Math.sqrt(xs.length)
    const t = tCrit(xs.length - 1)
    return {
      factor: round2(m / meanG),
      lo: round2(Math.max(0, (m - t * se) / meanG)),
      hi: round2((m + t * se) / meanG),
      n: xs.length,
    }
  }
  const factorCi: AdvancedStats["factor_ci"] = { wday: {}, evt: {}, weather: {} }
  for (let d = 1; d <= 7; d++) {
    const ci = ciOf(h.filter((x) => x.dow === d).map((x) => x.guests))
    if (ci) factorCi.wday[String(d)] = ci
  }
  for (const t of ["soccer_pv", "japan", "pro", "live", "dome", "sports", "hall", "none"]) {
    const ci = ciOf(h.filter((x) => x.evType === t).map((x) => x.guests))
    if (ci) factorCi.evt[t] = ci
  }
  for (const w of ["rainy", "dry"]) {
    const ci = ciOf(h.filter((x) => (w === "rainy" ? x.rainy : !x.rainy)).map((x) => x.guests))
    if (ci) factorCi.weather[w] = ci
  }

  // ② 条件別の客数分布（四分位数）。平均だけでは見えない「同じ条件でも最悪これだけ低い日がある」を渡す。
  const quantiles: Record<string, QuantEntry> = {}
  const quantOf = (key: string, xs: number[]) => {
    if (xs.length < 3) return
    const sorted = xs.slice().sort((a, b) => a - b)
    quantiles[key] = {
      n: xs.length,
      min: Math.round(sorted[0]),
      q25: Math.round(quantile(sorted, 0.25)),
      med: Math.round(quantile(sorted, 0.5)),
      q75: Math.round(quantile(sorted, 0.75)),
      max: Math.round(sorted[sorted.length - 1]),
    }
  }
  for (const t of ["soccer_pv", "japan", "pro", "live", "dome", "sports", "hall", "none"]) {
    quantOf(`evt:${t}`, h.filter((x) => x.evType === t).map((x) => x.guests))
  }
  quantOf("weekend", h.filter(isWeekend).map((x) => x.guests))
  quantOf("weekday", h.filter((x) => !isWeekend(x)).map((x) => x.guests))
  quantOf("rainy", h.filter((x) => x.rainy).map((x) => x.guests))
  quantOf("dry", h.filter((x) => !x.rainy).map((x) => x.guests))

  // ③ 交互作用: 「条件が重なった日」の実測倍率 vs 独立仮定（生係数の掛け算）の倍率。
  //    乗算モデルは独立を仮定しているため、実測との乖離＝モデルが構造的に外す領域をAIに知らせる。
  const interactions: InteractionEntry[] = []
  const marginalRatio = (xs: number[]): number | null => {
    if (meanG <= 0 || !xs.length) return null
    return avg(xs)! / meanG
  }
  const addInteraction = (label: string, r1: number | null, r2: number | null, combo: Hist[]) => {
    if (r1 == null || r2 == null || combo.length < 3 || meanG <= 0) return
    const actual = avg(combo.map((x) => x.guests))! / meanG
    const expected = r1 * r2
    if (expected <= 0) return
    interactions.push({ label, n: combo.length, actual: round2(actual), expected: round2(expected), ratio: round2(actual / expected) })
  }
  const rWeekend = marginalRatio(h.filter(isWeekend).map((x) => x.guests))
  const rWeekday = marginalRatio(h.filter((x) => !isWeekend(x)).map((x) => x.guests))
  const rBig = marginalRatio(h.filter(isBigEvent).map((x) => x.guests))
  const rNoBig = marginalRatio(h.filter((x) => !isBigEvent(x)).map((x) => x.guests))
  const rRainy = marginalRatio(h.filter((x) => x.rainy).map((x) => x.guests))
  addInteraction("土日×大型イベント(野球/ライブ/ドーム)", rWeekend, rBig, h.filter((x) => isWeekend(x) && isBigEvent(x)))
  addInteraction("平日×大型イベント(野球/ライブ/ドーム)", rWeekday, rBig, h.filter((x) => !isWeekend(x) && isBigEvent(x)))
  addInteraction("土日×イベント無し系", rWeekend, rNoBig, h.filter((x) => isWeekend(x) && !isBigEvent(x)))
  addInteraction("雨×大型イベント(野球/ライブ/ドーム)", rRainy, rBig, h.filter((x) => x.rainy && isBigEvent(x)))

  // ④ 残差バイアス: バックテスト(out-of-sample)の符号付き誤差率を条件別に集計。
  //    「モデルはこの条件で系統的に過大/過小評価する」という自己申告の弱点リスト。
  const residualBias: ResidualBiasEntry[] = []
  const biasGroups: Record<string, number[]> = {}
  for (const b of back) {
    if (b.gAct <= 0) continue
    const f = histByDate.get(b.date)
    if (!f) continue
    const err = (b.gPred - b.gAct) / b.gAct
    const keys = [
      `evt:${f.evType}`,
      isWeekend(f) ? "weekend" : "weekday",
      f.rainy ? "rainy" : "dry",
    ]
    for (const k of keys) (biasGroups[k] ??= []).push(err)
  }
  const BIAS_LABEL: Record<string, string> = {
    "evt:soccer_pv": "サッカーPVの日", "evt:japan": "日本戦PVの日", "evt:pro": "プロ野球の日",
    "evt:live": "ライブの日", "evt:dome": "ドーム本体(その他)の日", "evt:sports": "世界スポーツ放映の日",
    "evt:hall": "小ホールのみの日", "evt:none": "イベント無しの日",
    weekend: "土日", weekday: "平日", rainy: "雨の日", dry: "雨でない日",
  }
  for (const [k, errs] of Object.entries(biasGroups)) {
    if (errs.length < 3) continue
    const bias = avg(errs)!
    if (Math.abs(bias) < 0.10) continue // ±10%未満の偏りはノイズとして報告しない
    residualBias.push({ label: BIAS_LABEL[k] ?? k, n: errs.length, bias: round3(bias) })
  }
  residualBias.sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias))

  // ⑤ 効果量(Cohen's d): 「どの要因が本当に影響力が大きいか」を単位に依存せず比較可能にする。
  const effectSizes: EffectSizeEntry[] = []
  const addEffect = (label: string, g1: number[], g2: number[]) => {
    if (g1.length < 2 || g2.length < 2) return
    const d = cohensD(g1, g2)
    if (d == null) return
    effectSizes.push({ label, d: round2(d), n1: g1.length, n2: g2.length, magnitude: dMagnitude(d) })
  }
  const noneGuests = h.filter((x) => x.evType === "none").map((x) => x.guests)
  const EVT_JP: Record<string, string> = {
    soccer_pv: "サッカーPV", japan: "日本戦PV", pro: "プロ野球", live: "ライブ",
    dome: "ドーム本体(その他)", sports: "世界スポーツ放映", hall: "小ホールのみ",
  }
  for (const t of Object.keys(EVT_JP)) {
    addEffect(`${EVT_JP[t]} vs イベント無し`, h.filter((x) => x.evType === t).map((x) => x.guests), noneGuests)
  }
  addEffect("雨 vs 雨でない", h.filter((x) => x.rainy).map((x) => x.guests), h.filter((x) => !x.rainy).map((x) => x.guests))
  addEffect("土日 vs 平日", h.filter(isWeekend).map((x) => x.guests), h.filter((x) => !isWeekend(x)).map((x) => x.guests))
  effectSizes.sort((a, b) => Math.abs(b.d) - Math.abs(a.d))

  return { version: "stats-ext-v1", factor_ci: factorCi, quantiles, interactions, residual_bias: residualBias, effect_sizes: effectSizes }
}

function sampleSd(xs: number[]): number | null {
  if (xs.length < 2) return null
  const m = avg(xs)!
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1)
  return Math.sqrt(v)
}
function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}
// t分布の97.5%点（95%CI用）。df>30はほぼ正規分布なので1.96へ。
function tCrit(df: number): number {
  const table: Record<number, number> = { 1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23, 12: 2.18, 15: 2.13, 20: 2.09, 25: 2.06, 30: 2.04 }
  if (df <= 0) return 12.71
  if (table[df]) return table[df]
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b)
  for (const k of keys) if (df <= k) return table[k]
  return 1.96
}
function cohensD(g1: number[], g2: number[]): number | null {
  const m1 = avg(g1), m2 = avg(g2)
  const s1 = sampleSd(g1), s2 = sampleSd(g2)
  if (m1 == null || m2 == null || s1 == null || s2 == null) return null
  const pooled = Math.sqrt(((g1.length - 1) * s1 * s1 + (g2.length - 1) * s2 * s2) / (g1.length + g2.length - 2))
  if (!isFinite(pooled) || pooled <= 0) return null
  return (m1 - m2) / pooled
}
function dMagnitude(d: number): string {
  const a = Math.abs(d)
  if (a >= 1.2) return "極めて大"
  if (a >= 0.8) return "大"
  if (a >= 0.5) return "中"
  if (a >= 0.2) return "小"
  return "ごく小"
}
function round2(v: number): number { return Math.round(v * 100) / 100 }
function round3(v: number): number { return Math.round(v * 1000) / 1000 }
function pickEvType(r: Record<string, unknown>): EvType {
  // 当店(marugoS)の売上ドライバー順で種別を決める。ドーム野球は当店の最強ドライバー＝PVより優先。
  // サッカーPVは「全体は大集客だが客はバーガー/ビールへ→当店への売上寄与は間接的・波及的」なので独立の控えめ係数として学習させる。
  // 会場規模を加味（ユーザー指示）: 東京ドーム本体(has_dome_main)は大集客、カナデビア等の小ホールのみの日は小。
  if (r.has_pro_baseball === true) return "pro"            // ドーム野球＝当店の最強ドライバー（同日にPVが重なってもこちらを優先）
  if (r.has_soccer_pv === true) return "soccer_pv"          // サッカーPV＝高集客でも当店売上は間接的・波及的（過大評価を避け別係数で学習）
  if (r.has_japan_match === true) return "japan"            // サッカー以外の日本戦PV（WBC/世界ボクシング/五輪 等）
  if (r.has_live === true && r.has_dome_main === true) return "live"  // 東京ドーム本体コンサート＝大集客（従来のlive係数を維持）
  if (r.has_dome_main === true) return "dome"               // ドーム本体のアマ野球/その他（live以外）＝大集客
  if (r.has_sports_broadcast === true) return "sports"     // 日本以外の世界スポーツ放映
  if (r.has_live === true || r.has_event === true) return "hall"  // 小ホール(カナデビア/後楽園等)のみ＝小集客。ドーム本体無しなのでlive係数を当てない
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
