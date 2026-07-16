import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { chooseFoodCourtGlm } from "../_shared/foodcourt_forecast_utils.ts"

// フードコート（MARUGO S）来客予測の「自己再学習型」モデル cron。
// 毎日、蓄積された全実績から係数を学習し直し（＝貯まるほど精度が上がる）、客数・売上を予測する。
//
// 2モデルを毎晩バックテストで比較し、精度の良い方を自動採用する「モデル選択ループ」を実装している:
//  A) 乗算モデル(mult-factor-v3・レガシー): 客数=ベース×曜日係数×イベント/会場係数(客層)×天気係数。
//     各係数は実績の平均比から推定し、サンプルが少ない係数は1へ収縮(shrink)。AI解説(foodcourt_forecast_factors)
//     はこのモデルの係数を常に参照する（解釈しやすい「倍率」の形を保つため、勝敗に関係なく毎晩計算）。
//  B) ポアソン回帰(glm-poisson-v4): 客数(カウントデータ)を log(客数) = 切片+曜日+イベント/会場×客層+雨
//     +log(1+降水量)+猛暑+log(1+予想動員数)+トレンド(時間) の一般化線形モデルで推定(IRLS)。イベント係数は
//     東京ドーム本体/カナデビア/後楽園を分け、会場ごとの客層差（野球/大型ライブ/若年層ライブ/格闘技等）を扱う。
//     v4で交互作用項(土日×大型/雨×大型/猛暑×大型イベント)を追加。係数はリッジ正則化(過学習防止＝旧モデルのshrinkに相当)つきの最尤推定になり、
//     「予想動員数」という連続値の特徴量と「トレンド(開店後の伸び)」を扱える。
//     リッジの強さλも複数候補をバックテストして最も当たる値を自動選択する（固定値に頼らない＝ループを閉じる）。
//  - 予測: 直近の特徴量(foodcourt_daily_features＝イベント＋天気＋曜日＋予想動員数)から、当日〜+14日を予測。
//          売上=予測客数×予測客単価。客単価はイベント種別で調整する動的モデル(spend-model-v1)で推定する
//          （従来の全期間中央値固定を廃止。イベント日はドリンク比率等で単価が変わるため）。
//          天気は「雨フラグ」に加え、降水量(mm・連続値)と猛暑(最高気温≥30℃)フラグも特徴量に使う。
//  - 自己採点: 拡張窓バックテスト（その日より前のデータだけで学習→当日を予測）で out-of-sample の MAPE(平均絶対誤差率) を
//              A/Bそれぞれ算出し、誤差が小さい方を当日の本番予測に採用する。過去日は採用モデルの out-of-sample
//              予測＋実績を forecast_predictions に保存し、画面/AIが「予測 vs 実績」で精度を確認できる。
// 冪等: forecast_predictions の (target_date, tenant_name, metric) 一意で upsert。verify_jwt=false で pg_cron から起動。

type DbClient = ReturnType<typeof createClient>
const BASE_TENANT = "MARUGO S"
const MODEL_VERSION = "mult-factor-v3"  // レガシー乗算モデルの識別子（AI解説用係数は常にこのモデルで算出）
const SHRINK_K = 4        // 乗算モデルの係数のサンプルが少ないとき 1（影響なし）へ収縮する強さ
const MIN_TRAIN = 4       // バックテストで予測を始める最小学習日数
const HORIZON_DAYS = 14   // 何日先まで予測するか
const PAST_WINDOW = 28    // 何日前までの「予測 vs 実績」を保存するか
const MODEL_HOLDOUT_DAYS = 14 // モデル選択は直近期間で比較し、古い誤差に固定されないようにする
const LAMBDA_GRID = [1, 2, 4, 8, 16]  // GLMのリッジ正則化強度の候補（バックテストで自動選択）

