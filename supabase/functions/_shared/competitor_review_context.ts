import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import {
  isRecord,
  resolveStorePartitionKey,
  roundToScale,
  toSafeString,
  type AppError,
} from './admin_utils.ts'
import { loadStoreRegistry } from './store_receipt_query.ts'

type CompetitorPlaceRow = {
  id: number
  store_partition_key: string
  competitor_name: string
  source: string
  place_id: string | null
  address: string | null
  google_maps_uri: string | null
  lat: number | null
  lng: number | null
  category: string | null
  distance_m: number | null
  is_active: boolean
  sort_order: number
  updated_at: string
}

type CompetitorSnapshotRow = {
  id: number
  competitor_place_id: number
  source: string
  snapshot_date: string
  rating: number | null
  user_ratings_total: number | null
  review_count: number | null
  review_excerpt: string | null
  positive_terms: string[] | null
  negative_terms: string[] | null
  ai_summary: string | null
  updated_at: string
}

type StoreReviewPlaceRow = {
  id: number
  store_partition_key: string
  store_name: string | null
  source: string
  place_id: string | null
  address: string | null
  google_maps_uri: string | null
  website_uri: string | null
  lat: number | null
  lng: number | null
  is_active: boolean
  updated_at: string
}

type StoreReviewSnapshotRow = {
  id: number
  store_review_place_id: number
  source: string
  snapshot_date: string
  rating: number | null
  user_ratings_total: number | null
  review_count: number | null
  review_excerpt: string | null
  positive_terms: string[] | null
  negative_terms: string[] | null
  updated_at: string
}

type StoreReviewProfileRow = {
  id: number
  store_review_place_id: number
  store_partition_key: string
  profile_version: string
  model: string | null
  cuisine_genres: string[] | null
  service_styles: string[] | null
  price_band: string | null
  visit_motives: string[] | null
  customer_segments: string[] | null
  strengths: string[] | null
  weaknesses: string[] | null
  competitor_keywords: string[] | null
  adjacent_competitor_keywords: string[] | null
  excluded_keywords: string[] | null
  summary: string | null
  rag_document: string | null
  dictionary: Record<string, unknown> | null
  source_snapshot_id: number | null
  source_snapshot_date: string | null
  generated_at: string
  updated_at: string
}

type NormalizedGooglePlaceDetails = {
  name: string | null
  address: string | null
  googleMapsUri: string | null
  websiteUri: string | null
  lat: number | null
  lng: number | null
  rating: number | null
  userRatingsTotal: number | null
  reviewTexts: string[]
  raw: Record<string, unknown>
}

async function resolveAnalyticsStoreKey(
  supabase: SupabaseClient,
  rawStoreKey: string,
): Promise<string> {
  const storeKey = toSafeString(rawStoreKey)
  if (!storeKey) {
    throw { status: 400, message: 'store_key is required.' } satisfies AppError
  }
  const registry = await loadStoreRegistry(supabase)
  const registryKeys = registry.map((entry) => entry.store_partition_key)
  return resolveStorePartitionKey(storeKey, registryKeys)
}

function shortText(value: unknown, max = 1000): string | null {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) return null
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function toNullableNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function buildReviewExcerpt(texts: string[]): string | null {
  const joined = texts
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' / ')
  return shortText(joined, 900)
}

function keywordHits(texts: string[], keywords: string[]): string[] {
  const hay = texts.join('\n')
  return keywords.filter((k) => hay.includes(k)).slice(0, 8)
}

function inferPositiveTerms(texts: string[]): string[] {
  return keywordHits(texts, ['美味しい', 'おいしい', '丁寧', '親切', '雰囲気', 'コスパ', '満足', 'おすすめ', '落ち着く'])
}

function inferNegativeTerms(texts: string[]): string[] {
  return keywordHits(texts, ['遅い', '高い', '狭い', 'うるさい', '不満', '残念', '待つ', '接客', '混雑'])
}

function uniqStrings(values: unknown, max = 16): string[] {
  const raw = Array.isArray(values)
    ? values
    : (typeof values === 'string' ? values.split(/[,\n、/]+/) : [])
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of raw) {
    const s = shortText(value, 80)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

function normalizeForKeyword(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[‐‑‒–—―ー－-]/g, '')
}

function inferStoreProfileSeed(place: StoreReviewPlaceRow, latest: StoreReviewSnapshotRow | null): {
  cuisineGenres: string[]
  serviceStyles: string[]
  priceBand: string
  visitMotives: string[]
  customerSegments: string[]
  strengths: string[]
  weaknesses: string[]
  competitorKeywords: string[]
  adjacentCompetitorKeywords: string[]
  excludedKeywords: string[]
} {
  const hay = normalizeForKeyword([
    place.store_name,
    place.address,
    latest?.review_excerpt,
    ...(latest?.positive_terms ?? []),
    ...(latest?.negative_terms ?? []),
  ].filter(Boolean).join(' '))
  const baseExcluded = ['コンビニ', 'スーパー', '薬局', 'ドラッグストア', '銀行', 'ATM', '不動産', '美容', 'サロン', 'ホテル', '駐車場', 'クリニック', '歯科', '病院', '学校', 'オフィス', '小売']
  let cuisineGenres = ['飲食店']
  let serviceStyles = ['レストラン']
  let visitMotives = ['食事', '近隣利用']
  let customerSegments = ['近隣客', '目的来店客']
  let direct = ['レストラン', '居酒屋', 'バル', '飲食店', 'カフェ']
  let adjacent = ['ファストフード', 'フードコート', 'ダイニングバー']
  let priceBand = '未推定'

  if (/寿司|鮨|すし|sushi|koruri/.test(hay)) {
    cuisineGenres = ['寿司', '和食']
    serviceStyles = ['カウンター・テーブル飲食', '食事中心']
    visitMotives = ['寿司・和食の食事', '会食', '接待']
    customerSegments = ['和食目的客', '会食客', '近隣勤務者']
    direct = ['寿司', '鮨', 'すし', '和食', '日本料理', '割烹', '海鮮']
    adjacent = ['居酒屋', '天ぷら', 'そば', 'うどん', '定食']
    priceBand = '中価格帯以上'
  } else if (/焼肉|yakiniku|ホルモン|肉/.test(hay)) {
    cuisineGenres = ['焼肉', '肉料理']
    serviceStyles = ['テーブル飲食', '食事・飲み併用']
    visitMotives = ['焼肉会食', '宴会', '食事']
    customerSegments = ['グループ客', '肉料理目的客', '近隣勤務者']
    direct = ['焼肉', 'ホルモン', '韓国料理', 'ステーキ', '肉料理']
    adjacent = ['居酒屋', 'バル', '鉄板焼き', 'しゃぶしゃぶ']
    priceBand = '中価格帯以上'
  } else if (/ビストロ|bistro|ワイン|wine|バル|bal|イタリアン|フレンチ|cava|pelota|まるごっと|marugo/.test(hay)) {
    cuisineGenres = ['ビストロ', 'イタリアン・洋食', 'ワイン']
    serviceStyles = ['食事・飲み併用', 'カジュアルダイニング']
    visitMotives = ['ワイン利用', '会食', 'デート', '仕事帰りの食事']
    customerSegments = ['ワイン・洋食目的客', '近隣勤務者', '少人数会食客']
    direct = ['ビストロ', 'イタリアン', 'フレンチ', 'ワインバー', 'バル', '洋食', 'ダイニングバー']
    adjacent = ['居酒屋', 'スペイン料理', 'カフェ', '肉バル']
    priceBand = '中価格帯'
  } else if (/カフェ|cafe|喫茶/.test(hay)) {
    cuisineGenres = ['カフェ']
    serviceStyles = ['軽食・喫茶', '短時間利用']
    visitMotives = ['休憩', '軽食', '待ち合わせ']
    customerSegments = ['カフェ利用客', '近隣客', '観光客']
    direct = ['カフェ', '喫茶', 'コーヒー', 'ベーカリー']
    adjacent = ['ファストフード', 'レストラン', 'スイーツ']
    priceBand = '低〜中価格帯'
  } else if (/フードコート|foodcourt|後楽|東京ドーム/.test(hay)) {
    cuisineGenres = ['フードコート内飲食']
    serviceStyles = ['短時間・回転型', '食事中心']
    visitMotives = ['イベント前後の食事', '短時間の食事', 'ファミリー利用']
    customerSegments = ['施設来訪客', 'イベント客', 'ファミリー客']
    direct = ['フードコート', 'レストラン', 'ファストフード', 'カフェ', 'ラーメン', '丼', '和食', '洋食']
    adjacent = ['売店', 'テイクアウト', 'スイーツ']
    priceBand = '低〜中価格帯'
  }

  return {
    cuisineGenres,
    serviceStyles,
    priceBand,
    visitMotives,
    customerSegments,
    strengths: uniqStrings([...(latest?.positive_terms ?? []), 'Google口コミ評価', '立地'], 8),
    weaknesses: uniqStrings(latest?.negative_terms ?? [], 8),
    competitorKeywords: uniqStrings(direct, 18),
    adjacentCompetitorKeywords: uniqStrings(adjacent, 18),
    excludedKeywords: baseExcluded,
  }
}

