import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import { toSafeString, type AppError } from './admin_utils.ts'

export type WeatherDay = {
  temp: number | null
  rain: number | null
}

export type WeatherDailyResult = {
  map: Record<string, WeatherDay>
  forecast_limited: boolean
  source: 'cache' | 'archive' | 'forecast' | 'mixed'
  archive_partial: boolean
  cache_hits: number
  fetched_new: number
}

function shiftDateString(dateStr: string, days: number): string {
  const dt = new Date(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(dt.getTime())) return dateStr
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

function jstDateString(offsetDays = 0): string {
  const now = new Date()
  if (offsetDays !== 0) {
    now.setUTCDate(now.getUTCDate() + offsetDays)
  }
  return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
}

function parseDateParts(dateStr: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null
  return { y, m: mo, d }
}

function lastDayOfMonth(y: number, m: number): string {
  const dt = new Date(Date.UTC(y, m, 0))
  return dt.toISOString().slice(0, 10)
}

function enumerateDates(from: string, to: string): string[] {
  if (from > to) return []
  const dates: string[] = []
  for (let d = from; d <= to; d = shiftDateString(d, 1)) dates.push(d)
  return dates
}

function groupContiguousDates(dates: string[]): Array<{ from: string; to: string }> {
  const sorted = [...dates].sort()
  if (sorted.length === 0) return []
  const ranges: Array<{ from: string; to: string }> = []
  let rangeFrom = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i]
    if (shiftDateString(prev, 1) === next) {
      prev = next
      continue
    }
    ranges.push({ from: rangeFrom, to: prev })
    rangeFrom = next
    prev = next
  }
  ranges.push({ from: rangeFrom, to: prev })
  return ranges
}

function splitInclusiveRangeByMonth(from: string, to: string): Array<{ from: string; to: string }> {
  const start = parseDateParts(from)
  const end = parseDateParts(to)
  if (!start || !end || from > to) return []

  const ranges: Array<{ from: string; to: string }> = []
  let y = start.y
  let mo = start.m
  while (y < end.y || (y === end.y && mo <= end.m)) {
    const monthStart = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-01`
    const monthEnd = lastDayOfMonth(y, mo)
    ranges.push({
      from: monthStart < from ? from : monthStart,
      to: monthEnd > to ? to : monthEnd,
    })
    mo += 1
    if (mo > 12) {
      mo = 1
      y += 1
    }
  }
  return ranges
}

function mergeDailyMaps(
  target: Record<string, WeatherDay>,
  dates: string[],
  temps: Array<number | null>,
  rains: Array<number | null>,
) {
  dates.forEach((dateKey, i) => {
    target[dateKey] = {
      temp: temps[i] ?? null,
      rain: rains[i] ?? null,
    }
  })
}

function buildCacheKey(storeKey: string, lat: number, lon: number): string {
  const key = toSafeString(storeKey)
  if (key) return key
  return `${lat.toFixed(4)},${lon.toFixed(4)}`
}

async function fetchOpenMeteoDaily(
  baseUrl: string,
  lat: number,
  lon: number,
  from: string,
  to: string,
  timeoutMs = 20000,
): Promise<Record<string, WeatherDay>> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: from,
    end_date: to,
    daily: 'temperature_2m_max,precipitation_sum',
    timezone: 'Asia/Tokyo',
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}?${params.toString()}`, { signal: controller.signal })
    if (!res.ok) return {}
    const data = await res.json()
    const out: Record<string, WeatherDay> = {}
    mergeDailyMaps(
      out,
      Array.isArray(data?.daily?.time) ? data.daily.time : [],
      Array.isArray(data?.daily?.temperature_2m_max) ? data.daily.temperature_2m_max : [],
      Array.isArray(data?.daily?.precipitation_sum) ? data.daily.precipitation_sum : [],
    )
    return out
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}

async function fetchOpenMeteoJson(url: string, timeoutMs = 20000): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const ARCHIVE_BASE = 'https://archive-api.open-meteo.com/v1/archive'
const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast'
const HISTORICAL_FORECAST_BASE = 'https://historical-forecast-api.open-meteo.com/v1/forecast'