// 会場×客層を区別する:
//   "live"=東京ドーム本体コンサート(大), "dome"=ドーム本体のアマ野球/その他(大), pro=ドーム野球。
//   小ホールは venue-segment-v1 として "hall_kanadevia"(ライブ/若年層) /
//   "hall_korakuen"(格闘技/中年男性) / "hall_other"(その他小ホール) に分ける。
const EVENT_MODEL_TYPES = ["soccer_pv", "japan", "pro", "live", "dome", "sports", "hall_kanadevia", "hall_korakuen", "hall_other"] as const
const EVENT_TYPES = [...EVENT_MODEL_TYPES, "none"] as const
type EvType = typeof EVENT_TYPES[number]
type Feat = { date: string; dow: number; evType: EvType; rainy: boolean; precipMm: number; hotDay: boolean; attendance: number }
type Hist = Feat & { guests: number; sales: number; spend: number }
type Factors = {
  meanG: number
  wday: Record<number, number>
  evt: Record<string, number>
  weather: Record<string, number>
  spend: number
  spendEvt: Record<string, number>
  spendEvtN: Record<string, number>
  spendWeather: Record<string, number>
  spendWeatherN: Record<string, number>
  wdayN: Record<number, number>
  evtN: Record<string, number>
  weatherN: Record<string, number>
}
// GLM(ポアソン回帰)のフィット結果。係数と、トレンド項の標準化に使った基準値（予測時に同じ変換を再現するため保持）。
type GlmModel = { beta: number[]; startEpoch: number; meanT: number; sdT: number; spend: SpendModel }
type SpendModel = {
  baseSpend: number
  eventFactors: Record<string, number>
  eventCounts: Record<string, number>
  weatherFactors: Record<string, number>
  weatherCounts: Record<string, number>
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
  const hiDate = addDays(todayJst, HORIZON_DAYS)

  // 1) 特徴量（イベント＋天気＋曜日）を取得（過去〜未来）
  const { data: featRows, error: featErr } = await supabase
    .from("foodcourt_daily_features")
    .select("business_date, iso_dow, has_event, has_pro_baseball, has_live, has_sports_broadcast, has_japan_match, has_soccer_pv, has_dome_main, has_kanadevia, has_korakuen, is_rainy, precipitation_mm, temp_max, max_expected_attendance")
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
      precipMm: Math.max(0, num((r as { precipitation_mm?: unknown }).precipitation_mm) ?? 0),
      hotDay: (num((r as { temp_max?: unknown }).temp_max) ?? 0) >= 30,
      attendance: Math.max(0, num((r as { max_expected_attendance?: unknown }).max_expected_attendance) ?? 0),
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
    const f = featByDate.get(d) ?? { date: d, dow: isoDow(d), evType: "none" as const, rainy: false, precipMm: 0, hotDay: false, attendance: 0 }
    const spend = num((r as { avg_spend?: unknown }).avg_spend) ?? Math.round(sales / guests)
    hist.push({ ...f, guests, sales, spend })
  }
  hist.sort((a, b) => a.date.localeCompare(b.date))

  if (hist.length < 2) {
    return json({ ok: true, skipped: true, reason: "not_enough_history", history_days: hist.length }, 200)
  }

  // 3) 拡張窓バックテスト（out-of-sample）で、乗算モデル(legacy)とポアソン回帰(GLM)を比較する。
  //    a) まずGLMのリッジ強度λ候補を粗いストライドでバックテストし、最も当たるλを選ぶ（データが増えても計算量が
  //       跳ね上がらないよう間引く。数十日規模の現状はストライド1＝全日評価）。
  //    b) 選んだλのGLMと、レガシー乗算モデルを全日程でバックテストし、売上WAPEが小さい方を本番採用する。
  //       MAPEだけだと客数/売上の小さい日が過大に効くため、経営影響に近いWAPEを主指標、MAPE/MAEを補助指標として記録する。
  //    これが「誤差実績を使って次の予測方法そのものを自動選択する」閉じたループ。
  type BackRow = { date: string; gPred: number; gAct: number; sPred: number; sAct: number }
  const selectStride = hist.length > 60 ? 3 : 1
  function runBacktest(predictor: (train: Hist[], target: Hist) => { guests: number; sales: number } | null, stride: number): BackRow[] {
    const out: BackRow[] = []
    for (let i = MIN_TRAIN; i < hist.length; i += stride) {
      const train = hist.slice(0, i)
      const p = predictor(train, hist[i])
      if (!p) continue
      out.push({ date: hist[i].date, gPred: p.guests, gAct: hist[i].guests, sPred: p.sales, sAct: hist[i].sales })
    }
    return out
  }
  const legacyPredictor = (train: Hist[], target: Hist) => predict(fit(train), target)
  const glmPredictor = (lambda: number) => (train: Hist[], target: Hist): { guests: number; sales: number } | null => {
    const m = fitGLM(train, lambda)
    if (!m) return null
    const guests = predictGLMGuests(m, target)
    return { guests, sales: Math.max(0, Math.round(guests * predictSpend(m.spend, target))) }
  }

  let bestLambda = LAMBDA_GRID[0]
  let bestLambdaWape = Infinity
  const holdoutStartIndex = Math.max(MIN_TRAIN + 1, hist.length - MODEL_HOLDOUT_DAYS)
  const holdoutStartDate = hist[Math.min(holdoutStartIndex, hist.length - 1)].date
  for (const lambda of LAMBDA_GRID) {
    const rows0 = runBacktest(glmPredictor(lambda), selectStride)
    const tuningRows = rows0.filter((r) => r.date < holdoutStartDate)
    const scoredRows = tuningRows.length >= 4 ? tuningRows : rows0
    const w = wape(scoredRows.map((r) => [r.sPred, r.sAct]))
    if (w != null && w < bestLambdaWape) { bestLambdaWape = w; bestLambda = lambda }
  }

  const backLegacy = runBacktest(legacyPredictor, 1)
  const backGlm = runBacktest(glmPredictor(bestLambda), 1)
  const mapeLegacyG = mape(backLegacy.map((b) => [b.gPred, b.gAct]))
  const mapeLegacyS = mape(backLegacy.map((b) => [b.sPred, b.sAct]))
  const mapeGlmG = mape(backGlm.map((b) => [b.gPred, b.gAct]))
  const mapeGlmS = mape(backGlm.map((b) => [b.sPred, b.sAct]))
  const wapeLegacyG = wape(backLegacy.map((b) => [b.gPred, b.gAct]))
  const wapeLegacyS = wape(backLegacy.map((b) => [b.sPred, b.sAct]))
  const wapeGlmG = wape(backGlm.map((b) => [b.gPred, b.gAct]))
  const wapeGlmS = wape(backGlm.map((b) => [b.sPred, b.sAct]))
  const maeLegacyG = mae(backLegacy.map((b) => [b.gPred, b.gAct]))
  const maeLegacyS = mae(backLegacy.map((b) => [b.sPred, b.sAct]))
  const maeGlmG = mae(backGlm.map((b) => [b.gPred, b.gAct]))
  const maeGlmS = mae(backGlm.map((b) => [b.sPred, b.sAct]))
  const recentLegacy = backLegacy.filter((b) => b.date >= holdoutStartDate)
  const recentGlm = backGlm.filter((b) => b.date >= holdoutStartDate)
  const rollingLegacyG = mape(recentLegacy.map((b) => [b.gPred, b.gAct]))
  const rollingGlmG = mape(recentGlm.map((b) => [b.gPred, b.gAct]))
  const rollingLegacyS = mape(recentLegacy.map((b) => [b.sPred, b.sAct]))
  const rollingGlmS = mape(recentGlm.map((b) => [b.sPred, b.sAct]))
  const rollingLegacyWapeG = wape(recentLegacy.map((b) => [b.gPred, b.gAct]))
  const rollingGlmWapeG = wape(recentGlm.map((b) => [b.gPred, b.gAct]))
  const rollingLegacyWapeS = wape(recentLegacy.map((b) => [b.sPred, b.sAct]))
  const rollingGlmWapeS = wape(recentGlm.map((b) => [b.sPred, b.sAct]))
  // λはholdoutより前で選び、モデル同士は直近holdoutの売上WAPEで比較する。データ不足時だけ全期間売上WAPEへフォールバック。
  const glmWins = chooseFoodCourtGlm(rollingLegacyWapeS, rollingGlmWapeS, wapeLegacyS, wapeGlmS)

  const back = glmWins ? backGlm : backLegacy
  const mapeG = glmWins ? mapeGlmG : mapeLegacyG
  const mapeS = mape(back.map((b) => [b.sPred, b.sAct]))
  const wapeG = glmWins ? wapeGlmG : wapeLegacyG
  const wapeS = glmWins ? wapeGlmS : wapeLegacyS
  const maeG = glmWins ? maeGlmG : maeLegacyG
  const maeS = glmWins ? maeGlmS : maeLegacyS
  const recentBack = back.filter((b) => b.date >= holdoutStartDate)
  const rollingMapeG = mape(recentBack.map((b) => [b.gPred, b.gAct]))
  const rollingMapeS = mape(recentBack.map((b) => [b.sPred, b.sAct]))
  const rollingWapeG = wape(recentBack.map((b) => [b.gPred, b.gAct]))
  const rollingWapeS = wape(recentBack.map((b) => [b.sPred, b.sAct]))
  const rollingMaeG = mae(recentBack.map((b) => [b.gPred, b.gAct]))
  const rollingMaeS = mae(recentBack.map((b) => [b.sPred, b.sAct]))
  const bandG = mapeG ?? 0.25 // 予測区間の幅（採用モデルのバックテスト誤差率。無ければ暫定±25%）
  const bandS = mapeS ?? 0.25
  const chosenModelVersion = glmWins ? `glm-poisson-v4(lambda=${bestLambda})` : MODEL_VERSION

  // 4) 本予測: 全データで学習し、当日〜+14日を予測（採用モデルを使用）。過去日は out-of-sample 予測＋実績を保存。
  //    AI解説(foodcourt_forecast_factors)向けの乗算係数は、採否に関係なく常に計算して維持する（解釈用の唯一の係数源）。
  const facFull = fit(hist)
  const glmFull = glmWins ? fitGLM(hist, bestLambda) : null
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
      if (!b || !h) continue // 学習初期(MIN_TRAIN未満)で out-of-sample 予測が無い日、または間引かれた日はスキップ
      gPred = b.gPred; sPred = b.sPred; gAct = h.guests; sAct = h.sales
    } else if (glmWins && glmFull) {
      const guests = predictGLMGuests(glmFull, f)
      gPred = guests; sPred = Math.max(0, Math.round(guests * predictSpend(glmFull.spend, f)))
      upcoming.push({ date: d, guests: gPred, sales: sPred, evType: f.evType, rainy: f.rainy })
    } else {
      const p = predict(facFull, f)
      gPred = p.guests; sPred = p.sales
      upcoming.push({ date: d, guests: gPred, sales: sPred, evType: f.evType, rainy: f.rainy })
    }
    const featJson = { dow: f.dow, evType: f.evType, rainy: f.rainy, precipMm: f.precipMm, hotDay: f.hotDay, attendance: f.attendance }
    rows.push({ target_date: d, tenant_name: BASE_TENANT, tenant_code: null, metric: "guests", predicted: gPred, predicted_low: Math.max(0, Math.round(gPred * (1 - bandG))), predicted_high: Math.round(gPred * (1 + bandG)), model_version: chosenModelVersion, features: featJson, actual: gAct })
    rows.push({ target_date: d, tenant_name: BASE_TENANT, tenant_code: null, metric: "sales", predicted: sPred, predicted_low: Math.max(0, Math.round(sPred * (1 - bandS))), predicted_high: Math.round(sPred * (1 + bandS)), model_version: chosenModelVersion, features: featJson, actual: sAct })
  }

  // 統計拡張(stats-ext-v1): 予測には使わない。AI解説の解釈精度を上げる材料を毎晩まとめて再計算。
  // 残差バイアスは「実際に採用されたモデル」のバックテスト結果(back)を使う＝AIに見せる弱点が実態と一致する。
  const advStats = computeAdvancedStats(hist, back)

  const summary = {
    history_days: hist.length,
    backtest_days: back.length,
    mape_guests: pct1(mapeG), // %
    mape_sales: pct1(mapeS),
    wape_guests: pct1(wapeG),
    wape_sales: pct1(wapeS),
    mae_guests: round0(maeG),
    mae_sales: round0(maeS),
    rolling_mape_guests: pct1(rollingMapeG),
    rolling_mape_sales: pct1(rollingMapeS),
    rolling_wape_guests: pct1(rollingWapeG),
    rolling_wape_sales: pct1(rollingWapeS),
    rolling_mae_guests: round0(rollingMaeG),
    rolling_mae_sales: round0(rollingMaeS),
    upcoming: upcoming.slice(0, HORIZON_DAYS),
    rows_to_upsert: rows.length,
    model_selection: {
      chosen: chosenModelVersion,
      glm_wins: glmWins,
      glm_lambda: bestLambda,
      selection_metric: "sales_wape",
      legacy_wape_sales: pct1(wapeLegacyS),
      glm_wape_sales: pct1(wapeGlmS),
      recent_legacy_wape_sales: pct1(rollingLegacyWapeS),
      recent_glm_wape_sales: pct1(rollingGlmWapeS),
      legacy_mape_guests: pct1(mapeLegacyG),
      glm_mape_guests: pct1(mapeGlmG),
      legacy_mape_sales: pct1(mapeLegacyS),
      glm_mape_sales: pct1(mapeGlmS),
      recent_legacy_mape_guests: pct1(rollingLegacyG),
      recent_glm_mape_guests: pct1(rollingGlmG),
      recent_legacy_mape_sales: pct1(rollingLegacyS),
      recent_glm_mape_sales: pct1(rollingGlmS),
      holdout_days: recentBack.length,
    },
  }

  if (dryRun) return json({ ok: true, dry_run: true, model_version: chosenModelVersion, ...summary, factors: facFull, glm_factors: glmFull, advanced_stats: advStats }, 200)

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
      backtest_days: backLegacy.length,
      mape_guests: mapeLegacyG,
      mape_sales: mapeLegacyS,
      rolling_mape_guests: rollingMapeG,
      rolling_mape_sales: rollingMapeS,
      advanced_stats: advStats,
      // 実際に forecast_predictions を生成したモデルの情報（AI解説の乗算係数とは別枠。透明性のための記録）。
      model_selection: {
        chosen: chosenModelVersion,
        glm_wins: glmWins,
        glm_lambda: bestLambda,
        selection_metric: "sales_wape",
        legacy_mape_guests: mapeLegacyG,
        legacy_mape_sales: mapeLegacyS,
        glm_mape_guests: mapeGlmG,
        glm_mape_sales: mapeGlmS,
        legacy_wape_guests: wapeLegacyG,
        legacy_wape_sales: wapeLegacyS,
        glm_wape_guests: wapeGlmG,
        glm_wape_sales: wapeGlmS,
        legacy_mae_guests: maeLegacyG,
        legacy_mae_sales: maeLegacyS,
        glm_mae_guests: maeGlmG,
        glm_mae_sales: maeGlmS,
        recent_legacy_mape_guests: rollingLegacyG,
        recent_glm_mape_guests: rollingGlmG,
        recent_legacy_mape_sales: rollingLegacyS,
        recent_glm_mape_sales: rollingGlmS,
        recent_legacy_wape_guests: rollingLegacyWapeG,
        recent_glm_wape_guests: rollingGlmWapeG,
        recent_legacy_wape_sales: rollingLegacyWapeS,
        recent_glm_wape_sales: rollingGlmWapeS,
        holdout_days: recentBack.length,
        spend_model: {
          version: "spend-model-v1",
          base_spend: facFull.spend,
          event_factors: facFull.spendEvt,
          event_counts: facFull.spendEvtN,
          weather_factors: facFull.spendWeather,
          weather_counts: facFull.spendWeatherN,
        },
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "tenant_name" })
  if (factorsErr) console.error("foodcourt_forecast_factors upsert failed:", factorsErr.message)

  // 学習の進化トラッキング: 今日の学習結果を1行追記（同日再実行は上書き＝冪等）。
  // 「賢くなっているか」を実際の本番予測（採用モデル）の精度で追うため、ここは chosenModelVersion / 採用モデルのMAPEを記録する
  // （AI解説用の乗算係数は常にレガシーだが、本番の予測精度はGLMが勝てばGLMのものを反映させる）。
  const { error: histErr } = await supabase
    .from("foodcourt_forecast_history")
    .upsert({
      tenant_name: BASE_TENANT,
      log_date: todayJst,
      model_version: chosenModelVersion,
      history_days: hist.length,
      backtest_days: back.length,
      mape_guests: mapeG,
      mape_sales: mapeS,
      wape_guests: wapeG,
      wape_sales: wapeS,
      mae_guests: maeG,
      mae_sales: maeS,
      rolling_mape_guests: rollingMapeG,
      rolling_mape_sales: rollingMapeS,
      rolling_wape_guests: rollingWapeG,
      rolling_wape_sales: rollingWapeS,
      rolling_mae_guests: rollingMaeG,
      rolling_mae_sales: rollingMaeS,
      mean_guests: facFull.meanG,
    }, { onConflict: "tenant_name,log_date" })
  if (histErr) console.error("foodcourt_forecast_history upsert failed:", histErr.message)
  return json({ ok: true, model_version: chosenModelVersion, ...summary }, 200)
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
  for (const t of EVENT_TYPES) {
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
  const spendModel = fitSpendModel(h)
  return {
    meanG,
    wday,
    evt,
    weather,
    spend: spendModel.baseSpend,
    spendEvt: spendModel.eventFactors,
    spendEvtN: spendModel.eventCounts,
    spendWeather: spendModel.weatherFactors,
    spendWeatherN: spendModel.weatherCounts,
    wdayN,
    evtN,
    weatherN,
  }
}
function predict(f: Factors, feat: Feat): { guests: number; sales: number } {
  const g = f.meanG * (f.wday[feat.dow] ?? 1) * (f.evt[feat.evType] ?? 1) * (f.weather[feat.rainy ? "rainy" : "dry"] ?? 1)
  const guests = Math.max(0, Math.round(g))
  const sales = Math.max(0, Math.round(guests * predictSpend({
    baseSpend: f.spend,
    eventFactors: f.spendEvt,
    eventCounts: f.spendEvtN,
    weatherFactors: f.spendWeather,
    weatherCounts: f.spendWeatherN,
  }, feat)))
  return { guests, sales }
}
function shrink(rawFactor: number, n: number, k = SHRINK_K): number {
  if (!isFinite(rawFactor) || rawFactor <= 0) return 1
  return (n * rawFactor + k * 1) / (n + k)
}

