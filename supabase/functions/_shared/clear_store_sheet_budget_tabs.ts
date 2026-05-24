import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import {
  clearSpreadsheetRange,
  formatSheetA1Range,
  updateSpreadsheetValues,
} from "./google_sheets_client.ts"
import { runReceiptSheetsPilotSyncForStore } from "./receipt_sheets_pilot_sync.ts"
import {
  receiptSheetsTabCandidates,
  resolveReceiptSheetsStoreDisplayName,
} from "./receipt_sheets_store_catalog.ts"

/** 月間予算・過去売上・日次売上タブのデータ行をクリアし、DB から push のみ反映 */
export async function clearStoreSheetBudgetTabsAndPushFromDb(
  supabase: ReturnType<typeof createClient>,
  spreadsheetId: string,
  storePartitionKey: string,
  options?: { skipPush?: boolean },
): Promise<Record<string, unknown>> {
  const store = String(storePartitionKey ?? "").trim()
  if (!store) throw new Error("store_partition_key is required")

  const pastTabs = receiptSheetsTabCandidates(store, "past")
  const budgetTabs = receiptSheetsTabCandidates(store, "budgets")
  const dailyTabs = receiptSheetsTabCandidates(store, "daily")
  const cleared: string[] = []
  const stamp = new Date().toISOString()

  function columnLetter1Based(col: number): string {
    let n = col
    let s = ""
    while (n > 0) {
      const r = (n - 1) % 26
      s = String.fromCharCode(65 + r) + s
      n = Math.floor((n - 1) / 26)
    }
    return s
  }

  async function clearTabAndStampWatermark(
    tabCandidates: string[],
    dataRange: string,
    watermarkCol1Based: number,
  ): Promise<string | null> {
    const col = columnLetter1Based(watermarkCol1Based)
    for (const tab of tabCandidates) {
      try {
        await clearSpreadsheetRange(spreadsheetId, formatSheetA1Range(tab, dataRange))
        await updateSpreadsheetValues(
          spreadsheetId,
          formatSheetA1Range(tab, `${col}1`),
          [[stamp]],
        )
        return tab
      } catch (e) {
        console.warn(`clear tab ${tab}:`, e)
      }
    }
    return null
  }

  const pastTab = await clearTabAndStampWatermark(pastTabs, "A2:I500", 9)
  if (pastTab) cleared.push(pastTab)
  const budgetTab = await clearTabAndStampWatermark(budgetTabs, "A2:Q500", 17)
  if (budgetTab) cleared.push(budgetTab)
  const dailyTab = await clearTabAndStampWatermark(dailyTabs, "A2:J2000", 10)
  if (dailyTab) cleared.push(dailyTab)

  if (options?.skipPush) {
    return {
      ok: true,
      store_partition_key: store,
      cleared_tabs: cleared,
      push_skipped: true,
    }
  }

  const displayName = resolveReceiptSheetsStoreDisplayName(store) ?? store
  const syncResult = await runReceiptSheetsPilotSyncForStore(
    supabase,
    {
      spreadsheetId,
      storePartitionKey: store,
      storeDisplayName: displayName,
      skipSyncLog: true,
    },
    "push",
  )

  return {
    ok: syncResult.ok,
    store_partition_key: store,
    cleared_tabs: cleared,
    push: syncResult.push,
    closed_dates_export: syncResult.closed_dates_export,
  }
}