async function fetchForecastPastDaysWindow(
  lat: number,
  lon: number,
  from: string,
  to: string,
  includeForecast: boolean,
): Promise<Record<string, WeatherDay>> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: 'temperature_2m_max,precipitation_sum',
    timezone: 'Asia/Tokyo',
    past_days: '92',
    forecast_days: includeForecast ? '10' : '0',
  })
  const data = await fetchOpenMeteoJson(`${FORECAST_BASE}?${params.toString()}`, 15000)
  if (!data) return {}
  const out: Record<string, WeatherDay> = {}
  mergeDailyMaps(
    out,
    Array.isArray(data?.daily?.time) ? data.daily.time as string[] : [],
    Array.isArray(data?.daily?.temperature_2m_max) ? data.daily.temperature_2m_max as Array<number | null> : [],
    Array.isArray(data?.daily?.precipitation_sum) ? data.daily.precipitation_sum as Array<number | null> : [],
  )
  const filtered: Record<string, WeatherDay> = {}
  for (const [dateKey, value] of Object.entries(out)) {
    if (dateKey >= from && dateKey <= to) filtered[dateKey] = value
  }
  return filtered
}

async function fetchArchiveRange(
  lat: number,
  lon: number,
  from: string,
  to: string,
): Promise<Record<string, WeatherDay>> {
  const chunks = splitInclusiveRangeByMonth(from, to)
  const merged: Record<string, WeatherDay> = {}
  for (const chunk of chunks) {
    let part = await fetchOpenMeteoDaily(ARCHIVE_BASE, lat, lon, chunk.from, chunk.to, 25000)
    if (Object.keys(part).length === 0) {
      part = await fetchOpenMeteoDaily(HISTORICAL_FORECAST_BASE, lat, lon, chunk.from, chunk.to, 25000)
    }
    Object.assign(merged, part)
  }
  return merged
}

async function fetchForecastRange(
  lat: number,
  lon: number,
  from: string,
  to: string,
): Promise<Record<string, WeatherDay>> {
  if (from > to) return {}
  return fetchOpenMeteoDaily(FORECAST_BASE, lat, lon, from, to)
}

type OpenMeteoFetchMeta = {
  map: Record<string, WeatherDay>
  usedArchive: boolean
  usedForecast: boolean
}

async function fetchOpenMeteoExternal(
  lat: number,
  lon: number,
  from: string,
  to: string,
  includeForecast: boolean,
): Promise<OpenMeteoFetchMeta> {
  const todayStr = jstDateString(0)
  const yesterdayStr = jstDateString(-1)
  const archiveCap = jstDateString(-3)
  const forecastCap = jstDateString(10)
  const pastDaysEarliest = jstDateString(-92)

  const safeToHistory = to > yesterdayStr ? yesterdayStr : to
  const result: Record<string, WeatherDay> = {}
  let usedArchive = false
  let usedForecast = false

  const recentPart = await fetchForecastPastDaysWindow(lat, lon, from, to, includeForecast)
  Object.assign(result, recentPart)
  if (Object.keys(recentPart).length > 0) usedForecast = true

  const archiveEnd = safeToHistory > archiveCap ? archiveCap : safeToHistory
  if (from <= archiveEnd && from < pastDaysEarliest) {
    const archiveTo = archiveEnd < pastDaysEarliest
      ? archiveEnd
      : shiftDateString(pastDaysEarliest, -1)
    if (from <= archiveTo) {
      const archivePart = await fetchArchiveRange(lat, lon, from, archiveTo)
      for (const [dateKey, value] of Object.entries(archivePart)) {
        if (!result[dateKey]) result[dateKey] = value
      }
      if (Object.keys(archivePart).length > 0) usedArchive = true
    }
  }

  const forecastHistoryFrom = from > shiftDateString(archiveCap, 1)
    ? from
    : shiftDateString(archiveCap, 1)
  if (forecastHistoryFrom <= safeToHistory) {
    const forecastPart = await fetchForecastRange(lat, lon, forecastHistoryFrom, safeToHistory)
    for (const [dateKey, value] of Object.entries(forecastPart)) {
      if (!result[dateKey]) result[dateKey] = value
    }
    if (Object.keys(forecastPart).length > 0) usedForecast = true
  }

  if (includeForecast) {
    const forecastFutureFrom = todayStr > from ? todayStr : from
    const forecastTo = to > forecastCap ? forecastCap : to
    if (forecastFutureFrom <= forecastTo) {
      const futurePart = await fetchForecastRange(lat, lon, forecastFutureFrom, forecastTo)
      for (const [dateKey, value] of Object.entries(futurePart)) {
        if (!result[dateKey]) result[dateKey] = value
      }
      if (Object.keys(futurePart).length > 0) usedForecast = true
    }
  }

  return { map: result, usedArchive, usedForecast }
}

