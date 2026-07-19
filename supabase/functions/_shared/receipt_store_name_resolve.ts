/**
 * レシート・帳票から得た店名を、既知のグループ店舗名へ正規化する。
 * OCR の語順入れ替え・綴り揺れに対し、既存店舗一覧（MARUGO_GROUP_STORE_OPTIONS）へ寄せる。
 */
import { normalizeInlineText } from './receipt_parse.ts'
import { MARUGO_GROUP_STORE_OPTIONS } from './marugo_group_stores.ts'
import { RECEIPT_SHEETS_STORE_CATALOG } from './receipt_sheets_store_catalog.ts'

/** 店名末尾のローマ数字を算用数字へ（クラウディアⅡ／クラウディアII ＝ クラウディア2）。
 *  実害: 2026-07-20 クラウディア2の日計精算レポートが、印字名「クラウディアⅡ」と登録名
 *  「クラウディア2」の不一致で“別店舗のレシート”＝経費候補と判定され、売上が登録されなかった。 */
function normalizeTrailingRomanNumeral(value: string): string {
  return String(value || '')
    .replace(/[ⅠⅡⅢⅣⅤ]/g, (m) => String('ⅠⅡⅢⅣⅤ'.indexOf(m) + 1))
    .replace(/[ⅰⅱⅲⅳⅴ]/g, (m) => String('ⅰⅱⅲⅳⅴ'.indexOf(m) + 1))
    // 半角の I を並べた表記は、カタカナ/ひらがな/漢字の直後かつ末尾のときだけ数字とみなす。
    .replace(/([ぁ-んァ-ヶ一-龠々])(III|II)(?=\s*$)/gi, (_m, head: string, roman: string) => `${head}${roman.length}`)
}

export function normalizeStoreToken(value: string): string {
  return normalizeTrailingRomanNumeral(String(value || ''))
    .toLowerCase()
    .replace(/株式会社ワルツ/g, '')
    .replace(/[^0-9a-zぁ-んァ-ヶ一-龠々]/g, '')
    .trim()
}

/** レシートに英字で出るブランド。partitionKey は Webhook の store_partition_key。 */
const RECEIPT_LATIN_BRAND_PROFILES: ReadonlyArray<{
  displayName: string
  latinCanonical: string
  partitionKey: string
}> = [
  {
    displayName: 'Bistro CAVACAVA',
    latinCanonical: 'bistrocavacava',
    partitionKey: 'bistrocavacava',
  },
]

/**
 * Webhook 登録名（カタカナ等）とレシート OCR 名（英字等）を同一店舗として扱う。
 * 公式サイト（05-marugo-group.com）の各店ページから抽出したアルファベット表記を網羅。
 * partitionKey は store_webhook_tables の store_partition_key を小文字化したもの
 * （照合時 registryPk も小文字化されるため）。
 */
