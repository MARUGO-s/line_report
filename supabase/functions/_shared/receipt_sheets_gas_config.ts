import {
  formatSheetA1Range,
  updateSpreadsheetValues,
} from "./google_sheets_client.ts"
import { fetchGoogleServiceAccountAccessToken } from "./google_service_account_auth.ts"

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
const GAS_CONFIG_TAB = "設定"

const SYNC_URL_DEFAULT =
  "https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/receipt-sheets-sync-cron"

async function ensureSpreadsheetTab(
  spreadsheetId: string,
  sheetTitle: string,
): Promise<void> {
  const accessToken = await fetchGoogleServiceAccountAccessToken([SHEETS_SCOPE])
  const metaUrl = `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!metaRes.ok) {
    const text = await metaRes.text()
    throw new Error(`Sheets metadata failed (${metaRes.status}): ${text}`)
  }
  const meta = await metaRes.json()
  const sheets = Array.isArray(meta?.sheets) ? meta.sheets : []
  const exists = sheets.some(
    (s: { properties?: { title?: string } }) => s?.properties?.title === sheetTitle,
  )
  if (exists) return

  const batchUrl = `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`
  const batchRes = await fetch(batchUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: sheetTitle, index: 1 } } }],
    }),
  })
  if (!batchRes.ok) {
    const text = await batchRes.text()
    throw new Error(`Sheets addSheet failed (${batchRes.status}): ${text}`)
  }
}

/** hocbn の Secret をスプレッドシート「設定」タブへ書き込み（GAS が読み取る） */
export async function writeGasSyncConfigToSpreadsheet(
  spreadsheetId: string,
): Promise<{ spreadsheet_id: string; tab: string; service_account_email: string }> {
  const id = String(spreadsheetId ?? "").trim()
  if (!id) throw new Error("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID is not set.")

  const syncSecret = String(Deno.env.get("RECEIPT_SHEETS_SYNC_SECRET") ?? "").trim()
  if (!syncSecret) throw new Error("RECEIPT_SHEETS_SYNC_SECRET is not set on hocbn.")

  const syncUrl = SYNC_URL_DEFAULT
  const saEmail = String(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "").trim()

  await ensureSpreadsheetTab(id, GAS_CONFIG_TAB)
  await updateSpreadsheetValues(
    id,
    formatSheetA1Range(GAS_CONFIG_TAB, "A1:B4"),
    [
      ["項目", "値（GAS が同期時に参照。編集しない）"],
      ["SUPABASE_RECEIPT_SHEETS_SYNC_URL", syncUrl],
      ["RECEIPT_SHEETS_SYNC_SECRET", syncSecret],
      ["更新日時", new Date().toISOString()],
    ],
  )

  return {
    spreadsheet_id: id,
    tab: GAS_CONFIG_TAB,
    service_account_email: saEmail,
  }
}
