import {
  buildKpiScenarioPack, buildKpiScenarioReference, deriveKpiBaselineFromUnifiedSales,
  formatKpiScenarioBlock, isKpiScenarioRequest, normalizeKpiAssumptions,
  KPI_ASSUMPTION_LABELS,
} from './kpi_scenario.ts'
import { buildTrustedAiSalesData, type UnifiedSalesSummary } from './sales_reconciliation_ai.ts'
import { allocateFoodCourtHourlyTargets, buildFoodCourtJournalDemandOutlook, type FoodCourtJournalDetail } from './foodcourt_journal_detail.ts'

/** 入力の参照は試算の許可とは別。数値allowlist以外や自由文はここへ取り込まない。 */
export function buildFoodCourtKpiInputs(raw: unknown, currentInputKeys?: string[]) {
  const normalized = normalizeKpiAssumptions(raw)
  if (!normalized.provided.length) return null
  const items = normalized.provided.map(key => ({
    key, label: KPI_ASSUMPTION_LABELS[key], value: normalized.values[key]!,
    unit: key.endsWith('Yen') ? '円' : key.endsWith('Pct') ? '％' : key === 'bakeBatchUnits' ? '個' : key === 'bakeBatchesPerDay' ? '回' : key === 'prepStaffCount' ? '人' : '時間',
    source: !currentInputKeys || currentInputKeys.includes(key) ? '今回の入力欄' : '店舗営業情報',
  }))
  const summary = items.map(item => `- 【仮定(入力)】${item.label}: ${item.value}${item.unit}（${item.source}）`).join('\n')
  return {
    block: `【今回の入力前提・実績ではない】\n${summary}\n関連する商品導入・価格・運営の相談では、入力済み条件を踏まえて判断する。入力済みの売価・原価・人員などを「不明」「未入力」と扱わない。専門AIや過去回答の「未設定」より今回の値を優先する。実績照会にはこれらを実績として混ぜず、質問と無関係な前提で結論を変えない。前提の参照だけでは試算を許可しない。サーバー確定計算ブロックがなければ新しい販売目標・利益・増収額・係数を作らない。未入力項目は未知のまま。`,
    summary,
    reference: { basis: 'input' as const, items },
  }
}
export type FoodCourtKpiInputs = NonNullable<ReturnType<typeof buildFoodCourtKpiInputs>>

export const FOODCOURT_KPI_POLICY = `【KPI試算・この質問だけの例外】
利用者が販売分析・目標・見込みを求めたため、以下のサーバー確定計算値だけを試算として引用できる。AIが別の係数で再計算することは禁止。
新しい施策・新商品にその施策自体の実績は無い。数値未確認・未計測で止めない。今の店舗売上【実績】と類似商品の日次販売から、寄与率と上積みを【仮定(シナリオ)】として引用する。
販売個数・売上見込みはジャーナルの類似/対象商品の日次実績と月次推移からコードが伸ばした【仮定(シナリオ)】である。実績そのものではない。
商品売上見込みは「売れた場合の額」。上積みは置き換えを見込んだ増分。寄与率は今の店舗日次売上に対する見込みの割合。上積みを店舗全体の確定純増・営業利益と呼ばない。
必ず保守／標準／強気の3シナリオを併記し、各数値の【実績】【仮定(入力)】【仮定(シナリオ)】を保持する。実績と仮定は別の表にし、同じ合計に混ぜない。
試算の基準期間はブロックに記載した統一売上の期間であり、表示中の単日や質問中のイベントの実績に読み替えない。テナント比較表の税抜売上とも合算しない。
価格・粗利率・損益分岐・営業区分別販売目標・日次/月次売上・寄与率・上積み・KPI目標・撤退ラインを簡潔に示す。見込み個数が損益分岐を下回れば撤退リスクとして述べる。未入力・粗利未登録は仮置きの推測値と述べ、最後に「この試算の精度を上げるために必要なデータ」を置く。
今回入力欄と保存済みの店舗前提だけが入力値。質問や過去回答中の数字を入力値に昇格しない。質問で別の前提が示されていれば、入力欄への反映を案内する。重ね聞きでもこのブロックの目標・見込み・寄与・上積み・撤退ラインを省略しない。`