function spendWeatherKey(f: Feat): string {
  if (f.hotDay) return "hot"
  if (f.rainy) return "rainy"
  return "normal"
}

function fitSpendModel(h: Hist[]): SpendModel {
  const baseSpend = median(h.map((x) => x.spend)) ?? 0
  const eventFactors: Record<string, number> = {}
  const eventCounts: Record<string, number> = {}
  for (const t of EVENT_TYPES) {
    const xs = h.filter((x) => x.evType === t).map((x) => x.spend)
    eventFactors[t] = shrinkSpend(baseSpend > 0 && xs.length ? ((median(xs) ?? baseSpend) / baseSpend) : 1, xs.length)
    eventCounts[t] = xs.length
  }
  const weatherFactors: Record<string, number> = {}
  const weatherCounts: Record<string, number> = {}
  for (const key of ["hot", "rainy", "normal"]) {
    const xs = h.filter((x) => spendWeatherKey(x) === key).map((x) => x.spend)
    weatherFactors[key] = shrinkSpend(baseSpend > 0 && xs.length ? ((median(xs) ?? baseSpend) / baseSpend) : 1, xs.length)
    weatherCounts[key] = xs.length
  }
  return { baseSpend, eventFactors, eventCounts, weatherFactors, weatherCounts }
}

