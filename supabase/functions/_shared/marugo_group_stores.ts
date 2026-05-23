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
