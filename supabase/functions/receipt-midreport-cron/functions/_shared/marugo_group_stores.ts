/** MARUGO GROUP 公式サイト「運営店舗」掲載ブランド（2026年時点の一覧に準拠） */ export const MARUGO_GROUP_STORE_OPTIONS = [
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
  "マルゴ D"
];
const LABEL_SET = new Set(MARUGO_GROUP_STORE_OPTIONS);
export function isMarugoGroupStoreLabel(value) {
  return LABEL_SET.has(value);
}
/** 店舗ごとの緯度・経度（天候データ取得用） store_partition_key → 座標 */ export const STORE_COORDINATES = {
  marugo: {
    lat: 35.6911,
    lon: 139.7060
  },
  marugosecond: {
    lat: 35.6912,
    lon: 139.7066
  },
  marugogrande: {
    lat: 35.6910,
    lon: 139.7058
  },
  sannanaichi: {
    lat: 35.6907,
    lon: 139.7062
  },
  shenlong: {
    lat: 35.6907,
    lon: 139.7064
  },
  claudia2: {
    lat: 35.6912,
    lon: 139.7065
  },
  sauvage: {
    lat: 35.6911,
    lon: 139.7064
  },
  barpelota: {
    lat: 35.6892,
    lon: 139.7073
  },
  briccola: {
    lat: 35.6919,
    lon: 139.7067
  },
  violette: {
    lat: 35.6918,
    lon: 139.7068
  },
  marugootto: {
    lat: 35.6931,
    lon: 139.7024
  },
  donaiya: {
    lat: 35.6911,
    lon: 139.7066
  },
  marugoyotsuya: {
    lat: 35.6877,
    lon: 139.7291
  },
  sushikoruri: {
    lat: 35.6877,
    lon: 139.7291
  },
  bistrocavacava: {
    lat: 35.6905,
    lon: 139.7222
  },
  marugoS: {
    lat: 35.7032,
    lon: 139.7522
  },
  marugoshinbashi: {
    lat: 35.6658,
    lon: 139.7562
  },
  marugomarunouchi: {
    lat: 35.6788,
    lon: 139.7631
  },
  yakinikumarugo: {
    lat: 35.6778,
    lon: 139.7614
  },
  erics: {
    lat: 35.6826,
    lon: 139.7643
  },
  mitan: {
    lat: 35.6826,
    lon: 139.7643
  },
  marugoD: {
    lat: 34.9922,
    lon: 137.0127
  }
};
