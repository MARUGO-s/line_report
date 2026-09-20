import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildKpiScenarioPack,
  buildKpiScenarioReference,
  deriveKpiBaselineFromUnifiedSales,
  emptyKpiBaseline,
  formatKpiScenarioBlock,
  KPI_REQUIRED_ASSUMPTION_KEYS,
  KPI_SCENARIO_NAMES,
  mergeBasis,
  missingRequiredKpiAssumptions,
  normalizeKpiAssumptions,
} from '../supabase/functions/_shared/kpi_scenario.ts'

/** 受け入れ条件の検証用。原価・売価・焼成数を入れた標準的な前提。 */
const filled = {
  unitPriceYen: 420,
  setDrinkPriceYen: 720,
  setWinePriceYen: 1120,
  unitCostYen: 126,
  setDrinkAddCostYen: 90,
  setWineAddCostYen: 210,
  bakeBatchUnits: 20,
  bakeBatchesPerDay: 3,
  prepStaffCount: 1,
  prepHoursPerDay: 3,
  staffHourlyCostYen: 1300,
  wasteRateTolerancePct: 8,
}

const standardOf = (pack: ReturnType<typeof buildKpiScenarioPack>) => {
  const s = pack.scenarios.find((row) => row.scenario === 'standard')
  assert.ok(s, 'standard scenario must exist')
  return s
}

test('入力値は allowlist と clamp を通り、未入力は null のまま残る', () => {
  const normalized = normalizeKpiAssumptions({
    unitPriceYen: '420',
    unitCostYen: 126,
    bakeBatchUnits: 1e9,
    wasteRateTolerancePct: -5,
    bogusField: 999,
  })
  assert.equal(normalized.values.unitPriceYen, 420)
  assert.equal(normalized.values.unitCostYen, 126)
  assert.equal(normalized.values.bakeBatchUnits, 2000, '上限でクランプする')
  assert.equal(normalized.values.wasteRateTolerancePct, 0, '下限でクランプする')
  assert.equal(normalized.values.prepStaffCount, null)
  assert.ok(!Object.prototype.hasOwnProperty.call(normalized.values, 'bogusField'))
  assert.ok(normalized.missing.includes('prepStaffCount'))
  assert.ok(normalized.provided.includes('unitPriceYen'))
})

test('必須の前提条件が欠けていれば確認質問用に列挙される', () => {
  assert.deepEqual(missingRequiredKpiAssumptions({}), KPI_REQUIRED_ASSUMPTION_KEYS)
  assert.deepEqual(missingRequiredKpiAssumptions(filled), [])
  assert.deepEqual(
    missingRequiredKpiAssumptions({ ...filled, unitCostYen: null }),
    ['unitCostYen'],
  )
})

test('実績と仮定を混ぜた合成値は、最も弱いラベルへ落ちる', () => {
  assert.equal(mergeBasis('actual', 'actual'), 'actual')
  assert.equal(mergeBasis('actual', 'input'), 'input')
  assert.equal(mergeBasis('actual', 'input', 'scenario'), 'scenario')
  assert.equal(mergeBasis('input', 'scenario'), 'scenario')
})

test('A-1 粗利率は 売価・原価 から決まり、入力値は「仮定(入力)」ラベルになる', () => {
  const s = standardOf(buildKpiScenarioPack({ assumptions: filled }))
  const single = s.prices.find((p) => p.key === 'single')!
  assert.equal(single.price.value, 420)
  assert.equal(single.cost.value, 126)
  assert.equal(single.grossProfit.value, 294)
  assert.equal(single.grossMarginPct.value, 70) // 294 / 420
  assert.equal(single.price.basis, 'input')
  assert.equal(single.grossMarginPct.basis, 'input')

  const drink = s.prices.find((p) => p.key === 'drink_set')!
  assert.equal(drink.cost.value, 216) // 126 + 90
  assert.equal(drink.grossProfit.value, 504) // 720 - 216
  assert.equal(drink.grossMarginPct.value, 70)

  const wine = s.prices.find((p) => p.key === 'wine_set')!
  assert.equal(wine.cost.value, 336) // 126 + 210
  assert.equal(wine.grossMarginPct.value, 70) // 784 / 1120
})

