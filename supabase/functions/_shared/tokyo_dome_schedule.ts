export type ExtractedTokyoDomeEvent = {
  event_date: string
  title: string
  category: string
  open_time?: string | null   // 開場（開門）時刻 HH:MM
  start_time?: string | null  // 開始（開演/試合開始）時刻 HH:MM
}

export function normalizeBaseballCategory(title: string, category: string): string {
  return /都市対抗|社会人野球|全日本クラブ野球|大学野球|高校野球/.test(title) ? "アマ野球" : category
}

// The official calendar uses both "(月)" and holiday labels such as
// "(月・祝)". Treat both forms as date-cell boundaries.
function isWeekdayLabel(value: string): boolean {
  return /^[（(][日月火水木金土](?:[・･][^）)]{1,12})?[）)]$/.test(value)
}

function markerCategory(value: string): "野球" | "コンサート" | "その他" | null {
  const text = String(value ?? "").trim()
  if (text === "野球") return "野球"
  if (text === "コンサート") return "コンサート"
  if (["イベント", "その他", "展示会", "展示", "格闘技", "プロレス", "式典"].includes(text)) return "その他"
  return null
}

// 時刻テキストの表記ゆれ（全角数字・全角コロン・「18時30分」）を HH:MM へ寄せる。
function normalizeTimeText(value: string): string {
  return String(value ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ":")
    .replace(/(\d{1,2})\s*時\s*(\d{1,2})\s*分?/g, "$1:$2")
    .replace(/(\d{1,2})\s*時(?!間)/g, "$1:00")
}

// "18:5" のような桁落ちを弾きつつ HH:MM に整形。範囲外(24時以降・60分以上)は不採用。
export function normalizeEventTime(value: unknown): string | null {
  const m = normalizeTimeText(String(value ?? "")).match(/(\d{1,2}):(\d{2})/)
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

const OPEN_LABEL = /^(開場|開門)$/
const START_LABEL = /^(開始|開演|試合開始|プレイボール|スタート)$/

// 1イベント分のテキストから開場／開始時刻を拾う。
// 想定表記: 「開場 12:00／開始 14:00」「開場12:00 開演18:00」「18:00開演」「開演18時」。
// 「終演」「試合時間」など終了・所要時間の表記は拾わない。
export function extractEventTimes(text: string): { openTime: string | null; startTime: string | null } {
  const normalized = normalizeTimeText(text)
  let openTime: string | null = null
  let startTime: string | null = null

  const assign = (label: string, raw: string) => {
    const time = normalizeEventTime(raw)
    if (!time) return
    if (OPEN_LABEL.test(label)) { if (!openTime) openTime = time }
    else if (START_LABEL.test(label)) { if (!startTime) startTime = time }
  }

  // ラベルが先（開場 12:00）
  const labelFirst = /(開場|開門|試合開始|プレイボール|開始|開演|スタート)\s*[:：]?\s*(\d{1,2}:\d{2})/g
  let m: RegExpExecArray | null
  while ((m = labelFirst.exec(normalized))) assign(m[1], m[2])

  // 時刻が先（12:00開場）
  const timeFirst = /(\d{1,2}:\d{2})\s*[:：]?\s*(開場|開門|試合開始|プレイボール|開始|開演|スタート)/g
  while ((m = timeFirst.exec(normalized))) assign(m[2], m[1])

  return { openTime, startTime }
}

// 配信・画面共通の時刻表記。両方あれば「開場16:00 / 開始18:00」、片方だけならその1つ。
export function formatEventTimeLabel(openTime?: string | null, startTime?: string | null): string {
  const parts: string[] = []
  if (openTime) parts.push(`開場${openTime}`)
  if (startTime) parts.push(`開始${startTime}`)
  return parts.join(" / ")
}

// Parse the text version of the official Tokyo Dome schedule by calendar cell.
// Structure: "YYYY年MM月" -> day -> weekday label -> category/title rows.
export function parseTokyoDomeSchedule(text: string): ExtractedTokyoDomeEvent[] {
  const lines = String(text ?? "").split("\n").map((line) => line.trim())
  const monthPattern = /^(\d{4})年(\d{1,2})月$/
  const isDay = (value: string) => /^\d{1,2}$/.test(value)
  const events: ExtractedTokyoDomeEvent[] = []
  const seen = new Set<string>()
  let currentYear = 0
  let currentMonth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const month = line.match(monthPattern)
    if (month) {
      currentYear = Number(month[1])
      currentMonth = Number(month[2])
      continue
    }
    if (!currentYear || !currentMonth || !isDay(line) || i + 1 >= lines.length || !isWeekdayLabel(lines[i + 1])) continue

    const day = Number(line)
    if (day < 1 || day > 31) continue
    const content: string[] = []
    let next = i + 2
    for (; next < lines.length; next++) {
      const candidate = lines[next]
      if (monthPattern.test(candidate)) break
      if (isDay(candidate) && next + 1 < lines.length && isWeekdayLabel(lines[next + 1])) break
      if (candidate) content.push(candidate)
    }

    const date = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    for (let k = 0; k < content.length; k++) {
      const marker = markerCategory(content[k])
      if (!marker) continue
      // このイベントの範囲＝次のジャンル見出しまで。タイトルと時刻はこの範囲から拾う。
      let segEnd = content.length
      for (let s = k + 1; s < content.length; s++) {
        if (markerCategory(content[s])) { segEnd = s; break }
      }
      let title = ""
      let titleIndex = -1
      for (let t = k + 1; t < segEnd; t++) {
        const candidate = content[t]
        if (/^(開場|開始|開演|開門|終演|開催)/.test(candidate)) continue
        if (candidate.startsWith("【") || /TEL|電話|お?問い合わせ|チケット|発売/.test(candidate)) continue
        title = candidate
        titleIndex = t
        break
      }
      if (!title || /TOKYO\s*DOME\s*TOUR/i.test(title)) continue

      // 「開場 12:00／開始 14:00」はタイトルの前後どちらに来ても拾えるよう、
      // タイトル行以外のこのイベント範囲をまとめて解析する。
      const timeSource = content.slice(k + 1, segEnd).filter((_, idx) => (k + 1 + idx) !== titleIndex).join(" ")
      const { openTime, startTime } = extractEventTimes(timeSource)

      const category = marker === "野球"
        ? (/(大学|高校|社会人|選手権|リトル|シニア|ボーイズ|女子|クラブ選手権|アマチュア)/.test(title) ? "アマ野球" : "プロ野球")
        : marker === "コンサート" ? "ライブ" : "その他"
      const cleanTitle = title.replace(/\s+/g, " ").slice(0, 200)
      const key = `${date}__${cleanTitle}`
      if (seen.has(key)) continue
      seen.add(key)
      events.push({
        event_date: date,
        title: cleanTitle,
        category: normalizeBaseballCategory(cleanTitle, category),
        open_time: openTime,
        start_time: startTime,
      })
    }
    i = next - 1
  }

  events.sort((a, b) => a.event_date.localeCompare(b.event_date) || a.title.localeCompare(b.title))
  return events
}
