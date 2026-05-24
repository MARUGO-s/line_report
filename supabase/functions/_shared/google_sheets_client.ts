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

/** 日本語タブ名などは 'シート名'!A1 形式が必須 */
export function formatSheetA1Range(sheetTabName: string, a1Suffix: string): string {
  const escaped = sheetTabName.replace(/'/g, "''")
  return `'${escaped}'!${a1Suffix}`
}

export async function getSpreadsheetValues(
  spreadsheetId: string,
  rangeA1: string,
): Promise<SheetValues> {
  const accessToken = await fetchGoogleServiceAccountAccessToken([SHEETS_SCOPE])
  const url = new URL(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(rangeA1)}`)
  const response = await fetchWithTimeout(url.toString(), {
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
  const response = await fetchWithTimeout(url, {
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
  const response = await fetchWithTimeout(url.toString(), {
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
  const response = await fetchWithTimeout(url.toString(), {
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

export async function batchUpdateSpreadsheetValues(
  spreadsheetId: string,
  data: Array<{ range: string; values: SheetValues }>,
): Promise<void> {
  if (data.length === 0) return
  const accessToken = await fetchGoogleServiceAccountAccessToken([SHEETS_SCOPE])
  const url = `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`
  const response = await fetchWithTimeout(url, {
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
