/** Q&Aで利用者が選ぶ分析角度。ブラウザーの FOODCOURT_QA_PLANNER.ANALYSIS_METHODS と同じ id。 */

export const FOODCOURT_ANALYSIS_METHODS = [
  {
    id: "mix",
    label: "売上構成・主力商品",
    instruction: "売上構成と主力商品を見る。原価なしの売上ABCは可。人気×採算は原価または推測値があるときだけ。",
  },
  {
    id: "decompose",
    label: "客数と客単価の分解",
    instruction: "売上＝客数×客単価の要因分解で、動きの主因を切り分ける。",
  },
  {
    id: "timing",
    label: "時間帯・曜日",
    instruction: "時間帯・曜日のピークと閑散。会計時刻は注文時刻ではない。",
  },
  {
    id: "bundle",
    label: "同時購入・併売",
    instruction: "同一会計内の同時購入を観測する。セット率の実績とは呼ばない。",
  },
  {
    id: "event",
    label: "イベント・天気",
    instruction: "会場イベント・天気と客層の相性。イベント日だけの数値を全体傾向と呼ばない。",
  },
  {
    id: "margin",
    label: "粗利・採算（未登録なら推測）",
    instruction: "粗利・採算。原価未登録なら【仮定(シナリオ)】の推測値で目標粗利を出してよい。実績と混ぜない。",
  },
  {
    id: "kpi",
    label: "目標・損益分岐・撤退",
    instruction: "販売目標・損益分岐・撤退ライン。新しい施策は実績が無い前提で、今の売上から寄与率と上積みの推測値を引用する。未入力は推測値でよい。",
  },
  {
    id: "goal",
    label: "改善の打ち手",
    instruction: "明日から試せる打ち手。選ばれていないときは次の一手を義務にしない。",
  },
] as const

export type FoodCourtAnalysisMethodId = typeof FOODCOURT_ANALYSIS_METHODS[number]["id"]

const METHOD_IDS = new Set<string>(FOODCOURT_ANALYSIS_METHODS.map((row) => row.id))

export function parseFoodCourtAnalysisMethods(raw: unknown): FoodCourtAnalysisMethodId[] {
  const list = Array.isArray(raw) ? raw : []
  const ids: FoodCourtAnalysisMethodId[] = []
  for (const item of list) {
    const id = String(item ?? "").trim()
    if (!METHOD_IDS.has(id)) continue
    if (!ids.includes(id as FoodCourtAnalysisMethodId)) ids.push(id as FoodCourtAnalysisMethodId)
  }
  return ids
}

export function analysisMethodsForceKpi(ids: readonly string[]): boolean {
  return ids.some((id) => id === "kpi" || id === "margin")
}

export function foodCourtAnalysisMethodPrompt(ids: readonly string[]): string {
  const selected = parseFoodCourtAnalysisMethods(ids)
  if (!selected.length) return ""
  const lines = selected.map((id) => {
    const row = FOODCOURT_ANALYSIS_METHODS.find((item) => item.id === id)!
    return `- ${row.label}: ${row.instruction}`
  })
  return [
    "【今回選ばれた分析方法・最優先】",
    "次の角度だけを本題にする。選ばれていない分析・フレームワーク・KPI節・次の一手を義務として並べない。下記の市場調査項目も、選ばれていないものは省略する。",
    ...lines,
    "粗利・目標を含む場合、原価や人件費が未登録でも【仮定(シナリオ)】の推測値で目標を出してよい。新しい施策に実績が無くても数値未確認で止めず、サーバー確定の寄与率・上積みを引用する。AIが別係数で作り直さない。実績と推測は混ぜない。",
  ].join("\n")
}