const WEATHER_CACHE_STORE_PREFIX = 'weather:'

function monthKeysBetween(from: string, to: string): string[] {
  const start = parseDateParts(from)
  const end = parseDateParts(to)
  if (!start || !end || from > to) return []
  const keys: string[] = []
  let y = start.y
  let mo = start.m
  while (y < end.y || (y === end.y && mo <= end.m)) {
    keys.push(`${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}`)
    mo += 1
    if (mo > 12) {
      mo = 1
      y += 1
    }
  }
  return keys
}

function groupEntriesByMonth(entries: Record<string, WeatherDay>): Map<string, Record<string, WeatherDay>> {
  const grouped = new Map<string, Record<string, WeatherDay>>()
  for (const [dateKey, value] of Object.entries(entries)) {
    const ym = dateKey.slice(0, 7)
    if (!grouped.has(ym)) grouped.set(ym, {})
    grouped.get(ym)![dateKey] = value
  }
  return grouped
}

function weatherCacheStoreKey(cacheKey: string): string {
  return `${WEATHER_CACHE_STORE_PREFIX}${cacheKey}`
}

function parseWeatherMonthPayload(raw: unknown): Record<string, WeatherDay> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, WeatherDay> = {}
  for (const [dateKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    out[dateKey] = {
      temp: row.temp == null ? null : Number(row.temp),
      rain: row.rain == null ? null : Number(row.rain),
    }
  }
  return out
}

async function loadCachedWeather(
  supabase: SupabaseClient,
  cacheKey: string,
  from: string,
  to: string,
): Promise<Record<string, WeatherDay>> {
  const months = monthKeysBetween(from, to)
  if (months.length === 0) return {}

  const { data, error } = await supabase
    .from('line_sales_month_budgets')
    .select('target_month, store_closed_dates')
    .eq('store_partition_key', weatherCacheStoreKey(cacheKey))
    .in('target_month', months)

  if (error) {
    console.error('weather cache load failed:', error.message)
    return {}
  }

  const map: Record<string, WeatherDay> = {}
  for (const row of data ?? []) {
    const monthMap = parseWeatherMonthPayload(row.store_closed_dates)
    for (const [dateKey, value] of Object.entries(monthMap)) {
      if (dateKey >= from && dateKey <= to) map[dateKey] = value
    }
  }
  return map
}

async function saveCachedWeather(
  supabase: SupabaseClient,
  cacheKey: string,
  entries: Record<string, WeatherDay>,
): Promise<void> {
  const grouped = groupEntriesByMonth(entries)
  for (const [ym, days] of grouped.entries()) {
    const existingRows = await supabase
      .from('line_sales_month_budgets')
      .select('store_closed_dates')
      .eq('store_partition_key', weatherCacheStoreKey(cacheKey))
      .eq('target_month', ym)
      .maybeSingle()

    const existing = parseWeatherMonthPayload(existingRows.data?.store_closed_dates)
    const merged = { ...existing, ...days }

    const { error } = await supabase
      .from('line_sales_month_budgets')
      .upsert({
        store_partition_key: weatherCacheStoreKey(cacheKey),
        target_month: ym,
        budget_yen: 1,
        weekday_weight: 1,
        pre_holiday_weight: 1,
        holiday_weight: 1,
        store_closed_dates: merged,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'store_partition_key,target_month' })

    if (error) {
      console.error(`weather cache upsert failed (${cacheKey}/${ym}):`, error.message)
    }
  }
}

