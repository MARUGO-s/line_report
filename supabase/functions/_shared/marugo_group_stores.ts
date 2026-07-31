/** MARUGO GROUP 公式サイト「運営店舗」掲載ブランド（2026年時点の一覧に準拠） */
export const MARUGO_GROUP_STORE_OPTIONS = [
  "マルゴ",
  "マルゴ セカンド",
  "マルゴ グランデ",
  "サンナナイチ バル",
  "シェンロン&クラウディア",
  "クラウディア2",
  "ソバージュ",
  "バルぺロタ",
  "トラットリア ブリッコラ",
  "ヴィオレット",
  "マルゴ オット",
  "元祖どないや 新宿三丁目店",
  "マルゴ 四谷",
  "鮨こるり",
  "ビストロ サヴァサヴァ",
  "マルゴエス",
  "マルゴ 新橋",
  "マルゴ丸の内",
  "焼肉マルゴ",
  "エリックスバイエリックトロション",
  "ミタン",
  "マルゴ D",
] as const

const LABEL_SET = new Set<string>(MARUGO_GROUP_STORE_OPTIONS as unknown as string[])

export function isMarugoGroupStoreLabel(value: string): boolean {
  return LABEL_SET.has(value)
}

/** 店舗ごとの緯度・経度（天候データ取得用） store_partition_key → 座標 */
export const STORE_COORDINATES: Record<string, { lat: number; lon: number }> = {
  marugo:              { lat: 35.6911, lon: 139.7060 }, // 新宿区新宿3-7-5
  marugosecond:        { lat: 35.6912, lon: 139.7066 }, // 新宿区新宿3-9-4
  marugogrande:        { lat: 35.6910, lon: 139.7058 }, // 新宿区新宿3-6-14
  sannanaichi:         { lat: 35.6907, lon: 139.7062 }, // 新宿区新宿3-7-1
  shenlong:            { lat: 35.6907, lon: 139.7064 }, // 新宿区新宿3-8-4
  claudia2:            { lat: 35.6912, lon: 139.7065 }, // 新宿区新宿3-10-10
  sauvage:             { lat: 35.6911, lon: 139.7064 }, // 新宿区新宿3-10-1
  barpelota:           { lat: 35.6892, lon: 139.7073 }, // 新宿区新宿2-5-15
  briccola:            { lat: 35.6919, lon: 139.7067 }, // 新宿区新宿3-11-10
  violette:            { lat: 35.6918, lon: 139.7068 }, // 新宿区新宿3-11-11
  marugootto:          { lat: 35.6931, lon: 139.7024 }, // 新宿区新宿3-21-7
  donaiya:             { lat: 35.6911, lon: 139.7066 }, // 新宿区新宿3-9-3
  marugoyotsuya:       { lat: 35.6877, lon: 139.7291 }, // 新宿区四谷1-6-1
  sushikoruri:         { lat: 35.6877, lon: 139.7291 }, // 新宿区四谷1-6-1
  bistrocavacava:      { lat: 35.6905, lon: 139.7222 }, // 新宿区荒木町9-7
  marugoS:             { lat: 35.7032, lon: 139.7522 }, // 文京区後楽1-3-61
  marugoshinbashi:     { lat: 35.6658, lon: 139.7562 }, // 港区新橋3-13-4
  marugomarunouchi:    { lat: 35.6788, lon: 139.7631 }, // 千代田区丸の内2-6-1
  yakinikumarugo:      { lat: 35.6778, lon: 139.7614 }, // 千代田区丸の内3-2-3
  erics:               { lat: 35.6826, lon: 139.7643 }, // 千代田区丸の内1-5-1
  mitan:               { lat: 35.6826, lon: 139.7643 }, // 千代田区丸の内1-5-1
  marugoD:             { lat: 34.9922, lon: 137.0127 }, // 愛知県刈谷市中山町2-38
}

export type StoreLocationProfile = {
  storeKey: string
  name: string
  area: string
  address: string
  /** 立地特性。AI分析はこの店舗の立地を基準にし、新宿三丁目前提にしない */
  locationNotes: string
}

