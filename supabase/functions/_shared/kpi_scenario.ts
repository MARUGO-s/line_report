/**
 * 数値提案（KPI試算）の決定論的計算。
 *
 * 目的: 単価・粗利率・損益分岐個数・目標販売個数・売上期待値・KPI目標・撤退ラインを
 * 「LLMに計算させず、コード側で確定させてからプロンプトへ渡す」ための唯一の計算層。
 *
 * ラベル規約（要件C）: すべての数値は basis を持つ。
 *   actual   = 実績（サーバー再集計の統一売上に由来）
 *   input    = 仮定（利用者が入力した前提条件）
 *   scenario = 仮定（未入力のためシナリオ既定値で仮置き）
 * 合成値の basis は、入力のうち最も弱いもの（scenario > input > actual）を採る。
 *
 * この層は確定実績を作らない。actual は呼び出し側が統一売上から渡した値だけに付く。
 */

export type KpiBasis = "actual" | "input" | "scenario";
export type KpiScenarioName = "conservative" | "standard" | "aggressive";

export type KpiNumber = {
  value: number;
  unit: string;
  basis: KpiBasis;
  source: string;
};

export const KPI_SCENARIO_NAMES: KpiScenarioName[] = [
  "conservative",
  "standard",
  "aggressive",
];

export const KPI_SCENARIO_LABELS: Record<KpiScenarioName, string> = {
  conservative: "保守",
  standard: "標準",
  aggressive: "強気",
};

export const KPI_BASIS_LABELS: Record<KpiBasis, string> = {
  actual: "実績",
  input: "仮定(入力)",
  scenario: "仮定(シナリオ)",
};

/** 営業区分。ランチは毎営業日、それ以外は当日のディナー帯の性格を表す。 */
export type KpiSegmentKey =
  | "lunch"
  | "baseball_day"
  | "major_live"
  | "night_game"
  | "normal_dinner";

export const KPI_SEGMENT_KEYS: KpiSegmentKey[] = [
  "lunch",
  "baseball_day",
  "major_live",
  "night_game",
  "normal_dinner",
];

export const KPI_SEGMENT_LABELS: Record<KpiSegmentKey, string> = {
  lunch: "ランチ",
  baseball_day: "野球デーゲーム",
  major_live: "大型ライブ",
  night_game: "ナイター",
  normal_dinner: "通常ディナー（イベントなし）",
};

export type KpiSlotKey = "before_event" | "after_event" | "steady";

export const KPI_SLOT_LABELS: Record<KpiSlotKey, string> = {
  before_event: "イベント開始前",
  after_event: "終演後",
  steady: "通常時間帯",
};

/** 利用者が入力できる前提条件（要件B）。未入力は null のまま残す。 */
export type KpiAssumptionValues = {
  unitPriceYen: number | null;
  setDrinkPriceYen: number | null;
  setWinePriceYen: number | null;
  unitCostYen: number | null;
  setDrinkAddCostYen: number | null;
  setWineAddCostYen: number | null;
  bakeBatchUnits: number | null;
  bakeBatchesPerDay: number | null;
  prepStaffCount: number | null;
  prepHoursPerDay: number | null;
  staffHourlyCostYen: number | null;
  wasteRateTolerancePct: number | null;
};

export type NormalizedKpiAssumptions = {
  values: KpiAssumptionValues;
  provided: (keyof KpiAssumptionValues)[];
  missing: (keyof KpiAssumptionValues)[];
};

type FieldRule = { min: number; max: number; integer: boolean };

const ASSUMPTION_RULES: Record<keyof KpiAssumptionValues, FieldRule> = {
  unitPriceYen: { min: 1, max: 100000, integer: true },
  setDrinkPriceYen: { min: 1, max: 100000, integer: true },
  setWinePriceYen: { min: 1, max: 100000, integer: true },
  unitCostYen: { min: 0, max: 100000, integer: true },
  setDrinkAddCostYen: { min: 0, max: 100000, integer: true },
  setWineAddCostYen: { min: 0, max: 100000, integer: true },
  bakeBatchUnits: { min: 1, max: 2000, integer: true },
  bakeBatchesPerDay: { min: 1, max: 48, integer: true },
  prepStaffCount: { min: 0.5, max: 50, integer: false },
  prepHoursPerDay: { min: 0.5, max: 24, integer: false },
  staffHourlyCostYen: { min: 1, max: 100000, integer: true },
  wasteRateTolerancePct: { min: 0, max: 100, integer: false },
};

export const KPI_ASSUMPTION_KEYS = Object.keys(
  ASSUMPTION_RULES,
) as (keyof KpiAssumptionValues)[];

export const KPI_ASSUMPTION_LABELS: Record<keyof KpiAssumptionValues, string> = {
  unitPriceYen: "想定売価（単品）",
  setDrinkPriceYen: "想定売価（ドリンクセット）",
  setWinePriceYen: "想定売価（ワインセット）",
  unitCostYen: "原価（1個あたり）",
  setDrinkAddCostYen: "ドリンクセットの追加原価",
  setWineAddCostYen: "ワインセットの追加原価",
  bakeBatchUnits: "設備で1回に焼ける個数",
  bakeBatchesPerDay: "1日の焼成回数の上限",
  prepStaffCount: "仕込み・焼成に割ける人員",
  prepHoursPerDay: "1日の仕込み・焼成時間",
  staffHourlyCostYen: "人件費（時給）",
  wasteRateTolerancePct: "廃棄の許容範囲（％）",
};

/** 受け入れ条件で必ず埋まっている必要がある項目。ここが欠けたら確認質問を出す。 */
export const KPI_REQUIRED_ASSUMPTION_KEYS: (keyof KpiAssumptionValues)[] = [
  "unitPriceYen",
  "unitCostYen",
  "bakeBatchUnits",
  "bakeBatchesPerDay",
  "prepStaffCount",
  "wasteRateTolerancePct",
];

const isRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

function clampField(raw: unknown, rule: FieldRule): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  const bounded = Math.max(rule.min, Math.min(rule.max, n));
  return rule.integer ? Math.round(bounded) : Math.round(bounded * 100) / 100;
}

/** ブラウザ・DB・チャットのどこから来ても同じ allowlist / clamp を通す。 */
export function normalizeKpiAssumptions(raw: unknown): NormalizedKpiAssumptions {
  const src = isRecord(raw);
  const values = {} as KpiAssumptionValues;
  const provided: (keyof KpiAssumptionValues)[] = [];
  const missing: (keyof KpiAssumptionValues)[] = [];
  for (const key of KPI_ASSUMPTION_KEYS) {
    const value = clampField(src[key], ASSUMPTION_RULES[key]);
    values[key] = value;
    if (value === null) missing.push(key);
    else provided.push(key);
  }
  return { values, provided, missing };
}

export function missingRequiredKpiAssumptions(
  raw: unknown,
): (keyof KpiAssumptionValues)[] {
  const { values } = normalizeKpiAssumptions(raw);
  return KPI_REQUIRED_ASSUMPTION_KEYS.filter((key) => values[key] === null);
}

/**
 * 未入力項目の仮置き値（要件B）。
 * 実績ではなく、東京ドームシティのフードホールで焼き上げ商品を出す場合の作業仮説。
 * 入力があれば必ず入力値が優先され、ここは使われない。
 */
type ScenarioDefaults = {
  unitPriceYen: number;
  setDrinkAddPriceYen: number;
  setWineAddPriceYen: number;
  costRate: number;
  setDrinkAddCostRate: number;
  setWineAddCostRate: number;
  bakeBatchUnits: number;
  bakeBatchesPerDay: number;
  prepStaffCount: number;
  prepHoursPerDay: number;
  staffHourlyCostYen: number;
  wasteRateTolerancePct: number;
  expectedWasteRate: number;
  purchaseRate: number;
  setRate: number;
  wineSetShareOfSets: number;
  takeoutRate: number;
  unitsPerPurchasingCheck: number;
  lunchGuestShare: number;
  guestsPerOperatingDay: number;
  operatingDaysPerMonth: number;
  segmentDaysPerMonth: Record<Exclude<KpiSegmentKey, "lunch">, number>;
  segmentGuestIndex: Record<Exclude<KpiSegmentKey, "lunch">, number>;
};

export const KPI_SCENARIO_DEFAULTS: Record<KpiScenarioName, ScenarioDefaults> = {
  conservative: {
    unitPriceYen: 380,
    setDrinkAddPriceYen: 300,
    setWineAddPriceYen: 600,
    costRate: 0.35,
    setDrinkAddCostRate: 0.30,
    setWineAddCostRate: 0.32,
    bakeBatchUnits: 12,
    bakeBatchesPerDay: 2,
    prepStaffCount: 1,
    prepHoursPerDay: 2,
    staffHourlyCostYen: 1200,
    wasteRateTolerancePct: 5,
    expectedWasteRate: 0.10,
    purchaseRate: 0.08,
    setRate: 0.20,
    wineSetShareOfSets: 0.30,
    takeoutRate: 0.25,
    unitsPerPurchasingCheck: 1.2,
    lunchGuestShare: 0.35,
    guestsPerOperatingDay: 80,
    operatingDaysPerMonth: 26,
    segmentDaysPerMonth: {
      baseball_day: 5,
      major_live: 2,
      night_game: 5,
      normal_dinner: 14,
    },
    segmentGuestIndex: {
      baseball_day: 1.15,
      major_live: 1.30,
      night_game: 1.25,
      normal_dinner: 1.00,
    },
  },
  standard: {
    unitPriceYen: 420,
    setDrinkAddPriceYen: 350,
    setWineAddPriceYen: 700,
    costRate: 0.30,
    setDrinkAddCostRate: 0.28,
    setWineAddCostRate: 0.30,
    bakeBatchUnits: 18,
    bakeBatchesPerDay: 3,
    prepStaffCount: 1,
    prepHoursPerDay: 2.5,
    staffHourlyCostYen: 1200,
    wasteRateTolerancePct: 8,
    expectedWasteRate: 0.07,
    purchaseRate: 0.12,
    setRate: 0.30,
    wineSetShareOfSets: 0.40,
    takeoutRate: 0.35,
    unitsPerPurchasingCheck: 1.4,
    lunchGuestShare: 0.40,
    guestsPerOperatingDay: 100,
    operatingDaysPerMonth: 28,
    segmentDaysPerMonth: {
      baseball_day: 6,
      major_live: 3,
      night_game: 5,
      normal_dinner: 14,
    },
    segmentGuestIndex: {
      baseball_day: 1.35,
      major_live: 1.60,
      night_game: 1.50,
      normal_dinner: 1.00,
    },
  },
  aggressive: {
    unitPriceYen: 480,
    setDrinkAddPriceYen: 400,
    setWineAddPriceYen: 800,
    costRate: 0.27,
    setDrinkAddCostRate: 0.26,
    setWineAddCostRate: 0.28,
    bakeBatchUnits: 24,
    bakeBatchesPerDay: 4,
    prepStaffCount: 2,
    prepHoursPerDay: 3,
    staffHourlyCostYen: 1200,
    wasteRateTolerancePct: 12,
    expectedWasteRate: 0.05,
    purchaseRate: 0.18,
    setRate: 0.40,
    wineSetShareOfSets: 0.50,
    takeoutRate: 0.45,
    unitsPerPurchasingCheck: 1.6,
    lunchGuestShare: 0.45,
    guestsPerOperatingDay: 120,
    operatingDaysPerMonth: 28,
    segmentDaysPerMonth: {
      baseball_day: 7,
      major_live: 3,
      night_game: 6,
      normal_dinner: 12,
    },
    segmentGuestIndex: {
      baseball_day: 1.60,
      major_live: 2.00,
      night_game: 1.80,
      normal_dinner: 1.00,
    },
  },
};

