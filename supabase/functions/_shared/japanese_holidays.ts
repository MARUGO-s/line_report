/**
 * 日本の祝日・振替休日・国民の休日（2022-2028）— analytics.html JAPANESE_HOLIDAYS と同一キー
 */
export const JAPANESE_HOLIDAY_ISO_DATES: readonly string[] = [
  "2022-01-01", "2022-01-10", "2022-02-11", "2022-02-23", "2022-03-21", "2022-04-29", "2022-05-03", "2022-05-04", "2022-05-05",
  "2022-07-18", "2022-08-11", "2022-09-19", "2022-09-23", "2022-10-10", "2022-11-03", "2022-11-23",
  "2023-01-01", "2023-01-02", "2023-01-09", "2023-02-11", "2023-02-23", "2023-03-21", "2023-04-29", "2023-05-03", "2023-05-04",
  "2023-05-05", "2023-07-17", "2023-08-11", "2023-09-18", "2023-09-23", "2023-10-09", "2023-11-03", "2023-11-23",
  "2024-01-01", "2024-01-08", "2024-02-11", "2024-02-12", "2024-02-23", "2024-03-20", "2024-04-29", "2024-05-03", "2024-05-04",
  "2024-05-05", "2024-05-06", "2024-07-15", "2024-08-11", "2024-08-12", "2024-09-16", "2024-09-22", "2024-09-23", "2024-10-14",
  "2024-11-03", "2024-11-04", "2024-11-23",
  "2025-01-01", "2025-01-13", "2025-02-11", "2025-02-23", "2025-02-24", "2025-03-20", "2025-04-29", "2025-05-03", "2025-05-04",
  "2025-05-05", "2025-05-06", "2025-07-21", "2025-08-11", "2025-09-15", "2025-09-23", "2025-10-13", "2025-11-03", "2025-11-23",
  "2025-11-24",
  "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
  "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04",
  "2027-05-05", "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23",
  "2028-01-01", "2028-01-10", "2028-02-11", "2028-02-23", "2028-03-20", "2028-04-29", "2028-05-03", "2028-05-04", "2028-05-05",
  "2028-07-17", "2028-08-11", "2028-09-18", "2028-09-22", "2028-10-09", "2028-11-03", "2028-11-23",
]

let cachedHolidaySet: Set<string> | null = null

/** ハードコード表（2022-2028）。取得失敗時のフォールバック・将来年の補完に使う。 */
export function getJapaneseHolidayDateSet(): Set<string> {
  if (!cachedHolidaySet) {
    cachedHolidaySet = new Set(JAPANESE_HOLIDAY_ISO_DATES)
  }
  return cachedHolidaySet
}

/* ───────────────────────────────────────────────────────────
 * 内閣府「国民の祝日」CSV（公式・正本）をサーバ取得
 *   https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv
 *   - Shift_JIS エンコード
 *   - 形式: 国民の祝日・休日月日,国民の祝日・休日名称 / YYYY/M/D,名称
 *   - モジュール内キャッシュ（TTL）＋短いタイムアウト＋失敗時はハードコード表へフォールバック
 *   - CSV が網羅する年は CSV を正本とし、CSV に無い「将来年」のみハードコード表で補完
 * ─────────────────────────────────────────────────────────── */
const CAO_HOLIDAY_CSV_URL = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv"
const HOLIDAY_LIVE_TTL_MS = 12 * 60 * 60 * 1000
const HOLIDAY_FETCH_TIMEOUT_MS = 4000

export type JapaneseHolidaySource = "cao_csv" | "fallback_hardcoded"

interface HolidayLiveCache {
  map: Map<string, string>
  fetchedAt: number
  source: JapaneseHolidaySource
}

let holidayLiveCache: HolidayLiveCache | null = null
let holidayInFlight: Promise<HolidayLiveCache> | null = null

function buildHardcodedHolidayMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const d of JAPANESE_HOLIDAY_ISO_DATES) map.set(d, "")
  return map
}

function parseCaoHolidayCsv(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const commaIdx = line.indexOf(",")
    if (commaIdx < 0) continue
    const rawDate = line.slice(0, commaIdx).trim()
    const name = line.slice(commaIdx + 1).trim()
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(rawDate)
    if (!m) continue // ヘッダ行・空行などはスキップ
    const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`
    map.set(iso, name)
  }
  return map
}

async function fetchCaoHolidayMap(): Promise<Map<string, string>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HOLIDAY_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(CAO_HOLIDAY_CSV_URL, { signal: controller.signal })
    if (!res.ok) throw new Error(`CAO holiday CSV HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    const text = new TextDecoder("shift_jis").decode(buf)
    const parsed = parseCaoHolidayCsv(text)
    if (parsed.size === 0) throw new Error("CAO holiday CSV parsed empty")
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

/** CSV が網羅する最大年より後の「将来年」だけハードコード表で補完する（CSV を正本にする） */
function mergeWithFutureFallback(caoMap: Map<string, string>): Map<string, string> {
  const merged = new Map(caoMap)
  let maxCaoYear = 0
  for (const iso of caoMap.keys()) {
    const y = Number(iso.slice(0, 4))
    if (Number.isFinite(y) && y > maxCaoYear) maxCaoYear = y
  }
  for (const iso of JAPANESE_HOLIDAY_ISO_DATES) {
    const y = Number(iso.slice(0, 4))
    if (y > maxCaoYear && !merged.has(iso)) merged.set(iso, "")
  }
  return merged
}

/** 祝日 Map（ISO→名称）を取得。CAO 正本→失敗時ハードコード。結果は TTL でキャッシュ。 */
export async function fetchJapaneseHolidayMap(): Promise<{ map: Map<string, string>; source: JapaneseHolidaySource }> {
  const now = Date.now()
  if (holidayLiveCache && now - holidayLiveCache.fetchedAt < HOLIDAY_LIVE_TTL_MS) {
    return { map: holidayLiveCache.map, source: holidayLiveCache.source }
  }
  if (!holidayInFlight) {
    holidayInFlight = (async (): Promise<HolidayLiveCache> => {
      try {
        const caoMap = await fetchCaoHolidayMap()
        const merged = mergeWithFutureFallback(caoMap)
        return { map: merged, fetchedAt: Date.now(), source: "cao_csv" }
      } catch (_e) {
        // 取得失敗：ハードコード表へフォールバック（短時間キャッシュして連打を防ぐ）
        return { map: buildHardcodedHolidayMap(), fetchedAt: Date.now(), source: "fallback_hardcoded" }
      } finally {
        holidayInFlight = null
      }
    })()
  }
  const result = await holidayInFlight
  holidayLiveCache = result
  return { map: result.map, source: result.source }
}

/** 祝日 Set（ISO）を取得。CAO 正本→失敗時ハードコード。配分計算へ注入する用途。 */
export async function fetchJapaneseHolidaySet(): Promise<Set<string>> {
  const { map } = await fetchJapaneseHolidayMap()
  return new Set(map.keys())
}