/** Journal / AI 分析用の店舗立地プロファイル（store_partition_key） */
export const STORE_LOCATION_PROFILES: Record<string, StoreLocationProfile> = {
  marugo: {
    storeKey: "marugo",
    name: "マルゴ",
    area: "新宿三丁目",
    address: "東京都新宿区新宿3-7-5",
    locationNotes: "新宿三丁目のワインバー密集エリア。姉妹店回遊・夜の立ち寄り需要が強い。",
  },
  marugosecond: {
    storeKey: "marugosecond",
    name: "マルゴ セカンド",
    area: "新宿三丁目",
    address: "東京都新宿区新宿3-9-4",
    locationNotes: "新宿三丁目。有機野菜×ワインの立ち飲み需要。近隣姉妹店との役割分担が重要。",
  },
  marugogrande: {
    storeKey: "marugogrande",
    name: "マルゴ グランデ",
    area: "新宿三丁目",
    address: "東京都新宿区新宿3-6-14",
    locationNotes: "新宿三丁目のワイン&イタリアン。グラスワイン回転とディナータイムの客単価が鍵。",
  },
  sannanaichi: {
    storeKey: "sannanaichi",
    name: "サンナナイチ バル",
    area: "新宿三丁目",
    address: "東京都新宿区新宿3-7-1",
    locationNotes: "新宿三丁目ホテルラウンジバル。昼夜ロング営業・多様な利用シーン。",
  },
  shenlong: {
    storeKey: "shenlong",
    name: "シェンロン&クラウディア",
    area: "新宿三丁目",
    address: "東京都新宿区新宿3-8-4",
    locationNotes: "新宿三丁目の街中華×酒。ワイン以外の酒も含むがグループのワイン強みも活用可。",
  },
  claudia2: {
    storeKey: "claudia2",
    name: "クラウディア2",
    area: "新宿三丁目",
    address: "東京都新宿区新宿3-10-10",
    locationNotes: "新宿三丁目ピッツェリア。窯焼きピザ×ワインのペアリング提案が中心。",
  },
  sauvage: {
    storeKey: "sauvage",
    name: "ソバージュ",
    area: "新宿三丁目",
    address: "東京都新宿区新宿3-10-1",
    locationNotes: "新宿三丁目の蕎麦処。昼そば／夜の酒（ワイン含む）の二面性を踏まえる。",
  },
  barpelota: {
    storeKey: "barpelota",
    name: "バルぺロタ",
    area: "新宿御苑付近",
    address: "東京都新宿区新宿2-5-15",
    locationNotes: "新宿御苑そばのスペインバル。三丁目密集地とは立地が異なり、観光・散策導線も意識。",
  },
  briccola: {
    storeKey: "briccola",
    name: "トラットリア ブリッコラ",
    area: "新宿三丁目",
    address: "東京都新宿区新宿3-11-10",
    locationNotes: "新宿三丁目の隠れ家トラットリア。ディナー・予約客のワイン提案が重要。",
  },
  violette: {
    storeKey: "violette",
    name: "ヴィオレット",
    area: "新宿三丁目",
    address: "東京都新宿区新宿3-11-11",
    locationNotes: "新宿三丁目の大人向けワインバー。長時間滞在・ボトル提案余地。",
  },
  marugootto: {
    storeKey: "marugootto",
    name: "マルゴ オット",
    area: "新宿東口",
    address: "東京都新宿区新宿3-21-7",
    locationNotes: "新宿東口寄りのピアノパブ。生演奏×クラフトビール／ワイン。三丁目立ち飲みとは客層が異なる。",
  },
  donaiya: {
    storeKey: "donaiya",
    name: "元祖どないや 新宿三丁目店",
    area: "新宿三丁目",
    address: "東京都新宿区新宿3-9-3",
    locationNotes: "たこ焼き専門。グループのワイン強みは無理に押し付けず、酒類・回遊の補完として見る。",
  },
  marugoyotsuya: {
    storeKey: "marugoyotsuya",
    name: "マルゴ 四谷",
    area: "四谷",
    address: "東京都新宿区四谷1-6-1",
    locationNotes: "四谷のビストロ&ワインショップ。オフィス・近隣居住・ショップ併設。新宿三丁目前提の分析は禁止。",
  },
  sushikoruri: {
    storeKey: "sushikoruri",
    name: "鮨こるり",
    area: "四谷",
    address: "東京都新宿区四谷1-6-1",
    locationNotes: "四谷の鮨。酒・ワイン提案は鮨業態に合わせる。新宿三丁目ワインバー前提にしない。",
  },
  bistrocavacava: {
    storeKey: "bistrocavacava",
    name: "ビストロ サヴァサヴァ",
    area: "荒木町（四谷エリア）",
    address: "東京都新宿区荒木町9-7",
    locationNotes:
      "荒木町のビストロ。和のアクセント×仏・日ワイン。新宿三丁目の立ち飲み密集地ではない。路地裏・ディナータイム・コース／ペアリングが中心。",
  },
  marugoS: {
    storeKey: "marugoS",
    name: "マルゴエス",
    area: "水道橋・東京ドームシティ",
    address: "東京都文京区後楽1-3-61",
    locationNotes: "東京ドームシティ内フードホール。イベント・昼夜の利用変化が大きい。新宿三丁目前提は禁止。",
  },
  marugoshinbashi: {
    storeKey: "marugoshinbashi",
    name: "マルゴ 新橋",
    area: "新橋",
    address: "東京都港区新橋3-13-4",
    locationNotes: "新橋のワインバル。ビジネス街の夜需要。新宿三丁目密集前提ではなく新橋の導線で分析する。",
  },
  marugomarunouchi: {
    storeKey: "marugomarunouchi",
    name: "マルゴ丸の内",
    area: "丸の内",
    address: "東京都千代田区丸の内2-6-1",
    locationNotes: "丸の内のワインビストロ。ランチ〜ディナーのオフィス需要。新宿三丁目前提は禁止。",
  },
  yakinikumarugo: {
    storeKey: "yakinikumarugo",
    name: "焼肉マルゴ",
    area: "丸の内",
    address: "東京都千代田区丸の内3-2-3",
    locationNotes: "丸の内の焼肉&カジュアルバル。ワイン／ドリンク提案は焼肉業態に合わせる。",
  },
  erics: {
    storeKey: "erics",
    name: "エリックスバイエリックトロション",
    area: "丸の内",
    address: "東京都千代田区丸の内1-5-1",
    locationNotes: "丸の内のワインビストロ（夜景・高単価帯）。ビジネス接待・ディナータイム中心。",
  },
  mitan: {
    storeKey: "mitan",
    name: "ミタン",
    area: "丸の内",
    address: "東京都千代田区丸の内1-5-1",
    locationNotes: "丸の内のテイクアウト&カジュアルバル。昼のテイクアウト／夜バルの二面性。",
  },
  marugoD: {
    storeKey: "marugoD",
    name: "マルゴ D",
    area: "愛知県刈谷（地方店）",
    address: "愛知県刈谷市中山町2-38",
    locationNotes:
      "都外（愛知・刈谷）のワインビストロ&ベーカリー。東京・新宿三丁目の立地前提は完全禁止。地元・ファミリー・ランチ〜ディナーの地方需要で分析する。",
  },
}