const RECEIPT_BRAND_PARTITION_ALIASES: ReadonlyArray<{
  partitionKey: string
  labels: string[]
}> = [
  // 単独「マルゴ」: 四谷/新橋/丸の内 等の部分一致で誤爆しないよう完全一致のみで運用する
  {
    partitionKey: 'marugo',
    labels: ['マルゴ', 'MARUGO'],
  },
  {
    partitionKey: 'marugosecond',
    labels: ['マルゴ セカンド', 'マルゴセカンド', 'マルゴ2', 'MARUGO II', 'MARUGOII', 'MARUGO2', 'MARUGO SECOND'],
  },
  {
    partitionKey: 'marugogrande',
    labels: ['マルゴ グランデ', 'マルゴグランデ', 'MARUGO GRANDE', 'MARUGOGRANDE'],
  },
  {
    partitionKey: 'sannanaichi',
    labels: ['サンナナイチ バル', 'サンナナイチバル', '371BAR', '371 BAR', 'SAN NANA ICHI BAR', 'SANNANAICHI'],
  },
  {
    partitionKey: 'shenlong',
    labels: ['シェンロン&クラウディア', 'シェンロンクラウディア', 'シェンロン', 'X&C', 'XENLON TOKYO', 'XENLON', 'XENLON&CLAUDIA'],
  },
  {
    partitionKey: 'claudia2',
    labels: [
      'クラウディア2',
      'クラウディアツー',
      // レシート印字は「クラウディアⅡ」（ローマ数字）。登録名「クラウディア2」と綴りが違う。
      'クラウディアⅡ',
      'クラウディアII',
      'Pizzeria Claudia2',
      'PIZZERIA CLAUDIA2',
      'CLAUDIA2',
      'CLAUDIA II',
    ],
  },
  {
    partitionKey: 'sauvage',
    labels: ['ソバージュ', 'SOBA-JU', 'SOBAJU', 'SOBA JU'],
  },
  {
    partitionKey: 'barpelota',
    labels: ['バルぺロタ', 'バルペロタ', 'BAR PELOTA', 'BARPELOTA', 'PELOTA'],
  },
  {
    partitionKey: 'briccola',
    labels: ['トラットリア ブリッコラ', 'トラットリアブリッコラ', 'TRATTORIA Briccola', 'TRATTORIA BRICCOLA', 'BRICCOLA'],
  },
  {
    partitionKey: 'violette',
    labels: ['ヴィオレット', 'バイオレット', 'Bar Violet', 'BAR VIOLET', 'BARVIOLET', 'VIOLET', 'VIOLETTE'],
  },
  {
    partitionKey: 'marugootto',
    labels: ['マルゴ オット', 'マルゴオット', 'MARUGO-OTTO', 'MARUGO OTTO', 'MARUGOOTTO'],
  },
  {
    partitionKey: 'donaiya',
    labels: ['元祖どないや 新宿三丁目店', '元祖どないや', 'どないや', 'どないや 新宿三丁目店', 'どないや新宿三丁目店', 'DONAIYA'],
  },
  {
    partitionKey: 'marugoyotsuya',
    labels: ['マルゴ 四谷', 'マルゴ四谷', 'マルコ四谷', 'マルコ 四谷', 'マルコ四谷名', 'MARUGO YOTSUYA', 'MARUGOYOTSUYA'],
  },
  {
    partitionKey: 'sushikoruri',
    labels: ['鮨こるり', 'すしこるり', 'SUSHI KORURI', 'SUSHIKORURI', 'KORURI'],
  },
  {
    partitionKey: 'bistrocavacava',
    labels: [
      'BISTRO CAVA CAVA',
      'BISTRO CAVA,CAVA',
      'BISTROCAVACAVA',
      'CAVA CAVA',
      'CAVA,CAVA',
      'CAVA.CAVA',
      'ビストロ サヴァサヴァ',
      'ビストロサヴァサヴァ',
      'サヴァサヴァ',
      'ÇAVA ÇAVA',
    ],
  },
  {
    partitionKey: 'marugos', // DB: marugoS（照合は小文字化されるため小文字キー）
    labels: ['マルゴエス', 'マルゴ エス', 'マルゴ S', 'MARUGO S', 'MARUGOS'],
  },
  {
    partitionKey: 'marugoshinbashi',
    labels: ['マルゴ 新橋', 'マルゴ新橋', 'マルコ新橋', 'マルコ 新橋', 'MARUGO SHINBASHI', 'MARUGOSHINBASHI'],
  },
  {
    partitionKey: 'marugomarunouchi',
    labels: ['マルゴ丸の内', 'マルゴ 丸の内', 'マルコ丸の内', 'MARUGO MARUNOUCHI', 'MARUGOMARUNOUCHI'],
  },
  {
    partitionKey: 'yakinikumarugo',
    labels: ['焼肉マルゴ', '焼肉 マルゴ', 'Yakiniku MARUGO', 'YAKINIKU MARUGO', 'YAKINIKUMARUGO', '焼肉MARUGO'],
  },
  {
    partitionKey: 'erics',
    labels: [
      'エリックスバイエリックトロション',
      'エリックス',
      'エリックトロション',
      "eric'S by Eric Trochon",
      'ERICS',
      "ERIC'S",
      'ERIC TROCHON',
    ],
  },
  {
    partitionKey: 'mitan',
    labels: ['ミタン', 'MITAN'],
  },
  {
    partitionKey: 'marugod', // DB: marugoD（照合は小文字化されるため小文字キー）
    labels: ['マルゴ D', 'マルゴD', 'マルゴ ディー', 'MARUGO-D', 'MARUGO D', 'MARUGOD'],
  },
]