test('未入力の価格はシナリオ既定で仮置きされ、「仮定(シナリオ)」ラベルになる', () => {
  const pack = buildKpiScenarioPack({ assumptions: {} })
  assert.equal(pack.scenarios.length, 3)
  for (const s of pack.scenarios) {
    for (const price of s.prices) {
      assert.equal(price.price.basis, 'scenario')
      assert.equal(price.grossMarginPct.basis, 'scenario')
      assert.ok(price.grossMarginPct.value > 0)
    }
  }
  const [conservative, standard, aggressive] = pack.scenarios
  assert.ok(conservative.prices[0].price.value < standard.prices[0].price.value)
  assert.ok(standard.prices[0].price.value < aggressive.prices[0].price.value)
})

test('A-2 損益分岐個数は 固定費 ÷ 貢献利益 の切り上げで、廃棄率を織り込む', () => {
  const s = standardOf(buildKpiScenarioPack({ assumptions: filled }))
  // 固定費 = 1人 × 3時間 × ¥1,300
  assert.equal(s.dailyFixedCostYen.value, 3900)
  assert.equal(s.dailyCapacityUnits.value, 60) // 20個 × 3回
  const expected = Math.ceil(
    s.dailyFixedCostYen.value / s.contributionPerSoldUnitYen.value,
  )
  assert.equal(s.breakEvenUnitsPerDay.value, expected)
  assert.ok(
    s.contributionPerSoldUnitYen.value < s.blendedPrice.value - s.blendedCost.value,
    '想定廃棄率のぶん貢献利益が目減りする',
  )
  assert.equal(s.breakEvenAchievable, true)
})

test('原価・売価・焼成数を変えると損益分岐個数と目標個数が動く（受け入れ条件2）', () => {
  const base = standardOf(buildKpiScenarioPack({ assumptions: filled }))
  const pricier = standardOf(buildKpiScenarioPack({
    assumptions: { ...filled, unitCostYen: 300 },
  }))
  assert.ok(
    pricier.breakEvenUnitsPerDay.value > base.breakEvenUnitsPerDay.value,
    '原価を上げると損益分岐個数は増える',
  )

  const cheaper = standardOf(buildKpiScenarioPack({
    assumptions: { ...filled, unitPriceYen: 600, setDrinkPriceYen: 900, setWinePriceYen: 1300 },
  }))
  assert.ok(
    cheaper.breakEvenUnitsPerDay.value < base.breakEvenUnitsPerDay.value,
    '売価を上げると損益分岐個数は減る',
  )

  const smallOven = standardOf(buildKpiScenarioPack({
    assumptions: { ...filled, bakeBatchUnits: 4, bakeBatchesPerDay: 1 },
  }))
  assert.equal(smallOven.dailyCapacityUnits.value, 4)
  const baseTotal = base.segments.reduce((n, seg) => n + seg.targetUnits.value, 0)
  const smallTotal = smallOven.segments.reduce((n, seg) => n + seg.targetUnits.value, 0)
  assert.ok(smallTotal < baseTotal, '焼成上限を絞ると目標個数が減る')
  assert.ok(
    smallOven.segments.some((seg) => seg.capacityLimited),
    '焼成上限で頭打ちになった区分に印が付く',
  )
})

test('A-3 目標販売個数は5区分そろい、イベント日は時間帯別に分かれる', () => {
  const s = standardOf(buildKpiScenarioPack({ assumptions: filled }))
  assert.deepEqual(
    s.segments.map((seg) => seg.key),
    ['lunch', 'baseball_day', 'major_live', 'night_game', 'normal_dinner'],
  )
  const live = s.segments.find((seg) => seg.key === 'major_live')!
  assert.deepEqual(
    live.slots.map((slot) => slot.key),
    ['before_event', 'after_event', 'steady'],
  )
  const normal = s.segments.find((seg) => seg.key === 'normal_dinner')!
  assert.deepEqual(normal.slots.map((slot) => slot.key), ['steady'])
  assert.ok(
    live.expectedGuests.value > normal.expectedGuests.value,
    '大型ライブ日の想定客数は通常ディナーより多い',
  )
})

test('A-4 売上期待値は3シナリオで単調に増え、月間は1日平均 × 営業日数と整合する', () => {
  const pack = buildKpiScenarioPack({ assumptions: {} })
  const monthly = pack.scenarios.map((s) => s.monthlyRevenueYen.value)
  assert.ok(monthly[0] < monthly[1], '保守 < 標準')
  assert.ok(monthly[1] < monthly[2], '標準 < 強気')

  for (const s of pack.scenarios) {
    const lunch = s.segments.find((seg) => seg.key === 'lunch')!
    const dinnerDays = s.segments
      .filter((seg) => seg.key !== 'lunch')
      .reduce((n, seg) => n + seg.daysPerMonth.value, 0)
    assert.ok(
      Math.abs(dinnerDays - lunch.daysPerMonth.value) < 0.5,
      'ディナー区分の日数合計は営業日数に一致する',
    )
    const recomputed = s.segments.reduce(
      (n, seg) => n + seg.dailyRevenue.value * seg.daysPerMonth.value,
      0,
    )
    assert.ok(Math.abs(recomputed - s.monthlyRevenueYen.value) <= 1)
    assert.equal(
      s.averageDailyRevenueYen.value,
      Math.round(s.monthlyRevenueYen.value / lunch.daysPerMonth.value),
    )
  }
})

