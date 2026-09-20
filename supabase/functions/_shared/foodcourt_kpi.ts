import {
  buildKpiScenarioPack, buildKpiScenarioReference, deriveKpiBaselineFromUnifiedSales,
  formatKpiScenarioBlock, isKpiScenarioRequest, normalizeKpiAssumptions,
} from './kpi_scenario.ts'
import { buildTrustedAiSalesData, type UnifiedSalesSummary } from './sales_reconciliation_ai.ts'

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

/** 認可後に呼ぶ。期間はサーバー取得の比較レポートから渡し、クライアント実績は受け取らない。 */
export async function prepareFoodCourtKpiScenario(
  input: { question: string; authorizedStore: string; salesDates: string[]; salesRanges?: Array<{from:string;to:string}>; assumptions?: unknown },
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
    return {
      block: formatKpiScenarioBlock(pack),
      reference: { ...buildKpiScenarioReference(pack), baseline_period: pack.baseline.periodLabel },
    }
  } finally {
    clearTimeout(timer)
  }
}

export type FoodCourtKpiContext = NonNullable<Awaited<ReturnType<typeof prepareFoodCourtKpiScenario>>>