const STORE_ALIAS_MAP: Record<string, string> = {
  cavacava: 'Bistro CAVACAVA',
  cava: 'Bistro CAVACAVA',
  cavabistro: 'Bistro CAVACAVA',
  cavacavabistro: 'Bistro CAVACAVA',
  bistrocavacava: 'Bistro CAVACAVA',
  bistrocava: 'Bistro CAVACAVA',
  marugod: 'マルゴ D',
  'marugo d': 'マルゴ D',
  sobaju: 'ソバージュ',
  'soba-ju': 'ソバージュ',
  '371bar': 'サンナナイチ バル',
  バルペロタ: 'バルぺロタ',
  どないや新宿三丁目店: '元祖どないや 新宿三丁目店',
  マルゴオット: 'マルゴ オット',
  マルゴグランデ: 'マルゴ グランデ',
  マルゴセカンド: 'マルゴ セカンド',
  マルゴ四谷: 'マルゴ 四谷',
  マルゴ新橋: 'マルゴ 新橋',
  マルコ四谷: 'マルゴ 四谷',
  マルコ四谷名: 'マルゴ 四谷',
  マルコ新橋: 'マルゴ 新橋',
}

/** レシート OCR で末尾に付きやすいノイズ（「四谷名」→「四谷」+「名」等） */
const TRAILING_STORE_NAME_OCR_NOISE = /(?:店名|店舗|店|様|名)+$/u

/** マルゴ系で OCR が「マルコ」と読む誤り＋店舗 suffix */
const MARUGO_OCR_LOCATION_SUFFIX =
  /(?:四谷|新橋|丸の内|セカンド|グランデ|オット|四ツ谷|四ッ谷)/

/**
 * レシート店名 OCR の前処理（Webhook 照合・正規化の前に適用）
 */
export function sanitizeReceiptOcrStoreName(raw: string): string {
  let s = String(raw || '').trim().normalize('NFKC')
  if (!s) return s
  s = s.replace(/[,，、.．]/g, ' ').replace(/\s+/g, ' ').trim()
  s = s.replace(TRAILING_STORE_NAME_OCR_NOISE, '').trim()
  if (/^マルコ/u.test(s) && MARUGO_OCR_LOCATION_SUFFIX.test(s)) {
    s = s.replace(/^マルコ/u, 'マルゴ')
  }
  return s.trim()
}

function tokenSimilarityScore(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  if (maxLen < 4) return 0
  const dist = levenshtein(a, b)
  return 1 - dist / maxLen
}

/** 既知店舗一覧へのあいまい一致（1〜2文字の OCR 誤り） */
function tryFuzzyMatchMarugoGroupStore(normalized: string): string | null {
  if (normalized.length < 4) return null

  type Hit = { store: string; score: number }
  const hits: Hit[] = []

  for (const store of MARUGO_GROUP_STORE_OPTIONS) {
    const norm = normalizeStoreToken(store)
    if (!norm) continue
    const score = tokenSimilarityScore(normalized, norm)
    if (score >= 0.78) hits.push({ store, score })
  }

  if (hits.length === 0) return null
  hits.sort((a, b) => b.score - a.score)
  const best = hits[0]!
  const second = hits[1]
  if (second && best.score - second.score < 0.06) return null
  if (best.score < 0.8 && second) return null
  return best.store
}

function catalogPartitionKeyForDisplayName(displayName: string): string | null {
  for (const [key, label] of Object.entries(RECEIPT_SHEETS_STORE_CATALOG)) {
    if (label === displayName) return key
  }
  return null
}

function extractLatinLettersLower(text: string): string {
  const m = String(text || '').toLowerCase().match(/[a-z]/g)
  return m ? m.join('') : ''
}

function sortedLatinFingerprint(latin: string): string {
  return latin.split('').sort().join('')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const al = a.length
  const bl = b.length
  if (al === 0) return bl
  if (bl === 0) return al
  const row = new Array<number>(bl + 1)
  for (let j = 0; j <= bl; j += 1) row[j] = j
  for (let i = 1; i <= al; i += 1) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= bl; j += 1) {
      const tmp = row[j]!
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + cost)
      prev = tmp
    }
  }
  return row[bl]!
}