function compactGoogleRaw(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    id: raw.id ?? raw.place_id ?? null,
    name: raw.displayName ?? raw.name ?? null,
    rating: raw.rating ?? null,
    userRatingCount: raw.userRatingCount ?? raw.user_ratings_total ?? null,
    googleMapsUri: raw.googleMapsUri ?? raw.url ?? null,
    websiteUri: raw.websiteUri ?? raw.website ?? null,
  }
}

function mapPlacesNewResponse(data: Record<string, unknown>): NormalizedGooglePlaceDetails {
  const displayName = isRecord(data.displayName) && typeof data.displayName.text === 'string'
    ? data.displayName.text
    : null
  const location = isRecord(data.location) ? data.location : {}
  const reviewsRaw = Array.isArray(data.reviews) ? data.reviews : []
  const reviewTexts = reviewsRaw
    .map((raw) => {
      if (!isRecord(raw)) return ''
      const text = isRecord(raw.text) ? raw.text.text : null
      return typeof text === 'string' ? text : ''
    })
    .filter(Boolean)
  return {
    name: shortText(displayName, 160),
    address: shortText(data.formattedAddress, 300),
    googleMapsUri: shortText(data.googleMapsUri, 500),
    websiteUri: shortText(data.websiteUri, 500),
    lat: toNullableNumber(location.latitude),
    lng: toNullableNumber(location.longitude),
    rating: toNullableNumber(data.rating),
    userRatingsTotal: toNullableNumber(data.userRatingCount),
    reviewTexts,
    raw: compactGoogleRaw(data),
  }
}

function mapPlacesLegacyResponse(data: Record<string, unknown>): NormalizedGooglePlaceDetails {
  const result = isRecord(data.result) ? data.result : {}
  const geometry = isRecord(result.geometry) ? result.geometry : {}
  const location = isRecord(geometry.location) ? geometry.location : {}
  const reviewsRaw = Array.isArray(result.reviews) ? result.reviews : []
  const reviewTexts = reviewsRaw
    .map((raw) => isRecord(raw) && typeof raw.text === 'string' ? raw.text : '')
    .filter(Boolean)
  return {
    name: shortText(result.name, 160),
    address: shortText(result.formatted_address, 300),
    googleMapsUri: shortText(result.url, 500),
    websiteUri: shortText(result.website, 500),
    lat: toNullableNumber(location.lat),
    lng: toNullableNumber(location.lng),
    rating: toNullableNumber(result.rating),
    userRatingsTotal: toNullableNumber(result.user_ratings_total),
    reviewTexts,
    raw: compactGoogleRaw(result),
  }
}

async function fetchGooglePlaceDetails(placeId: string): Promise<NormalizedGooglePlaceDetails> {
  const apiKey = getGooglePlacesApiKey()
  const id = placeId.replace(/^places\//, '').trim()
  if (!id) {
    throw { status: 400, message: 'place_id is required.' } satisfies AppError
  }

  const newUrl = `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?languageCode=ja`
  const fieldMask = [
    'id',
    'displayName',
    'formattedAddress',
    'location',
    'rating',
    'userRatingCount',
    'reviews',
    'googleMapsUri',
    'websiteUri',
  ].join(',')
  const newRes = await fetch(newUrl, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
    },
  })
  if (newRes.ok) {
    const data = await newRes.json()
    if (isRecord(data)) return mapPlacesNewResponse(data)
  }

  // 旧place_idとの互換性用フォールバック。フロントには返さず、保存するrawも最小化する。
  const legacy = new URL('https://maps.googleapis.com/maps/api/place/details/json')
  legacy.searchParams.set('place_id', id)
  legacy.searchParams.set('language', 'ja')
  legacy.searchParams.set('fields', 'name,rating,user_ratings_total,reviews,formatted_address,geometry,url,website')
  legacy.searchParams.set('key', apiKey)
  const legacyRes = await fetch(legacy.toString())
  const legacyBody = await legacyRes.json().catch(() => null)
  if (!legacyRes.ok || !isRecord(legacyBody) || legacyBody.status !== 'OK') {
    const status = isRecord(legacyBody) ? String(legacyBody.status ?? '') : ''
    throw {
      status: 502,
      message: `Failed to fetch Google Places details${status ? `: ${status}` : ''}.`,
    } satisfies AppError
  }
  return mapPlacesLegacyResponse(legacyBody)
}

function getGooglePlacesApiKey(): string {
  const apiKey = (
    Deno.env.get('GOOGLE_PLACES_API_KEY')
    ?? Deno.env.get('GOOGLE_MAPS_API_KEY')
    ?? Deno.env.get('GOOGLE_API_KEY')
    ?? ''
  ).trim()
  if (!apiKey) {
    throw { status: 500, message: 'GOOGLE_PLACES_API_KEY is not set.' } satisfies AppError
  }
  return apiKey
}

function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  const direct = text.trim()
  try {
    const parsed = JSON.parse(direct)
    return isRecord(parsed) ? parsed : null
  } catch (_) { /* fallback */ }
  const block = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (block) {
    try {
      const parsed = JSON.parse(block[1].trim())
      return isRecord(parsed) ? parsed : null
    } catch (_) { /* fallback */ }
  }
  const balanced = extractFirstBalanced(text, '{', '}')
  if (!balanced) return null
  try {
    const parsed = JSON.parse(balanced)
    return isRecord(parsed) ? parsed : null
  } catch (_) {
    return null
  }
}

function profileRowForAi(profile: StoreReviewProfileRow | null): Record<string, unknown> | null {
  if (!profile) return null
  return {
    summary: profile.summary ?? '',
    cuisine_genres: profile.cuisine_genres ?? [],
    service_styles: profile.service_styles ?? [],
    price_band: profile.price_band ?? '',
    visit_motives: profile.visit_motives ?? [],
    customer_segments: profile.customer_segments ?? [],
    strengths: profile.strengths ?? [],
    weaknesses: profile.weaknesses ?? [],
    competitor_keywords: profile.competitor_keywords ?? [],
    adjacent_competitor_keywords: profile.adjacent_competitor_keywords ?? [],
    excluded_keywords: profile.excluded_keywords ?? [],
    dictionary: profile.dictionary ?? {},
    rag_document: profile.rag_document ?? '',
  }
}

