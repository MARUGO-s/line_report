/**
 * レシート・帳票から得た店名を、既知のグループ店舗名へ正規化する。
 * OCR の語順入れ替え・綴り揺れに対し、既存店舗一覧（MARUGO_GROUP_STORE_OPTIONS）へ寄せる。
 */
import { normalizeInlineText } from './receipt_parse.ts'
import { MARUGO_GROUP_STORE_OPTIONS } from './marugo_group_stores.ts'
import { RECEIPT_SHEETS_STORE_CATALOG } from './receipt_sheets_store_catalog.ts'

export function normalizeStoreToken(value: string): string {
  return String(value || '')
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

/** Webhook 登録名（カタカナ等）とレシート OCR 名（英字等）を同一店舗として扱う */
const RECEIPT_BRAND_PARTITION_ALIASES: ReadonlyArray<{
  partitionKey: string
  labels: string[]
}> = [
  {
    partitionKey: 'bistrocavacava',
    labels: [
      'BISTRO CAVA CAVA',
      'BISTROCAVACAVA',
      'CAVA CAVA',
      'ビストロ サヴァサヴァ',
      'ビストロサヴァサヴァ',
      'ÇAVA ÇAVA',
    ],
  },
  {
    partitionKey: 'marugoyotsuya',
    labels: [
      'マルゴ 四谷',
      'マルゴ四谷',
      'マルコ四谷',
      'マルコ 四谷',
      'マルコ四谷名',
    ],
  },
  {
    partitionKey: 'marugoshinbashi',
    labels: ['マルゴ 新橋', 'マルゴ新橋', 'マルコ新橋', 'マルコ 新橋'],
  },
  {
    partitionKey: 'marugomarunouchi',
    labels: ['マルゴ丸の内', 'マルゴ 丸の内', 'マルコ丸の内'],
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

function collectNameMatchTokens(rawName: string): Set<string> {
  const tokens = new Set<string>()
  const trimmed = sanitizeReceiptOcrStoreName(String(rawName || '').trim())
  if (!trimmed) return tokens

  const norm = normalizeStoreToken(trimmed)
  if (norm) tokens.add(norm)

  const resolved = resolveBestStoreName(trimmed)
  if (resolved) {
    const resolvedNorm = normalizeStoreToken(resolved)
    if (resolvedNorm) tokens.add(resolvedNorm)
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

/** レシート OCR 店名がどの store_partition_key に属するか（揺らぎ・英字/カタカナ混在） */
export function resolveReceiptNamePartitionKey(rawName: string | null | undefined): string | null {
  const trimmed = String(rawName ?? '').trim()
  if (!trimmed) return null

  const tokens = collectNameMatchTokens(trimmed)

  for (const brand of RECEIPT_BRAND_PARTITION_ALIASES) {
    for (const label of brand.labels) {
      const labelTokens = collectNameMatchTokens(label)
      for (const t of tokens) {
        for (const lt of labelTokens) {
          if (!t || !lt) continue
          if (t === lt) return brand.partitionKey
          const minLen = Math.min(t.length, lt.length)
          if (minLen >= 4 && (t.includes(lt) || lt.includes(t))) {
            return brand.partitionKey
          }
        }
      }
    }
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
