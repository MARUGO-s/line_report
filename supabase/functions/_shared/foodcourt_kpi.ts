import {
  buildKpiScenarioPack, buildKpiScenarioReference, deriveKpiBaselineFromUnifiedSales,
  formatKpiScenarioBlock, isKpiScenarioRequest, normalizeKpiAssumptions,
  KPI_ASSUMPTION_LABELS,
} from './kpi_scenario.ts'
import { buildTrustedAiSalesData, type UnifiedSalesSummary } from './sales_reconciliation_ai.ts'
import { allocateFoodCourtHourlyTargets, type FoodCourtJournalDetail } from './foodcourt_journal_detail.ts'

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
利用者が明示的に依頼したため、以下のサーバー確定計算値だけを試算として引用できる。AI自身による数値・係数・前提の創作や再計算は禁止。
必ず保守／標準／強気の3シナリオを併記し、各数値の【実績】【仮定(入力)】【仮定(シナリオ)】を保持する。実績と仮定は別の表にし、同じ合計に混ぜない。
試算の基準期間はブロックに記載した統一売上の期間であり、表示中の単日や質問中のイベントの実績に読み替えない。テナント比較表の税抜売上とも合算しない。
価格・粗利率・損益分岐・営業区分別販売目標・日次/月次売上・KPI目標・撤退ラインを簡潔に示す。未入力は仮置きと述べ、最後に「この試算の精度を上げるために必要なデータ」を置く。
今回入力欄と保存済みの店舗前提だけが入力値。質問や過去回答中の数字を入力値に昇格しない。質問で別の前提が示されていれば、入力欄への反映を案内する。`

type Profile = { store_key: string; profile: { kpiAssumptions?: unknown } | null }
type Loaders = {
  loadProfile: (store: string) => Promise<Profile>
  loadSales: (store: string, from: string, to: string) => Promise<UnifiedSalesSummary>
  timeoutMs?: number
}

/** 認可後に呼ぶ。自店売上の確定期間を優先し、クライアント実績は受け取らない。 */
export async function prepareFoodCourtKpiScenario(
  input: { question: string; authorizedStore: string; salesDates: string[]; salesRanges?: Array<{from:string;to:string}>; assumptions?: unknown; journalDetail?: FoodCourtJournalDetail | null },
  loaders: Loaders,
) {
  if (!isKpiScenarioRequest(input.question)) return null
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
    const pack = buildKpiScenarioPack({ assumptions, baseline: deriveKpiBaselineFromUnifiedSales(sales.unified_sales) })
    const detail = input.journalDetail
    const hourlyTargets = detail && detail.facts.hourly.length ? pack.scenarios.map(s => ({
      scenario: s.scenarioLabel, basis: 'scenario', daily_target_units: s.normalDayOutlook.targetUnits.value,
      hours: allocateFoodCourtHourlyTargets(s.normalDayOutlook.targetUnits.value, detail),
    })) : []
    const hourlyBlock = hourlyTargets.length ? `\n\n【ジャーナル実績を重みにした時間別KPI配分案】\n${detail!.summary}\n【実績】時刻が分かる会計の時間別件数を配分の重みとする。【仮定(シナリオ)】通常日の新商品販売目標を同じ時間構成で売ると仮定した配分案。将来の需要予測・イベント前後の実績・注文時刻ではない。時刻不明会計は重みから除外し、整数配分の合計は各シナリオの日次目標に一致させる。\n${JSON.stringify(hourlyTargets)}` : ''
    return {
      inputs: buildFoodCourtKpiInputs(assumptions, normalizeKpiAssumptions(input.assumptions).provided),
      block: formatKpiScenarioBlock(pack) + hourlyBlock,
      reference: { ...buildKpiScenarioReference(pack), baseline_period: pack.baseline.periodLabel, journal_detail_coverage: detail?.coverage ?? null, hourly_targets: hourlyTargets },
    }
  } finally {
    clearTimeout(timer)
  }
}

export type FoodCourtKpiContext = NonNullable<Awaited<ReturnType<typeof prepareFoodCourtKpiScenario>>>