export function getStoreLocationProfile(
  storeKey: string | null | undefined,
): StoreLocationProfile | null {
  const key = String(storeKey || "").trim()
  if (!key) return null
  return STORE_LOCATION_PROFILES[key] || null
}

/** AIプロンプトに埋め込む「この店舗の立地」ブロック */
export function buildStoreLocationPromptBlock(
  storeKey: string | null | undefined,
  storeNameHint?: string | null,
): string {
  const profile = getStoreLocationProfile(storeKey)
  if (!profile) {
    const name = String(storeNameHint || storeKey || "").trim()
    return `【分析対象店舗の立地】
店舗: ${name || "（未指定）"}
注意: 店舗キー未特定のため、新宿三丁目をデフォルト前提にしてはいけません。データ上の店舗名から立地を推定し、推定できない場合は立地固有の断定を避けること。`
  }
  return `【分析対象店舗の立地（必須・この店舗基準）】
店舗キー: ${profile.storeKey}
店舗名: ${profile.name}${storeNameHint && storeNameHint !== profile.name ? `（表示名: ${storeNameHint}）` : ""}
エリア: ${profile.area}
住所: ${profile.address}
立地特性: ${profile.locationNotes}

重要:
- このジャーナル／売上データの分析は、上記店舗の住所・エリアを基準に行うこと。
- 新宿三丁目の姉妹店密集を全店共通の前提にしてはいけない（該当エリアの店だけが使える論点）。
- 四谷・荒木町・新橋・丸の内・水道橋・刈谷など、店舗ごとに客層・時間帯・競合・回遊が異なる。`
}