function sanitizeProfilePayload(
  parsed: Record<string, unknown> | null,
  place: StoreReviewPlaceRow,
  latest: StoreReviewSnapshotRow | null,
  model: string | null,
  source: 'ai' | 'fallback',
): Record<string, unknown> {
  const seed = inferStoreProfileSeed(place, latest)
  const cuisineGenres = uniqStrings(parsed?.cuisine_genres, 12)
  const serviceStyles = uniqStrings(parsed?.service_styles, 12)
  const visitMotives = uniqStrings(parsed?.visit_motives, 12)
  const customerSegments = uniqStrings(parsed?.customer_segments, 12)
  const strengths = uniqStrings(parsed?.strengths, 12)
  const weaknesses = uniqStrings(parsed?.weaknesses, 12)
  const competitorKeywords = uniqStrings(parsed?.competitor_keywords, 20)
  const adjacentKeywords = uniqStrings(parsed?.adjacent_competitor_keywords, 20)
  const excludedKeywords = uniqStrings(parsed?.excluded_keywords, 20)
  const summary = shortText(parsed?.summary, 700)
    || `${place.store_name || '自店舗'}は${seed.cuisineGenres.join('・')}系の店舗として扱います。`
  const ragDocument = shortText(parsed?.rag_document, 2400)
    || [
      `店舗名: ${place.store_name || ''}`,
      `住所: ${place.address || ''}`,
      `推定ジャンル: ${seed.cuisineGenres.join('、')}`,
      `提供形態: ${seed.serviceStyles.join('、')}`,
      `来店動機: ${seed.visitMotives.join('、')}`,
      latest?.rating != null ? `Google評価: ${latest.rating} / 口コミ ${latest.user_ratings_total ?? 0}件` : '',
      latest?.review_excerpt ? `口コミ抜粋: ${latest.review_excerpt}` : '',
    ].filter(Boolean).join('\n')

  const direct = competitorKeywords.length ? competitorKeywords : seed.competitorKeywords
  const adjacent = adjacentKeywords.length ? adjacentKeywords : seed.adjacentCompetitorKeywords
  const excluded = excludedKeywords.length ? excludedKeywords : seed.excludedKeywords
  return {
    model,
    cuisine_genres: cuisineGenres.length ? cuisineGenres : seed.cuisineGenres,
    service_styles: serviceStyles.length ? serviceStyles : seed.serviceStyles,
    price_band: shortText(parsed?.price_band, 80) || seed.priceBand,
    visit_motives: visitMotives.length ? visitMotives : seed.visitMotives,
    customer_segments: customerSegments.length ? customerSegments : seed.customerSegments,
    strengths: strengths.length ? strengths : seed.strengths,
    weaknesses: weaknesses.length ? weaknesses : seed.weaknesses,
    competitor_keywords: direct,
    adjacent_competitor_keywords: adjacent,
    excluded_keywords: excluded,
    summary,
    rag_document: ragDocument,
    dictionary: {
      source,
      direct_keywords: direct,
      adjacent_keywords: adjacent,
      excluded_keywords: excluded,
      cuisine_genres: cuisineGenres.length ? cuisineGenres : seed.cuisineGenres,
      visit_motives: visitMotives.length ? visitMotives : seed.visitMotives,
      rule: 'direct_keywordsを同ジャンル・直接競合として最優先、adjacent_keywordsを周辺競合として次点、excluded_keywordsは原則除外。',
    },
    source_snapshot_id: latest?.id ?? null,
    source_snapshot_date: latest?.snapshot_date ?? null,
    generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

async function buildStoreReviewProfilePayload(
  place: StoreReviewPlaceRow,
  latest: StoreReviewSnapshotRow | null,
): Promise<Record<string, unknown>> {
  const groqKey = String(Deno.env.get('GROQ_API_KEY') || '').trim()
  const model = String(Deno.env.get('STORE_PROFILE_MODEL') || Deno.env.get('COMPETITOR_CLASSIFY_MODEL') || 'llama-3.3-70b-versatile').trim()
  if (!groqKey) return sanitizeProfilePayload(null, place, latest, null, 'fallback')

  const input = {
    store_name: place.store_name,
    address: place.address,
    website_uri: place.website_uri,
    rating: latest?.rating ?? null,
    user_ratings_total: latest?.user_ratings_total ?? null,
    review_excerpt: latest?.review_excerpt ?? null,
    positive_terms: latest?.positive_terms ?? [],
    negative_terms: latest?.negative_terms ?? [],
  }
  const prompt = `あなたは飲食店の商圏・口コミ・競合分析担当です。以下の自店舗資料を一度だけ詳しく精査し、あとでRAG風コンテキストとして再利用できる「店舗理解資料」と「競合辞典」を作ってください。

自店舗資料:
${JSON.stringify(input, null, 2)}

要件:
- 店舗名だけに頼らず、住所、口コミ抜粋、評価、ポジティブ/ネガティブ語から業態・客層・来店動機を推定する
- 競合検索で優先すべき同ジャンル/同利用シーンのキーワードを competitor_keywords に入れる
- ジャンルは違っても客を奪い合う周辺競合を adjacent_competitor_keywords に入れる
- 飲食競合ではない施設や自店誤検出を除外しやすい語を excluded_keywords に入れる
- rag_document は、後続の競合判定AIが自店舗を理解するための保存資料として、具体的に書く

以下のJSONのみで返してください:
{
  "summary": "店舗理解の要約",
  "cuisine_genres": ["主要ジャンル"],
  "service_styles": ["提供形態"],
  "price_band": "価格帯推定",
  "visit_motives": ["来店動機"],
  "customer_segments": ["客層"],
  "strengths": ["口コミや情報から見た強み"],
  "weaknesses": ["注意点"],
  "competitor_keywords": ["直接競合キーワード"],
  "adjacent_competitor_keywords": ["周辺競合キーワード"],
  "excluded_keywords": ["除外キーワード"],
  "rag_document": "保存資料本文"
}`

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2200,
      }),
    })
    if (!res.ok) return sanitizeProfilePayload(null, place, latest, model, 'fallback')
    const json = await res.json()
    const rawText: string = json?.choices?.[0]?.message?.content ?? ''
    return sanitizeProfilePayload(parseFirstJsonObject(rawText), place, latest, model, 'ai')
  } catch (_) {
    return sanitizeProfilePayload(null, place, latest, model, 'fallback')
  }
}

async function fetchLatestStoreReviewProfile(
  supabase: SupabaseClient,
  storeKeyRaw: string,
): Promise<StoreReviewProfileRow | null> {
  const storeKey = await resolveAnalyticsStoreKey(supabase, storeKeyRaw)
  const { data, error } = await supabase
    .from('store_review_profiles')
    .select('id, store_review_place_id, store_partition_key, profile_version, model, cuisine_genres, service_styles, price_band, visit_motives, customer_segments, strengths, weaknesses, competitor_keywords, adjacent_competitor_keywords, excluded_keywords, summary, rag_document, dictionary, source_snapshot_id, source_snapshot_date, generated_at, updated_at')
    .eq('store_partition_key', storeKey)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw { status: 500, message: `Failed to fetch store review profile: ${error.message}` } satisfies AppError
  }
  return (data && isRecord(data) ? data : null) as StoreReviewProfileRow | null
}

async function upsertStoreReviewProfileFromSnapshot(
  supabase: SupabaseClient,
  storeKey: string,
  place: StoreReviewPlaceRow,
  latest: StoreReviewSnapshotRow | null,
): Promise<StoreReviewProfileRow> {
  const payload = await buildStoreReviewProfilePayload(place, latest)
  const patch = {
    store_review_place_id: place.id,
    store_partition_key: storeKey,
    profile_version: 'store-review-profile-v1',
    ...payload,
  }
  const { data, error } = await supabase
    .from('store_review_profiles')
    .upsert(patch, { onConflict: 'store_review_place_id' })
    .select('id, store_review_place_id, store_partition_key, profile_version, model, cuisine_genres, service_styles, price_band, visit_motives, customer_segments, strengths, weaknesses, competitor_keywords, adjacent_competitor_keywords, excluded_keywords, summary, rag_document, dictionary, source_snapshot_id, source_snapshot_date, generated_at, updated_at')
    .single()
  if (error) {
    throw { status: 500, message: `Failed to save store review profile: ${error.message}` } satisfies AppError
  }
  return data as StoreReviewProfileRow
}

