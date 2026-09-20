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
  KPI_SCENARIO_DEFAULTS,
  isKpiScenarioRequest,
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

test('入力値は allowlist と範囲検証を通り、範囲外・未入力は null のまま残る', () => {
  const normalized = normalizeKpiAssumptions({
    unitPriceYen: '420',
    unitCostYen: 126,
    bakeBatchUnits: 1e9,
    wasteRateTolerancePct: -5,
    bogusField: 999,
  })
  assert.equal(normalized.values.unitPriceYen, 420)
  assert.equal(normalized.values.unitCostYen, 126)
  assert.equal(normalized.values.bakeBatchUnits, null, '範囲外を別の入力値に変換しない')
  assert.equal(normalized.values.wasteRateTolerancePct, null, '負の率をゼロへ変換しない')
  assert.equal(normalized.values.prepStaffCount, null)
  assert.ok(!Object.prototype.hasOwnProperty.call(normalized.values, 'bogusField'))
  assert.ok(normalized.missing.includes('prepStaffCount'))
  assert.ok(normalized.provided.includes('unitPriceYen'))
})

test('通常の改善提案・KGI/KPI/KFIの関係説明は数値試算を許可しない', () => {
  for (const query of ['売上を伸ばすための提案を3つ', 'KGI・KPI・KFIを含む改善提案', '売上アップを狙うには', 'KPI目標の達成状況を確認して']) {
    assert.equal(isKpiScenarioRequest(query), false, query)
  }
  for (const query of ['新商品のKPI目標を設定して', '売上を3シナリオで試算してください', 'KPIを具体的な数字で提案して']) {
    assert.equal(isKpiScenarioRequest(query), true, query)
  }
})

test('空白・配列・不正な入力値を実際に入力された数値へ変換しない', () => {
  for (const value of ['   ', [], [420], {}, true, -1, Infinity, 100001]) {
    assert.equal(normalizeKpiAssumptions({ unitPriceYen: value }).values.unitPriceYen, null)
  }
})

test('実績は重複しない同一日・同一母集団から導き、部分月を月間営業日数にしない', () => {
  const range = {
    totals: { gross_sales_yen: 9000000, guest_count: 5000 },
    daily: [['2026-08-01', 120000, 60], ['2026-08-02', 180000, 90], ['2026-08-03', 100000, null]],
    monthly_fallbacks: [{ month: '2026-07', gross_sales_yen: 8700000, guest_count: 4850 }],
  }
  const baseline = deriveKpiBaselineFromUnifiedSales({ periods: [{ label: '部分月', ranges: [range, range] }] })
  assert.equal(baseline.guestsPerOperatingDay, 75)
  assert.equal(baseline.averageSpendYen, 2000)
  assert.equal(baseline.operatingDaysPerMonth, null)
})

test('不正日付と矛盾する同日データをベースラインへ含めない', () => {
  const baseline = deriveKpiBaselineFromUnifiedSales({ periods: [{ ranges: [
    { daily: [['2026-08-01', 120000, 60], ['2026-02-30', 1000000, 1000]] },
    { daily: [['2026-08-01', 240000, 120], ['2026-08-02', 180000, 90]] },
  ] }] })
  assert.equal(baseline.guestsPerOperatingDay, 90)
  assert.equal(baseline.averageSpendYen, 2000)
  assert.match(baseline.sourceNote, /競合.*1日/)
})

test('個数・時間帯・売上・月日数は表示値で再現でき、廃棄後能力を超えない', () => {
  for (let capacity = 1; capacity <= 100; capacity++) {
    const pack = buildKpiScenarioPack({ assumptions: { ...filled, bakeBatchUnits: capacity, bakeBatchesPerDay: 1 }, baseline: { ...emptyKpiBaseline(), guestsPerOperatingDay: 10000, operatingDaysPerMonth: 17.3 } })
    for (const s of pack.scenarios) {
      const sellable = Math.floor(capacity * (1 - KPI_SCENARIO_DEFAULTS[s.scenario].expectedWasteRate))
      const lunch = s.segments[0]
      for (const seg of s.segments) {
        assert.equal(seg.slots.reduce((n, slot) => n + slot.targetUnits.value, 0), seg.targetUnits.value)
        assert.equal(seg.dailyRevenue.value, Math.round(seg.targetUnits.value * s.blendedPrice.value))
        if (seg.key !== 'lunch') assert.ok(lunch.targetUnits.value + seg.targetUnits.value <= sellable)
      }
      assert.equal(Math.round(s.segments.slice(1).reduce((n, seg) => n + seg.daysPerMonth.value, 0) * 10), 173)
      assert.equal(s.breakEvenAchievable, s.breakEvenUnitsPerDay !== null && s.breakEvenUnitsPerDay.value <= sellable)
    }
  }
})