test('A-5 / A-6 / A-7 が数値で出る', () => {
  const s = standardOf(buildKpiScenarioPack({ assumptions: filled }))
  assert.ok(s.kpiTargets.setRatePct.value > 0)
  assert.ok(s.kpiTargets.checkUpliftYen.value > 0)
  assert.ok(s.kpiTargets.takeoutRatePct.value > 0)
  assert.equal(s.kpiTargets.wasteRatePct.value <= 8, true, '廃棄許容範囲を超えない')

  assert.equal(
    s.exitLines.shrinkUnitsPerDay.value,
    Math.floor(s.breakEvenUnitsPerDay.value * 0.8),
  )
  assert.equal(
    s.exitLines.exitUnitsPerDay.value,
    Math.floor(s.breakEvenUnitsPerDay.value * 0.5),
  )
  assert.equal(s.exitLines.wasteRateAlertPct.value, 12) // 8% × 1.5
  assert.ok(s.exitLines.shrinkUnitsPerDay.value > s.exitLines.exitUnitsPerDay.value)

  assert.ok(s.normalDayOutlook.targetUnits.value > 0)
  assert.ok(s.normalDayOutlook.dailyRevenue.value > 0)
  assert.equal(typeof s.normalDayOutlook.coversBreakEven, 'boolean')
})

test('統一売上から実績ベースラインを取り、実績ラベルを付ける', () => {
  const baseline = deriveKpiBaselineFromUnifiedSales({
    periods: [{
      label: '2026年8月',
      ranges: [{
        totals: { gross_sales_yen: 3000000, guest_count: 1500 },
        daily: [
          ['2026-08-01', 120000],
          ['2026-08-02', 130000],
          ['2026-08-03', 0],
          ['not-a-date', 100000],
        ],
      }],
    }],
  })
  assert.equal(baseline.guestsPerOperatingDay, 750) // 1500名 ÷ 売上のある2日
  assert.equal(baseline.operatingDaysPerMonth, 2)
  assert.equal(baseline.averageSpendYen, 2000)
  assert.match(baseline.sourceNote, /統一売上の日別実績 2日/)

  const s = standardOf(buildKpiScenarioPack({ assumptions: filled, baseline }))
  const lunch = s.segments.find((seg) => seg.key === 'lunch')!
  assert.equal(lunch.expectedGuests.basis, 'scenario', '実績客数 × 仮定比率は仮定側へ落ちる')
  assert.equal(lunch.daysPerMonth.basis, 'actual', '営業日数はそのまま実績')
})

test('統一売上が空なら実績を 0 と決めつけず null で返す', () => {
  const baseline = deriveKpiBaselineFromUnifiedSales({ periods: [] })
  assert.equal(baseline.guestsPerOperatingDay, null)
  assert.equal(baseline.operatingDaysPerMonth, null)
  assert.equal(baseline.averageSpendYen, null)
  assert.equal(emptyKpiBaseline().guestsPerOperatingDay, null)

  const pack = buildKpiScenarioPack({ assumptions: filled, baseline })
  const lunch = standardOf(pack).segments.find((seg) => seg.key === 'lunch')!
  assert.equal(lunch.daysPerMonth.basis, 'scenario')
  assert.ok(
    pack.dataGaps.some((gap) => gap.includes('日別来店客数')),
    '不足データが出力末尾用に列挙される',
  )
})

test('プロンプトブロックは A-1〜A-7 とラベルと不足データを必ず含む', () => {
  const block = formatKpiScenarioBlock(
    buildKpiScenarioPack({ assumptions: filled, productName: '焼き上げクロワッサン' }),
  )
  for (const heading of ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7']) {
    assert.ok(block.includes(heading), `${heading} が出力に含まれること`)
  }
  assert.ok(block.includes('焼き上げクロワッサン'))
  assert.ok(block.includes('【仮定(入力)】'))
  assert.ok(block.includes('【仮定(シナリオ)】'))
  assert.ok(block.includes('【この試算の精度を上げるために必要なデータ】'))
  assert.ok(block.includes('保守シナリオ'))
  assert.ok(block.includes('標準シナリオ'))
  assert.ok(block.includes('強気シナリオ'))
  assert.ok(
    block.includes('ここに無い金額・個数・比率を新たに作ってはいけません'),
    'AIが数値を追加で作らないための規約が残る',
  )
})

