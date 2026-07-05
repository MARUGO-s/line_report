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
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    const arrStr = extractFirstBalanced(text, '[', ']')
    if (!arrStr) return null
    try {
      const arr = JSON.parse(arrStr)
      if (Array.isArray(arr)) return { classifications: arr }
    } catch (_) { return null }
  }
  const objStr = extractFirstBalanced(text, '{', '}')
  if (!objStr) return null
  try {
    const obj = JSON.parse(objStr)
    if (typeof obj === 'object' && obj !== null && Array.isArray((obj as Record<string, unknown>).classifications)) {
      return obj as { classifications: unknown[] }
    }
  } catch (_) { return null }
  return null
}

async function classifyNearbyWithAI(
  candidates: NearbyCandidate[],
): Promise<{ candidates: NearbyCandidate[]; debug: unknown }> {
  if (!candidates.length) return { candidates, debug: { skipped: 'no candidates' } }

  const groqKey = String(Deno.env.get('GROQ_API_KEY') || '').trim()
  if (!groqKey) return { candidates, debug: { skipped: 'no groq key' } }

  const list = candidates.map((c, i) => ({
    idx: i,
    name: c.name ?? '不明',
    address: c.address ?? '',
    rating: c.rating,
    review_count: c.user_ratings_total,
  }))

  const prompt = `あなたは東京ドームシティ フードスタジアム内の飲食店「MARUGO S」（クラフトビール・串カツ・ビアホール系カジュアルダイニング、客単価2,500〜4,000円）の売上競合分析AIです。

以下の周辺店舗リストを見て、MARUGO Sへの売上影響を分析してください。

判断基準：
- フードコート内・同ビル内の飲食店 → 強力な競合（高confidence）
- アルコール提供の飲食店・ビアホール系 → 直接競合
- ファストフード・カジュアル飲食 → 軽度競合
- コンビニ・小売・非飲食 → 競合外（false）
- 店名に「MARUGO」を含む → 自店のため除外（false）

reasonの書き方（重要）：
- 「〇〇だから競合」という薄い説明は禁止
- 「どの客層を奪うか」「どんな場面で選ばれるか」「価格帯・業態の重なり」を具体的に1文で
- 例：「ドーム観戦後の打ち上げ需要を直撃、アルコール単価が近くビール好き客層が完全に重複する」
- 例：「ランチ〜ディナー通しで営業し、ファミリー層のカジュアル外食需要を広く吸収するため夜間の集客に影響」
- 例：「同フードコート内で視認性が高く、串揚げ・軽食系メニューで飲み需要の一部を代替される」

店舗リスト:
${JSON.stringify(list, null, 2)}

以下のJSON形式のみで回答してください（説明文不要）。idxは店舗リストのidxをそのまま返すこと:
{"classifications":[{"idx":0,"is_competitor":true,"confidence":"high","reason":"具体的な競合理由を1文で"}]}`

  try {
    const model = String(Deno.env.get('COMPETITOR_CLASSIFY_MODEL') || 'llama-3.3-70b-versatile').trim()
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
      }),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      return { candidates, debug: { http_status: res.status, error: errBody.slice(0, 500), model } }
    }
    const json = await res.json()
    const rawText: string = json?.choices?.[0]?.message?.content ?? ''
    const parsed = extractClassifications(rawText)
    if (!parsed) {
      return { candidates, debug: { http_status: res.status, raw_text: rawText.slice(0, 500), error: 'no valid json' } }
    }

    const classMap = new Map<number, { is_competitor: boolean; confidence: string; reason: string }>()
    for (const c of parsed.classifications) {
      if (isRecord(c) && (typeof c.idx === 'number' || typeof c.idx === 'string')) {
        const idx = Number(c.idx)
        if (Number.isInteger(idx) && idx >= 0) {
          classMap.set(idx, {
            is_competitor: Boolean(c.is_competitor),
            confidence: typeof c.confidence === 'string' ? c.confidence : 'medium',
            reason: typeof c.reason === 'string' ? c.reason : '',
          })
        }
      }
    }

    return {
      debug: { http_status: res.status, classified_count: classMap.size, model },
      candidates: candidates.map((c, i) => {
        const cls = classMap.get(i)
        if (!cls) return c
        return {
          ...c,
          ai_is_competitor: cls.is_competitor,
          ai_confidence: (cls.confidence === 'high' || cls.confidence === 'medium' || cls.confidence === 'low')
            ? cls.confidence
            : 'medium',
          ai_reason: cls.reason || null,
        }
      }),
    }
  } catch (e) {
    return { candidates, debug: { error: String(e) } }
  }
}

export async function nearbySearchGooglePlaces(
  body: Record<string, unknown>,
): Promise<{ candidates: NearbyCandidate[]; _debug?: unknown }> {
  const apiKey = getGooglePlacesApiKey()

  // フードスタジアム東京（東京ドームシティ）をデフォルト座標とする
  const lat = Number.isFinite(Number(body.lat)) ? Number(body.lat) : 35.70499
  const lng = Number.isFinite(Number(body.lng)) ? Number(body.lng) : 139.75188
  const radius = Number.isFinite(Number(body.radius)) && Number(body.radius) > 0
    ? Math.min(Number(body.radius), 2000)
    : 300

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
      } satisfies NearbyCandidate
    })
    .filter((c: NearbyCandidate | null): c is NearbyCandidate => c !== null)

  const { candidates: classified, debug } = await classifyNearbyWithAI(candidates)
  const websiteSample = placesRaw.slice(0, 3).map((p: unknown) => isRecord(p) ? {
    name: isRecord(p.displayName) && typeof p.displayName.text === 'string' ? p.displayName.text : null,
    websiteUri: p.websiteUri ?? '(none)',
  } : null)
  const candidateWebsiteSample = classified.slice(0, 3).map((c) => ({ name: c.name, website_uri: c.website_uri }))
  return { candidates: classified, _debug: { ...(isRecord(debug) ? debug : { info: debug }), websiteSample, candidateWebsiteSample } }
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
    rating,
    total_ratings: totalRatings,
    summary,
    generated_at: new Date().toISOString(),
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

  return {
    ok: true,
    refreshed: 1,
    errors: [],
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