/**
 * 英字主体の店名（語順入れ替え・1〜2 文字の OCR 誤り）を既知プロファイルへ寄せる。
 * 曖昧なときは null（一覧外の生表記は返さない）。
 */
function tryMatchReceiptLatinBrand(rawName: string): string | null {
  const latin = extractLatinLettersLower(rawName)
  if (latin.length < 8) return null

  type Hit = { displayName: string; score: number; anagram: boolean }
  const hits: Hit[] = []
  const sortedInput = sortedLatinFingerprint(latin)

  for (const p of RECEIPT_LATIN_BRAND_PROFILES) {
    if (latin === p.latinCanonical || latin.includes(p.latinCanonical) || p.latinCanonical.includes(latin)) {
      hits.push({ displayName: p.displayName, score: 1, anagram: false })
      continue
    }
    if (sortedInput === sortedLatinFingerprint(p.latinCanonical)) {
      hits.push({ displayName: p.displayName, score: 1, anagram: true })
      continue
    }
    const maxLen = Math.max(latin.length, p.latinCanonical.length)
    if (maxLen < 6) continue
    const dist = levenshtein(latin, p.latinCanonical)
    const score = 1 - dist / maxLen
    if (score >= 0.84) hits.push({ displayName: p.displayName, score, anagram: false })
  }
  if (hits.length === 0) return null
  hits.sort((a, b) => b.score - a.score)
  const best = hits[0]!
  const second = hits[1]
  if (second && best.score - second.score < 0.035) return null
  if (!best.anagram && best.score < 0.9 && second) return null
  return best.displayName
}

export function resolveBestStoreName(rawName: string): string | null {
  const trimmed = sanitizeReceiptOcrStoreName(String(rawName || '').trim())
  if (!trimmed) return null

  const normalized = normalizeStoreToken(trimmed)
  if (!normalized) return null

  const aliasHit = STORE_ALIAS_MAP[normalized]
  if (aliasHit) return aliasHit

  const fuzzyHit = tryFuzzyMatchMarugoGroupStore(normalized)
  if (fuzzyHit) return fuzzyHit

  const candidates = [...MARUGO_GROUP_STORE_OPTIONS]
    .map((store) => ({ store, norm: normalizeStoreToken(store) }))
    .filter((row) => row.norm.length > 0)
    .sort((a, b) => b.norm.length - a.norm.length)

  for (const candidate of candidates) {
    if (normalized.includes(candidate.norm) || candidate.norm.includes(normalized)) {
      return candidate.store
    }
  }

  const latinHit = tryMatchReceiptLatinBrand(trimmed)
  if (latinHit) return latinHit

  /** 店舗一覧に一致しない生の OCR 表記は採用しない */
  return null
}

export function findBestStoreNameInText(text: string): string | null {
  const normalized = normalizeStoreToken(text)
  if (!normalized) return null
  const aliasKeys = Object.keys(STORE_ALIAS_MAP).sort((a, b) => b.length - a.length)
  for (const key of aliasKeys) {
    if (normalized.includes(key)) return STORE_ALIAS_MAP[key]
  }
  const candidates = [...MARUGO_GROUP_STORE_OPTIONS]
    .map((store) => ({ store, norm: normalizeStoreToken(store) }))
    .filter((row) => row.norm.length > 0)
    .sort((a, b) => b.norm.length - a.norm.length)
  for (const candidate of candidates) {
    if (normalized.includes(candidate.norm) || candidate.norm.includes(normalized)) {
      return candidate.store
    }
  }
  return tryMatchReceiptLatinBrand(String(text || '').trim())
}

/**
 * @param expand true のとき resolveBestStoreName による正規名展開も含める（入力＝OCR名向け）。
 *   ラベル（既に正規名）側で展開すると "マルゴ"→"マルゴ セカンド" のような貪欲一致で
 *   別店トークンが混入し誤マッチするため、ラベル側は expand=false で呼ぶこと。
 */
