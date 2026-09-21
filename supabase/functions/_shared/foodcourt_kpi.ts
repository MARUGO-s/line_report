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

export function readKpiGoalFromAssumptions(raw: unknown): {
  kgiTargetYen: number | null
  kgiHorizon: 'day' | 'month' | null
  kgiKind: 'uplift' | 'store' | null
} {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const n = Number(src.kgiTargetYen)
  const yen = Number.isFinite(n) && n >= 1 && n <= 100000000 ? Math.round(n) : null
  const horizon = src.kgiHorizon === 'month' || src.kgiHorizon === 'day' ? src.kgiHorizon : null
  const kind = src.kgiKind === 'store' || src.kgiKind === 'uplift' ? src.kgiKind : null
  return { kgiTargetYen: yen, kgiHorizon: horizon, kgiKind: kind }
}

function resolveKgiKind(
  goal: { kgiTargetYen: number; kgiKind: 'uplift' | 'store' | null },
  storeDailyYen: number | null | undefined,
): 'uplift' | 'store' {
  if (goal.kgiKind === 'store' || goal.kgiKind === 'uplift') return goal.kgiKind
  if (storeDailyYen != null && Number.isFinite(storeDailyYen) && goal.kgiTargetYen >= storeDailyYen * 0.5) return 'store'
  return 'uplift'
}

export const FOODCOURT_KPI_POLICY = `【KPI試算・この質問だけの例外】
利用者が販売分析・目標・見込みを求めたため、以下のサーバー確定計算値だけを試算として引用できる。AIが別の係数で再計算することは禁止。
新しい施策・新商品にその施策自体の実績は無い。数値未確認・未計測で止めない。今の店舗売上【実績】と類似商品の日次販売から、寄与率と上積みを【仮定(シナリオ)】として引用する。
販売個数・売上見込みはジャーナルの類似/対象商品の日次実績と月次推移からコードが伸ばした【仮定(シナリオ)】である。実績そのものではない。
商品売上見込みは「売れた場合の額」。上積みは置き換えを見込んだ増分。寄与率は今の店舗日次売上に対する見込みの割合。上積みを店舗全体の確定純増・営業利益と呼ばない。
予想売上・寄与率・上積みは「単品のみ」と「セット込み（ドリンク・ワインの上乗せを加重平均）」の2基準がある。どちらの数字を引用するときも必ずどちらの基準かを明記し、セット込みの数字にはセット選択比率・上乗せ額が仮定(シナリオ)で実測のセット購入率ではない旨を添える。基準を混在させて1つの数字であるかのように書かない。
必ず保守／標準／強気の3シナリオを併記する。表では【仮定(シナリオ)】をセルに繰り返さず、表の直上に注釈を1行だけ置く。箇条書きで個別引用するときだけ【実績】【仮定(入力)】【仮定(シナリオ)】を付ける。実績と仮定は別の表にし、同じ合計に混ぜない。
試算の基準期間はブロックに記載した統一売上の期間であり、表示中の単日や質問中のイベントの実績に読み替えない。テナント比較表の税抜売上とも合算しない。
価格・粗利率・損益分岐・営業区分別販売目標・日次/月次売上・寄与率・上積み・KPI目標・撤退ラインを簡潔に示す。見込み個数が損益分岐を下回れば撤退リスクとして述べる。未入力・粗利未登録は仮置きの推測値と述べ、最後に「この試算の精度を上げるために必要なデータ」を置く。
今回入力欄と保存済みの店舗前提だけが入力値。質問や過去回答中の数字を入力値に昇格しない。質問で別の前提が示されていれば、入力欄への反映を案内する。重ね聞きでもこのブロックの目標・見込み・寄与・上積み・撤退ラインを省略しない。
KGIは店舗の最終成果である。新商品のKGIは単品売上ではなく、現状の店舗日次売上＋純増目標（セットの置き換えを引いたあとに店が増える額）。施策のセット込み売上はKPIであり店舗KGIではない。施策売上≠純増。KGI未入力なら達成率を作らない。プロセスを分解し、現場が動かせる最重要プロセス（CSF）を1つに絞り、その数値目標だけをKPIとする。悪化時はいつ・どれくらい・何をする・誰が決めるを判定・中止ラインへ。KFIはそのCSFを実行する行動。
売上だけで施策の成否を決めない。客数（新規/固定/頻度が分かる範囲）と客単価（何円の商品がいくつ売れたか）に分解する。人時売上は総労働時間があるときだけ。月末だけの振り返しにせず、日次・時間帯の先行指標を優先する。`

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
  /** 単品のみ／セット込みなど、この計算がどの売上基準を使ったかを併記するときのラベル。 */
  basisLabel?: string
  /** basisLabel の内訳・前提を1文で添えるときの補足（例: セット選択比率と上乗せ額の出所）。 */
  basisNote?: string
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
    (input.basisLabel ? `【基準: ${input.basisLabel}】\n` : '') +
    `【新しい施策の店舗売上への寄与・上積み・仮定(シナリオ)】\n` +
    `新しい施策にその施策自体の実績は無い。数値未確認とはしない。今の店舗日次売上【実績】${storeYen}（${input.storePeriodLabel}）を分母にする。\n` +
    `商品売上見込みは類似/対象商品の販売から伸ばした【仮定(シナリオ)】。寄与率＝見込み÷今の店舗日次売上。上積み＝見込み×置き換えを見込んだ増分率（保守0.3／標準0.55／強気0.85）。置き換え率は観測ではない。上積みを確定の純増売上・営業利益と呼ばない。` +
    (input.basisNote ? `\n${input.basisNote}` : '') + '\n' +
    JSON.stringify(facts)
  return { facts, block }
}

