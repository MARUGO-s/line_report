import type { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import {
  clearSpreadsheetRange,
  formatSheetA1Range,
  listSpreadsheetSheetTitles,
  updateSpreadsheetValues,
} from "./google_sheets_client.ts"
import { runReceiptSheetsPilotSyncForStore } from "./receipt_sheets_pilot_sync.ts"
import {
  listReceiptSheetsStores,
  receiptSheetsTabCandidates,
  resolveReceiptSheetsStoreDisplayName,
  resolveReceiptSheetsStoreKey,
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

function canonicalKeepStoreKey(raw: string): string | null {
  return resolveReceiptSheetsStoreKey(raw)
}

function tabNamesForStore(storeKey: string): string[] {
  const names = new Set<string>()
  for (const kind of ["budgets", "past", "daily"] as const) {
    for (const tab of receiptSheetsTabCandidates(storeKey, kind)) {
      names.add(tab)
    }
  }
  return Array.from(names)
}

function extractStoreKeyPrefixFromTabTitle(title: string): string | null {
  const name = String(title ?? "").trim()
  const m = name.match(/^([a-zA-Z][a-zA-Z0-9_]*)_/)
  return m?.[1] ?? null
}

function resolveStoreKeyFromSheetTitle(
  title: string,
  knownKeys: string[],
): string | null {
  const name = String(title ?? "").trim()
  if (!name) return null
  for (const key of knownKeys) {
    if (name === key || name.startsWith(`${key}_`)) return key
  }
  const extracted = extractStoreKeyPrefixFromTabTitle(name)
  if (extracted) return resolveReceiptSheetsStoreKey(extracted) ?? extracted
  return null
}

const SKIP_SHEET_TITLES = new Set([
  "設定",
  "config",
  "目次",
  "操作",
  "使い方",
  "店舗一覧",
  "同期ログ",
  "シート1",
])

const LEGACY_SALES_TAB = /^(月間予算|過去売上|日次売上|monthly_budgets|past_sales|daily_sales)$/

const STORE_SALES_TAB_SUFFIX =
  /_(月間予算|過去売上|日次売上|monthly_budgets|past_sales|daily_sales)$/

function isStoreSalesDataTab(title: string): boolean {
  const name = String(title ?? "").trim()
  if (!name) return false
  if (LEGACY_SALES_TAB.test(name)) return true
  return STORE_SALES_TAB_SUFFIX.test(name)
}

function isKeptStoreKey(storeKey: string, keep: Set<string>): boolean {
  const canonical = resolveReceiptSheetsStoreKey(storeKey) ?? storeKey
  if (keep.has(canonical)) return true
  if (canonical.toLowerCase() === "marugos" && keep.has("marugoS")) return true
  return false
}

/** 保持店舗以外の売上連携タブを列挙してデータ行をゼロにする */
export async function clearSpreadsheetTabsExceptStores(
  spreadsheetId: string,
  keepStorePartitionKeys: string[],
  extraRegistryStoreKeys: string[] = [],
): Promise<Record<string, unknown>> {
  const keep = new Set<string>()
  for (const raw of keepStorePartitionKeys) {
    const canonical = canonicalKeepStoreKey(raw) ?? String(raw ?? "").trim()
    if (canonical) keep.add(canonical)
  }
  keep.add("marugoS")

  const catalogKeys = listReceiptSheetsStores().map((s) => s.storePartitionKey)
  const allKeys = Array.from(new Set([
    ...catalogKeys,
    ...extraRegistryStoreKeys.map((k) => resolveReceiptSheetsStoreKey(k) ?? k),
  ]))

  const titles = await listSpreadsheetSheetTitles(spreadsheetId)
  const skippedKeep: string[] = []
  const cleared: string[] = []
  const notMatched: string[] = []
  const stamp = new Date().toISOString()

  for (const title of titles) {
    if (SKIP_SHEET_TITLES.has(title)) continue
    if (!isStoreSalesDataTab(title)) {
      notMatched.push(title)
      continue
    }

    if (!LEGACY_SALES_TAB.test(title)) {
      const ownerKey = resolveStoreKeyFromSheetTitle(title, allKeys)
      if (!ownerKey) {
        notMatched.push(title)
        continue
      }
      if (isKeptStoreKey(ownerKey, keep)) {
        skippedKeep.push(title)
        continue
      }
    }

    try {
      await clearSpreadsheetRange(spreadsheetId, formatSheetA1Range(title, "A2:ZZ3000"))
      if (title.includes("月間予算") || title.includes("monthly_budget")) {
        await updateSpreadsheetValues(
          spreadsheetId,
          formatSheetA1Range(title, "Q1"),
          [[stamp]],
        )
      } else if (title.includes("過去売上") || title.includes("past_sales")) {
        await updateSpreadsheetValues(
          spreadsheetId,
          formatSheetA1Range(title, "I1"),
          [[stamp]],
        )
      } else if (title.includes("日次売上") || title.includes("daily_sales")) {
        await updateSpreadsheetValues(
          spreadsheetId,
          formatSheetA1Range(title, "J1"),
          [[stamp]],
        )
      }
      cleared.push(title)
    } catch (e) {
      console.warn(`clearSpreadsheetTabsExceptStores ${title}:`, e)
    }
  }

  return {
    ok: true,
    spreadsheet_id: spreadsheetId,
    keep_stores: Array.from(keep),
    purge_stores: allKeys.filter((k) => !isKeptStoreKey(k, keep)),
    sheet_titles_total: titles.length,
    cleared_tabs: cleared,
    skipped_keep_tabs: skippedKeep,
    untouched_tabs: notMatched,
  }
}