/** 新しい施策の店舗売上への寄与と上積み。施策自体の実績は使わない。 */
const INITIATIVE_INCREMENTAL_SHARE: Record<string, number> = {
  保守: 0.3,
  標準: 0.55,
  強気: 0.85,
}

export function buildFoodCourtInitiativeUplift(input: {
  storeDailySalesYen: number | null
  storePeriodLabel: string
  operatingDaysPerMonth: number | null
  scenarios: Array<{ label: string; daily_sales_yen: number | null; daily_units: number | null }>
}) {
  const usable = input.scenarios.filter((row) => row.daily_sales_yen != null && row.daily_sales_yen > 0)
  if (!usable.length) return null
  const monthDays = input.operatingDaysPerMonth != null && input.operatingDaysPerMonth > 0
    ? input.operatingDaysPerMonth
    : 30
  const monthDaysBasis = input.operatingDaysPerMonth != null && input.operatingDaysPerMonth > 0 ? 'actual' : 'scenario'
  const rows = input.scenarios.map((row) => {
    const share = INITIATIVE_INCREMENTAL_SHARE[row.label] ?? 0.55
    const initiative = row.daily_sales_yen
    const contributionPct = input.storeDailySalesYen && initiative != null
      ? Math.round(initiative / input.storeDailySalesYen * 1000) / 10
      : null
    const dailyUpliftYen = initiative != null ? Math.round(initiative * share) : null
    return {
      label: row.label,
      daily_units: row.daily_units,
      initiative_daily_sales_yen: initiative,
      store_contribution_pct: contributionPct,
      incremental_share: share,
      daily_uplift_yen: dailyUpliftYen,
      monthly_uplift_yen: dailyUpliftYen != null ? Math.round(dailyUpliftYen * monthDays) : null,
    }
  })
  const storeYen = input.storeDailySalesYen != null ? `¥${input.storeDailySalesYen.toLocaleString('ja-JP')}` : '取得なし'
  const facts = {
    store_daily_sales_yen: input.storeDailySalesYen,
    store_period_label: input.storePeriodLabel,
    operating_days_per_month: monthDays,
    operating_days_basis: monthDaysBasis,
    scenarios: rows,
  }
  const block =
    `【新しい施策の店舗売上への寄与・上積み・仮定(シナリオ)】\n` +
    `新しい施策にその施策自体の実績は無い。数値未確認とはしない。今の店舗日次売上【実績】${storeYen}（${input.storePeriodLabel}）を分母にする。\n` +
    `商品売上見込みは類似/対象商品の販売から伸ばした【仮定(シナリオ)】。寄与率＝見込み÷今の店舗日次売上。上積み＝見込み×置き換えを見込んだ増分率（保守0.3／標準0.55／強気0.85）。置き換え率は観測ではない。上積みを確定の純増売上・営業利益と呼ばない。\n` +
    JSON.stringify(facts)
  return { facts, block }
}

type Profile = { store_key: string; profile: { kpiAssumptions?: unknown } | null }
type Loaders = {
  loadProfile: (store: string) => Promise<Profile>
  loadSales: (store: string, from: string, to: string) => Promise<UnifiedSalesSummary>
  timeoutMs?: number
}