type Profile = { store_key: string; profile: { kpiAssumptions?: unknown } | null }
type Loaders = {
  loadProfile: (store: string) => Promise<Profile>
  loadSales: (store: string, from: string, to: string) => Promise<UnifiedSalesSummary>
  timeoutMs?: number
}

const KPI_TABLE_NOTE = '注釈: この表の数値はすべて【仮定(シナリオ)】（入力済み前提がある項目はそれを使用）。実績ではない。ラベルはここにだけ書く。'

function mdTable(headers: string[], rows: string[][]) {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n')
}

/**
 * ジャーナル類似商品の観測個数（他商品の合算実績）を、新商品の販売数見込みにそのまま使わない。
 * 焼成上限×廃棄控除（sellableCapacityUnits）を新商品1品の物理的な上限として頭打ちする。
 */
function clampOutlookUnitsToCapacity(
  outlookUnits: number | null | undefined,
  capacityUnits: number | null | undefined,
): number | null {
  if (outlookUnits == null || !Number.isFinite(outlookUnits)) return null
  if (capacityUnits == null || !Number.isFinite(capacityUnits)) return outlookUnits
  return Math.min(outlookUnits, capacityUnits)
}

export function formatKpiUserAppendix(
  pack: NonNullable<ReturnType<typeof buildKpiScenarioPack>>,
  uplift: ReturnType<typeof buildFoodCourtInitiativeUplift>,
  outlook: ReturnType<typeof buildFoodCourtJournalDemandOutlook>,
  goal?: { kgiTargetYen: number | null; kgiHorizon: 'day' | 'month' | null; kgiKind?: 'uplift' | 'store' | null },
  upliftWithSets?: ReturnType<typeof buildFoodCourtInitiativeUplift>,
) {
  const yen = (n: number | null | undefined) =>
    n == null || !Number.isFinite(n) ? '—' : `¥${Math.round(n).toLocaleString('ja-JP')}`
  const num = (n: number | null | undefined, unit = '') =>
    n == null || !Number.isFinite(n) ? '—' : `${Math.round(n * 10) / 10}${unit}`
  const col = pack.scenarios.map((scenario) => {
    const item = scenario.prices[0]
    const fromOutlook = outlook?.facts.scenarios.find((row) => row.label === scenario.scenarioLabel)
    const fromUplift = uplift?.facts.scenarios.find((row) => row.label === scenario.scenarioLabel)
    const fromUpliftWithSets = upliftWithSets?.facts.scenarios.find((row) => row.label === scenario.scenarioLabel)
    const capacityUnits = scenario.sellableCapacityUnits.value
    const units = clampOutlookUnitsToCapacity(fromOutlook?.daily_units, capacityUnits) ?? scenario.normalDayOutlook.targetUnits.value
    const priced = item?.price.value != null && units != null ? Math.round(Number(units) * item.price.value) : null
    const dailySales = priced ?? fromUplift?.initiative_daily_sales_yen ?? scenario.averageDailyRevenueYen.value
    const pricedWithSets = scenario.blendedPrice.value != null && units != null ? Math.round(Number(units) * scenario.blendedPrice.value) : null
    const dailySalesWithSets = pricedWithSets ?? fromUpliftWithSets?.initiative_daily_sales_yen ?? null
    const setUpsellPerDay = dailySalesWithSets != null && dailySales != null ? dailySalesWithSets - dailySales : null
    const outlookExceedsCapacity = fromOutlook?.daily_units != null && fromOutlook.daily_units > capacityUnits
    return { scenario, item, units, dailySales, dailySalesWithSets, setUpsellPerDay, fromUplift, fromUpliftWithSets, outlookExceedsCapacity, capacityUnits }
  })
  const labels = col.map((row) => row.scenario.scenarioLabel)
  const lines = [
    '【新しい施策のKPI見込み（コード計算）】',
    'この施策自体の販売実績はない。データ不足で分析を止めない。売価・原価は入力または仮定(シナリオ)。販売数の錨だけ類似商品の日次実績を使う。',
  ]
  if (pack.baseline.averageDailySalesYen != null) {
    lines.push(`今の店舗 1日あたり売上【実績】${yen(pack.baseline.averageDailySalesYen)}（${pack.baseline.periodLabel}）`)
  }
  if (outlook?.facts.product_names?.length) {
    lines.push(`類似/対象商品: ${outlook.facts.product_names.join('、')}。観測 1日 ${outlook.facts.daily_units}個・${yen(outlook.facts.daily_sales_yen)}を販売数の錨にする。`)
  }
  const horizonLabel = goal?.kgiHorizon === 'month' ? '月間' : goal?.kgiHorizon === 'day' ? '1日' : '1日'
  const storeDaily = pack.baseline.averageDailySalesYen
  const monthDays = pack.baseline.operatingDaysPerMonth
  if (goal?.kgiTargetYen != null) {
    const kind = resolveKgiKind({ kgiTargetYen: goal.kgiTargetYen, kgiKind: goal.kgiKind ?? null }, storeDaily)
    const standardRow = col.find((row) => row.scenario.scenarioLabel === '標準')
    const standardUplift = standardRow?.fromUplift
    const standardUpliftWithSets = standardRow?.fromUpliftWithSets
    if (kind === 'uplift') {
      const dailyUplift = goal.kgiHorizon === 'month' && monthDays ? Math.round(goal.kgiTargetYen / monthDays) : goal.kgiTargetYen
      const storeKgiDaily = storeDaily != null ? storeDaily + dailyUplift : null
      const storeKgiMonth = storeKgiDaily != null && monthDays ? Math.round(storeKgiDaily * monthDays) : null
      if (goal.kgiHorizon === 'month' && storeKgiMonth != null && storeDaily != null && monthDays) {
        lines.push(`KGI【仮定(入力)】店舗月間売上 ${yen(storeKgiMonth)}（現状【実績】月換算 ${yen(Math.round(storeDaily * monthDays))} ＋ 純増目標 ${yen(goal.kgiTargetYen)}）`)
      } else if (storeKgiDaily != null && storeDaily != null) {
        lines.push(`KGI【仮定(入力)】店舗1日売上 ${yen(storeKgiDaily)}（現状【実績】${yen(storeDaily)} ＋ 純増目標 ${yen(dailyUplift)}）`)
      } else {
        lines.push(`KGI【仮定(入力)】店舗売上の純増 ${yen(goal.kgiTargetYen)}（${horizonLabel}）`)
      }
      lines.push('施策の単品売上は店舗KGIではない。下表は単品のみとセット込み（ドリンク・ワインの上乗せを含む）の両方を併記する。セット込みはドリンク・ワイン同時購入率を仮定した見込みで実測ではない。置き換えがあるため施策売上≠純増。成否は上積み/日を純増目標と比べる。')
      const targetUplift = goal.kgiHorizon === 'month' ? goal.kgiTargetYen : dailyUplift
      const upliftYenSingle = goal.kgiHorizon === 'month' ? standardUplift?.monthly_uplift_yen : standardUplift?.daily_uplift_yen
      if (upliftYenSingle != null) {
        const gap = targetUplift - upliftYenSingle
        lines.push(`純増ギャップ（標準シナリオ・単品のみ） ${yen(gap)}（正なら不足、負なら超過）`)
      }
      const upliftYenWithSets = goal.kgiHorizon === 'month' ? standardUpliftWithSets?.monthly_uplift_yen : standardUpliftWithSets?.daily_uplift_yen
      if (upliftYenWithSets != null) {
        const gap = targetUplift - upliftYenWithSets
        lines.push(`純増ギャップ（標準シナリオ・セット込み） ${yen(gap)}（正なら不足、負なら超過。ドリンク・ワイン同時購入率は仮定であり実測ではない）`)
      }
    } else if (storeDaily != null && goal.kgiHorizon === 'month' && monthDays) {
      const monthActual = Math.round(storeDaily * monthDays)
      const gap = goal.kgiTargetYen - monthActual
      lines.push(`KGI【仮定(入力)】店舗月間売上 ${yen(goal.kgiTargetYen)}`)
      lines.push(`現状【実績】月換算 ${yen(monthActual)}（1日${yen(storeDaily)}×${monthDays}日）。ギャップ ${yen(gap)}（正なら不足、負なら超過）`)
    } else if (storeDaily != null) {
      const gap = goal.kgiTargetYen - storeDaily
      lines.push(`KGI【仮定(入力)】店舗${horizonLabel}売上 ${yen(goal.kgiTargetYen)}`)
      lines.push(`現状【実績】1日 ${yen(storeDaily)}。ギャップ ${yen(gap)}（正なら不足、負なら超過）`)
    } else {
      lines.push(`KGI【仮定(入力)】店舗売上 ${yen(goal.kgiTargetYen)}（${horizonLabel}）`)
      lines.push('店舗日次売上が無いためギャップは作らない。')
    }
  } else {
    lines.push('KGIは未設定。達成率・不足額は作らない。入力するなら店舗売上の純増（今の日次＋増やしたい額）を書く。施策の単品売上はKGIにしない。')
  }
  const cappedRows = col.filter((row) => row.outlookExceedsCapacity)
  if (cappedRows.length) {
    const detail = cappedRows.map((row) => {
      const observed = outlook?.facts.scenarios.find((s) => s.label === row.scenario.scenarioLabel)?.daily_units
      return `${row.scenario.scenarioLabel}(観測${num(observed)}個→上限${num(row.capacityUnits)}個)`
    }).join('、')
    lines.push(`類似/対象商品の観測個数（他商品の合算実績）が焼成上限×廃棄控除を上回ったため、販売数見込みはその上限に丸めた: ${detail}。`)
  }
  lines.push('')
  lines.push('【セット込み予想売上の考え方・注釈】')
  lines.push('予想売上/日には「単品のみ」と「セット込み」の2通りを併記する。単品のみは、来店客が全員クロワッサン単品しか買わなかった場合の下限の参考値。セット込みは、一部の客がドリンクセット・ワインセットを選ぶと仮定し、単品価格に上乗せ額を加重平均した参考値。計算式: 単品価格×単品比率 ＋ ドリンクセット価格×ドリンク比率 ＋ ワインセット価格×ワイン比率。')
  lines.push('セット選択比率・上乗せ額はすべて【仮定(シナリオ)】であり、実測のドリンク・ワイン同時購入率ではない。根拠となる前提は次の通り:')
  for (const row of col) {
    const s = row.scenario
    const drinkPrice = s.prices[1]?.price.value
    const winePrice = s.prices[2]?.price.value
    lines.push(
      `- ${s.scenarioLabel}: 単品比率${num(s.setMix.singleSharePct.value, '%')}／` +
      `ドリンクセット比率${num(s.setMix.drinkSetSharePct.value, '%')}（単品+${yen(s.setMix.drinkAddYen.value)}＝セット価格${yen(drinkPrice)}）／` +
      `ワインセット比率${num(s.setMix.wineSetSharePct.value, '%')}（単品+${yen(s.setMix.wineAddYen.value)}＝セット価格${yen(winePrice)}）` +
      `→ 加重平均売価${yen(s.blendedPrice.value)}`,
    )
  }
  lines.push('実際のセット選択率・同時購入率を計測できたら、この仮定比率を置き換える。単品のみの数値は、セットが一切売れなかった場合の保守的な下限として引き続き参照できる。')
  lines.push('')
  lines.push('シナリオ別KGI・KPI・採算の一覧')
  lines.push(KPI_TABLE_NOTE)
  lines.push(mdTable(
    ['項目', ...labels],
    [
      ['予想売価（単品）', ...col.map((row) => yen(row.item?.price.value))],
      ['予想原価（単品）', ...col.map((row) => yen(row.item?.cost.value))],
      ['予想販売数/日', ...col.map((row) => num(row.units, '個'))],
      ['予想売上/日（単品のみ）', ...col.map((row) => yen(row.dailySales))],
      ['予想売上/日（セット込み）', ...col.map((row) => yen(row.dailySalesWithSets))],
      ['セットによる上乗せ額/日', ...col.map((row) => yen(row.setUpsellPerDay))],
      ['今の売上への寄与（単品のみ）', ...col.map((row) => row.fromUplift?.store_contribution_pct == null ? '—' : `${row.fromUplift.store_contribution_pct}%`)],
      ['今の売上への寄与（セット込み）', ...col.map((row) => row.fromUpliftWithSets?.store_contribution_pct == null ? '—' : `${row.fromUpliftWithSets.store_contribution_pct}%`)],
      ['上積み/日（単品のみ）', ...col.map((row) => yen(row.fromUplift?.daily_uplift_yen))],
      ['上積み/日（セット込み）', ...col.map((row) => yen(row.fromUpliftWithSets?.daily_uplift_yen))],
      ['上積み/月（単品のみ）', ...col.map((row) => yen(row.fromUplift?.monthly_uplift_yen))],
      ['上積み/月（セット込み）', ...col.map((row) => yen(row.fromUpliftWithSets?.monthly_uplift_yen))],
      ['月間売上見込み', ...col.map((row) => yen(row.scenario.monthlyRevenueYen.value))],
      ['粗利率（セット込み加重）', ...col.map((row) => num(row.scenario.blendedGrossMarginPct.value, '%'))],
      ['1個あたり貢献利益（セット込み加重）', ...col.map((row) => yen(row.scenario.contributionPerSoldUnitYen.value))],
      ['損益分岐 個/日', ...col.map((row) => row.scenario.breakEvenUnitsPerDay ? num(row.scenario.breakEvenUnitsPerDay.value, '個') : '成立しない')],
      ['セット率', ...col.map((row) => num(row.scenario.kpiTargets.setRatePct.value, '%'))],
      ['テイクアウト比率', ...col.map((row) => num(row.scenario.kpiTargets.takeoutRatePct.value, '%'))],
      ['廃棄率上限', ...col.map((row) => num(row.scenario.kpiTargets.wasteRatePct.value, '%'))],
    ],
  ))
  lines.push('寄与率＝見込み売上÷今の店舗日次売上。上積み＝見込み×置き換えを見込んだ増分（保守0.3／標準0.55／強気0.85）。確定の純増・営業利益ではない。単品のみ／セット込みの前提は表の上の注釈を参照。')
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
    // 売価は入力欄・店舗前提・3シナリオ仮置きだけを使う。
    // ジャーナル類似商品の単価（客単価や別SKU）を新商品の店頭価格に流用しない。
    const pack = buildKpiScenarioPack({ assumptions, baseline: deriveKpiBaselineFromUnifiedSales(sales.unified_sales) })
    const dailyUnits = (label: string) => {
      const scenarioPack = pack.scenarios.find(s => s.scenarioLabel === label)
      const fromOutlook = outlook?.facts.scenarios.find(s => s.label === label)?.daily_units
      const clamped = clampOutlookUnitsToCapacity(fromOutlook, scenarioPack?.sellableCapacityUnits.value)
      if (clamped != null) return Math.round(clamped)
      return scenarioPack?.normalDayOutlook.targetUnits.value
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
    // 販売数（焼成上限で頭打ち済み）は両方の売上基準で共通。基準が違うのは単価だけ
    // （単品価格 vs ドリンク/ワインセットを加重したセット込み価格）。
    const scenarioUnits = new Map(pack.scenarios.map((s) => {
      const fromOutlook = outlook?.facts.scenarios.find((row) => row.label === s.scenarioLabel)
      const units = clampOutlookUnitsToCapacity(fromOutlook?.daily_units, s.sellableCapacityUnits.value) ?? s.normalDayOutlook.targetUnits.value
      return [s.scenarioLabel, units] as const
    }))
    const uplift = buildFoodCourtInitiativeUplift({
      storeDailySalesYen: pack.baseline.averageDailySalesYen,
      storePeriodLabel: pack.baseline.periodLabel,
      operatingDaysPerMonth: pack.baseline.operatingDaysPerMonth,
      basisLabel: '単品価格のみ（ドリンク・ワインのセット上乗せなし）',
      scenarios: pack.scenarios.map((s) => {
        const units = scenarioUnits.get(s.scenarioLabel) ?? null
        const price = s.prices[0]?.price.value
        return {
          label: s.scenarioLabel,
          daily_units: units,
          daily_sales_yen: units != null && price != null ? Math.round(Number(units) * price) : s.averageDailyRevenueYen.value,
        }
      }),
    })
    const upliftWithSets = buildFoodCourtInitiativeUplift({
      storeDailySalesYen: pack.baseline.averageDailySalesYen,
      storePeriodLabel: pack.baseline.periodLabel,
      operatingDaysPerMonth: pack.baseline.operatingDaysPerMonth,
      basisLabel: 'セット込み（ドリンクセット・ワインセットの上乗せを加重平均、選択比率は仮定(シナリオ)）',
      basisNote: 'セット選択比率・上乗せ額は実測のドリンク・ワイン同時購入率ではない。ユーザー向け付録テーブルの【セット込み予想売上の考え方】に前提の内訳を記載する。',
      scenarios: pack.scenarios.map((s) => {
        const units = scenarioUnits.get(s.scenarioLabel) ?? null
        const price = s.blendedPrice.value
        return {
          label: s.scenarioLabel,
          daily_units: units,
          daily_sales_yen: units != null && price != null ? Math.round(Number(units) * price) : null,
        }
      }),
    })
    const upliftBlock = uplift ? `\n\n${uplift.block}` : ''
    const upliftWithSetsBlock = upliftWithSets ? `\n\n${upliftWithSets.block}` : ''
    const userAppendix = formatKpiUserAppendix(pack, uplift, outlook, readKpiGoalFromAssumptions(input.assumptions), upliftWithSets)
    return {
      inputs: buildFoodCourtKpiInputs(assumptions, normalizeKpiAssumptions(input.assumptions).provided),
      block: formatKpiScenarioBlock(pack) + outlookBlock + hourlyBlock + upliftBlock + upliftWithSetsBlock,
      userAppendix,
      reference: { ...buildKpiScenarioReference(pack), baseline_period: pack.baseline.periodLabel, journal_detail_coverage: detail?.coverage ?? null, demand_outlook: outlook?.facts ?? null, hourly_targets: hourlyTargets, initiative_uplift: uplift?.facts ?? null, initiative_uplift_with_sets: upliftWithSets?.facts ?? null },
    }
  } finally {
    clearTimeout(timer)
  }
}

export type FoodCourtKpiContext = NonNullable<Awaited<ReturnType<typeof prepareFoodCourtKpiScenario>>>