test('全シナリオで A-1〜A-7 の数値が欠けない', () => {
  const pack = buildKpiScenarioPack({ assumptions: {} })
  assert.deepEqual(pack.scenarios.map((s) => s.scenario), KPI_SCENARIO_NAMES)
  for (const s of pack.scenarios) {
    assert.equal(s.prices.length, 3)
    assert.ok(Number.isFinite(s.breakEvenUnitsPerDay.value))
    assert.equal(s.segments.length, 5)
    assert.ok(Number.isFinite(s.monthlyRevenueYen.value))
    assert.ok(Number.isFinite(s.kpiTargets.setRatePct.value))
    assert.ok(Number.isFinite(s.exitLines.exitUnitsPerDay.value))
    assert.ok(Number.isFinite(s.normalDayOutlook.targetUnits.value))
  }
})

test('KGI/KPI/KFI mapping reuses computed scenario values and never invents action counts', () => {
  for (const assumptions of [{}, filled, { ...filled, unitCostYen: 100000, setDrinkAddCostYen: 100000, setWineAddCostYen: 100000 }]) {
    const pack = buildKpiScenarioPack({ assumptions })
    const block = formatKpiScenarioBlock(pack)
    for (const scenario of pack.scenarios) {
      const section = block.split(`■ ${scenario.scenarioLabel}シナリオ`)[1].split('■ ')[0]
      assert.match(section, /KGI候補: 商品の月間売上見込み/)
      assert.ok(section.includes(`¥${scenario.monthlyRevenueYen.value.toLocaleString('ja-JP')}`))
      assert.match(section, /KFI候補（現場行動）.*実施件数・提案率は未計測、数値目標は未設定/)
      assert.match(section, /採算確認（KFIとは別）/)
      assert.match(section, /店頭案内・セット提案（KFI）→販売数・セット率（KPI）→商品売上（KGI候補）/)
      assert.match(section, /店舗の純増売上・最終利益ではない/)
      assert.ok(section.includes(scenario.breakEvenAchievable ? '実現・利益を保証しない' : '価格・原価・生産条件を見直す'))
      assert.ok(section.includes(`通常日の販売目標は損益分岐${scenario.normalDayOutlook.coversBreakEven ? 'に届く' : 'に届かない'}`))
    }
    assert.match(buildKpiScenarioReference(pack).goal_metrics.kfi, /現場行動（未計測）/)
  }
})

test('sales_data には軽量な参照だけを載せ、数値の正本はブロック側に残す', () => {
  const pack = buildKpiScenarioPack({ assumptions: filled, productName: '焼き上げクロワッサン' })
  const reference = buildKpiScenarioReference(pack)
  const json = JSON.stringify(reference)

  assert.ok(
    json.length < JSON.stringify(pack).length / 10,
    'パック全体をそのまま sales_data へ重複させない',
  )
  assert.ok(json.length < 2000, 'sales_data の長さ上限を圧迫しない')
  assert.equal(reference.product_name, '焼き上げクロワッサン')
  assert.deepEqual([...reference.scenarios], ['保守', '標準', '強気'])
  assert.ok(reference.provided_assumptions.includes('原価（1個あたり）'))
  assert.equal(reference.scenario_filled_assumptions.length, 0, '全項目入力済みなら仮置きなし')
  assert.match(reference.note, /数値の正本は system 側の【数値提案（KPI試算）】ブロック/)

  // 入力と仮置きの内訳が参照からも読める（出力末尾の「必要なデータ」と対応する）
  const partial = buildKpiScenarioReference(
    buildKpiScenarioPack({ assumptions: { unitPriceYen: 420, unitCostYen: 126 } }),
  )
  assert.deepEqual(
    [...partial.provided_assumptions],
    ['想定売価（単品）', '原価（1個あたり）'],
  )
  assert.ok(partial.scenario_filled_assumptions.includes('1日の仕込み・焼成時間'))
  assert.ok(partial.scenario_filled_assumptions.includes('設備で1回に焼ける個数'))

  // 参照だけからは金額を再現できない＝AIが参照から再計算できない
  assert.ok(!json.includes('420'), '価格などの生の数値は参照へ含めない')
})