type NearbyCandidate = {
  place_id: string
  name: string | null
  address: string | null
  google_maps_uri: string | null
  website_uri: string | null
  lat: number | null
  lng: number | null
  rating: number | null
  user_ratings_total: number | null
  ai_is_competitor: boolean | null
  ai_confidence: 'high' | 'medium' | 'low' | null
  ai_reason: string | null
  ai_genre_match: boolean | null
}

function isSameBrandCandidate(candidateName: string, storeName: string): boolean {
  const c = normalizeForKeyword(candidateName)
  const s = normalizeForKeyword(storeName)
  if (!c || !s) return false
  return c === s || c.includes(s) || s.includes(c)
}

function keywordMatch(text: string, keywords: string[]): string | null {
  const hay = normalizeForKeyword(text)
  for (const keyword of keywords) {
    const k = normalizeForKeyword(keyword)
    if (k && hay.includes(k)) return keyword
  }
  return null
}

function applyProfileDictionaryClassification(
  candidates: NearbyCandidate[],
  storeName: string,
  profile: StoreReviewProfileRow | null,
): NearbyCandidate[] {
  if (!profile) return candidates
  const direct = uniqStrings(profile.competitor_keywords, 24)
  const adjacent = uniqStrings(profile.adjacent_competitor_keywords, 24)
  const excluded = uniqStrings(profile.excluded_keywords, 24)
  if (!direct.length && !adjacent.length && !excluded.length) return candidates

  return candidates.map((candidate) => {
    const text = [candidate.name, candidate.address].filter(Boolean).join(' ')
    if (isSameBrandCandidate(candidate.name || '', storeName)) {
      return {
        ...candidate,
        ai_is_competitor: false,
        ai_confidence: 'high',
        ai_genre_match: false,
        ai_reason: '保存済み店舗理解資料上の自店舗名と近く、自店または同一ブランドの可能性が高いため除外。',
      }
    }
    const excludedHit = keywordMatch(text, excluded)
    const directHit = keywordMatch(text, direct)
    const adjacentHit = keywordMatch(text, adjacent)
    if (directHit) {
      return {
        ...candidate,
        ai_is_competitor: true,
        ai_confidence: 'high',
        ai_genre_match: true,
        ai_reason: `保存済み店舗理解資料の直接競合辞典「${directHit}」に該当し、同じ来店動機・客層で比較されやすい。`,
      }
    }
    if (adjacentHit) {
      return {
        ...candidate,
        ai_is_competitor: true,
        ai_confidence: 'medium',
        ai_genre_match: false,
        ai_reason: `保存済み店舗理解資料の周辺競合辞典「${adjacentHit}」に該当し、ジャンルは違っても食事・飲み需要を奪い合う。`,
      }
    }
    if (excludedHit) {
      return {
        ...candidate,
        ai_is_competitor: false,
        ai_confidence: 'high',
        ai_genre_match: false,
        ai_reason: `保存済み店舗理解資料の除外辞典「${excludedHit}」に該当し、飲食の直接競合ではない可能性が高い。`,
      }
    }
    return {
      ...candidate,
      ai_is_competitor: candidate.ai_is_competitor ?? null,
      ai_confidence: candidate.ai_confidence ?? 'low',
      ai_genre_match: candidate.ai_genre_match ?? null,
      ai_reason: candidate.ai_reason ?? '保存済み店舗理解資料の競合辞典には明確に該当しないため、Google Places上の飲食候補として低優先で確認対象にしています。',
    }
  })
}

function extractFirstBalanced(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open)
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function extractClassifications(text: string): { classifications: unknown[] } | null {
  // 1. ```json ... ``` ブロックがあれば最優先でパースを試みる
  const mdMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (mdMatch) {
    const content = mdMatch[1].trim()
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) return { classifications: parsed }
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).classifications)) {
        return parsed as { classifications: unknown[] }
      }
    } catch (_) { /* ignore and fallback */ }
  }

  // 2. テキスト内のすべての { または [ の出現位置について、有効な JSON が取れるか試す
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      const str = extractFirstBalanced(text.slice(i), '{', '}')
      if (str) {
        try {
          const parsed = JSON.parse(str)
          if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).classifications)) {
            return parsed as { classifications: unknown[] }
          }
        } catch (_) {}
      }
    } else if (text[i] === '[') {
      const str = extractFirstBalanced(text.slice(i), '[', ']')
      if (str) {
        try {
          const parsed = JSON.parse(str)
          if (Array.isArray(parsed)) {
            return { classifications: parsed }
          }
        } catch (_) {}
      }
    }
  }

  return null
}