function predictSpend(model: SpendModel, feat: Feat): number {
  const base = Math.max(0, model.baseSpend || 0)
  if (base <= 0) return 0
  const raw = base
    * (model.eventFactors[feat.evType] ?? 1)
    * (model.weatherFactors[spendWeatherKey(feat)] ?? 1)
  return Math.max(0, Math.round(raw))
}

function shrinkSpend(rawFactor: number, n: number): number {
  // 客単価は日次サンプルが少ない段階でもブレやすいため、客数係数より少し強めに1倍へ寄せ、
  // さらに極端な外れ値で売上予測が暴れないよう安全な範囲に収める。
  const factor = shrink(rawFactor, n, SHRINK_K + 2)
  return Math.max(0.65, Math.min(1.45, factor))
}

// --- GLM(ポアソン回帰・IRLS) ---
// 客数(カウントデータ)を log(客数) = 切片 + 曜日 + イベント種別 + 天気 + log(1+降水量)
// + 猛暑(最高気温30℃以上) + log(1+予想動員数) + トレンド(時間)
// の対数線形モデルで推定する。乗算モデル(fit/predict)と違い、
//  - 予想動員数という連続値の特徴量をそのまま扱える（イベント種別の粗い分類だけでなく規模を反映）
//  - 雨の有無だけでなく、降水量と猛暑の影響も連続/閾値特徴量として反映できる
//  - トレンド項で「開店後に客数が伸び続けている」段階的な変化を捉えられる
//  - リッジ正則化(λ)が、サンプルの少ない係数を0(＝乗算モデルでいう「1倍＝無効果」)へ寄せる役割を、
//    全特徴量に対して統一的な統計的裏付けをもって行う（乗算モデルの shrink() に相当するが連続値にも効く）。
const WDAY_LEVELS = [2, 3, 4, 5, 6, 7] as const   // 曜日ダミー（基準=1=月曜）
const EVT_LEVELS = EVENT_MODEL_TYPES // イベント/会場×客層ダミー（基準=none）
// 大型イベント＝当店の来客が最も跳ねる東京ドーム本体系(プロ野球/本体ライブ/本体その他)。交互作用の主対象。
const BIG_EVTYPES = new Set<EvType>(["pro", "live", "dome"])
function isBigEvType(t: EvType): boolean { return BIG_EVTYPES.has(t) }
// 交互作用項(interaction-v1): 主効果だけでは表せない「条件の重なりで効き方が変わる」領域を明示的に足す。
//  1) 土日×大型イベント（週末の大型は平日と伸び方が違う）
//  2) 雨×大型イベント（大型集客日は雨でも来る＝雨の減衰が弱まる/強まる）
//  3) 猛暑×大型イベント（猛暑日の大型はドリンク/休憩需要で当店利用が変わる）
// フル曜日×イベント(6×9)は小データで過学習するため、経営的に意味の大きい3項に絞る。リッジがスパース列を0へ寄せる。
const INTERACTION_COLS = 3
const GLM_COLS = 1 + WDAY_LEVELS.length + EVT_LEVELS.length + 1 /*rainy*/ + 1 /*precip*/ + 1 /*hot*/ + 1 /*attendance*/ + 1 /*trend*/ + INTERACTION_COLS