/** 時間帯配分（仮定）。ランチ・通常ディナーは通常時間帯のみ。 */
const SLOT_SPLIT: Record<KpiSegmentKey, Record<KpiSlotKey, number>> = {
  lunch: { before_event: 0, after_event: 0, steady: 1 },
  normal_dinner: { before_event: 0, after_event: 0, steady: 1 },
  baseball_day: { before_event: 0.45, after_event: 0.35, steady: 0.20 },
  major_live: { before_event: 0.35, after_event: 0.45, steady: 0.20 },
  night_game: { before_event: 0.40, after_event: 0.40, steady: 0.20 },
};

/** 統一売上から取れる実績ベースライン。取れない項目は null で渡す。 */
export type KpiBaseline = {
  guestsPerOperatingDay: number | null;
  operatingDaysPerMonth: number | null;
  averageSpendYen: number | null;
  periodLabel: string;
  sourceNote: string;
};

export function emptyKpiBaseline(periodLabel = "対象期間"): KpiBaseline {
  return {
    guestsPerOperatingDay: null,
    operatingDaysPerMonth: null,
    averageSpendYen: null,
    periodLabel,
    sourceNote: "統一売上の実績を取得できませんでした",
  };
}

/**
 * ai-analyze が組み立てた unified_sales から実績ベースラインを導く。
 * 数値は統一売上の値だけを使い、無い項目は null（0 とみなさない）。
 */