async function classifyNearbyWithAI(
  candidates: NearbyCandidate[],
  storeName: string,
  storeAddress: string,
  profile: StoreReviewProfileRow | null,
): Promise<{ candidates: NearbyCandidate[]; debug: unknown }> {
  if (!candidates.length) return { candidates, debug: { skipped: 'no candidates' } }

  const profiledCandidates = applyProfileDictionaryClassification(candidates, storeName, profile)
  const profileForPrompt = profileRowForAi(profile)
  const groqKey = String(Deno.env.get('GROQ_API_KEY') || '').trim()
  if (!groqKey) return { candidates: profiledCandidates, debug: { skipped: 'no groq key', profile_applied: !!profile } }

  const list = profiledCandidates.map((c, i) => ({
    idx: i,
    name: c.name ?? '不明',
    address: c.address ?? '',
    rating: c.rating,
    review_count: c.user_ratings_total,
    dictionary_guess: c.ai_is_competitor == null ? null : {
      is_competitor: c.ai_is_competitor,
      confidence: c.ai_confidence,
      genre_match: c.ai_genre_match,
      reason: c.ai_reason,
    },
  }))

  const selfLabel = [storeName, storeAddress].filter(Boolean).join(' / ') || storeName

  const profileBlock = profileForPrompt
    ? `保存済み店舗理解資料（RAG風コンテキスト。最優先で参照）:\n${JSON.stringify(profileForPrompt, null, 2)}`
    : `保存済み店舗理解資料は未作成です。店名・住所から補助的に推定してください。`

  const prompt = `あなたは飲食店「${selfLabel}」の売上競合分析AIです。以下の保存済み店舗理解資料を最優先の基準として読み込み、その自店舗資料・競合辞典に照らして周辺店舗リストを分析してください。

${profileBlock}

各店舗について次の3項目を判定すること：
1. is_competitor（true/false）: 客数・売上・滞在時間を奪い合う競合とみなせるか
   - 同ビル・同フロア・同フードコート内の飲食店 → 強い競合（high）
   - 近接する飲食店全般（ジャンルが違っても来店動機や時間帯が重なるなら）→ 中〜軽度の競合
   - コンビニ・小売・銀行・非飲食施設 → 競合外（false）
   - 店名に「${storeName}」と同一・類似ブランドを含む → 自店のため除外（false）
2. confidence（high/medium/low）: is_competitor=true の場合の確信度
3. genre_match（true/false）: その店の料理ジャンル・業態が保存済み店舗理解資料上の自店舗業態と同系統（似た客層・似た利用シーン）とみなせるか
   - 例：「${storeName}」が寿司店と推定される場合、他の寿司店・和食店・割烹は true。焼肉店やラーメン店、カフェは false（競合ではあっても系統は別）
   - 例：「${storeName}」が居酒屋・バル系と推定される場合、他の居酒屋・バル・ビアホールは true。ファミレスやファストフードは false
   - 保存済み競合辞典の direct_keywords に該当する場合は原則 true として優先する

reasonの書き方（重要）：
- 「〇〇だから競合」という薄い説明は禁止
- 「どの客層を奪うか」「どんな場面で選ばれるか」「価格帯・業態の重なり」を具体的に1文で
- 例：「同じ和食・日本酒需要を持つ客層と競合し、接待利用の候補として直接比較される」
- 例：「カジュアルな飲み需要を広く吸収するため、アルコール中心の来店動機を奪い合う」

店舗リスト:
${JSON.stringify(list, null, 2)}

以下のJSON形式のみで回答してください（説明文不要）。idxは店舗リストのidxをそのまま返すこと:
{"classifications":[{"idx":0,"is_competitor":true,"confidence":"high","genre_match":true,"reason":"具体的な競合理由を1文で"}]}`

  try {
    const model = String(Deno.env.get('COMPETITOR_CLASSIFY_MODEL') || 'llama-3.3-70b-versatile').trim()
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        // 最大20件 × (idx/is_competitor/confidence/genre_match/reason) を安全に返すための余裕。
        // 1024 だと候補数が多い時にJSON出力が途中で切れ（finish_reason:"length"）、
        // 分類が丸ごと失敗してAIバッジが全滅する不具合があったため引き上げた。
        max_tokens: 3072,
      }),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      return { candidates: profiledCandidates, debug: { http_status: res.status, error: errBody.slice(0, 500), model, profile_applied: !!profile } }
    }
    const json = await res.json()
    const rawText: string = json?.choices?.[0]?.message?.content ?? ''
    const finishReason = json?.choices?.[0]?.finish_reason ?? null
    const parsed = extractClassifications(rawText)
    if (!parsed) {
      return {
        candidates: profiledCandidates,
        debug: { http_status: res.status, finish_reason: finishReason, raw_text: rawText.slice(0, 800), error: 'no valid json', profile_applied: !!profile },
      }
    }

    const classMap = new Map<number, { is_competitor: boolean; confidence: string; reason: string; genre_match: boolean | null }>()
    for (const c of parsed.classifications) {
      if (isRecord(c) && (typeof c.idx === 'number' || typeof c.idx === 'string')) {
        const idx = Number(c.idx)
        if (Number.isInteger(idx) && idx >= 0) {
          classMap.set(idx, {
            is_competitor: Boolean(c.is_competitor),
            confidence: typeof c.confidence === 'string' ? c.confidence : 'medium',
            reason: typeof c.reason === 'string' ? c.reason : '',
            genre_match: typeof c.genre_match === 'boolean' ? c.genre_match : null,
          })
        }
      }
    }

    return {
      debug: { http_status: res.status, finish_reason: finishReason, classified_count: classMap.size, total_count: profiledCandidates.length, model, profile_applied: !!profile },
      candidates: profiledCandidates.map((c, i) => {
        const cls = classMap.get(i)
        if (!cls) return c
        return {
          ...c,
          ai_is_competitor: cls.is_competitor,
          ai_confidence: (cls.confidence === 'high' || cls.confidence === 'medium' || cls.confidence === 'low')
            ? cls.confidence
            : 'medium',
          ai_reason: cls.reason || null,
          ai_genre_match: cls.genre_match,
        }
      }),
    }
  } catch (e) {
    return { candidates: profiledCandidates, debug: { error: String(e), profile_applied: !!profile } }
  }
}

export async function nearbySearchGooglePlaces(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{ candidates: NearbyCandidate[]; _debug?: unknown }> {
  const apiKey = getGooglePlacesApiKey()

  // フードスタジアム東京（東京ドームシティ）をデフォルト座標とする（呼び出し元が座標未送信の場合のフォールバックのみ）
  const lat = Number.isFinite(Number(body.lat)) ? Number(body.lat) : 35.70499
  const lng = Number.isFinite(Number(body.lng)) ? Number(body.lng) : 139.75188
  const radius = Number.isFinite(Number(body.radius)) && Number(body.radius) > 0
    ? Math.min(Number(body.radius), 2000)
    : 300
  const storeName = shortText(body.store_name, 160) || shortText(body.store_key, 120) || '自店舗'
  const storeAddress = shortText(body.address, 300) || ''
  const storeKeyRaw = shortText(body.store_key, 120) || storeName

  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.location',
    'places.rating',
    'places.userRatingCount',
    'places.googleMapsUri',
    'places.websiteUri',
  ].join(',')
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify({
      includedTypes: ['restaurant', 'bar', 'cafe', 'food_court', 'fast_food_restaurant'],
      maxResultCount: 20,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
      languageCode: 'ja',
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw { status: 502, message: `Google Places Nearby Search failed: ${res.status} ${text.slice(0, 300)}` } satisfies AppError
  }

  const data = await res.json()
  const placesRaw: unknown[] = Array.isArray(data.places) ? data.places : []
  const candidates: NearbyCandidate[] = placesRaw
    .filter((p: unknown): p is Record<string, unknown> => isRecord(p))
    .map((p: Record<string, unknown>): NearbyCandidate | null => {
      const displayName = isRecord(p.displayName) && typeof p.displayName.text === 'string'
        ? p.displayName.text
        : null
      const location = isRecord(p.location) ? p.location : {}
      const id = typeof p.id === 'string' ? p.id : null
      if (!id) return null
      return {
        place_id: id,
        name: shortText(displayName, 160),
        address: shortText(p.formattedAddress, 300),
        google_maps_uri: shortText(p.googleMapsUri, 500),
        website_uri: shortText(p.websiteUri, 500),
        lat: toNullableNumber(location.latitude),
        lng: toNullableNumber(location.longitude),
        rating: toNullableNumber(p.rating),
        user_ratings_total: toNullableNumber(p.userRatingCount),
        ai_is_competitor: null,
        ai_confidence: null,
        ai_reason: null,
        ai_genre_match: null,
      } satisfies NearbyCandidate
    })
    .filter((c: NearbyCandidate | null): c is NearbyCandidate => c !== null)

  const profile = await fetchLatestStoreReviewProfile(supabase, storeKeyRaw).catch(() => null)
  const { candidates: classified, debug } = await classifyNearbyWithAI(candidates, storeName, storeAddress, profile)
  const websiteSample = placesRaw.slice(0, 3).map((p: unknown) => isRecord(p) ? {
    name: isRecord(p.displayName) && typeof p.displayName.text === 'string' ? p.displayName.text : null,
    websiteUri: p.websiteUri ?? '(none)',
  } : null)
  const candidateWebsiteSample = classified.slice(0, 3).map((c) => ({ name: c.name, website_uri: c.website_uri }))
  return {
    candidates: classified,
    _debug: {
      ...(isRecord(debug) ? debug : { info: debug }),
      profile_loaded: !!profile,
      profile_updated_at: profile?.updated_at ?? null,
      websiteSample,
      candidateWebsiteSample,
    },
  }
}

function normalizeGooglePlaceCandidate(p: Record<string, unknown>): NearbyCandidate | null {
  const displayName = isRecord(p.displayName) ? p.displayName.text : null
  const location = isRecord(p.location) ? p.location : {}
  const id = typeof p.id === 'string' ? p.id : null
  if (!id) return null
  return {
    place_id: id,
    name: shortText(displayName, 160),
    address: shortText(p.formattedAddress, 300),
    google_maps_uri: shortText(p.googleMapsUri, 500),
    website_uri: shortText(p.websiteUri, 500),
    lat: toNullableNumber(location.latitude),
    lng: toNullableNumber(location.longitude),
    rating: toNullableNumber(p.rating),
    user_ratings_total: toNullableNumber(p.userRatingCount),
    ai_is_competitor: null,
    ai_confidence: null,
    ai_reason: null,
    ai_genre_match: null,
  }
}

export async function searchStoreReviewPlaces(
  body: Record<string, unknown>,
): Promise<{ candidates: NearbyCandidate[]; query: string }> {
  const apiKey = getGooglePlacesApiKey()
  const storeName = shortText(body.store_name ?? body.name, 160)
  const address = shortText(body.address, 300)
  const storeKey = shortText(body.store_key, 120)
  const query = [storeName, address || storeKey, 'レストラン']
    .filter(Boolean)
    .join(' ')
    .trim()
  if (!query) {
    throw { status: 400, message: 'store_name or address is required.' } satisfies AppError
  }

  const lat = Number(body.lat)
  const lng = Number(body.lng)
  const bodyJson: Record<string, unknown> = {
    textQuery: query,
    languageCode: 'ja',
    maxResultCount: 8,
  }
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    bodyJson.locationBias = {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: 900,
      },
    }
  }

  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.location',
    'places.rating',
    'places.userRatingCount',
    'places.googleMapsUri',
    'places.websiteUri',
  ].join(',')
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(bodyJson),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw { status: 502, message: `Google Places Text Search failed: ${res.status} ${text.slice(0, 300)}` } satisfies AppError
  }

  const data = await res.json()
  const placesRaw: unknown[] = Array.isArray(data.places) ? data.places : []
  const candidates = placesRaw
    .filter((p: unknown): p is Record<string, unknown> => isRecord(p))
    .map((p: Record<string, unknown>): NearbyCandidate | null => normalizeGooglePlaceCandidate(p))
    .filter((c: NearbyCandidate | null): c is NearbyCandidate => c !== null)
  return { candidates, query }
}