// 特徴量1件を設計行列の1行に変換する（trendStdは呼び出し側で標準化済みの値を渡す）。
function designRow(f: Feat, trendStd: number): number[] {
  const row = new Array(GLM_COLS).fill(0)
  row[0] = 1
  const wi = WDAY_LEVELS.indexOf(f.dow as typeof WDAY_LEVELS[number])
  if (wi >= 0) row[1 + wi] = 1
  const ei = EVT_LEVELS.indexOf(f.evType as typeof EVT_LEVELS[number])
  if (ei >= 0) row[1 + WDAY_LEVELS.length + ei] = 1
  const weatherStart = 1 + WDAY_LEVELS.length + EVT_LEVELS.length
  row[weatherStart] = f.rainy ? 1 : 0
  row[weatherStart + 1] = Math.log1p(Math.max(0, f.precipMm || 0))
  row[weatherStart + 2] = f.hotDay ? 1 : 0
  row[weatherStart + 3] = Math.log1p(Math.max(0, f.attendance || 0))
  row[weatherStart + 4] = trendStd
  // --- 交互作用項(interaction-v1) ---
  const interStart = weatherStart + 5
  const big = isBigEvType(f.evType) ? 1 : 0
  const weekend = (f.dow === 6 || f.dow === 7) ? 1 : 0
  row[interStart] = weekend * big              // 土日×大型イベント
  row[interStart + 1] = (f.rainy ? 1 : 0) * big // 雨×大型イベント
  row[interStart + 2] = (f.hotDay ? 1 : 0) * big // 猛暑×大型イベント
  return row
}
// 日付を「1970-01-01からの通算日数」に変換（トレンド項の時間軸に使う）。
function epochDay(ymd: string): number {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return 0
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000)
}
// 連立一次方程式 A x = b をガウスの消去法(部分ピボット選択)で解く。特異(ほぼ0ピボット)ならnull。
function solveLinearSystem(Ain: number[][], bin: number[]): number[] | null {
  const n = bin.length
  const A = Ain.map((row) => row.slice())
  const b = bin.slice()
  for (let col = 0; col < n; col++) {
    let piv = col
    let best = Math.abs(A[col][col])
    for (let r = col + 1; r < n; r++) { const v = Math.abs(A[r][col]); if (v > best) { best = v; piv = r } }
    if (best < 1e-10) return null
    if (piv !== col) { const t = A[col]; A[col] = A[piv]; A[piv] = t; const tb = b[col]; b[col] = b[piv]; b[piv] = tb }
    const pv = A[col][col]
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / pv
      if (f === 0) continue
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c]
      b[r] -= f * b[col]
    }
  }
  const x = new Array(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c]
    x[r] = s / A[r][r]
  }
  return x
}
// ポアソン回帰をIRLS(反復重み付き最小二乗)で学習する。リッジ(λ、切片は正則化しない)で過学習を防ぐ。
// トレンド項は学習ウィンドウ内の通算日数を標準化して使う（予測時も同じ基準(startEpoch/meanT/sdT)で変換する）。
function fitGLM(train: Hist[], lambda: number): GlmModel | null {
  const n = train.length
  if (n < 2) return null
  const startEpoch = epochDay(train[0].date)
  const epochs = train.map((h) => epochDay(h.date) - startEpoch)
  const meanT = avg(epochs) ?? 0
  const sdT = sampleSd(epochs) || 1
  const X = train.map((h, i) => designRow(h, (epochs[i] - meanT) / sdT))
  const y = train.map((h) => h.guests)
  const p = X[0].length
  let beta = new Array(p).fill(0)
  beta[0] = Math.log(Math.max(1, avg(y) ?? 1))
  for (let iter = 0; iter < 25; iter++) {
    const W = new Array(n); const z = new Array(n)
    for (let i = 0; i < n; i++) {
      let eta = 0
      for (let a = 0; a < p; a++) eta += X[i][a] * beta[a]
      const mu = Math.exp(Math.max(-20, Math.min(20, eta)))
      const muC = Math.max(mu, 1e-6)
      W[i] = muC
      z[i] = eta + (y[i] - muC) / muC
    }
    const XtWX: number[][] = Array.from({ length: p }, () => new Array(p).fill(0))
    const XtWz: number[] = new Array(p).fill(0)
    for (let i = 0; i < n; i++) {
      const xi = X[i], wi = W[i], zi = z[i]
      for (let a = 0; a < p; a++) {
        const xa = xi[a]
        if (xa === 0) continue // ダミー列のスパース性を利用して省略（速度対策）
        XtWz[a] += xa * wi * zi
        for (let b = 0; b < p; b++) {
          const xb = xi[b]
          if (xb === 0) continue
          XtWX[a][b] += xa * wi * xb
        }
      }
    }
    for (let a = 1; a < p; a++) XtWX[a][a] += lambda // リッジ（切片は正則化しない）
    const newBeta = solveLinearSystem(XtWX, XtWz)
    if (!newBeta) break // 特異になったら直前のbetaのまま打ち切り
    let diff = 0
    for (let a = 0; a < p; a++) diff += Math.abs(newBeta[a] - beta[a])
    beta = newBeta
    if (diff < 1e-6) break
  }
  const spend = fitSpendModel(train)
  return { beta, startEpoch, meanT, sdT, spend }
}
// 学習済みGLMで客数を予測する（学習時と同じトレンド標準化を再現する）。
function predictGLMGuests(m: GlmModel, f: Feat): number {
  const t = (epochDay(f.date) - m.startEpoch - m.meanT) / m.sdT
  const row = designRow(f, t)
  let eta = 0
  for (let a = 0; a < row.length; a++) eta += row[a] * m.beta[a]
  const mu = Math.exp(Math.max(-20, Math.min(20, eta)))
  return Math.max(0, Math.round(mu))
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
  for (const t of EVENT_TYPES) {
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
  for (const t of EVENT_TYPES) {
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
    "evt:hall_kanadevia": "カナデビアホールの日", "evt:hall_korakuen": "後楽園ホールの日",
    "evt:hall_other": "その他小ホールの日", "evt:none": "イベント無しの日",
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
    dome: "ドーム本体(その他)", sports: "世界スポーツ放映",
    hall_kanadevia: "カナデビアホール", hall_korakuen: "後楽園ホール", hall_other: "その他小ホール",
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
  // 会場×客層を加味（#5）: 東京ドーム本体(has_dome_main)は大集客、カナデビア/後楽園は小ホールでも客層が異なるため別係数。
  if (r.has_pro_baseball === true) return "pro"            // ドーム野球＝当店の最強ドライバー（同日にPVが重なってもこちらを優先）
  if (r.has_soccer_pv === true) return "soccer_pv"          // サッカーPV＝高集客でも当店売上は間接的・波及的（過大評価を避け別係数で学習）
  if (r.has_japan_match === true) return "japan"            // サッカー以外の日本戦PV（WBC/世界ボクシング/五輪 等）
  if (r.has_live === true && r.has_dome_main === true) return "live"  // 東京ドーム本体コンサート＝大集客（従来のlive係数を維持）
  if (r.has_dome_main === true) return "dome"               // ドーム本体のアマ野球/その他（live以外）＝大集客
  if (r.has_sports_broadcast === true) return "sports"     // 日本以外の世界スポーツ放映
  if (r.has_korakuen === true) return "hall_korakuen"       // 後楽園ホール＝格闘技/ボクシング/プロレス中心。中年男性客層として別学習。
  if (r.has_kanadevia === true) return "hall_kanadevia"     // カナデビアホール＝ライブ/舞台中心。若年層・公演客として別学習。
  if (r.has_live === true || r.has_event === true) return "hall_other"  // その他小ホール/ラクーア/プリズム等。ドーム本体無しなのでlive係数を当てない。
  return "none"
}

// --- helpers ---
function mape(pairs: Array<[number, number]>): number | null {
  const xs = pairs.filter(([, a]) => a > 0).map(([p, a]) => Math.abs(p - a) / a)
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null
}
// WAPE(加重絶対誤差率)= Σ|予測-実績| / Σ実績。MAPEと違い実績の小さい日で誤差率が跳ね上がらず、
// 実績(売上・客数)の大きい日を重く扱う＝経営判断に近い指標。分母が0以下なら評価不能としてnull。
function wape(pairs: Array<[number, number]>): number | null {
  let num = 0, den = 0
  for (const [p, a] of pairs) {
    if (!(a > 0)) continue
    num += Math.abs(p - a)
    den += a
  }
  return den > 0 ? num / den : null
}
// MAE(平均絶対誤差)= mean|予測-実績|。誤差率でなく実数（客数なら「人」、売上なら「円」）の平均ズレ。
function mae(pairs: Array<[number, number]>): number | null {
  const xs = pairs.filter(([, a]) => a != null && isFinite(a)).map(([p, a]) => Math.abs(p - a))
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null
}
function pct1(v: number | null): number | null { return v != null ? Math.round(v * 1000) / 10 : null }
function round0(v: number | null): number | null { return v != null ? Math.round(v) : null }
function avg(a: number[]): number | null { const x = a.filter((v) => v != null && isFinite(v)); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null }
function median(a: number[]): number | null { const x = a.filter((v) => v != null && isFinite(v)).slice().sort((p, q) => p - q); if (!x.length) return null; const m = Math.floor(x.length / 2); return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2 }
function num(v: unknown): number | null { if (v == null) return null; const n = Number(v); return isFinite(n) ? n : null }
function jstDate(base: Date): string { const j = new Date(base.getTime() + 9 * 3600 * 1000); return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, "0")}-${String(j.getUTCDate()).padStart(2, "0")}` }
function addDays(ymd: string, n: number): string { const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return ymd; const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}` }
function isoDow(ymd: string): number { const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return 0; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(); return d === 0 ? 7 : d }
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
}