export function formatKpiUserAppendix(
  pack: NonNullable<ReturnType<typeof buildKpiScenarioPack>>,
  uplift: ReturnType<typeof buildFoodCourtInitiativeUplift>,
  outlook: ReturnType<typeof buildFoodCourtJournalDemandOutlook>,
) {
  const yen = (n: number | null | undefined) =>
    n == null || !Number.isFinite(n) ? '—' : `¥${Math.round(n).toLocaleString('ja-JP')}`
  const num = (n: number | null | undefined, unit = '') =>
    n == null || !Number.isFinite(n) ? '—' : `${Math.round(n * 10) / 10}${unit}`
  const lines = [
    '【新しい施策のKPI見込み（コード計算・仮定）】',
    'この施策自体の販売実績はない。データ不足で分析を止めない。今の店舗売上と類似商品から売価・原価・販売数を推測した。【仮定(シナリオ)】であり実績ではない。',
  ]
  if (pack.baseline.averageDailySalesYen != null) {
    lines.push(`今の店舗 1日あたり売上【実績】${yen(pack.baseline.averageDailySalesYen)}（${pack.baseline.periodLabel}）`)
  }
  if (outlook?.facts.product_names?.length) {
    lines.push(`類似/対象商品: ${outlook.facts.product_names.join('、')}。観測 1日 ${outlook.facts.daily_units}個・${yen(outlook.facts.daily_sales_yen)}を販売数の錨にする。`)
  }
  lines.push('シナリオ | 予想売価 | 予想原価 | 予想販売数/日 | 予想売上/日 | 今の売上への寄与 | 上積み/日 | 上積み/月')
  for (const scenario of pack.scenarios) {
    const item = scenario.prices[0]
    const fromOutlook = outlook?.facts.scenarios.find((row) => row.label === scenario.scenarioLabel)
    const fromUplift = uplift?.facts.scenarios.find((row) => row.label === scenario.scenarioLabel)
    const units = fromOutlook?.daily_units ?? scenario.normalDayOutlook.targetUnits.value
    const dailySales = fromOutlook?.daily_sales_yen ?? fromUplift?.initiative_daily_sales_yen ?? scenario.averageDailyRevenueYen.value
    const contribution = fromUplift?.store_contribution_pct
    lines.push([
      scenario.scenarioLabel,
      yen(item?.price.value),
      yen(item?.cost.value),
      num(units, '個'),
      yen(dailySales),
      contribution == null ? '—' : `${contribution}%`,
      yen(fromUplift?.daily_uplift_yen),
      yen(fromUplift?.monthly_uplift_yen),
    ].join(' | '))
  }
  lines.push('寄与率＝見込み売上÷今の店舗日次売上。上積み＝見込み×置き換えを見込んだ増分（保守0.3／標準0.55／強気0.85）。確定の純増・営業利益ではない。')
  return lines.join('\n')
}