function parseCoordinate(value: string | null, min: number, max: number): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n
}

function parseDateParam(value: string | null): string | null {
  const s = toSafeString(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

function resolveSourceLabel(
  cacheHits: number,
  fetchedNew: number,
  usedArchive: boolean,
  usedForecast: boolean,
): WeatherDailyResult['source'] {
  if (fetchedNew === 0 && cacheHits > 0) return 'cache'
  if (usedArchive && usedForecast) return 'mixed'
  if (usedArchive) return 'archive'
  if (usedForecast) return 'forecast'
  return cacheHits > 0 ? 'mixed' : 'forecast'
}

export async function fetchWeatherDailyState(
  supabase: SupabaseClient,
  url: URL,
): Promise<WeatherDailyResult> {
  const lat = parseCoordinate(url.searchParams.get('lat'), -90, 90)
  const lon = parseCoordinate(url.searchParams.get('lon'), -180, 180)
  const from = parseDateParam(url.searchParams.get('from'))
  const to = parseDateParam(url.searchParams.get('to'))
  const includeForecast = url.searchParams.get('include_forecast') !== '0'
  const storeKey = toSafeString(url.searchParams.get('store_key'))

  if (lat == null || lon == null || !from || !to) {
    throw { status: 400, message: 'lat, lon, from, to (YYYY-MM-DD) are required.' } satisfies AppError
  }
  if (from > to) {
    throw { status: 400, message: 'from must be on or before to.' } satisfies AppError
  }

  const cacheKey = buildCacheKey(storeKey, lat, lon)
  const todayStr = jstDateString(0)
  const yesterdayStr = jstDateString(-1)
  const archiveCap = jstDateString(-3)
  const forecastCap = jstDateString(10)
  const safeToHistory = to > yesterdayStr ? yesterdayStr : to

  const requestedDates = enumerateDates(from, to)
  const cachedMap = await loadCachedWeather(supabase, cacheKey, from, to)
  const result: Record<string, WeatherDay> = { ...cachedMap }

  const missingDates = requestedDates.filter((d) => !result[d])
  const cacheHits = requestedDates.length - missingDates.length

  let fetchedNew = 0
  let usedArchive = false
  let usedForecast = false

  if (missingDates.length > 0) {
    const missingSet = new Set(missingDates)
    const missingRanges = groupContiguousDates(missingDates)
    for (const range of missingRanges) {
      const external = await fetchOpenMeteoExternal(lat, lon, range.from, range.to, includeForecast)
      usedArchive = usedArchive || external.usedArchive
      usedForecast = usedForecast || external.usedForecast

      const toSave: Record<string, WeatherDay> = {}
      for (const dateKey of enumerateDates(range.from, range.to)) {
        if (!missingSet.has(dateKey)) continue
        const value = external.map[dateKey]
        if (!value) continue
        result[dateKey] = value
        toSave[dateKey] = value
        fetchedNew += 1
      }

      await saveCachedWeather(supabase, cacheKey, toSave)
    }
  }

  let expectedDays = 0
  for (let d = from; d <= safeToHistory; d = shiftDateString(d, 1)) expectedDays += 1
  const filledPast = Object.keys(result).filter((d) => d >= from && d <= safeToHistory).length
  const archivePartial = expectedDays > 0 && filledPast < expectedDays && from < archiveCap

  return {
    map: result,
    forecast_limited: includeForecast && to > forecastCap,
    source: resolveSourceLabel(cacheHits, fetchedNew, usedArchive, usedForecast),
    archive_partial: archivePartial,
    cache_hits: cacheHits,
    fetched_new: fetchedNew,
  }
}