export async function fetchStoreReviewContext(
  supabase: SupabaseClient,
  storeKeyRaw: string,
): Promise<Record<string, unknown>> {
  const storeKey = await resolveAnalyticsStoreKey(supabase, storeKeyRaw)
  const { data: placeData, error: placeError } = await supabase
    .from('store_review_places')
    .select('id, store_partition_key, store_name, source, place_id, address, google_maps_uri, website_uri, lat, lng, is_active, updated_at')
    .eq('store_partition_key', storeKey)
    .eq('is_active', true)
    .maybeSingle()
  if (placeError) {
    throw { status: 500, message: `Failed to fetch store review place: ${placeError.message}` } satisfies AppError
  }

  const place = (placeData && isRecord(placeData) ? placeData : null) as StoreReviewPlaceRow | null
  let latestSnapshot: StoreReviewSnapshotRow | null = null
  let profile: StoreReviewProfileRow | null = null
  if (place) {
    const { data: snapData, error: snapError } = await supabase
      .from('store_review_snapshots')
      .select('id, store_review_place_id, source, snapshot_date, rating, user_ratings_total, review_count, review_excerpt, positive_terms, negative_terms, updated_at')
      .eq('store_review_place_id', place.id)
      .order('snapshot_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (snapError) {
      throw { status: 500, message: `Failed to fetch store review snapshot: ${snapError.message}` } satisfies AppError
    }
    latestSnapshot = (snapData && isRecord(snapData) ? snapData : null) as StoreReviewSnapshotRow | null
    const { data: profileData, error: profileError } = await supabase
      .from('store_review_profiles')
      .select('id, store_review_place_id, store_partition_key, profile_version, model, cuisine_genres, service_styles, price_band, visit_motives, customer_segments, strengths, weaknesses, competitor_keywords, adjacent_competitor_keywords, excluded_keywords, summary, rag_document, dictionary, source_snapshot_id, source_snapshot_date, generated_at, updated_at')
      .eq('store_review_place_id', place.id)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (profileError) {
      throw { status: 500, message: `Failed to fetch store review profile: ${profileError.message}` } satisfies AppError
    }
    profile = (profileData && isRecord(profileData) ? profileData : null) as StoreReviewProfileRow | null
  }

  const rating = latestSnapshot?.rating != null ? Number(latestSnapshot.rating) : null
  const totalRatings = latestSnapshot?.user_ratings_total != null ? Number(latestSnapshot.user_ratings_total) : null
  const summary = !place
    ? '自店舗のGoogle Place IDが未登録です。自店舗を検索して登録すると、評価と口コミ件数を売上分析に表示します。'
    : rating != null
      ? `自店舗の評価 ${roundToScale(rating, 2)} / 口コミ ${Math.max(0, totalRatings ?? 0).toLocaleString('ja-JP')}件。競合口コミとは別枠で管理しています。`
      : '自店舗は登録済みですが、口コミ情報は未取得です。「自店舗口コミを更新」を押してください。'

  return {
    enabled: true,
    store_key: storeKey,
    registered: !!place,
    place,
    latest_snapshot: latestSnapshot,
    profile,
    rating,
    total_ratings: totalRatings,
    summary,
    generated_at: new Date().toISOString(),
  }
}

