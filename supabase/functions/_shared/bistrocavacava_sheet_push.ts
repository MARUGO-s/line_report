import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import {
  clearSpreadsheetRange,
  formatSheetA1Range,
} from "./google_sheets_client.ts"
import { runReceiptSheetsPilotSyncForStore } from "./receipt_sheets_pilot_sync.ts"
import {
  receiptSheetsTabCandidates,
  resolveReceiptSheetsStoreDisplayName,
} from "./receipt_sheets_store_catalog.ts"

const STORE = "bistrocavacava"
const TAB_ALIASES_PAST = ["過去売上", "past_sales"]
const TAB_ALIASES_BUDGETS = ["月間予算", "monthly_budgets"]

/** 過去売上・月間予算タブのデータ行をクリアし、DB から push のみ反映 */
export async function clearBistrocavacavaSheetDataRowsAndPushFromDb(
  supabase: ReturnType<typeof createClient>,
  spreadsheetId: string,
): Promise<Record<string, unknown>> {
  const pastTabs = [
    ...receiptSheetsTabCandidates(STORE, "past"),
    ...TAB_ALIASES_PAST,
  ]
  const budgetTabs = [
    ...receiptSheetsTabCandidates(STORE, "budgets"),
    ...TAB_ALIASES_BUDGETS,
  ]
  const cleared: string[] = []
  for (const tab of pastTabs) {
    try {
      await clearSpreadsheetRange(spreadsheetId, formatSheetA1Range(tab, "A2:H500"))
      cleared.push(tab)
      break
    } catch (e) {
      console.warn(`clear past tab ${tab}:`, e)
    }
  }
  for (const tab of budgetTabs) {
    try {
      await clearSpreadsheetRange(spreadsheetId, formatSheetA1Range(tab, "A2:Q500"))
      cleared.push(tab)
      break
    } catch (e) {
      console.warn(`clear budget tab ${tab}:`, e)
    }
  }

  const displayName = resolveReceiptSheetsStoreDisplayName(STORE) ?? STORE
  const syncResult = await runReceiptSheetsPilotSyncForStore(
    supabase,
    {
      spreadsheetId,
      storePartitionKey: STORE,
      storeDisplayName: displayName,
      skipSyncLog: true,
    },
    "push",
  )

  return {
    ok: syncResult.ok,
    cleared_tabs: cleared,
    push: syncResult.push,
    closed_dates_export: syncResult.closed_dates_export,
  }
}