export function deriveKpiBaselineFromUnifiedSales(raw: unknown): KpiBaseline {
  const unified = isRecord(raw);
  const periods = Array.isArray(unified.periods) ? unified.periods : [];
  let guestTotal = 0;
  let salesTotal = 0;
  let dayCount = 0;
  let hasGuest = false;
  let hasSales = false;
  const labels: string[] = [];
  const months = new Set<string>();
  for (const periodRaw of periods) {
    const period = isRecord(periodRaw);
    const label = typeof period.label === "string" ? period.label : "";
    if (label) labels.push(label);
    const ranges = Array.isArray(period.ranges) ? period.ranges : [];
    for (const rangeRaw of ranges) {
      const range = isRecord(rangeRaw);
      const totals = isRecord(range.totals);
      const guests = Number(totals.guest_count);
      const gross = Number(totals.gross_sales_yen);
      if (Number.isFinite(guests) && guests > 0) {
        guestTotal += guests;
        hasGuest = true;
      }
      if (Number.isFinite(gross) && gross > 0) {
        salesTotal += gross;
        hasSales = true;
      }
      const daily = Array.isArray(range.daily) ? range.daily : [];
      for (const rowRaw of daily) {
        if (!Array.isArray(rowRaw)) continue;
        const date = String(rowRaw[0] ?? "");
        const sales = Number(rowRaw[1]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (!Number.isFinite(sales) || sales <= 0) continue;
        dayCount += 1;
        months.add(date.slice(0, 7));
      }
    }
  }
  const monthCount = months.size;
  return {
    guestsPerOperatingDay: hasGuest && dayCount > 0
      ? Math.round((guestTotal / dayCount) * 10) / 10
      : null,
    operatingDaysPerMonth: dayCount > 0 && monthCount > 0
      ? Math.round((dayCount / monthCount) * 10) / 10
      : null,
    averageSpendYen: hasGuest && hasSales && guestTotal > 0
      ? Math.round(salesTotal / guestTotal)
      : null,
    periodLabel: labels.join(" / ") || "対象期間",
    sourceNote: dayCount > 0
      ? `統一売上の日別実績 ${dayCount}日（${monthCount}か月）`
      : "統一売上に日別実績なし",
  };
}

const BASIS_RANK: Record<KpiBasis, number> = {
  actual: 0,
  input: 1,
  scenario: 2,
};

/** 合成値の basis は最も弱い入力に合わせる。実績に仮定を掛けたら実績とは呼ばない。 */
export function mergeBasis(...list: KpiBasis[]): KpiBasis {
  let worst: KpiBasis = "actual";
  for (const basis of list) {
    if (BASIS_RANK[basis] > BASIS_RANK[worst]) worst = basis;
  }
  return worst;
}

function num(
  value: number,
  unit: string,
  basis: KpiBasis,
  source: string,
): KpiNumber {
  return { value, unit, basis, source };
}

const round0 = (n: number) => Math.round(n);
const round1 = (n: number) => Math.round(n * 10) / 10;

export type KpiPriceLine = {
  key: "single" | "drink_set" | "wine_set";
  label: string;
  price: KpiNumber;
  cost: KpiNumber;
  grossProfit: KpiNumber;
  grossMarginPct: KpiNumber;
};

export type KpiSegmentTarget = {
  key: KpiSegmentKey;
  label: string;
  expectedGuests: KpiNumber;
  targetUnits: KpiNumber;
  capacityLimited: boolean;
  slots: Array<{ key: KpiSlotKey; label: string; targetUnits: KpiNumber }>;
  dailyRevenue: KpiNumber;
  daysPerMonth: KpiNumber;
};

export type KpiScenarioResult = {
  scenario: KpiScenarioName;
  scenarioLabel: string;
  assumptionBasis: Record<keyof KpiAssumptionValues, KpiBasis>;
  resolvedAssumptions: Record<keyof KpiAssumptionValues, KpiNumber>;
  prices: KpiPriceLine[];
  blendedPrice: KpiNumber;
  blendedCost: KpiNumber;
  blendedGrossMarginPct: KpiNumber;
  dailyCapacityUnits: KpiNumber;
  dailyFixedCostYen: KpiNumber;
  contributionPerSoldUnitYen: KpiNumber;
  breakEvenUnitsPerDay: KpiNumber;
  breakEvenAchievable: boolean;
  segments: KpiSegmentTarget[];
  normalDayOutlook: {
    targetUnits: KpiNumber;
    dailyRevenue: KpiNumber;
    coversBreakEven: boolean;
  };
  monthlyRevenueYen: KpiNumber;
  averageDailyRevenueYen: KpiNumber;
  kpiTargets: {
    setRatePct: KpiNumber;
    checkUpliftYen: KpiNumber;
    takeoutRatePct: KpiNumber;
    wasteRatePct: KpiNumber;
  };
  exitLines: {
    shrinkUnitsPerDay: KpiNumber;
    shrinkWeeks: KpiNumber;
    exitUnitsPerDay: KpiNumber;
    exitWeeks: KpiNumber;
    wasteRateAlertPct: KpiNumber;
    wasteAlertWeeks: KpiNumber;
  };
};

export type KpiScenarioPack = {
  version: 1;
  productName: string;
  baseline: KpiBaseline;
  assumptions: NormalizedKpiAssumptions;
  scenarios: KpiScenarioResult[];
  dataGaps: string[];
};

function resolveAssumption(
  key: keyof KpiAssumptionValues,
  values: KpiAssumptionValues,
  fallback: number,
  unit: string,
): KpiNumber {
  const provided = values[key];
  if (provided !== null) {
    return num(provided, unit, "input", `入力値（${KPI_ASSUMPTION_LABELS[key]}）`);
  }
  return num(
    fallback,
    unit,
    "scenario",
    `未入力のためシナリオ既定値（${KPI_ASSUMPTION_LABELS[key]}）`,
  );
}

function computeScenario(
  scenario: KpiScenarioName,
  assumptions: NormalizedKpiAssumptions,
  baseline: KpiBaseline,
): KpiScenarioResult {
  const d = KPI_SCENARIO_DEFAULTS[scenario];
  const v = assumptions.values;

  const unitPrice = resolveAssumption("unitPriceYen", v, d.unitPriceYen, "円");
  const drinkSetPrice = resolveAssumption(
    "setDrinkPriceYen",
    v,
    round0(unitPrice.value + d.setDrinkAddPriceYen),
    "円",
  );
  const wineSetPrice = resolveAssumption(
    "setWinePriceYen",
    v,
    round0(unitPrice.value + d.setWineAddPriceYen),
    "円",
  );
  const unitCost = resolveAssumption(
    "unitCostYen",
    v,
    round0(unitPrice.value * d.costRate),
    "円",
  );
  const drinkAddCost = resolveAssumption(
    "setDrinkAddCostYen",
    v,
    round0((drinkSetPrice.value - unitPrice.value) * d.setDrinkAddCostRate),
    "円",
  );
  const wineAddCost = resolveAssumption(
    "setWineAddCostYen",
    v,
    round0((wineSetPrice.value - unitPrice.value) * d.setWineAddCostRate),
    "円",
  );
  const batchUnits = resolveAssumption(
    "bakeBatchUnits",
    v,
    d.bakeBatchUnits,
    "個",
  );
  const batchesPerDay = resolveAssumption(
    "bakeBatchesPerDay",
    v,
    d.bakeBatchesPerDay,
    "回",
  );
  const staffCount = resolveAssumption(
    "prepStaffCount",
    v,
    d.prepStaffCount,
    "人",
  );
  const prepHours = resolveAssumption(
    "prepHoursPerDay",
    v,
    d.prepHoursPerDay,
    "時間",
  );
  const hourlyCost = resolveAssumption(
    "staffHourlyCostYen",
    v,
    d.staffHourlyCostYen,
    "円",
  );
  const wasteTolerance = resolveAssumption(
    "wasteRateTolerancePct",
    v,
    d.wasteRateTolerancePct,
    "%",
  );

  const resolvedAssumptions: Record<keyof KpiAssumptionValues, KpiNumber> = {
    unitPriceYen: unitPrice,
    setDrinkPriceYen: drinkSetPrice,
    setWinePriceYen: wineSetPrice,
    unitCostYen: unitCost,
    setDrinkAddCostYen: drinkAddCost,
    setWineAddCostYen: wineAddCost,
    bakeBatchUnits: batchUnits,
    bakeBatchesPerDay: batchesPerDay,
    prepStaffCount: staffCount,
    prepHoursPerDay: prepHours,
    staffHourlyCostYen: hourlyCost,
    wasteRateTolerancePct: wasteTolerance,
  };
  const assumptionBasis = {} as Record<keyof KpiAssumptionValues, KpiBasis>;
  for (const key of KPI_ASSUMPTION_KEYS) {
    assumptionBasis[key] = resolvedAssumptions[key].basis;
  }

  // A-1 価格設定案と粗利率
  const priceLine = (
    key: KpiPriceLine["key"],
    label: string,
    price: KpiNumber,
    cost: KpiNumber,
  ): KpiPriceLine => {
    const basis = mergeBasis(price.basis, cost.basis);
    const gross = price.value - cost.value;
    return {
      key,
      label,
      price,
      cost,
      grossProfit: num(round0(gross), "円", basis, "売価 − 原価"),
      grossMarginPct: num(
        price.value > 0 ? round1((gross / price.value) * 100) : 0,
        "%",
        basis,
        "粗利 ÷ 売価",
      ),
    };
  };
  const drinkSetCost = num(
    round0(unitCost.value + drinkAddCost.value),
    "円",
    mergeBasis(unitCost.basis, drinkAddCost.basis),
    "単品原価 + ドリンク追加原価",
  );
  const wineSetCost = num(
    round0(unitCost.value + wineAddCost.value),
    "円",
    mergeBasis(unitCost.basis, wineAddCost.basis),
    "単品原価 + ワイン追加原価",
  );
  const prices: KpiPriceLine[] = [
    priceLine("single", "単品", unitPrice, unitCost),
    priceLine("drink_set", "ドリンクセット", drinkSetPrice, drinkSetCost),
    priceLine("wine_set", "ワインセット", wineSetPrice, wineSetCost),
  ];

  // 販売構成（セット率・ワイン比率）はシナリオ仮定
  const setRate = d.setRate;
  const wineShare = d.wineSetShareOfSets;
  const singleShare = 1 - setRate;
  const drinkSetShare = setRate * (1 - wineShare);
  const wineSetShare = setRate * wineShare;
  const mixBasis: KpiBasis = "scenario";

  const blendedPriceValue = unitPrice.value * singleShare +
    drinkSetPrice.value * drinkSetShare + wineSetPrice.value * wineSetShare;
  const blendedCostValue = unitCost.value * singleShare +
    drinkSetCost.value * drinkSetShare + wineSetCost.value * wineSetShare;
  const blendedBasis = mergeBasis(
    unitPrice.basis,
    drinkSetPrice.basis,
    wineSetPrice.basis,
    unitCost.basis,
    mixBasis,
  );
  const blendedPrice = num(
    round0(blendedPriceValue),
    "円",
    blendedBasis,
    `販売構成 単品${round0(singleShare * 100)}% / ドリンクセット${
      round0(drinkSetShare * 100)
    }% / ワインセット${round0(wineSetShare * 100)}% で加重`,
  );
  const blendedCost = num(
    round0(blendedCostValue),
    "円",
    blendedBasis,
    "同じ販売構成で原価を加重",
  );
  const blendedGrossMarginPct = num(
    blendedPriceValue > 0
      ? round1(((blendedPriceValue - blendedCostValue) / blendedPriceValue) * 100)
      : 0,
    "%",
    blendedBasis,
    "加重粗利 ÷ 加重売価",
  );

  // A-2 損益分岐となる1日の販売個数
  const dailyCapacityUnits = num(
    round0(batchUnits.value * batchesPerDay.value),
    "個",
    mergeBasis(batchUnits.basis, batchesPerDay.basis),
    "1回の焼成個数 × 1日の焼成回数上限",
  );
  const dailyFixedCost = staffCount.value * prepHours.value * hourlyCost.value;
  const dailyFixedCostYen = num(
    round0(dailyFixedCost),
    "円",
    mergeBasis(staffCount.basis, prepHours.basis, hourlyCost.basis),
    "人員 × 1日の仕込み・焼成時間 × 時給",
  );
  const expectedWasteRate = Math.min(0.9, d.expectedWasteRate);
  const costPerSoldUnit = blendedCostValue / (1 - expectedWasteRate);
  const contributionValue = blendedPriceValue - costPerSoldUnit;
  const contributionPerSoldUnitYen = num(
    round0(contributionValue),
    "円",
    mergeBasis(blendedBasis, "scenario"),
    `加重売価 − 加重原価 ÷ (1 − 想定廃棄率${round1(expectedWasteRate * 100)}%)`,
  );
  const breakEvenUnits = contributionValue > 0
    ? Math.ceil(dailyFixedCost / contributionValue)
    : 0;
  const breakEvenUnitsPerDay = num(
    breakEvenUnits,
    "個/日",
    mergeBasis(dailyFixedCostYen.basis, contributionPerSoldUnitYen.basis),
    contributionValue > 0
      ? "1日の固定費 ÷ 1個あたり貢献利益（切り上げ）"
      : "貢献利益が0以下のため損益分岐点が成立しない",
  );
  const breakEvenAchievable = contributionValue > 0 &&
    breakEvenUnits <= dailyCapacityUnits.value;

  // A-3 目標販売個数（営業区分別・時間帯別）
  const guestsPerDayValue = baseline.guestsPerOperatingDay ??
    d.guestsPerOperatingDay;
  const guestsBasis: KpiBasis = baseline.guestsPerOperatingDay !== null
    ? "actual"
    : "scenario";
  const operatingDaysValue = baseline.operatingDaysPerMonth ??
    d.operatingDaysPerMonth;
  const operatingDaysBasis: KpiBasis = baseline.operatingDaysPerMonth !== null
    ? "actual"
    : "scenario";

  // ディナー区分は同じ日に1つだけ立つので、月あたり日数の合計を営業日数へ正規化する。
  // 実績の営業日数が既定合計（例: 28日）と違っても、月間売上が営業日数と矛盾しない。
  const dinnerSegmentKeys = KPI_SEGMENT_KEYS.filter(
    (key): key is Exclude<KpiSegmentKey, "lunch"> => key !== "lunch",
  );
  const defaultDinnerDayTotal = dinnerSegmentKeys.reduce(
    (sum, key) => sum + d.segmentDaysPerMonth[key],
    0,
  );
  const dinnerDayScale = defaultDinnerDayTotal > 0
    ? operatingDaysValue / defaultDinnerDayTotal
    : 0;
  const scaledDinnerDays = {} as Record<Exclude<KpiSegmentKey, "lunch">, number>;
  for (const key of dinnerSegmentKeys) {
    scaledDinnerDays[key] = round1(d.segmentDaysPerMonth[key] * dinnerDayScale);
  }

  const lunchGuests = guestsPerDayValue * d.lunchGuestShare;
  const dinnerGuests = guestsPerDayValue * (1 - d.lunchGuestShare);
  // ランチは毎営業日、ディナー区分は同じ日に1つだけ立つ。1日の焼成上限は両者の合算に効く。
  const lunchUnitsRaw = lunchGuests * d.purchaseRate;
  const lunchCap = dailyCapacityUnits.value * (1 - expectedWasteRate) *
    d.lunchGuestShare;
  const lunchUnits = Math.min(lunchUnitsRaw, lunchCap);
  const dinnerCapBase = dailyCapacityUnits.value * (1 - expectedWasteRate) -
    lunchUnits;

  const segments: KpiSegmentTarget[] = KPI_SEGMENT_KEYS.map((key) => {
    const isLunch = key === "lunch";
    const index = isLunch
      ? 1
      : d.segmentGuestIndex[key as Exclude<KpiSegmentKey, "lunch">];
    const rawGuests = isLunch ? lunchGuests : dinnerGuests * index;
    const rawUnits = isLunch ? lunchUnitsRaw : rawGuests * d.purchaseRate;
    const cap = isLunch ? lunchCap : Math.max(0, dinnerCapBase);
    const units = Math.max(0, Math.min(rawUnits, cap));
    const unitsBasis = mergeBasis(
      guestsBasis,
      "scenario",
      dailyCapacityUnits.basis,
    );
    const split = SLOT_SPLIT[key];
    const slotKeys: KpiSlotKey[] = ["before_event", "after_event", "steady"];
    const slots = slotKeys
      .filter((slotKey) => split[slotKey] > 0)
      .map((slotKey) => ({
        key: slotKey,
        label: KPI_SLOT_LABELS[slotKey],
        targetUnits: num(
          round0(units * split[slotKey]),
          "個",
          unitsBasis,
          `${KPI_SEGMENT_LABELS[key]}の目標個数 × 時間帯配分${
            round0(split[slotKey] * 100)
          }%（配分は仮定）`,
        ),
      }));
    const daysPerMonth = isLunch
      ? operatingDaysValue
      : scaledDinnerDays[key as Exclude<KpiSegmentKey, "lunch">];
    return {
      key,
      label: KPI_SEGMENT_LABELS[key],
      expectedGuests: num(
        round1(rawGuests),
        "名",
        mergeBasis(guestsBasis, "scenario"),
        isLunch
          ? `1営業日の来店客数 × ランチ比率${round0(d.lunchGuestShare * 100)}%`
          : `1営業日のディナー客数 × 需要指数${index}（指数は仮定）`,
      ),
      targetUnits: num(round0(units), "個", unitsBasis, "想定客数 × 購入率（焼成上限で頭打ち）"),
      capacityLimited: rawUnits > cap + 0.5,
      slots,
      dailyRevenue: num(
        round0(units * blendedPriceValue),
        "円",
        mergeBasis(unitsBasis, blendedBasis),
        "目標個数 × 加重売価",
      ),
      daysPerMonth: num(
        round1(daysPerMonth),
        "日/月",
        isLunch ? operatingDaysBasis : "scenario",
        isLunch ? "統一売上の営業日数" : "月あたり該当日数（仮定）",
      ),
    };
  });

  const segmentByKey = new Map(segments.map((s) => [s.key, s]));
  const lunchSegment = segmentByKey.get("lunch")!;
  const normalDinner = segmentByKey.get("normal_dinner")!;

  // A-7 イベントのない通常営業日の見込み（ランチ＋通常ディナー）
  const normalDayUnits = lunchSegment.targetUnits.value +
    normalDinner.targetUnits.value;
  const normalDayRevenue = lunchSegment.dailyRevenue.value +
    normalDinner.dailyRevenue.value;
  const normalDayBasis = mergeBasis(
    lunchSegment.targetUnits.basis,
    normalDinner.targetUnits.basis,
  );

  // A-4 売上の期待値（1日・月間）
  let monthlyRevenue = lunchSegment.dailyRevenue.value *
    lunchSegment.daysPerMonth.value;
  for (const segment of segments) {
    if (segment.key === "lunch") continue;
    monthlyRevenue += segment.dailyRevenue.value * segment.daysPerMonth.value;
  }
  const revenueBasis = mergeBasis(
    blendedBasis,
    guestsBasis,
    operatingDaysBasis,
    "scenario",
  );
  const monthlyRevenueYen = num(
    round0(monthlyRevenue),
    "円/月",
    revenueBasis,
    "各営業区分の1日売上 × 月あたり該当日数の合計",
  );
  const averageDailyRevenueYen = num(
    operatingDaysValue > 0 ? round0(monthlyRevenue / operatingDaysValue) : 0,
    "円/日",
    revenueBasis,
    "月間売上 ÷ 営業日数",
  );

  // A-5 KPI目標値
  const kpiTargets = {
    setRatePct: num(
      round1(setRate * 100),
      "%",
      "scenario",
      "セット（ドリンク／ワイン）を付けた会計の比率目標",
    ),
    checkUpliftYen: num(
      round0(blendedPriceValue * d.unitsPerPurchasingCheck),
      "円",
      mergeBasis(blendedBasis, "scenario"),
      `加重売価 × 購入会計あたり${d.unitsPerPurchasingCheck}個（個数は仮定）`,
    ),
    takeoutRatePct: num(
      round1(d.takeoutRate * 100),
      "%",
      "scenario",
      "持ち帰り会計の比率目標",
    ),
    wasteRatePct: num(
      round1(Math.min(wasteTolerance.value, expectedWasteRate * 100)),
      "%",
      mergeBasis(wasteTolerance.basis, "scenario"),
      "廃棄許容範囲と想定廃棄率のうち厳しい方",
    ),
  };

  // A-6 撤退・縮小ラインの数値化
  const exitLines = {
    shrinkUnitsPerDay: num(
      Math.max(0, Math.floor(breakEvenUnits * 0.8)),
      "個/日",
      breakEvenUnitsPerDay.basis,
      "損益分岐個数の80%",
    ),
    shrinkWeeks: num(4, "週", "scenario", "判定に使う連続週数（仮定）"),
    exitUnitsPerDay: num(
      Math.max(0, Math.floor(breakEvenUnits * 0.5)),
      "個/日",
      breakEvenUnitsPerDay.basis,
      "損益分岐個数の50%",
    ),
    exitWeeks: num(8, "週", "scenario", "判定に使う連続週数（仮定）"),
    wasteRateAlertPct: num(
      round1(wasteTolerance.value * 1.5),
      "%",
      wasteTolerance.basis,
      "廃棄許容範囲の1.5倍",
    ),
    wasteAlertWeeks: num(4, "週", "scenario", "判定に使う連続週数（仮定）"),
  };

  return {
    scenario,
    scenarioLabel: KPI_SCENARIO_LABELS[scenario],
    assumptionBasis,
    resolvedAssumptions,
    prices,
    blendedPrice,
    blendedCost,
    blendedGrossMarginPct,
    dailyCapacityUnits,
    dailyFixedCostYen,
    contributionPerSoldUnitYen,
    breakEvenUnitsPerDay,
    breakEvenAchievable,
    segments,
    normalDayOutlook: {
      targetUnits: num(
        round0(normalDayUnits),
        "個/日",
        normalDayBasis,
        "ランチ＋通常ディナーの目標個数",
      ),
      dailyRevenue: num(
        round0(normalDayRevenue),
        "円/日",
        mergeBasis(normalDayBasis, blendedBasis),
        "ランチ＋通常ディナーの1日売上",
      ),
      coversBreakEven: normalDayUnits >= breakEvenUnits && breakEvenUnits > 0,
    },
    monthlyRevenueYen,
    averageDailyRevenueYen,
    kpiTargets,
    exitLines,
  };
}

/** 精度を上げるために必要なデータ（要件C）。 */
function buildDataGaps(
  assumptions: NormalizedKpiAssumptions,
  baseline: KpiBaseline,
): string[] {
  const gaps: string[] = [];
  for (const key of assumptions.missing) {
    gaps.push(`${KPI_ASSUMPTION_LABELS[key]}（未入力のため3シナリオで仮置き）`);
  }
  if (baseline.guestsPerOperatingDay === null) {
    gaps.push("統一売上の日別来店客数（1営業日あたり客数の実績が取れないためシナリオ値を使用）");
  }
  if (baseline.operatingDaysPerMonth === null) {
    gaps.push("統一売上の日別実績（月あたり営業日数の実績が取れないためシナリオ値を使用）");
  }
  gaps.push("購入率・セット率・テイクアウト比率の実測（現状はすべてシナリオ仮定）");
  gaps.push("イベント種別ごとの実績客数（野球デーゲーム／ナイター／大型ライブと通常営業日の差）");
  gaps.push("廃棄の実測数と金額（想定廃棄率の検証に必要）");
  return gaps;
}

/**
 * 3シナリオぶんの数値提案を一括で確定する。入力が1つも無くても計算は返す
 * （その場合は全項目が「仮定(シナリオ)」ラベルになる）。
 */
export function buildKpiScenarioPack(params: {
  assumptions?: unknown;
  baseline?: KpiBaseline | null;
  productName?: string;
}): KpiScenarioPack {
  const assumptions = normalizeKpiAssumptions(params.assumptions);
  const baseline = params.baseline ?? emptyKpiBaseline();
  const productName = String(params.productName || "検討中の新商品").slice(0, 80);
  return {
    version: 1,
    productName,
    baseline,
    assumptions,
    scenarios: KPI_SCENARIO_NAMES.map((scenario) =>
      computeScenario(scenario, assumptions, baseline)
    ),
    dataGaps: buildDataGaps(assumptions, baseline),
  };
}

/**
 * sales_data へ載せる軽量な参照。数値の正本は system 側の確定ブロックなので、
 * ここへ全シナリオのJSONを重複させない（プロンプト長と再計算リスクを増やさないため）。
 */
export function buildKpiScenarioReference(pack: KpiScenarioPack) {
  return {
    version: pack.version as 1,
    status: "computed_server_side" as const,
    product_name: pack.productName,
    scenarios: pack.scenarios.map((s) => s.scenarioLabel),
    provided_assumptions: pack.assumptions.provided.map((key) =>
      KPI_ASSUMPTION_LABELS[key]
    ),
    scenario_filled_assumptions: pack.assumptions.missing.map((key) =>
      KPI_ASSUMPTION_LABELS[key]
    ),
    baseline_source: pack.baseline.sourceNote,
    note:
      "数値の正本は system 側の【数値提案（KPI試算）】ブロックです。そこにある値をラベル付きでそのまま引用し、ここから再計算しないでください。",
  };
}

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const tag = (value: KpiNumber) => `【${KPI_BASIS_LABELS[value.basis]}】`;
const show = (value: KpiNumber) =>
  `${tag(value)}${
    value.unit === "円" || value.unit.startsWith("円")
      ? `${yen(value.value)}${value.unit.slice(1)}`
      : `${value.value}${value.unit}`
  }`;

/** プロンプトへ載せる確定ブロック。ここに無い数値をAIが作ることは禁止する。 */
export function formatKpiScenarioBlock(pack: KpiScenarioPack): string {
  const lines: string[] = [];
  lines.push("【数値提案（KPI試算・コード側で確定計算済み）】");
  lines.push(`対象: ${pack.productName}`);
  lines.push(
    `実績ベースライン: ${pack.baseline.periodLabel} / ${pack.baseline.sourceNote}`,
  );
  lines.push(
    `- 1営業日あたり来店客数: ${
      pack.baseline.guestsPerOperatingDay === null
        ? "【仮定(シナリオ)】実績なしのためシナリオ値"
        : `【実績】${pack.baseline.guestsPerOperatingDay}名`
    }`,
  );
  lines.push(
    `- 月あたり営業日数: ${
      pack.baseline.operatingDaysPerMonth === null
        ? "【仮定(シナリオ)】実績なしのためシナリオ値"
        : `【実績】${pack.baseline.operatingDaysPerMonth}日`
    }`,
  );
  lines.push(
    `- 平均客単価: ${
      pack.baseline.averageSpendYen === null
        ? "【実績なし】"
        : `【実績】${yen(pack.baseline.averageSpendYen)}`
    }`,
  );
  const provided = pack.assumptions.provided.map((key) =>
    `${KPI_ASSUMPTION_LABELS[key]}=${pack.assumptions.values[key]}`
  );
  lines.push(
    `入力済みの前提条件: ${provided.length ? provided.join(" / ") : "なし（全項目をシナリオで仮置き）"}`,
  );

  for (const s of pack.scenarios) {
    lines.push("");
    lines.push(`■ ${s.scenarioLabel}シナリオ`);
    lines.push("  A-1 価格設定案と粗利率");
    for (const p of s.prices) {
      lines.push(
        `    - ${p.label}: 売価 ${show(p.price)} / 原価 ${show(p.cost)} / 粗利 ${
          show(p.grossProfit)
        } / 粗利率 ${show(p.grossMarginPct)}`,
      );
    }
    lines.push(
      `    - 加重平均: 売価 ${show(s.blendedPrice)} / 原価 ${
        show(s.blendedCost)
      } / 粗利率 ${show(s.blendedGrossMarginPct)}（${s.blendedPrice.source}）`,
    );
    lines.push("  A-2 損益分岐となる1日の販売個数");
    lines.push(
      `    - 1日の焼成上限: ${show(s.dailyCapacityUnits)}（${s.dailyCapacityUnits.source}）`,
    );
    lines.push(
      `    - 1日の固定費: ${show(s.dailyFixedCostYen)}（${s.dailyFixedCostYen.source}）`,
    );
    lines.push(
      `    - 1個あたり貢献利益: ${show(s.contributionPerSoldUnitYen)}（${s.contributionPerSoldUnitYen.source}）`,
    );
    lines.push(
      `    - 損益分岐個数: ${show(s.breakEvenUnitsPerDay)}（${s.breakEvenUnitsPerDay.source}）${
        s.breakEvenAchievable ? "" : " ※焼成上限内では到達しない"
      }`,
    );
    lines.push("  A-3 目標販売個数（営業区分別・時間帯別）");
    for (const seg of s.segments) {
      const slotText = seg.slots.map((slot) =>
        `${slot.label} ${slot.targetUnits.value}個`
      ).join(" / ");
      lines.push(
        `    - ${seg.label}: 想定客数 ${show(seg.expectedGuests)} → 目標 ${
          show(seg.targetUnits)
        }${seg.capacityLimited ? "（焼成上限で頭打ち）" : ""} / 時間帯配分 ${slotText} / 1日売上 ${
          show(seg.dailyRevenue)
        } / 月あたり ${show(seg.daysPerMonth)}`,
      );
    }
    lines.push("  A-4 売上の期待値");
    lines.push(`    - 1日平均: ${show(s.averageDailyRevenueYen)}`);
    lines.push(`    - 月間: ${show(s.monthlyRevenueYen)}（${s.monthlyRevenueYen.source}）`);
    lines.push("  A-5 KPI目標値");
    lines.push(`    - セット率: ${show(s.kpiTargets.setRatePct)}`);
    lines.push(
      `    - 購入会計の客単価上昇額: ${show(s.kpiTargets.checkUpliftYen)}（${s.kpiTargets.checkUpliftYen.source}）`,
    );
    lines.push(`    - テイクアウト比率: ${show(s.kpiTargets.takeoutRatePct)}`);
    lines.push(`    - 廃棄率: ${show(s.kpiTargets.wasteRatePct)}以下`);
    lines.push("  A-6 撤退・縮小ライン");
    lines.push(
      `    - 縮小: ${s.exitLines.shrinkWeeks.value}週連続で1日 ${
        s.exitLines.shrinkUnitsPerDay.value
      }個未満${tag(s.exitLines.shrinkUnitsPerDay)}`,
    );
    lines.push(
      `    - 撤退: ${s.exitLines.exitWeeks.value}週連続で1日 ${
        s.exitLines.exitUnitsPerDay.value
      }個未満${tag(s.exitLines.exitUnitsPerDay)}`,
    );
    lines.push(
      `    - 廃棄: ${s.exitLines.wasteAlertWeeks.value}週連続で廃棄率 ${
        s.exitLines.wasteRateAlertPct.value
      }%超${tag(s.exitLines.wasteRateAlertPct)}`,
    );
    lines.push("  A-7 イベントのない通常営業日の見込み");
    lines.push(
      `    - 目標個数 ${show(s.normalDayOutlook.targetUnits)} / 売上 ${
        show(s.normalDayOutlook.dailyRevenue)
      } / 損益分岐${s.normalDayOutlook.coversBreakEven ? "を上回る" : "に届かない"}`,
    );
  }

  lines.push("");
  lines.push("【この試算の精度を上げるために必要なデータ】");
  for (const gap of pack.dataGaps) lines.push(`- ${gap}`);
  lines.push("");
  lines.push(
    "利用ルール: 上の数値はコード側で確定計算した結果です。回答では【実績】【仮定(入力)】【仮定(シナリオ)】のラベルを必ず保持し、"
      + "実績と仮定を同じ数値として混ぜないでください。ここに無い金額・個数・比率を新たに作ってはいけません。"
      + "前提が変わる場合は、変更後の前提を明示したうえで再計算を依頼するよう案内してください。",
  );
  return lines.join("\n");
}