async function fetchStoreReviewPlaceAndLatest(
  supabase: SupabaseClient,
  storeKey: string,
): Promise<{ place: StoreReviewPlaceRow | null; latest: StoreReviewSnapshotRow | null; profile: StoreReviewProfileRow | null }> {
  const { data: placeData, error: placeError } = await supabase
    .from('store_review_places')
    .select('id, store_partition_key, store_name, source, place_id, address, google_maps_uri, website_uri, lat, lng, is_active, updated_at')
    .eq('store_partition_key', storeKey)
    .eq('is_active', true)
    .maybeSingle()
  if (placeError) throw { status: 500, message: `Failed to fetch store review place: ${placeError.message}` } satisfies AppError
  const place = (placeData && isRecord(placeData) ? placeData : null) as StoreReviewPlaceRow | null
  if (!place) return { place: null, latest: null, profile: null }

  const { data: snapData, error: snapError } = await supabase
    .from('store_review_snapshots')
    .select('id, store_review_place_id, source, snapshot_date, rating, user_ratings_total, review_count, review_excerpt, positive_terms, negative_terms, updated_at')
    .eq('store_review_place_id', place.id)
    .order('snapshot_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (snapError) throw { status: 500, message: `Failed to fetch store review snapshot: ${snapError.message}` } satisfies AppError

  const { data: profileData, error: profileError } = await supabase
    .from('store_review_profiles')
    .select('id, store_review_place_id, store_partition_key, profile_version, model, cuisine_genres, service_styles, price_band, visit_motives, customer_segments, strengths, weaknesses, competitor_keywords, adjacent_competitor_keywords, excluded_keywords, summary, rag_document, dictionary, source_snapshot_id, source_snapshot_date, generated_at, updated_at')
    .eq('store_review_place_id', place.id)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (profileError) throw { status: 500, message: `Failed to fetch store review profile: ${profileError.message}` } satisfies AppError

  return {
    place,
    latest: (snapData && isRecord(snapData) ? snapData : null) as StoreReviewSnapshotRow | null,
    profile: (profileData && isRecord(profileData) ? profileData : null) as StoreReviewProfileRow | null,
  }
}

export async function ensureStoreReviewProfile(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const storeKey = await resolveAnalyticsStoreKey(supabase, toSafeString(body.store_key))
  const force = body.force === true
  const { place, latest, profile } = await fetchStoreReviewPlaceAndLatest(supabase, storeKey)
  if (!place) {
    return {
      ok: false,
      created: false,
      updated: false,
      reason: '自店舗のGoogle Place IDが未登録です。',
      context: await fetchStoreReviewContext(supabase, storeKey),
    }
  }

  if (profile && !force) {
    return {
      ok: true,
      created: false,
      updated: false,
      profile,
      context: await fetchStoreReviewContext(supabase, storeKey),
    }
  }

  const saved = await upsertStoreReviewProfileFromSnapshot(supabase, storeKey, place, latest)
  return {
    ok: true,
    created: !profile,
    updated: !!profile,
    profile: saved,
    context: await fetchStoreReviewContext(supabase, storeKey),
  }
}

export async function upsertStoreReviewPlace(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const storeKey = await resolveAnalyticsStoreKey(supabase, toSafeString(body.store_key))
  const placeId = shortText(body.place_id, 220)
  const storeName = shortText(body.store_name ?? body.name, 160)
  const address = shortText(body.address, 300)
  const googleMapsUri = shortText(body.google_maps_uri, 500)
  const websiteUri = shortText(body.website_uri, 500)
  const lat = Number(body.lat)
  const lng = Number(body.lng)
  if (!placeId) {
    throw { status: 400, message: 'place_id is required.' } satisfies AppError
  }

  const now = new Date().toISOString()
  const { data: existing, error: existingError } = await supabase
    .from('store_review_places')
    .select('id')
    .eq('store_partition_key', storeKey)
    .eq('is_active', true)
    .maybeSingle()
  if (existingError) {
    throw { status: 500, message: `Failed to check store review place: ${existingError.message}` } satisfies AppError
  }

  const patch = {
    store_partition_key: storeKey,
    store_name: storeName,
    source: 'google_places',
    place_id: placeId,
    address,
    google_maps_uri: googleMapsUri,
    website_uri: websiteUri,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    is_active: true,
    updated_at: now,
  }
  if (existing && isRecord(existing) && Number(existing.id) > 0) {
    const { error } = await supabase
      .from('store_review_places')
      .update(patch)
      .eq('id', Number(existing.id))
    if (error) throw { status: 500, message: `Failed to update store review place: ${error.message}` } satisfies AppError
  } else {
    const { error } = await supabase.from('store_review_places').insert(patch)
    if (error) throw { status: 500, message: `Failed to create store review place: ${error.message}` } satisfies AppError
  }
  return fetchStoreReviewContext(supabase, storeKey)
}

export async function deactivateStoreReviewPlace(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const storeKey = await resolveAnalyticsStoreKey(supabase, toSafeString(body.store_key))
  const { error } = await supabase
    .from('store_review_places')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('store_partition_key', storeKey)
    .eq('is_active', true)
  if (error) throw { status: 500, message: `Failed to delete store review place: ${error.message}` } satisfies AppError
  return fetchStoreReviewContext(supabase, storeKey)
}

export async function refreshStoreReview(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const storeKey = await resolveAnalyticsStoreKey(supabase, toSafeString(body.store_key))
  const { data, error } = await supabase
    .from('store_review_places')
    .select('id, store_partition_key, store_name, source, place_id, address, google_maps_uri, website_uri, lat, lng, is_active, updated_at')
    .eq('store_partition_key', storeKey)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw { status: 500, message: `Failed to fetch store review place: ${error.message}` } satisfies AppError
  const place = (data && isRecord(data) ? data : null) as StoreReviewPlaceRow | null
  if (!place || !place.place_id) {
    return {
      ok: false,
      refreshed: 0,
      errors: ['自店舗のGoogle Place IDが未登録です。'],
      context: await fetchStoreReviewContext(supabase, storeKey),
    }
  }

  const details = await fetchGooglePlaceDetails(String(place.place_id))
  const now = new Date().toISOString()
  const { error: placeErr } = await supabase
    .from('store_review_places')
    .update({
      store_name: details.name || place.store_name,
      address: details.address || place.address,
      google_maps_uri: details.googleMapsUri || place.google_maps_uri,
      website_uri: details.websiteUri || place.website_uri,
      lat: details.lat ?? place.lat,
      lng: details.lng ?? place.lng,
      updated_at: now,
    })
    .eq('id', place.id)
  if (placeErr) throw { status: 500, message: `Failed to update store review place: ${placeErr.message}` } satisfies AppError

  const reviewTexts = details.reviewTexts
  const snapshot = {
    store_review_place_id: place.id,
    source: 'google_places',
    snapshot_date: now.slice(0, 10),
    rating: details.rating,
    user_ratings_total: details.userRatingsTotal,
    review_count: reviewTexts.length,
    review_excerpt: buildReviewExcerpt(reviewTexts),
    positive_terms: inferPositiveTerms(reviewTexts),
    negative_terms: inferNegativeTerms(reviewTexts),
    raw: details.raw,
    updated_at: now,
  }
  const { error: snapErr } = await supabase
    .from('store_review_snapshots')
    .upsert(snapshot, { onConflict: 'store_review_place_id,snapshot_date' })
  if (snapErr) throw { status: 500, message: `Failed to save store review snapshot: ${snapErr.message}` } satisfies AppError

  let profileError: string | null = null
  try {
    const { data: savedSnapshotData, error: savedSnapshotError } = await supabase
      .from('store_review_snapshots')
      .select('id, store_review_place_id, source, snapshot_date, rating, user_ratings_total, review_count, review_excerpt, positive_terms, negative_terms, updated_at')
      .eq('store_review_place_id', place.id)
      .eq('snapshot_date', snapshot.snapshot_date)
      .maybeSingle()
    if (savedSnapshotError) throw savedSnapshotError
    const savedSnapshot = (savedSnapshotData && isRecord(savedSnapshotData) ? savedSnapshotData : null) as StoreReviewSnapshotRow | null
    await upsertStoreReviewProfileFromSnapshot(supabase, storeKey, {
      ...place,
      store_name: details.name || place.store_name,
      address: details.address || place.address,
      google_maps_uri: details.googleMapsUri || place.google_maps_uri,
      website_uri: details.websiteUri || place.website_uri,
      lat: details.lat ?? place.lat,
      lng: details.lng ?? place.lng,
      updated_at: now,
    }, savedSnapshot)
  } catch (e) {
    profileError = e instanceof Error ? e.message : String(e)
  }

  return {
    ok: profileError ? false : true,
    refreshed: 1,
    errors: profileError ? [`店舗理解資料の保存に失敗: ${profileError}`] : [],
    context: await fetchStoreReviewContext(supabase, storeKey),
  }
}

export async function fetchCompetitorReviewContext(
  supabase: SupabaseClient,
  storeKeyRaw: string,
): Promise<Record<string, unknown>> {
  const storeKey = await resolveAnalyticsStoreKey(supabase, storeKeyRaw)
  const { data: placesData, error: placesError } = await supabase
    .from('competitor_places')
    .select('id, store_partition_key, competitor_name, source, place_id, address, google_maps_uri, lat, lng, category, distance_m, is_active, sort_order, updated_at')
    .eq('store_partition_key', storeKey)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('competitor_name', { ascending: true })

  if (placesError) {
    throw { status: 500, message: `Failed to fetch competitors: ${placesError.message}` } satisfies AppError
  }
  const places = (Array.isArray(placesData) ? placesData : []) as CompetitorPlaceRow[]
  const ids = places.map((p) => p.id)
  const latestByPlace = new Map<number, CompetitorSnapshotRow>()
  if (ids.length > 0) {
    const { data: snapshotsData, error: snapshotsError } = await supabase
      .from('competitor_review_snapshots')
      .select('id, competitor_place_id, source, snapshot_date, rating, user_ratings_total, review_count, review_excerpt, positive_terms, negative_terms, ai_summary, updated_at')
      .in('competitor_place_id', ids)
      .order('snapshot_date', { ascending: false })
      .order('created_at', { ascending: false })

    if (snapshotsError) {
      throw { status: 500, message: `Failed to fetch competitor snapshots: ${snapshotsError.message}` } satisfies AppError
    }
    for (const raw of (Array.isArray(snapshotsData) ? snapshotsData : []) as CompetitorSnapshotRow[]) {
      if (!latestByPlace.has(raw.competitor_place_id)) latestByPlace.set(raw.competitor_place_id, raw)
    }
  }

  const competitors = places.map((place) => {
    const latest = latestByPlace.get(place.id) ?? null
    return {
      ...place,
      latest_snapshot: latest,
    }
  })

  const rated = competitors
    .map((c) => c.latest_snapshot)
    .filter((s): s is CompetitorSnapshotRow => !!s && Number.isFinite(Number(s.rating)))
  const avgRating = rated.length
    ? roundToScale(rated.reduce((a, s) => a + Number(s.rating ?? 0), 0) / rated.length, 2)
    : null
  const totalRatings = rated.reduce((a, s) => a + Math.max(0, Number(s.user_ratings_total ?? 0) || 0), 0)
  const highRatingCount = rated.filter((s) => Number(s.rating ?? 0) >= 4.2).length
  let pressureScore = 0
  if (avgRating != null && avgRating >= 4.3) pressureScore += 2
  else if (avgRating != null && avgRating >= 4.0) pressureScore += 1
  if (totalRatings >= 1000) pressureScore += 2
  else if (totalRatings >= 200) pressureScore += 1
  if (highRatingCount >= 2) pressureScore += 1
  if (competitors.length >= 4) pressureScore += 1
  const pressureLevel = pressureScore >= 4 ? 'high' : pressureScore >= 2 ? 'medium' : competitors.length > 0 ? 'low' : 'none'
  const summary = competitors.length === 0
    ? '周辺競合は未登録です。Google Place IDを登録すると、評価と口コミ件数を売上分析に加味できます。'
    : `周辺競合 ${competitors.length}件 / 評価平均 ${avgRating ?? '-'} / 口コミ件数 ${totalRatings.toLocaleString('ja-JP')}件。競合圧力は${pressureLevel === 'high' ? '高め' : pressureLevel === 'medium' ? '中程度' : '低め'}です。`

  return {
    enabled: true,
    store_key: storeKey,
    competitor_count: competitors.length,
    avg_rating: avgRating,
    total_ratings: totalRatings,
    high_rating_count: highRatingCount,
    pressure_level: pressureLevel,
    summary,
    competitors,
    generated_at: new Date().toISOString(),
  }
}

export async function upsertCompetitorPlace(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const storeKey = await resolveAnalyticsStoreKey(supabase, toSafeString(body.store_key))
  const id = Number(body.id)
  const placeId = shortText(body.place_id, 220)
  const competitorName = shortText(body.competitor_name ?? body.name, 160)
  const address = shortText(body.address, 300)
  const category = shortText(body.category, 100)
  const distanceM = Number(body.distance_m)
  const sortOrder = Number(body.sort_order)
  const sourceRaw = toSafeString(body.source) || 'google_places'
  const source = sourceRaw === 'manual' ? 'manual' : 'google_places'

  if (!competitorName && !placeId) {
    throw { status: 400, message: 'competitor_name or place_id is required.' } satisfies AppError
  }

  const patch = {
    store_partition_key: storeKey,
    competitor_name: competitorName || placeId || '未設定',
    source,
    place_id: placeId,
    address,
    category,
    distance_m: Number.isFinite(distanceM) && distanceM >= 0 ? Math.floor(distanceM) : null,
    sort_order: Number.isFinite(sortOrder) ? Math.floor(sortOrder) : 0,
    is_active: true,
    updated_at: new Date().toISOString(),
  }

  if (Number.isInteger(id) && id > 0) {
    const { error } = await supabase
      .from('competitor_places')
      .update(patch)
      .eq('id', id)
      .eq('store_partition_key', storeKey)
    if (error) throw { status: 500, message: `Failed to update competitor: ${error.message}` } satisfies AppError
    return fetchCompetitorReviewContext(supabase, storeKey)
  }

  if (placeId) {
    const { data: existing, error: existingError } = await supabase
      .from('competitor_places')
      .select('id')
      .eq('store_partition_key', storeKey)
      .eq('source', source)
      .eq('place_id', placeId)
      .maybeSingle()
    if (existingError) {
      throw { status: 500, message: `Failed to check competitor: ${existingError.message}` } satisfies AppError
    }
    if (existing && isRecord(existing) && Number(existing.id) > 0) {
      const { error } = await supabase
        .from('competitor_places')
        .update(patch)
        .eq('id', Number(existing.id))
      if (error) throw { status: 500, message: `Failed to update competitor: ${error.message}` } satisfies AppError
      return fetchCompetitorReviewContext(supabase, storeKey)
    }
  }

  const { error } = await supabase.from('competitor_places').insert(patch)
  if (error) throw { status: 500, message: `Failed to create competitor: ${error.message}` } satisfies AppError
  return fetchCompetitorReviewContext(supabase, storeKey)
}

export async function deactivateCompetitorPlace(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const storeKey = await resolveAnalyticsStoreKey(supabase, toSafeString(body.store_key))
  const id = Number(body.id)
  if (!Number.isInteger(id) || id <= 0) {
    throw { status: 400, message: 'id is required.' } satisfies AppError
  }
  const { error } = await supabase
    .from('competitor_places')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('store_partition_key', storeKey)
  if (error) throw { status: 500, message: `Failed to delete competitor: ${error.message}` } satisfies AppError
  return fetchCompetitorReviewContext(supabase, storeKey)
}

export async function refreshCompetitorReviews(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const storeKey = await resolveAnalyticsStoreKey(supabase, toSafeString(body.store_key))
  const id = Number(body.id)
  let query = supabase
    .from('competitor_places')
    .select('id, store_partition_key, competitor_name, source, place_id, address, google_maps_uri, lat, lng, category, distance_m, is_active, sort_order, updated_at')
    .eq('store_partition_key', storeKey)
    .eq('is_active', true)
  if (Number.isInteger(id) && id > 0) query = query.eq('id', id)
  const { data, error } = await query.order('sort_order', { ascending: true })
  if (error) throw { status: 500, message: `Failed to fetch competitors: ${error.message}` } satisfies AppError

  const places = ((Array.isArray(data) ? data : []) as CompetitorPlaceRow[])
    .filter((p) => p.source === 'google_places' && p.place_id)
  let refreshed = 0
  const errors: string[] = []
  const today = new Date().toISOString().slice(0, 10)

  for (const place of places) {
    try {
      const details = await fetchGooglePlaceDetails(String(place.place_id))
      const placePatch = {
        competitor_name: details.name || place.competitor_name,
        address: details.address || place.address,
        google_maps_uri: details.googleMapsUri || place.google_maps_uri,
        lat: details.lat ?? place.lat,
        lng: details.lng ?? place.lng,
        updated_at: new Date().toISOString(),
      }
      const { error: placeErr } = await supabase.from('competitor_places').update(placePatch).eq('id', place.id)
      if (placeErr) throw placeErr

      const reviewTexts = details.reviewTexts
      const snapshot = {
        competitor_place_id: place.id,
        source: 'google_places',
        snapshot_date: today,
        rating: details.rating,
        user_ratings_total: details.userRatingsTotal,
        review_count: reviewTexts.length,
        review_excerpt: buildReviewExcerpt(reviewTexts),
        positive_terms: inferPositiveTerms(reviewTexts),
        negative_terms: inferNegativeTerms(reviewTexts),
        ai_summary: null,
        raw: details.raw,
        updated_at: new Date().toISOString(),
      }
      const { error: snapErr } = await supabase
        .from('competitor_review_snapshots')
        .upsert(snapshot, { onConflict: 'competitor_place_id,snapshot_date' })
      if (snapErr) throw snapErr
      refreshed += 1
    } catch (e) {
      errors.push(`${place.competitor_name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    ok: errors.length === 0,
    refreshed,
    errors,
    context: await fetchCompetitorReviewContext(supabase, storeKey),
  }
}