function collectNameMatchTokens(rawName: string, expand = true): Set<string> {
  const tokens = new Set<string>()
  const trimmed = sanitizeReceiptOcrStoreName(String(rawName || '').trim())
  if (!trimmed) return tokens

  const norm = normalizeStoreToken(trimmed)
  if (norm) tokens.add(norm)

  if (expand) {
    const resolved = resolveBestStoreName(trimmed)
    if (resolved) {
      const resolvedNorm = normalizeStoreToken(resolved)
      if (resolvedNorm) tokens.add(resolvedNorm)
    }
  }

  const latin = extractLatinLettersLower(trimmed)
  if (latin.length >= 4) tokens.add(latin)

  const compact = normalizeInlineText(trimmed.normalize('NFKC'))
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[・·\-ー—―_]/g, '')
  if (compact) tokens.add(compact)

  return tokens
}

/** ラベル（正規名）用: 貪欲展開なしのトークン化 */
function collectLabelMatchTokens(label: string): Set<string> {
  return collectNameMatchTokens(label, false)
}

/** レシート OCR 店名がどの store_partition_key に属するか（揺らぎ・英字/カタカナ混在） */
export function resolveReceiptNamePartitionKey(rawName: string | null | undefined): string | null {
  const trimmed = String(rawName ?? '').trim()
  if (!trimmed) return null

  const tokens = collectNameMatchTokens(trimmed)

  // Pass 1: 完全一致を最優先（「マルゴ」=marugo が四谷/新橋/丸の内に化けるのを防ぐ）。
  // 例: "MARUGO GRANDE" は marugogrande の完全一致が先に決まり、bare marugo の部分一致では奪われない。
  for (const brand of RECEIPT_BRAND_PARTITION_ALIASES) {
    for (const label of brand.labels) {
      const labelTokens = collectLabelMatchTokens(label)
      for (const t of tokens) {
        if (!t) continue
        for (const lt of labelTokens) {
          if (lt && t === lt) return brand.partitionKey
        }
      }
    }
  }

  // Pass 2: 部分一致は「最も長いラベルトークン（=より具体的）」を優先採用する。
  // 完全一致が無かった場合のみ到達するため、bare marugo(6) より marugoshinbashi(15) 等が勝つ。
  {
    let bestPk: string | null = null
    let bestMatchLen = 0
    for (const brand of RECEIPT_BRAND_PARTITION_ALIASES) {
      for (const label of brand.labels) {
        const labelTokens = collectLabelMatchTokens(label)
        for (const t of tokens) {
          if (!t) continue
          for (const lt of labelTokens) {
            if (!lt) continue
            const minLen = Math.min(t.length, lt.length)
            if (minLen >= 4 && (t.includes(lt) || lt.includes(t))) {
              if (lt.length > bestMatchLen) {
                bestMatchLen = lt.length
                bestPk = brand.partitionKey
              }
            }
          }
        }
      }
    }
    if (bestPk) return bestPk
  }

  const latinBrand = tryMatchReceiptLatinBrand(trimmed)
  if (latinBrand) {
    for (const p of RECEIPT_LATIN_BRAND_PROFILES) {
      if (p.displayName === latinBrand) return p.partitionKey
    }
  }

  const resolved = resolveBestStoreName(trimmed)
  if (resolved) {
    const pk = catalogPartitionKeyForDisplayName(resolved)
    if (pk) return pk
  }

  const sanitizedNorm = normalizeStoreToken(trimmed)
  if (sanitizedNorm.length >= 4) {
    let bestKey: string | null = null
    let bestScore = 0
    let secondScore = 0
    for (const [key, label] of Object.entries(RECEIPT_SHEETS_STORE_CATALOG)) {
      const labelNorm = normalizeStoreToken(label)
      if (!labelNorm) continue
      const score = tokenSimilarityScore(sanitizedNorm, labelNorm)
      if (score > bestScore) {
        secondScore = bestScore
        bestScore = score
        bestKey = key
      } else if (score > secondScore) {
        secondScore = score
      }
    }
    if (bestKey && bestScore >= 0.78 && bestScore - secondScore >= 0.06) {
      return bestKey
    }
  }

  return null
}