test('貢献利益が非正なら損益分岐・縮小個数は0ではなく成立しないと表示する', () => {
  const pack = buildKpiScenarioPack({ assumptions: { ...filled, unitCostYen: 100000 } })
  for (const s of pack.scenarios) {
    assert.equal(s.breakEvenUnitsPerDay, null)
    assert.equal(s.exitLines.shrinkUnitsPerDay, null)
    assert.equal(s.exitLines.exitUnitsPerDay, null)
    assert.equal(s.breakEvenAchievable, false)
    assert.equal(s.normalDayOutlook.coversBreakEven, false)
  }
  const block = formatKpiScenarioBlock(pack)
  assert.match(block, /損益分岐.*成立しない/)
  assert.doesNotMatch(block, /損益分岐個数:.*0個\/日/)
  assert.match(block, /導入前に価格・原価を見直す/)
})

test('セット値引きから負の追加原価を作らず、廃棄警戒値はシナリオとして表示する', () => {
  for (const s of buildKpiScenarioPack({ assumptions: { ...filled, setDrinkPriceYen: 300, setWinePriceYen: 200, setDrinkAddCostYen: null, setWineAddCostYen: null, wasteRateTolerancePct: 90 } }).scenarios) {
    assert.ok(s.resolvedAssumptions.setDrinkAddCostYen.value > 0)
    assert.ok(s.resolvedAssumptions.setWineAddCostYen.value > 0)
    assert.equal(s.exitLines.wasteRateAlertPct.basis, 'scenario')
    assert.ok(s.exitLines.wasteRateAlertPct.value <= 100)
  }
})

test('商品購入額を純増の客単価上昇と呼ばず、採算試算の未算入費用と税区分を明記する', () => {
  const block = formatKpiScenarioBlock(buildKpiScenarioPack({ assumptions: filled }))
  assert.doesNotMatch(block, /客単価上昇額/)
  assert.match(block, /商品購入額/)
  assert.match(block, /税区分/)
  assert.match(block, /光熱費/)
  assert.match(block, /既存商品の置き換え/)
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
  assert.ok(s.kpiTargets.productSpendPerPurchasingCheckYen.value > 0)
  assert.ok(s.kpiTargets.takeoutRatePct.value > 0)
  assert.equal(s.kpiTargets.wasteRatePct.value <= 8, true, '廃棄許容範囲を超えない')

  assert.equal(
    s.exitLines.shrinkUnitsPerDay.value,
    Math.ceil(s.breakEvenUnitsPerDay.value * 0.8),
  )
  assert.equal(
    s.exitLines.exitUnitsPerDay.value,
    Math.ceil(s.breakEvenUnitsPerDay.value * 0.5),
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
          ['2026-08-01', 120000, 60],
          ['2026-08-02', 130000, 65],
          ['2026-08-03', 0, 0],
          ['not-a-date', 100000],
        ],
      }],
    }],
  })
  assert.equal(baseline.guestsPerOperatingDay, 62.5)
  assert.equal(baseline.operatingDaysPerMonth, null)
  assert.equal(baseline.averageSpendYen, 2000)
  assert.match(baseline.sourceNote, /統一売上の日別実績 2日/)

  const s = standardOf(buildKpiScenarioPack({ assumptions: filled, baseline }))
  const lunch = s.segments.find((seg) => seg.key === 'lunch')!
  assert.equal(lunch.expectedGuests.basis, 'scenario', '実績客数 × 仮定比率は仮定側へ落ちる')
  assert.equal(lunch.daysPerMonth.basis, 'scenario', '部分月から月間営業日数は導かない')
})

test('全暦日を観測した月だけ売上発生日数を営業日数の代替として明示する', () => {
  const daily = Array.from({ length: 31 }, (_, i) => [`2026-08-${String(i + 1).padStart(2, '0')}`, i < 20 ? 120000 : 0, i < 20 ? 60 : 0])
  const baseline = deriveKpiBaselineFromUnifiedSales({ periods: [{ ranges: [{ daily }] }] })
  assert.equal(baseline.operatingDaysPerMonth, 20)
  assert.equal(baseline.guestsPerOperatingDay, 60)
  const s = standardOf(buildKpiScenarioPack({ assumptions: filled, baseline }))
  assert.equal(s.segments[0].daysPerMonth.basis, 'actual')
  assert.match(s.segments[0].daysPerMonth.source, /売上発生日数.*代替/)
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