/** 認可後に呼ぶ。自店売上の確定期間を優先し、クライアント実績は受け取らない。 */
export async function prepareFoodCourtKpiScenario(
  input: { question: string; historyText?: string; authorizedStore: string; salesDates: string[]; salesRanges?: Array<{from:string;to:string}>; assumptions?: unknown; journalDetail?: FoodCourtJournalDetail | null; force?: boolean },
  loaders: Loaders,
) {
  if (!input.force && !isKpiScenarioRequest(input.question, input.historyText)) return null
  const store = input.authorizedStore.trim().toLowerCase()
  if (!/^[a-z0-9_-]{1,80}$/.test(store)) throw new Error('Invalid KPI store')
  const dates = [...new Set(input.salesDates)].sort()
  if (dates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) {
    throw new Error('Invalid KPI baseline dates')
  }
  const ranges = input.salesRanges?.length ? input.salesRanges : dates.length ? [{ from: dates[0], to: dates.at(-1)! }] : []
  const periods = ranges.length ? [{
    label: `Q&A参考期間 ${ranges.map(r => r.from+'〜'+r.to).join(' / ')}`,
    ranges,
  }] : []
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [profile, sales] = await Promise.race([
      Promise.all([
        loaders.loadProfile(store),
        buildTrustedAiSalesData({ salesPeriods: periods }, store, loaders.loadSales),
      ]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('KPI inputs unavailable')), Math.max(1, Math.min(8000, loaders.timeoutMs ?? 8000)))
      }),
    ])
    if (profile.store_key !== store) throw new Error('KPI profile store mismatch')
    const assumptions = { ...normalizeKpiAssumptions(profile.profile?.kpiAssumptions).values }
    for (const [key, value] of Object.entries(normalizeKpiAssumptions(input.assumptions).values)) {
      if (value !== null) assumptions[key as keyof typeof assumptions] = value
    }
    const detail = input.journalDetail
    const outlook = buildFoodCourtJournalDemandOutlook(
      detail,
      `${input.question}\n${input.historyText || ""}`,
    )
    if (assumptions.unitPriceYen == null && outlook?.facts.unit_price_yen) {
      assumptions.unitPriceYen = outlook.facts.unit_price_yen
    }
    const pack = buildKpiScenarioPack({ assumptions, baseline: deriveKpiBaselineFromUnifiedSales(sales.unified_sales) })
    const dailyUnits = (label: string) => {
      const fromOutlook = outlook?.facts.scenarios.find(s => s.label === label)?.daily_units
      if (fromOutlook != null) return Math.round(fromOutlook)
      return pack.scenarios.find(s => s.scenarioLabel === label)?.normalDayOutlook.targetUnits.value
    }
    const hourlyTargets = detail && detail.facts.hourly.length ? pack.scenarios.map(s => {
      const units = dailyUnits(s.scenarioLabel) ?? s.normalDayOutlook.targetUnits.value
      return {
        scenario: s.scenarioLabel, basis: 'scenario' as const, daily_target_units: units,
        hours: allocateFoodCourtHourlyTargets(units, detail),
      }
    }) : []
    const hourlyBlock = hourlyTargets.length ? `\n\n【ジャーナル実績を重みにした時間別KPI配分案】\n${detail!.summary}\n【実績】時刻が分かる会計の時間別件数を配分の重みとする。【仮定(シナリオ)】通常日の新商品販売目標を同じ時間構成で売ると仮定した配分案。将来の需要予測・イベント前後の実績・注文時刻ではない。時刻不明会計は重みから除外し、整数配分の合計は各シナリオの日次目標に一致させる。\n${JSON.stringify(hourlyTargets)}` : ''
    const outlookBlock = outlook ? `\n\n${outlook.block}` : ''
    const uplift = buildFoodCourtInitiativeUplift({
      storeDailySalesYen: pack.baseline.averageDailySalesYen,
      storePeriodLabel: pack.baseline.periodLabel,
      operatingDaysPerMonth: pack.baseline.operatingDaysPerMonth,
      scenarios: pack.scenarios.map((s) => {
        const fromOutlook = outlook?.facts.scenarios.find((row) => row.label === s.scenarioLabel)
        return {
          label: s.scenarioLabel,
          daily_units: fromOutlook?.daily_units ?? s.normalDayOutlook.targetUnits.value,
          daily_sales_yen: fromOutlook?.daily_sales_yen ?? s.averageDailyRevenueYen.value,
        }
      }),
    })
    const upliftBlock = uplift ? `\n\n${uplift.block}` : ''
    const userAppendix = formatKpiUserAppendix(pack, uplift, outlook)
    return {
      inputs: buildFoodCourtKpiInputs(assumptions, normalizeKpiAssumptions(input.assumptions).provided),
      block: formatKpiScenarioBlock(pack) + outlookBlock + hourlyBlock + upliftBlock,
      userAppendix,
      reference: { ...buildKpiScenarioReference(pack), baseline_period: pack.baseline.periodLabel, journal_detail_coverage: detail?.coverage ?? null, demand_outlook: outlook?.facts ?? null, hourly_targets: hourlyTargets, initiative_uplift: uplift?.facts ?? null },
    }
  } finally {
    clearTimeout(timer)
  }
}

export type FoodCourtKpiContext = NonNullable<Awaited<ReturnType<typeof prepareFoodCourtKpiScenario>>>
