import { fetchGoogleServiceAccountAccessToken } from "./google_service_account_auth.ts"

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"

/** Sheets API の1回の fetch に対するタイムアウト（ms）
 * これを超えたら AbortError を投げ、store ごとのエラー回復に任せる */
const SHEETS_FETCH_TIMEOUT_MS = 20_000

export type SheetValues = string[][]

/** タイムアウト付き fetch ヘルパー */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = SHEETS_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const SHEETS_RETRY_MAX_ATTEMPTS = 6

/** 429 / 5xx 時に指数バックオフで再試行 */
async function sheetsApiFetch(
  url: string,
  options: RequestInit,
  timeoutMs = SHEETS_FETCH_TIMEOUT_MS,
): Promise<Response> {
  let last: Response | null = null
  for (let attempt = 0; attempt < SHEETS_RETRY_MAX_ATTEMPTS; attempt++) {
    last = await fetchWithTimeout(url, options, timeoutMs)
    if (last.ok) return last
    const retryable = last.status === 429 || last.status === 503 || last.status >= 500
    if (!retryable || attempt === SHEETS_RETRY_MAX_ATTEMPTS - 1) return last
    const retryAfter = last.headers.get("Retry-After")
    let waitMs = 1500 * Math.pow(2, attempt)
    if (retryAfter) {
      const sec = parseInt(retryAfter, 10)
      if (!isNaN(sec)) waitMs = Math.max(waitMs, sec * 1000)
    }
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 45_000)))
  }
  return last!
}

/** 日本語タブ名などは 'シート名'!A1 形式が必須 */
export function formatSheetA1Range(sheetTabName: string, a1Suffix: string): string {
  const escaped = sheetTabName.replace(/'/g, "''")
  return `'${escaped}'!${a1Suffix}`
}

export async function listSpreadsheetSheetTitles(spreadsheetId: string): Promise<string[]> {
  const accessToken = await fetchGoogleServiceAccountAccessToken([SHEETS_SCOPE])
  const url = `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`
  const response = await sheetsApiFetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Sheets metadata failed (${response.status}): ${text}`)
  }
  const json = await response.json()
  const sheets = json?.sheets
  if (!Array.isArray(sheets)) return []
  const titles: string[] = []
  for (const sheet of sheets) {
    const title = String(sheet?.properties?.title ?? "").trim()
    if (title) titles.push(title)
  }
  return titles
}

export async function getSpreadsheetValues(
  spreadsheetId: string,
  rangeA1: string,
): Promise<SheetValues> {
  const accessToken = await fetchGoogleServiceAccountAccessToken([SHEETS_SCOPE])
  const url = new URL(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(rangeA1)}`)
  const response = await sheetsApiFetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Sheets values.get failed (${response.status}): ${text}`)
  }
  const json = await response.json()
  const values = json?.values
  return Array.isArray(values) ? values.map((row: unknown) =>
    Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []
  ) : []
}

/** 指定範囲のセル内容をクリア（値・書式は残る） */
export async function clearSpreadsheetRange(
  spreadsheetId: string,
  rangeA1: string,
): Promise<void> {
  const accessToken = await fetchGoogleServiceAccountAccessToken([SHEETS_SCOPE])
  const url = `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(rangeA1)}:clear`
  const response = await sheetsApiFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Sheets values.clear failed (${response.status}): ${text}`)
  }
}

export async function updateSpreadsheetValues(
  spreadsheetId: string,
  rangeA1: string,
  values: SheetValues,
): Promise<void> {
  const accessToken = await fetchGoogleServiceAccountAccessToken([SHEETS_SCOPE])
  const url = new URL(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(rangeA1)}`,
  )
  url.searchParams.set("valueInputOption", "USER_ENTERED")
  const response = await sheetsApiFetch(url.toString(), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Sheets values.update failed (${response.status}): ${text}`)
  }
}

export async function appendSpreadsheetValues(
  spreadsheetId: string,
  rangeA1: string,
  values: SheetValues,
): Promise<void> {
  const accessToken = await fetchGoogleServiceAccountAccessToken([SHEETS_SCOPE])
  const url = new URL(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(rangeA1)}:append`,
  )
  url.searchParams.set("valueInputOption", "USER_ENTERED")
  url.searchParams.set("insertDataOption", "INSERT_ROWS")
  const response = await sheetsApiFetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Sheets values.append failed (${response.status}): ${text}`)
  }
}

/** タブが無いときに新規シートを追加 */
export async function addSpreadsheetSheet(
  spreadsheetId: string,
  title: string,
): Promise<void> {
  const sheetTitle = String(title ?? "").trim()
  if (!sheetTitle) throw new Error("addSpreadsheetSheet: title is required")
  const accessToken = await fetchGoogleServiceAccountAccessToken([SHEETS_SCOPE])
  const url = `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`
  const response = await sheetsApiFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: sheetTitle } } }],
    }),
  })
  if (!response.ok) {
    const text = await response.text()
    if (text.includes("already exists") || text.includes("duplicate")) {
      return
    }
    throw new Error(`Sheets batchUpdate addSheet failed (${response.status}): ${text}`)
  }
}

export async function batchUpdateSpreadsheetValues(
  spreadsheetId: string,
  data: Array<{ range: string; values: SheetValues }>,
): Promise<void> {
  if (data.length === 0) return
  const accessToken = await fetchGoogleServiceAccountAccessToken([SHEETS_SCOPE])
  const url = `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`
  const response = await sheetsApiFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data,
    }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Sheets values.batchUpdate failed (${response.status}): ${text}`)
  }
}
