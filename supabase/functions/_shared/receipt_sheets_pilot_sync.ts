import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import {
  fetchManualMonthSalesMapForStore,
  upsertManualMonthSalesEntries,
  type ManualMonthSalesRecord,
  type ManualMonthSalesUpsertEntry,
  normalizeSheetIntegerInput,
  parsePastSalesSheetRow,
} from "./manual_month_sales.ts"
import {
  allocateDailyBudgetsForMonth,
  getDefaultJapaneseHolidaySet,
  countOperatingDaysInCalendarMonth,
  parseStoreClosedDatesForMonth,
  type SalesBudgetAllocationWeights,
} from "./sales_budget_allocation.ts"
import {
  appendSpreadsheetValues,
  batchUpdateSpreadsheetValues,
  formatSheetA1Range,
  getSpreadsheetValues,
  updateSpreadsheetValues,
  type SheetValues,
} from "./google_sheets_client.ts"
import { queryStoreReceiptRows } from "./store_receipt_query.ts"
import {
  isKnownReceiptSheetsStoreKey,
  listReceiptSheetsStores,
  receiptSheetsTabCandidates,
  canonicalStorePartitionKeyForDb,
  resolveReceiptSheetsStoreDisplayName,
  resolveReceiptSheetsStoreKey,
  pilotStorePartitionKeysMatch,
  type ReceiptSheetsStoreEntry,
} from "./receipt_sheets_store_catalog.ts"

/** Google スプレッドシートのタブ名（日本語・正） */
export const SHEET_MONTHLY_BUDGETS = "月間予算"
export const SHEET_PAST_SALES = "過去売上"
export const SHEET_DAILY_SALES = "日次売上"
export const SHEET_SYNC_LOG = "同期ログ"
export const SHEET_README = "使い方"

const TAB_ALIASES_BUDGETS = [SHEET_MONTHLY_BUDGETS, "monthly_budgets"]
const TAB_ALIASES_PAST = [SHEET_PAST_SALES, "past_sales"]
const TAB_ALIASES_DAILY = [SHEET_DAILY_SALES, "daily_sales"]
const TAB_ALIASES_LOG = [SHEET_SYNC_LOG, "sync_log"]

function isSheetNotFoundError(e: unknown): boolean {
  const msg = String(e)
  return msg.includes("Unable to parse range") ||
    msg.includes("(404)") ||
    msg.includes("NOT_FOUND") ||
    msg.includes("not found")
}

async function getSheetValuesForTab(
  spreadsheetId: string,
  tabCandidates: string[],
  rangeSuffix: string,
): Promise<{ values: SheetValues; tabName: string }> {
  for (const tab of tabCandidates) {
    try {
      const values = await getSpreadsheetValues(
        spreadsheetId,
        formatSheetA1Range(tab, rangeSuffix),
      )
      return { values, tabName: tab }
    } catch (e) {
      if (!isSheetNotFoundError(e)) throw e
    }
  }
  throw new Error(`シートが見つかりません: ${tabCandidates.join(" / ")}`)
}

async function updateSheetValuesForTab(
  spreadsheetId: string,
  tabCandidates: string[],
  rangeSuffix: string,
  values: SheetValues,
): Promise<string> {
  for (const tab of tabCandidates) {
    try {
      await updateSpreadsheetValues(spreadsheetId, formatSheetA1Range(tab, rangeSuffix), values)
      return tab
    } catch (e) {
      if (!isSheetNotFoundError(e)) throw e
    }
  }
  throw new Error(`シートが見つかりません: ${tabCandidates.join(" / ")}`)
}

async function appendSheetValuesForTab(
  spreadsheetId: string,
  tabCandidates: string[],
  rangeSuffix: string,
  values: SheetValues,
): Promise<string> {
  for (const tab of tabCandidates) {
    try {
      await appendSpreadsheetValues(spreadsheetId, formatSheetA1Range(tab, rangeSuffix), values)
      return tab
    } catch (e) {
      if (!isSheetNotFoundError(e)) throw e
    }
  }
  throw new Error(`シートが見つかりません: ${tabCandidates.join(" / ")}`)
}

export type ReceiptSheetsSyncDirection = "pull" | "push" | "both"

export type ReceiptSheetsPilotConfig = {
  spreadsheetId: string
  storePartitionKey: string
  storeDisplayName: string
  /** サーバーサイド同期では同期ログタブへの書き込みをスキップする（API呼び出し数削減） */
  skipSyncLog?: boolean
}

export type ReceiptSheetsSyncResult = {
  ok: boolean
  store_partition_key: string
  spreadsheet_id: string
  direction: ReceiptSheetsSyncDirection
  pull?: {
    budgets_applied: number
    budgets_skipped: number
    past_sales_applied: number
    past_sales_skipped: number
    errors: string[]
  }
  push?: {
    months_written: string[]
    rows_written: number
    closed_dates_rows_updated: number
    /** DB（売上分析の手入力）→ 過去売上タブへ書き出した行数 */
    past_sales_rows_written?: number
    /** DB（サイトの月間予算）→ 月間予算タブへ書き出した行数 */
    budget_rows_written?: number
  }
  closed_dates_export?: {
    rows_updated: number
    dates_by_month: Record<string, string[]>
    pilot_store_key: string
  }
  log_appended: boolean
  generated_at: string
  via_gas?: boolean
  sheet_export?: ReceiptSheetsGasSheetExport
  sync_log_row?: string[]
}

export type ReceiptSheetsPilotStoreConfig = {
  storePartitionKey: string
  storeDisplayName: string
}

export type ReceiptSheetsGasPullInput = {
  store_partition_key?: string
  store_display_name?: string
  monthly_budget_rows?: SheetValues
  past_sales_rows?: SheetValues
}

export type ReceiptSheetsGasClosedDateUpdate = {
  row: number
  month: string
  value: string
}

export type ReceiptSheetsGasOperatingDaysUpdate = {
  row: number
  month: string
  operating_days: number
}

export type ReceiptSheetsGasPastSalesUpdate = {
  row?: number
  sales_month: string
  gross_sales_yen: number
  party_count: number | null
  guest_count: number | null
  operating_days_count: number | null
  /** true = レシート集計由来（pull で DB に取り込まない） */
  from_receipt?: boolean
}

export type ReceiptSheetsGasSheetExport = {
  daily_sales?: { header: string[]; rows: string[][] }
  closed_dates_by_month: Record<string, string[]>
  /** GAS が行番号で H 列へ直接書込（月セルの Date 型ずれを回避） */
  closed_dates_updates?: ReceiptSheetsGasClosedDateUpdate[]
  /** GAS が行番号で I 列（営業日数）へ書込 */
  budget_operating_days_updates?: ReceiptSheetsGasOperatingDaysUpdate[]
  /** DB の手入力過去売上 → 過去売上タブ（売上分析で保存した値の反映） */
  past_sales_updates?: ReceiptSheetsGasPastSalesUpdate[]
  /** DB の月間予算 → 月間予算タブ（A〜J 行まるごと） */
  budget_row_updates?: ReceiptSheetsGasBudgetRowUpdate[]
}

export type ReceiptSheetsGasBudgetRowUpdate = {
  row?: number
  sales_month: string
  values: string[]
}

function readReceiptSheetsPilotStoreConfig(
  override?: Partial<ReceiptSheetsPilotStoreConfig>,
): ReceiptSheetsPilotStoreConfig | null {
  const storePartitionKey = resolveReceiptSheetsStoreKey(
    String(
      override?.storePartitionKey ??
        Deno.env.get("RECEIPT_SHEETS_PILOT_STORE_KEY") ??
        "",
    ),
  )
  if (!storePartitionKey) return null
  const storeDisplayName = String(
    override?.storeDisplayName ??
      resolveReceiptSheetsStoreDisplayName(storePartitionKey) ??
      Deno.env.get("RECEIPT_SHEETS_PILOT_STORE_NAME") ??
      "",
  ).trim()
  return { storePartitionKey, storeDisplayName }
}

export function resolveReceiptSheetsGasStoreConfig(
  input: Partial<ReceiptSheetsGasPullInput>,
): ReceiptSheetsPilotStoreConfig {
  const store = readReceiptSheetsPilotStoreConfig({
    storePartitionKey: input.store_partition_key,
    storeDisplayName: input.store_display_name,
  })
  if (!store) {
    throw new Error(
      "store_partition_key is invalid or missing. Use a key from the store catalog (e.g. bistrocavacava).",
    )
  }
  return store
}

export function readReceiptSheetsPilotConfig(): ReceiptSheetsPilotConfig | null {
  const store = readReceiptSheetsPilotStoreConfig()
  const spreadsheetId = (Deno.env.get("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID") ?? "").trim()
  if (!store || !spreadsheetId) return null
  return { spreadsheetId, ...store }
}

/** 同時実行数を制限しながら Promise を実行する（Sheets API レート制限対策）
 * 1店舗がエラー/タイムアウトになっても他の店舗は続行する */
async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  onBatchComplete?: (completedCount: number, total: number) => Promise<void>,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let nextIndex = 0
  let completedCount = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const i = nextIndex++
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() }
      } catch (e) {
        console.error(`Store sync failed at task index ${i}:`, e)
        results[i] = { status: "rejected", reason: e }
      }
      completedCount++
      // バッチ区切り OR 全タスク完了時に通知（22 % 4 ≠ 0 の端数も確実に拾う）
      if (onBatchComplete && (completedCount % limit === 0 || completedCount === tasks.length)) {
        await onBatchComplete(completedCount, tasks.length).catch(() => {})
      }
    }
  })
  await Promise.all(workers)
  return results
}

export async function runReceiptSheetsPilotSync(
  supabase: ReturnType<typeof createClient>,
  direction: ReceiptSheetsSyncDirection,
): Promise<ReceiptSheetsSyncResult> {
  const spreadsheetId = (Deno.env.get("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID") ?? "").trim()
  if (!spreadsheetId) {
    throw new Error(
      "RECEIPT_SHEETS_PILOT_SPREADSHEET_ID is not set. See docs/RECEIPT_SHEETS_PILOT.md.",
    )
  }

  const stores = listReceiptSheetsStores()

  if (stores.length === 0) {
    throw new Error("No receipt sheets stores configured.")
  }

  // 22店舗を一度に並列処理すると Sheets API の rate limit（429）が発生するため
  // 4店舗ずつ処理する。1店舗がタイムアウト/エラーでも他は続行。
  const settled = await runWithConcurrencyLimit(
    stores.map((store) => () =>
      runReceiptSheetsPilotSyncForStore(supabase, { spreadsheetId, skipSyncLog: true, ...store }, direction)
    ),
    4,
    async (done, total) => {
      const isFinal = done === total
      // バッチ完了のたびに DB に中間ステータスを書く
      // done === total のとき error_message を null にして GAS の「完了」判定を確実にトリガーする
      await supabase.from("receipt_sheets_sync_status").upsert(
        {
          id: 1,
          last_completed_at: new Date().toISOString(),
          direction,
          failed: false,
          error_message: isFinal ? null : `進行中 ${done}/${total} 店舗完了`,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      )
    },
  )

  const errors = settled.filter((r) => r.status === "rejected")
  if (errors.length > 0) {
    console.warn(`runReceiptSheetsPilotSync: ${errors.length}/${stores.length} stores failed`)
  }

  const last = settled[settled.length - 1]
  return last.status === "fulfilled"
    ? last.value
    : { ok: false, store_partition_key: "", spreadsheet_id: spreadsheetId, direction, log_appended: false, generated_at: new Date().toISOString() }
}

async function runReceiptSheetsPilotSyncForStore(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  direction: ReceiptSheetsSyncDirection,
): Promise<ReceiptSheetsSyncResult> {
  const result: ReceiptSheetsSyncResult = {
    ok: true,
    store_partition_key: config.storePartitionKey,
    spreadsheet_id: config.spreadsheetId,
    direction,
    log_appended: false,
    generated_at: new Date().toISOString(),
  }

  const logLines: string[] = []

  // タブを1回だけ並列で読み込んで使い回す（同一タブへの重複読み込みを防ぐ）
  // budget tab: pull + exportBudget + exportClosedDates で3回読まれていた → 1回に削減
  // past tab:   pull + exportPastSales で2回読まれていた → 1回に削減
  const budgetTabCandidates = [
    ...receiptSheetsTabCandidates(config.storePartitionKey, "budgets"),
    ...(config.storePartitionKey === "bistrocavacava" ? TAB_ALIASES_BUDGETS : []),
  ]
  const pastTabCandidates = [
    ...receiptSheetsTabCandidates(config.storePartitionKey, "past"),
    ...(config.storePartitionKey === "bistrocavacava" ? TAB_ALIASES_PAST : []),
  ]

  const [budgetTabData, pastTabData] = await Promise.all([
    getSheetValuesForTab(config.spreadsheetId, budgetTabCandidates, "A2:J500"),
    getSheetValuesForTab(config.spreadsheetId, pastTabCandidates, "A2:G500"),
  ])

  // both: 先にシート→DB、後に DB→シート（シートで直した値をサイトへ反映するため）
  if (direction === "pull" || direction === "both") {
    result.pull = await processPullRowsToDb(
      supabase,
      config,
      budgetTabData.values,
      pastTabData.values,
      logLines,
      { bothMerge: direction === "both" },
    )
  }
  if (direction === "push" || direction === "both") {
    result.push = await pushDailySalesToSheet(supabase, config, logLines)
    const pastExport = await exportPastSalesFromDbToPastSheet(
      supabase, config, logLines, pastTabData,
    )
    const budgetExport = await exportBudgetFromDbToBudgetSheet(
      supabase, config, logLines, budgetTabData,
    )
    if (result.push) {
      result.push.past_sales_rows_written = pastExport.rows_written
      result.push.budget_rows_written = budgetExport.rows_written
    }
  }
  if (direction === "pull" || direction === "push" || direction === "both") {
    result.closed_dates_export = await exportClosedDatesFromDbToBudgetSheet(
      supabase, config, budgetTabData,
    )
    logLines.push(
      `closed_export rows=${result.closed_dates_export.rows_updated} months=${
        Object.keys(result.closed_dates_export.dates_by_month).join(",") || "(none)"
      }`,
    )
  }

  if (!config.skipSyncLog) {
    try {
      await appendSyncLog(config.spreadsheetId, [
        new Date().toISOString(),
        direction,
        config.storePartitionKey,
        result.pull
          ? `budgets=${result.pull.budgets_applied} past=${result.pull.past_sales_applied} err=${result.pull.errors.length}`
          : "-",
        result.push ? `rows=${result.push.rows_written} months=${result.push.months_written.join(",")}` : "-",
        logLines.slice(0, 3).join(" | ") || "ok",
      ])
      result.log_appended = true
    } catch (e) {
      console.error("appendSyncLog failed:", e)
      result.ok = false
    }
  }

  return result
}

/** GAS がシートを読み書きし、サーバーは DB のみ操作（Google Sheets API 不要） */
export async function runReceiptSheetsPilotSyncViaGas(
  supabase: ReturnType<typeof createClient>,
  direction: ReceiptSheetsSyncDirection,
  input: Partial<ReceiptSheetsGasPullInput>,
): Promise<ReceiptSheetsSyncResult> {
  const store = resolveReceiptSheetsGasStoreConfig(input)
  const config: ReceiptSheetsPilotConfig = {
    spreadsheetId: (Deno.env.get("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID") ?? "").trim() || "gas-client",
    ...store,
  }

  const result: ReceiptSheetsSyncResult = {
    ok: true,
    store_partition_key: config.storePartitionKey,
    spreadsheet_id: config.spreadsheetId,
    direction,
    log_appended: false,
    generated_at: new Date().toISOString(),
    via_gas: true,
  }

  const logLines: string[] = []
  const sheetExport: ReceiptSheetsGasSheetExport = { closed_dates_by_month: {} }

  if (direction === "pull" || direction === "both") {
    if (!input.monthly_budget_rows || !input.past_sales_rows) {
      throw new Error(
        "via_gas pull requires monthly_budget_rows and past_sales_rows from the spreadsheet.",
      )
    }
    result.pull = await processPullRowsToDb(
      supabase,
      config,
      input.monthly_budget_rows,
      input.past_sales_rows,
      logLines,
      { bothMerge: direction === "both" },
    )
    if (direction === "both") {
      logLines.push("both: pull(merge) then push")
    }
  }

  if (direction === "push" || direction === "both") {
    const built = await buildDailySalesExportRows(supabase, config)
    const pastUpdates = await buildPastSalesSheetUpdatesFromDb(
      supabase,
      config.storePartitionKey,
      input.past_sales_rows,
    )
    result.push = {
      months_written: built.months_written,
      rows_written: built.rows_written,
      closed_dates_rows_updated: 0,
      past_sales_rows_written: pastUpdates.length,
    }
    sheetExport.daily_sales = { header: built.header, rows: built.rows }
    const budgetUpdates = await buildBudgetSheetRowUpdatesFromDb(
      supabase,
      config,
      input.monthly_budget_rows,
    )
    if (budgetUpdates.length > 0) {
      sheetExport.budget_row_updates = budgetUpdates
      result.push.budget_rows_written = budgetUpdates.length
    }
    if (pastUpdates.length > 0) {
      sheetExport.past_sales_updates = pastUpdates
      const snapRows: PastSalesComparable[] = []
      const snapMonths: string[] = []
      for (const u of pastUpdates) {
        snapMonths.push(u.sales_month)
        snapRows.push({
          gross_sales_yen: u.gross_sales_yen,
          party_count: u.party_count,
          guest_count: u.guest_count,
          operating_days_count: u.operating_days_count,
        })
      }
      await upsertPastSalesSnapshots(supabase, config.storePartitionKey, snapRows, snapMonths)
    }
    logLines.push(`push rows=${built.rows_written} past_export=${pastUpdates.length}`)
  }

  const monthsForClosed = await listMonthsForClosedExport(
    supabase,
    config.storePartitionKey,
    input.monthly_budget_rows,
  )
  const closedExport = await buildClosedDatesExportFromDb(
    supabase,
    config.storePartitionKey,
    monthsForClosed,
  )
  result.closed_dates_export = closedExport
  sheetExport.closed_dates_by_month = closedExport.dates_by_month
  if (input.monthly_budget_rows && input.monthly_budget_rows.length > 0) {
    sheetExport.closed_dates_updates = buildClosedDatesSheetUpdates(
      input.monthly_budget_rows,
      config.storePartitionKey,
      closedExport.dates_by_month,
    )
    sheetExport.budget_operating_days_updates = buildBudgetOperatingDaysSheetUpdates(
      input.monthly_budget_rows,
      config.storePartitionKey,
    )
  }
  result.sheet_export = sheetExport

  result.sync_log_row = [
    result.generated_at,
    direction,
    config.storePartitionKey,
    result.pull
      ? `budgets=${result.pull.budgets_applied} past=${result.pull.past_sales_applied} err=${result.pull.errors.length}`
      : "-",
    result.push ? `rows=${result.push.rows_written} months=${result.push.months_written.join(",")}` : "-",
    logLines.slice(0, 3).join(" | ") || "ok (gas)",
  ]

  return result
}

/** GAS 経由（via_gas）呼び出し用: シートを自前で読む旧来のインターフェースを維持 */
async function pullFromSheetsToDb(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  logLines: string[],
  bothMerge = false,
): Promise<NonNullable<ReceiptSheetsSyncResult["pull"]>> {
  const budgetTabs = receiptSheetsTabCandidates(config.storePartitionKey, "budgets")
  const pastTabs = receiptSheetsTabCandidates(config.storePartitionKey, "past")
  const legacyBudgetTabs = config.storePartitionKey === "bistrocavacava" ? TAB_ALIASES_BUDGETS : []
  const legacyPastTabs = config.storePartitionKey === "bistrocavacava" ? TAB_ALIASES_PAST : []
  const [{ values: budgetRows }, { values: pastRows }] = await Promise.all([
    getSheetValuesForTab(config.spreadsheetId, [...budgetTabs, ...legacyBudgetTabs], "A2:J500"),
    getSheetValuesForTab(config.spreadsheetId, [...pastTabs, ...legacyPastTabs], "A2:G500"),
  ])
  return processPullRowsToDb(supabase, config, budgetRows, pastRows, logLines, { bothMerge })
}

type PastSalesComparable = {
  gross_sales_yen: number
  party_count: number | null
  guest_count: number | null
  operating_days_count: number | null
}

function pastSalesComparableFromManual(
  row: ManualMonthSalesRecord,
): PastSalesComparable {
  return {
    gross_sales_yen: row.gross_sales_yen,
    party_count: row.party_count,
    guest_count: row.guest_count,
    operating_days_count: row.operating_days_count,
  }
}

function pastSalesComparableFromEntry(
  entry: ManualMonthSalesUpsertEntry & { gross_sales_yen: number },
): PastSalesComparable {
  return {
    gross_sales_yen: entry.gross_sales_yen,
    party_count: entry.party_count ?? null,
    guest_count: entry.guest_count ?? null,
    operating_days_count: entry.operating_days_count ?? null,
  }
}

function pastSalesComparableEqual(a: PastSalesComparable, b: PastSalesComparable): boolean {
  return a.gross_sales_yen === b.gross_sales_yen
    && a.party_count === b.party_count
    && a.guest_count === b.guest_count
    && a.operating_days_count === b.operating_days_count
}

async function fetchPastSalesSnapshotMap(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
): Promise<Map<string, PastSalesComparable>> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  const out = new Map<string, PastSalesComparable>()
  const { data, error } = await supabase
    .from("receipt_sheets_past_sales_export_snapshot")
    .select("sales_month, gross_sales_yen, party_count, guest_count, operating_days_count")
    .eq("store_partition_key", key)

  if (error) {
    console.error(`fetchPastSalesSnapshotMap failed (store=${key}):`, error.message)
    return out
  }

  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const month = String(r.sales_month ?? "").trim().slice(0, 7)
    const gross = Number(r.gross_sales_yen)
    if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(gross)) continue
    out.set(month, {
      gross_sales_yen: Math.round(gross),
      party_count: parseOptionalPastSalesInt(r.party_count),
      guest_count: parseOptionalPastSalesInt(r.guest_count),
      operating_days_count: parseOptionalPastSalesInt(r.operating_days_count),
    })
  }
  return out
}

async function upsertPastSalesSnapshots(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  entries: PastSalesComparable[],
  salesMonths: string[],
): Promise<void> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  const now = new Date().toISOString()
  for (let i = 0; i < entries.length; i += 1) {
    const month = salesMonths[i]
    const e = entries[i]
    if (!month || !/^\d{4}-\d{2}$/.test(month)) continue
    const { error } = await supabase
      .from("receipt_sheets_past_sales_export_snapshot")
      .upsert({
        store_partition_key: key,
        sales_month: month,
        gross_sales_yen: e.gross_sales_yen,
        party_count: e.party_count,
        guest_count: e.guest_count,
        operating_days_count: e.operating_days_count,
        exported_at: now,
      }, { onConflict: "store_partition_key,sales_month" })
    if (error) throw new Error(`upsertPastSalesSnapshots: ${error.message}`)
  }
}

async function deletePastSalesSnapshots(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  salesMonths: string[],
): Promise<void> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  for (const month of salesMonths) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue
    await supabase
      .from("receipt_sheets_past_sales_export_snapshot")
      .delete()
      .eq("store_partition_key", key)
      .eq("sales_month", month)
  }
}

async function processPullRowsToDb(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  budgetRows: SheetValues,
  pastRows: SheetValues,
  logLines: string[],
  opts?: { bothMerge?: boolean },
): Promise<NonNullable<ReceiptSheetsSyncResult["pull"]>> {
  const errors: string[] = []
  let budgetsApplied = 0
  let budgetsSkipped = 0
  let pastApplied = 0
  let pastSkipped = 0
  const budgetOperatingDaysByMonth = new Map<string, number>()

  for (let i = 0; i < budgetRows.length; i += 1) {
    const row = budgetRows[i]
    const rowNum = i + 2
    const month = normalizeMonthCell(row[0])
    const storeKey = normalizePilotStoreKey(row[2])
    const budgetCols = parseMonthlyBudgetSheetRow(row)
    const enabled = parseEnabledCell(row[budgetCols.enabledCol])
    if (!enabled) {
      budgetsSkipped += 1
      continue
    }
    if (!pilotStorePartitionKeysMatch(storeKey, config.storePartitionKey)) {
      budgetsSkipped += 1
      continue
    }
    if (!month) {
      errors.push(`${SHEET_MONTHLY_BUDGETS} 行${rowNum}: 月の形式が不正です`)
      budgetsSkipped += 1
      continue
    }
    const budgetYen = parseNonNegativeInt(row[3])
    if (budgetYen <= 0) {
      errors.push(`${SHEET_MONTHLY_BUDGETS} 行${rowNum}: 予算は正の整数にしてください`)
      budgetsSkipped += 1
      continue
    }
    try {
      const closedCellRaw = String(row[budgetCols.closedCol] ?? "").trim()
      const sheetSpecifiedClosed = closedCellRaw.length > 0
      let storeClosedDates = parseClosedDatesCell(row[budgetCols.closedCol], month)
      if (!sheetSpecifiedClosed) {
        storeClosedDates = await loadStoreClosedDatesForMonth(
          supabase,
          config.storePartitionKey,
          month,
        )
      }
      const operatingDays = countOperatingDaysInCalendarMonth(month, storeClosedDates)
      if (operatingDays > 0) {
        budgetOperatingDaysByMonth.set(month, operatingDays)
      }
      await upsertBudgetRow(supabase, {
        store_partition_key: config.storePartitionKey,
        month,
        budget_yen: budgetYen,
        weekday_weight: parsePositiveWeight(row[4], 1),
        pre_holiday_weight: parsePositiveWeight(row[5], 1.5),
        holiday_weight: parsePositiveWeight(row[6], 2),
        store_closed_dates: storeClosedDates,
      })
      budgetsApplied += 1
    } catch (e) {
      errors.push(`${SHEET_MONTHLY_BUDGETS} 行${rowNum}: ${String(e)}`)
    }
  }

  const bothMerge = opts?.bothMerge === true
  const pastMonthsForDb: string[] = []
  if (bothMerge) {
    for (let i = 0; i < pastRows.length; i += 1) {
      const m = normalizeMonthCell(pastRows[i][0])
      if (m) pastMonthsForDb.push(m)
    }
  }
  const dbMap = bothMerge
    ? await fetchManualMonthSalesMapForStore(supabase, config.storePartitionKey, pastMonthsForDb)
    : new Map<string, ManualMonthSalesRecord>()
  const snapMap = bothMerge
    ? await fetchPastSalesSnapshotMap(supabase, config.storePartitionKey)
    : new Map<string, PastSalesComparable>()
  let pastDbWins = 0

  const pastEntries: ManualMonthSalesUpsertEntry[] = []
  const pastSnapshotWrites: PastSalesComparable[] = []
  const pastSnapshotMonths: string[] = []
  const pastSnapshotDeletes: string[] = []

  for (let i = 0; i < pastRows.length; i += 1) {
    const row = pastRows[i]
    const rowNum = i + 2
    const salesMonth = normalizeMonthCell(row[0])
    const storeKey = normalizePilotStoreKey(row[1])
    const pastCols = parsePastSalesSheetRow(row)
    const enabled = parseEnabledCell(row[pastCols.enabledCol])
    if (!enabled || !pilotStorePartitionKeysMatch(storeKey, config.storePartitionKey)) {
      pastSkipped += 1
      continue
    }
    if (!salesMonth) {
      errors.push(`${SHEET_PAST_SALES} 行${rowNum}: 対象月の形式が不正です`)
      pastSkipped += 1
      continue
    }
    const rawGross = String(row[2] ?? "").trim()
    if (rawGross === "") {
      pastEntries.push({ sales_month: salesMonth, gross_sales_yen: null })
      pastSnapshotDeletes.push(salesMonth)
      pastApplied += 1
    } else {
      const gross = parseNonNegativeInt(rawGross)
      const opDaysFromBudget = budgetOperatingDaysByMonth.get(salesMonth) ?? null
      const entry: ManualMonthSalesUpsertEntry = {
        sales_month: salesMonth,
        gross_sales_yen: gross,
        party_count: pastCols.party_count,
        guest_count: pastCols.guest_count,
        operating_days_count: pastCols.operating_days_count ?? opDaysFromBudget,
      }
      const sheetComparable = pastSalesComparableFromEntry(
        entry as ManualMonthSalesUpsertEntry & { gross_sales_yen: number },
      )
      const db = dbMap.get(salesMonth)
      const snap = snapMap.get(salesMonth)
      if (bothMerge && db && !pastSalesComparableEqual(sheetComparable, pastSalesComparableFromManual(db))) {
        let dbWins = false
        if (snap && pastSalesComparableEqual(sheetComparable, snap)) {
          dbWins = true
        } else if (!snap && db.updated_at) {
          const updatedMs = new Date(db.updated_at).getTime()
          if (Number.isFinite(updatedMs) && updatedMs > Date.now() - 20 * 60 * 1000) {
            dbWins = true
          }
        }
        if (dbWins) {
          pastSkipped += 1
          pastDbWins += 1
          continue
        }
      }
      pastEntries.push(entry)
      pastSnapshotWrites.push(sheetComparable)
      pastSnapshotMonths.push(salesMonth)
      pastApplied += 1
    }
  }

  if (pastEntries.length > 0) {
    try {
      await upsertManualMonthSalesEntries(supabase, config.storePartitionKey, pastEntries)
      if (pastSnapshotWrites.length > 0) {
        await upsertPastSalesSnapshots(
          supabase,
          config.storePartitionKey,
          pastSnapshotWrites,
          pastSnapshotMonths,
        )
      }
      if (pastSnapshotDeletes.length > 0) {
        await deletePastSalesSnapshots(supabase, config.storePartitionKey, pastSnapshotDeletes)
      }
    } catch (e) {
      errors.push(`${SHEET_PAST_SALES}: ${String(e)}`)
    }
  }

  if (bothMerge && pastDbWins > 0) {
    logLines.push(`both past_db_wins=${pastDbWins}`)
  }
  logLines.push(`pull budgets=${budgetsApplied} past=${pastApplied}`)
  return {
    budgets_applied: budgetsApplied,
    budgets_skipped: budgetsSkipped,
    past_sales_applied: pastApplied,
    past_sales_skipped: pastSkipped,
    errors,
  }
}

async function buildDailySalesExportRows(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotStoreConfig,
): Promise<{
  header: string[]
  rows: string[][]
  months_written: string[]
  rows_written: number
}> {
  const months = listPilotSyncMonthsJst()
  const header = [
    "日付",
    "店舗キー",
    "店舗名",
    "総売上",
    "組数",
    "客数",
    "日別予算",
    "差額",
    "レシート件数",
    "更新日時",
  ]
  const rows: string[][] = []
  const updatedAt = new Date().toISOString()

  for (const month of months) {
    const series = await buildDailySeriesForStoreMonth(supabase, config.storePartitionKey, month)
    const budgetRow = await fetchBudgetRow(supabase, config.storePartitionKey, month)
    let dailyBudgetMap: Map<string, number> | null = null
    if (budgetRow && budgetRow.budget_yen > 0) {
      const weights: SalesBudgetAllocationWeights = {
        weekday: budgetRow.weekday_weight,
        pre_holiday: budgetRow.pre_holiday_weight,
        holiday: budgetRow.holiday_weight,
      }
      dailyBudgetMap = allocateDailyBudgetsForMonth(
        month,
        budgetRow.budget_yen,
        weights,
        getDefaultJapaneseHolidaySet(),
        new Set(budgetRow.store_closed_dates),
      )
    }

    for (const day of series) {
      const budgetYen = dailyBudgetMap?.get(day.date) ?? 0
      const variance = day.gross_sales_yen - budgetYen
      rows.push([
        day.date,
        config.storePartitionKey,
        config.storeDisplayName,
        day.gross_sales_yen,
        day.party_count,
        day.guest_count,
        budgetYen,
        variance,
        day.receipt_count,
        updatedAt,
      ])
    }
  }

  return {
    header,
    rows,
    months_written: months,
    rows_written: rows.length,
  }
}

async function pushDailySalesToSheet(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  logLines: string[],
): Promise<NonNullable<ReceiptSheetsSyncResult["push"]>> {
  const built = await buildDailySalesExportRows(supabase, config)
  const allRows: string[][] = [built.header, ...built.rows]
  await updateSheetValuesForTab(
    config.spreadsheetId,
    [
      ...receiptSheetsTabCandidates(config.storePartitionKey, "daily"),
      ...(config.storePartitionKey === "bistrocavacava" ? TAB_ALIASES_DAILY : []),
    ],
    "A1",
    allRows,
  )
  logLines.push(`push rows=${built.rows_written}`)
  return {
    months_written: built.months_written,
    rows_written: built.rows_written,
    closed_dates_rows_updated: 0,
  }
}

function collectPilotMonthsFromBudgetRows(
  budgetRows: SheetValues,
  storePartitionKey: string,
): string[] {
  const months = new Set(listPilotSyncMonthsJst())
  for (const row of budgetRows) {
    const month = normalizeMonthCell(row[0])
    const storeKey = normalizePilotStoreKey(row[2])
    if (month && pilotStorePartitionKeysMatch(storeKey, storePartitionKey)) {
      months.add(month)
    }
  }
  return [...months].sort()
}

async function listMonthsForClosedExport(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  budgetRows?: SheetValues,
): Promise<string[]> {
  const months = new Set(
    collectPilotMonthsFromBudgetRows(budgetRows ?? [], storePartitionKey),
  )
  const { data, error } = await supabase
    .from("line_sales_month_budgets")
    .select("target_month")
    .eq("store_partition_key", storePartitionKey)
  if (error) {
    throw new Error(`Failed to list budget months: ${error.message}`)
  }
  for (const row of Array.isArray(data) ? data : []) {
    const month = normalizeMonthCell((row as Record<string, unknown>).target_month)
    if (month) months.add(month)
  }

  const { data: closedRows, error: closedErr } = await supabase
    .from("line_sales_month_store_closed_days")
    .select("target_month")
    .eq("store_partition_key", storePartitionKey)
  if (closedErr) {
    throw new Error(`Failed to list closed-day months: ${closedErr.message}`)
  }
  for (const row of Array.isArray(closedRows) ? closedRows : []) {
    const month = normalizeMonthCell((row as Record<string, unknown>).target_month)
    if (month) months.add(month)
  }

  return [...months].sort()
}

function buildClosedDatesSheetUpdates(
  budgetRows: SheetValues,
  storePartitionKey: string,
  datesByMonth: Record<string, string[]>,
): ReceiptSheetsGasClosedDateUpdate[] {
  const updates: ReceiptSheetsGasClosedDateUpdate[] = []
  for (let i = 0; i < budgetRows.length; i += 1) {
    const month = normalizeMonthCell(budgetRows[i][0])
    const storeKey = normalizePilotStoreKey(budgetRows[i][2])
    if (!month || !pilotStorePartitionKeysMatch(storeKey, storePartitionKey)) continue
    if (!(month in datesByMonth)) continue
    updates.push({
      row: i + 2,
      month,
      value: formatClosedDatesForSheetCell(datesByMonth[month] ?? [], month),
    })
  }
  return updates
}

async function buildClosedDatesExportFromDb(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  months: string[],
): Promise<NonNullable<ReceiptSheetsSyncResult["closed_dates_export"]>> {
  const closedByMonth = await loadStoreClosedDatesBatchForMonths(supabase, storePartitionKey, months)
  const datesByMonth: Record<string, string[]> = {}
  for (const month of months) {
    datesByMonth[month] = closedByMonth.get(month) ?? []
  }
  return {
    rows_updated: months.length,
    dates_by_month: datesByMonth,
    pilot_store_key: storePartitionKey,
  }
}

const RECEIPT_MONTHLY_AGGREGATE_PAGE_SIZE = 1000

/** store_webhook_tables からレシートテーブル名を取得して月次集計を返す
 * DB の store_partition_key と catalog のキーで大文字小文字が異なる場合があるため
 * 全件取得してクライアント側で小文字照合する */
async function fetchReceiptMonthlyAggregatesForStore(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
): Promise<Map<string, { gross_sales_yen: number; party_count: number; guest_count: number }>> {
  const normalizedKey = storePartitionKey.toLowerCase().trim()

  // まず完全一致で試みる
  const { data: reg } = await supabase
    .from("store_webhook_tables")
    .select("receipt_table")
    .eq("store_partition_key", storePartitionKey)
    .maybeSingle()

  let receiptTable = typeof (reg as Record<string, unknown> | null)?.receipt_table === "string"
    ? (reg as Record<string, unknown>).receipt_table as string
    : null

  // 完全一致で見つからなかった場合: 全件取得して小文字で照合（大文字小文字の不一致対策）
  if (!receiptTable) {
    const { data: allStores } = await supabase
      .from("store_webhook_tables")
      .select("store_partition_key, receipt_table")
    const matched = (allStores ?? []).find(
      (s: Record<string, unknown>) => String(s.store_partition_key ?? "").toLowerCase().trim() === normalizedKey,
    ) as Record<string, unknown> | null | undefined
    receiptTable = typeof matched?.receipt_table === "string" ? matched.receipt_table as string : null
    if (receiptTable) {
      console.log(`fetchReceiptMonthlyAggregatesForStore: fallback match for "${storePartitionKey}" → "${matched?.store_partition_key}" → table "${receiptTable}"`)
    }
  }

  if (!receiptTable) {
    console.warn(`fetchReceiptMonthlyAggregatesForStore: no receipt table found for store_partition_key="${storePartitionKey}"`)
    return new Map()
  }

  const threeYearsAgo = new Date()
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3)
  const fromDate = threeYearsAgo.toISOString().slice(0, 10)

  const byMonth = new Map<string, { gross_sales_yen: number; party_count: number; guest_count: number }>()
  let offset = 0

  while (true) {
    // PostgREST / Supabase の既定取得件数で途中打ち切りにならないよう、全件をページングで読む。
    const { data, error } = await supabase
      .from(receiptTable)
      .select("id, receipt_date, gross_sales_yen, party_count, guest_count")
      .not("receipt_date", "is", null)
      .not("gross_sales_yen", "is", null)
      .gte("receipt_date", fromDate)
      .order("id", { ascending: true })
      .range(offset, offset + RECEIPT_MONTHLY_AGGREGATE_PAGE_SIZE - 1)

    if (error) {
      console.error(`fetchReceiptMonthlyAggregatesForStore failed (${receiptTable} offset=${offset}):`, error.message)
      return new Map()
    }

    const rows = Array.isArray(data) ? data : []
    for (const row of rows) {
      const r = row as Record<string, unknown>
      const date = String(r.receipt_date ?? "").slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      const month = date.slice(0, 7)
      const gross = Number(r.gross_sales_yen)
      if (!Number.isFinite(gross) || gross <= 0) continue
      const existing = byMonth.get(month) ?? { gross_sales_yen: 0, party_count: 0, guest_count: 0 }
      existing.gross_sales_yen += Math.round(gross)
      existing.party_count += Math.max(0, Math.round(Number(r.party_count) || 0))
      existing.guest_count += Math.max(0, Math.round(Number(r.guest_count) || 0))
      byMonth.set(month, existing)
    }

    if (rows.length < RECEIPT_MONTHLY_AGGREGATE_PAGE_SIZE) {
      break
    }
    offset += rows.length
  }

  return byMonth
}

/** DB の過去売上（手入力優先・レシート集計で補完）を「過去売上」タブへ書き出す */
async function buildPastSalesSheetUpdatesFromDb(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  existingPastRows?: SheetValues,
): Promise<ReceiptSheetsGasPastSalesUpdate[]> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)

  const [manualResult, receiptByMonth] = await Promise.all([
    supabase
      .from("line_sales_manual_month_gross")
      .select("sales_month, gross_sales_yen, party_count, guest_count, operating_days_count")
      .eq("store_partition_key", key)
      .order("sales_month", { ascending: true }),
    fetchReceiptMonthlyAggregatesForStore(supabase, key),
  ])

  if (manualResult.error) {
    throw new Error(`buildPastSalesSheetUpdatesFromDb: ${manualResult.error.message}`)
  }

  const manualByMonth = new Map<string, {
    gross_sales_yen: number
    party_count: number | null
    guest_count: number | null
    operating_days_count: number | null
  }>()
  for (const row of Array.isArray(manualResult.data) ? manualResult.data : []) {
    const r = row as Record<string, unknown>
    const month = String(r.sales_month ?? "").trim().slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(month)) continue
    const gross = Number(r.gross_sales_yen)
    if (!Number.isFinite(gross) || gross < 0) continue
    manualByMonth.set(month, {
      gross_sales_yen: Math.round(gross),
      party_count: parseOptionalPastSalesInt(r.party_count),
      guest_count: parseOptionalPastSalesInt(r.guest_count),
      operating_days_count: parseOptionalPastSalesInt(r.operating_days_count),
    })
  }

  const allMonths = [...new Set([...manualByMonth.keys(), ...receiptByMonth.keys()])].sort()

  const monthToRow = new Map<string, number>()
  if (existingPastRows) {
    for (let i = 0; i < existingPastRows.length; i += 1) {
      const month = normalizeMonthCell(existingPastRows[i][0])
      if (month) monthToRow.set(month, i + 2)
    }
  }

  const updates: ReceiptSheetsGasPastSalesUpdate[] = []
  for (const month of allMonths) {
    const manual = manualByMonth.get(month)
    if (manual) {
      updates.push({
        row: monthToRow.get(month),
        sales_month: month,
        gross_sales_yen: manual.gross_sales_yen,
        party_count: manual.party_count,
        guest_count: manual.guest_count,
        operating_days_count: manual.operating_days_count,
      })
    } else {
      const agg = receiptByMonth.get(month)!
      updates.push({
        row: monthToRow.get(month),
        sales_month: month,
        gross_sales_yen: agg.gross_sales_yen,
        party_count: agg.party_count > 0 ? agg.party_count : null,
        guest_count: agg.guest_count > 0 ? agg.guest_count : null,
        operating_days_count: null,
        from_receipt: true,
      })
    }
  }
  return updates
}

function parseOptionalPastSalesInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

function pastSalesSheetRowValues(
  storePartitionKey: string,
  update: ReceiptSheetsGasPastSalesUpdate,
): SheetValues {
  return [[
    update.sales_month,
    storePartitionKey,
    update.gross_sales_yen,
    update.party_count ?? "",
    update.guest_count ?? "",
    update.operating_days_count ?? "",
    update.from_receipt ? "FALSE" : "TRUE",
  ]]
}

async function buildBudgetSheetRowUpdatesFromDb(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  existingBudgetRows?: SheetValues,
): Promise<ReceiptSheetsGasBudgetRowUpdate[]> {
  const dbKey = canonicalStorePartitionKeyForDb(config.storePartitionKey)
  const { data, error } = await supabase
    .from("line_sales_month_budgets")
    .select(
      "target_month, budget_yen, weekday_weight, pre_holiday_weight, holiday_weight",
    )
    .eq("store_partition_key", dbKey)
    .order("target_month", { ascending: true })
  if (error) {
    throw new Error(`buildBudgetSheetRowUpdatesFromDb: ${error.message}`)
  }
  const dbRows = Array.isArray(data) ? data : []
  const sheetRows = existingBudgetRows ?? []
  const monthToRowIndex = new Map<string, number>()
  for (let i = 0; i < sheetRows.length; i += 1) {
    const month = normalizeMonthCell(sheetRows[i][0])
    const rowStore = normalizePilotStoreKey(sheetRows[i][2])
    if (month && pilotStorePartitionKeysMatch(rowStore, config.storePartitionKey)) {
      monthToRowIndex.set(month, i)
    }
  }

  const validMonths: string[] = []
  for (const raw of dbRows) {
    const row = raw as Record<string, unknown>
    const month = normalizeMonthCell(row.target_month)
    if (!month) continue
    if (parseNonNegativeInt(row.budget_yen) <= 0) continue
    if (!validMonths.includes(month)) validMonths.push(month)
  }
  const closedByMonth = await loadStoreClosedDatesBatchForMonths(supabase, config.storePartitionKey, validMonths)

  const updates: ReceiptSheetsGasBudgetRowUpdate[] = []
  let nextAppendRow = sheetRows.length + 2
  for (const raw of dbRows) {
    const row = raw as Record<string, unknown>
    const month = normalizeMonthCell(row.target_month)
    if (!month) continue
    const budgetYen = parseNonNegativeInt(row.budget_yen)
    if (budgetYen <= 0) continue
    const closed = closedByMonth.get(month) ?? []
    const operatingDays = countOperatingDaysInCalendarMonth(month, closed)
    const values = [
      month,
      config.storeDisplayName,
      config.storePartitionKey,
      String(budgetYen),
      String(parsePositiveWeight(row.weekday_weight, 1)),
      String(parsePositiveWeight(row.pre_holiday_weight, 1.5)),
      String(parsePositiveWeight(row.holiday_weight, 2)),
      formatClosedDatesForSheetCell(closed, month),
      operatingDays > 0 ? String(operatingDays) : "",
      "TRUE",
    ]
    const idx = monthToRowIndex.get(month)
    const rowNum = idx !== undefined ? idx + 2 : nextAppendRow++
    if (idx === undefined) monthToRowIndex.set(month, rowNum - 2)
    updates.push({ row: rowNum, sales_month: month, values })
  }
  return updates
}

/** DB の月間予算を「月間予算」タブへ書き出す（サイトで登録済みの予算を反映） */
async function exportBudgetFromDbToBudgetSheet(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  logLines: string[],
  preloadedBudgetTab?: { values: SheetValues; tabName: string },
): Promise<{ rows_written: number }> {
  const { values: sheetRows, tabName } = preloadedBudgetTab ?? await (async () => {
    const budgetTabCandidates = [
      ...receiptSheetsTabCandidates(config.storePartitionKey, "budgets"),
      ...(config.storePartitionKey === "bistrocavacava" ? TAB_ALIASES_BUDGETS : []),
    ]
    return getSheetValuesForTab(config.spreadsheetId, budgetTabCandidates, "A2:J500")
  })()
  const updates = await buildBudgetSheetRowUpdatesFromDb(supabase, config, sheetRows)
  if (updates.length === 0) {
    logLines.push("budget_export=0")
    return { rows_written: 0 }
  }
  const batch: Array<{ range: string; values: SheetValues }> = updates.map((u) => ({
    range: formatSheetA1Range(tabName, `A${u.row}:J${u.row}`),
    values: [u.values],
  }))
  await batchUpdateSpreadsheetValues(config.spreadsheetId, batch)
  logLines.push(`budget_export=${batch.length}`)
  return { rows_written: batch.length }
}

async function exportPastSalesFromDbToPastSheet(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  logLines: string[],
  preloadedPastTab?: { values: SheetValues; tabName: string },
): Promise<{ rows_written: number }> {
  const updates = await buildPastSalesSheetUpdatesFromDb(
    supabase,
    config.storePartitionKey,
  )
  if (updates.length === 0) {
    logLines.push("past_sales_export=0")
    return { rows_written: 0 }
  }

  const { values: pastRows, tabName } = preloadedPastTab ?? await (async () => {
    const pastTabCandidates = [
      ...receiptSheetsTabCandidates(config.storePartitionKey, "past"),
      ...(config.storePartitionKey === "bistrocavacava" ? TAB_ALIASES_PAST : []),
    ]
    return getSheetValuesForTab(config.spreadsheetId, pastTabCandidates, "A2:G500")
  })()
  const monthToRowIndex = new Map<string, number>()
  for (let i = 0; i < pastRows.length; i += 1) {
    const month = normalizeMonthCell(pastRows[i][0])
    if (month) monthToRowIndex.set(month, i)
  }

  const batch: Array<{ range: string; values: SheetValues }> = []
  let nextAppendRow = pastRows.length + 2
  for (const update of updates) {
    const idx = monthToRowIndex.get(update.sales_month)
    const rowNum = idx !== undefined ? idx + 2 : nextAppendRow++
    if (idx === undefined) {
      monthToRowIndex.set(update.sales_month, rowNum - 2)
    }
    batch.push({
      range: formatSheetA1Range(tabName, `A${rowNum}:G${rowNum}`),
      values: pastSalesSheetRowValues(config.storePartitionKey, update),
    })
  }

  if (batch.length > 0) {
    await batchUpdateSpreadsheetValues(config.spreadsheetId, batch)
    const snapRows: PastSalesComparable[] = []
    const snapMonths: string[] = []
    for (const update of updates) {
      snapMonths.push(update.sales_month)
      snapRows.push({
        gross_sales_yen: update.gross_sales_yen,
        party_count: update.party_count,
        guest_count: update.guest_count,
        operating_days_count: update.operating_days_count,
      })
    }
    await upsertPastSalesSnapshots(supabase, config.storePartitionKey, snapRows, snapMonths)
  }
  logLines.push(`past_sales_export=${batch.length}`)
  return { rows_written: batch.length }
}

/** DB の休業日を「月間予算」シートの休業日列（H）へ書き戻す */
async function exportClosedDatesFromDbToBudgetSheet(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  preloadedBudgetTab?: { values: SheetValues; tabName: string },
): Promise<NonNullable<ReceiptSheetsSyncResult["closed_dates_export"]>> {
  const datesByMonth: Record<string, string[]> = {}
  const batch: Array<{ range: string; values: SheetValues }> = []

  const { values: budgetRows, tabName } = preloadedBudgetTab ?? await (async () => {
    const budgetTabCandidates = [
      ...receiptSheetsTabCandidates(config.storePartitionKey, "budgets"),
      ...(config.storePartitionKey === "bistrocavacava" ? TAB_ALIASES_BUDGETS : []),
    ]
    return getSheetValuesForTab(config.spreadsheetId, budgetTabCandidates, "A2:J500")
  })()

  const months: string[] = []
  for (const row of budgetRows) {
    const month = normalizeMonthCell(row[0])
    const storeKey = normalizePilotStoreKey(row[2])
    if (month && pilotStorePartitionKeysMatch(storeKey, config.storePartitionKey) && !months.includes(month)) {
      months.push(month)
    }
  }
  const closedByMonth = await loadStoreClosedDatesBatchForMonths(supabase, config.storePartitionKey, months)

  let rowsUpdated = 0
  for (let i = 0; i < budgetRows.length; i += 1) {
    const row = budgetRows[i]
    const month = normalizeMonthCell(row[0])
    const storeKey = normalizePilotStoreKey(row[2])
    if (!month || !pilotStorePartitionKeysMatch(storeKey, config.storePartitionKey)) continue

    const closed = closedByMonth.get(month) ?? []
    datesByMonth[month] = closed
    const rowNum = i + 2
    batch.push({
      range: formatSheetA1Range(tabName, `H${rowNum}`),
      values: [[formatClosedDatesForSheetCell(closed, month)]],
    })
    rowsUpdated += 1
  }

  if (batch.length > 0) {
    await batchUpdateSpreadsheetValues(config.spreadsheetId, batch)
  }

  return {
    rows_updated: rowsUpdated,
    dates_by_month: datesByMonth,
    pilot_store_key: config.storePartitionKey,
  }
}

function normalizePilotStoreKey(raw: unknown): string {
  const resolved = resolveReceiptSheetsStoreKey(String(raw ?? ""))
  return resolved ?? String(raw ?? "").trim().toLowerCase()
}

/** シート表示用: 同月内は M/D、連休は 5/3〜5/6（常に1行・「、」区切り） */
function formatClosedDatesForSheetCell(dates: string[], month?: string): string {
  if (dates.length === 0) return ""
  const sorted = [...dates].sort()
  const targetMonth = month ?? sorted[0]?.slice(0, 7) ?? ""
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
    return sorted.join("、")
  }
  const monthNum = Number(targetMonth.slice(5, 7))
  const dayNums: number[] = []
  for (const iso of sorted) {
    if (!iso.startsWith(`${targetMonth}-`)) continue
    const day = Number(iso.slice(8, 10))
    if (day >= 1 && day <= 31) dayNums.push(day)
  }
  if (dayNums.length === 0) return sorted.join("、")

  const segments = compressClosedDaysToSegments(dayNums, monthNum)
  return segments.join("、")
}

function compressClosedDaysToSegments(days: number[], monthNum: number): string[] {
  const unique = [...new Set(days)].sort((a, b) => a - b)
  const segments: string[] = []
  let start = unique[0]
  let end = unique[0]
  const fmt = (day: number) => `${monthNum}/${day}`
  for (let i = 1; i <= unique.length; i += 1) {
    const d = unique[i]
    if (i < unique.length && d === end + 1) {
      end = d
      continue
    }
    segments.push(start === end ? fmt(start) : `${fmt(start)}〜${fmt(end)}`)
    if (i < unique.length) {
      start = d
      end = d
    }
  }
  return segments
}

async function appendSyncLog(spreadsheetId: string, row: string[]): Promise<void> {
  let hasHeader = false
  for (const tab of TAB_ALIASES_LOG) {
    try {
      const existing = await getSpreadsheetValues(spreadsheetId, formatSheetA1Range(tab, "A1:A1"))
      hasHeader = existing.length > 0
      break
    } catch (e) {
      if (!isSheetNotFoundError(e)) throw e
    }
  }
  if (!hasHeader) {
    await updateSheetValuesForTab(spreadsheetId, TAB_ALIASES_LOG, "A1", [
      ["同期日時", "方向", "店舗キー", "取込結果", "書出結果", "メモ"],
    ])
  }
  await appendSheetValuesForTab(spreadsheetId, TAB_ALIASES_LOG, "A:F", [row])
}

type DailySeriesRow = {
  date: string
  gross_sales_yen: number
  party_count: number
  guest_count: number
  receipt_count: number
}

async function buildDailySeriesForStoreMonth(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  month: string,
): Promise<DailySeriesRow[]> {
  const range = buildJstMonthRange(month)
  const dayKeys = buildJstDateKeysForMonth(month)
  const dayKeySet = new Set(dayKeys)

  const rows = await queryStoreReceiptRows(supabase, {
    storeKey: storePartitionKey,
    createdFrom: range.startIso,
    createdTo: range.endIso,
    orderByCreatedAt: true,
    limit: 20000,
  })

  const dailyMap = new Map<string, DailySeriesRow>()
  for (const row of rows) {
    const dayKey = resolveReceiptEntryDateKeyForMonth(row.receipt_date, month)
    if (!dayKey || !dayKeySet.has(dayKey)) continue
    const gross = parseNonNegativeInt(row.gross_sales_yen)
    const party = parseNonNegativeInt(row.party_count)
    const guest = parseNonNegativeInt(row.guest_count)
    const existing = dailyMap.get(dayKey)
    if (!existing) {
      dailyMap.set(dayKey, {
        date: dayKey,
        gross_sales_yen: gross,
        party_count: party,
        guest_count: guest,
        receipt_count: 1,
      })
    } else {
      existing.gross_sales_yen += gross
      existing.party_count += party
      existing.guest_count += guest
      existing.receipt_count += 1
    }
  }

  return dayKeys.map((date) => dailyMap.get(date) ?? {
    date,
    gross_sales_yen: 0,
    party_count: 0,
    guest_count: 0,
    receipt_count: 0,
  })
}

type BudgetRow = {
  budget_yen: number
  weekday_weight: number
  pre_holiday_weight: number
  holiday_weight: number
  store_closed_dates: string[]
}

async function fetchBudgetRow(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  month: string,
): Promise<BudgetRow | null> {
  const { data, error } = await supabase
    .from("line_sales_month_budgets")
    .select("budget_yen, weekday_weight, pre_holiday_weight, holiday_weight, store_closed_dates")
    .eq("store_partition_key", storePartitionKey)
    .eq("target_month", month)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to fetch budget: ${error.message}`)
  }
  if (!data) return null
  const row = data as Record<string, unknown>
  const budgetYen = parseNonNegativeInt(row.budget_yen)
  if (budgetYen <= 0) return null

  const { data: closedRows } = await supabase
    .from("line_sales_month_store_closed_days")
    .select("closed_on")
    .eq("store_partition_key", storePartitionKey)
    .eq("target_month", month)

  const closedMerged = await loadStoreClosedDatesForMonth(
    supabase,
    storePartitionKey,
    month,
    row.store_closed_dates,
  )

  return {
    budget_yen: budgetYen,
    weekday_weight: parsePositiveWeight(row.weekday_weight, 1),
    pre_holiday_weight: parsePositiveWeight(row.pre_holiday_weight, 1.5),
    holiday_weight: parsePositiveWeight(row.holiday_weight, 2),
    store_closed_dates: closedMerged,
  }
}

/** 休業日テーブル＋予算 jsonb を統合（予算行が無くてもテーブルだけ読む） */
async function loadStoreClosedDatesForMonth(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  month: string,
  budgetJsonbRaw?: unknown,
): Promise<string[]> {
  const closedFromTable: string[] = []
  let jsonbRaw = budgetJsonbRaw

  if (jsonbRaw === undefined) {
    const [closedResult, budgetResult] = await Promise.all([
      supabase
        .from("line_sales_month_store_closed_days")
        .select("closed_on")
        .eq("store_partition_key", storePartitionKey)
        .eq("target_month", month),
      supabase
        .from("line_sales_month_budgets")
        .select("store_closed_dates")
        .eq("store_partition_key", storePartitionKey)
        .eq("target_month", month)
        .maybeSingle(),
    ])
    if (closedResult.error) {
      throw new Error(`Failed to fetch store closed days: ${closedResult.error.message}`)
    }
    for (const cr of Array.isArray(closedResult.data) ? closedResult.data : []) {
      const iso = closedOnToMonthDateIso((cr as Record<string, unknown>).closed_on, month)
      if (iso) closedFromTable.push(iso)
    }
    jsonbRaw = (budgetResult.data as Record<string, unknown> | null)?.store_closed_dates
  } else {
    const { data: closedRows, error: closedErr } = await supabase
      .from("line_sales_month_store_closed_days")
      .select("closed_on")
      .eq("store_partition_key", storePartitionKey)
      .eq("target_month", month)
    if (closedErr) {
      throw new Error(`Failed to fetch store closed days: ${closedErr.message}`)
    }
    for (const cr of Array.isArray(closedRows) ? closedRows : []) {
      const iso = closedOnToMonthDateIso((cr as Record<string, unknown>).closed_on, month)
      if (iso) closedFromTable.push(iso)
    }
  }

  return [...new Set([
    ...closedFromTable,
    ...parseStoreClosedDatesForMonth(jsonbRaw, month),
  ])].sort()
}

/** 複数月の休業日を 2 クエリでまとめて取得 */
async function loadStoreClosedDatesBatchForMonths(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  months: string[],
): Promise<Map<string, string[]>> {
  if (months.length === 0) return new Map()
  const [closedResult, budgetResult] = await Promise.all([
    supabase
      .from("line_sales_month_store_closed_days")
      .select("target_month, closed_on")
      .eq("store_partition_key", storePartitionKey)
      .in("target_month", months),
    supabase
      .from("line_sales_month_budgets")
      .select("target_month, store_closed_dates")
      .eq("store_partition_key", storePartitionKey)
      .in("target_month", months),
  ])
  const tableByMonth = new Map<string, string[]>()
  for (const cr of Array.isArray(closedResult.data) ? closedResult.data : []) {
    const r = cr as Record<string, unknown>
    const m = String(r.target_month ?? "").slice(0, 7)
    const iso = closedOnToMonthDateIso(r.closed_on, m)
    if (!iso) continue
    const arr = tableByMonth.get(m) ?? []
    arr.push(iso)
    tableByMonth.set(m, arr)
  }
  const budgetByMonth = new Map<string, unknown>()
  for (const br of Array.isArray(budgetResult.data) ? budgetResult.data : []) {
    const r = br as Record<string, unknown>
    const m = String(r.target_month ?? "").slice(0, 7)
    budgetByMonth.set(m, r.store_closed_dates)
  }
  const result = new Map<string, string[]>()
  for (const month of months) {
    const fromTable = tableByMonth.get(month) ?? []
    const jsonbRaw = budgetByMonth.get(month)
    result.set(month, [...new Set([...fromTable, ...parseStoreClosedDatesForMonth(jsonbRaw, month)])].sort())
  }
  return result
}

function closedOnToMonthDateIso(value: unknown, month: string): string | null {
  if (value == null) return null
  const s = String(value).trim()
  const matched = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (!matched) return null
  const iso = matched[1]
  if (!iso.startsWith(`${month}-`)) return null
  return iso
}

async function upsertBudgetRow(
  supabase: ReturnType<typeof createClient>,
  input: {
    store_partition_key: string
    month: string
    budget_yen: number
    weekday_weight: number
    pre_holiday_weight: number
    holiday_weight: number
    store_closed_dates: string[]
  },
): Promise<void> {
  const updatedAt = new Date().toISOString()
  const { error } = await supabase
    .from("line_sales_month_budgets")
    .upsert(
      {
        store_partition_key: input.store_partition_key,
        target_month: input.month,
        budget_yen: input.budget_yen,
        weekday_weight: input.weekday_weight,
        pre_holiday_weight: input.pre_holiday_weight,
        holiday_weight: input.holiday_weight,
        store_closed_dates: input.store_closed_dates,
        updated_at: updatedAt,
      },
      { onConflict: "store_partition_key,target_month" },
    )
  if (error) {
    throw new Error(error.message)
  }

  const { error: delErr } = await supabase
    .from("line_sales_month_store_closed_days")
    .delete()
    .eq("store_partition_key", input.store_partition_key)
    .eq("target_month", input.month)
  if (delErr) {
    throw new Error(delErr.message)
  }
  if (input.store_closed_dates.length > 0) {
    const rows = input.store_closed_dates.map((closed_on) => ({
      store_partition_key: input.store_partition_key,
      target_month: input.month,
      closed_on,
    }))
    const { error: insErr } = await supabase.from("line_sales_month_store_closed_days").insert(rows)
    if (insErr) {
      throw new Error(insErr.message)
    }
  }
}

function listPilotSyncMonthsJst(): string[] {
  const now = new Date()
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now)
  const y = Number(parts.find((p) => p.type === "year")?.value ?? now.getUTCFullYear())
  const m = Number(parts.find((p) => p.type === "month")?.value ?? 1)
  const current = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`
  const prevTotal = y * 12 + (m - 1) - 1
  const py = Math.floor(prevTotal / 12)
  const pm = (prevTotal % 12) + 1
  const previous = `${String(py).padStart(4, "0")}-${String(pm).padStart(2, "0")}`
  return [previous, current]
}

function normalizeMonthCell(raw: unknown): string | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return formatYearMonthJst(raw)
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 20000 && raw < 120000) {
    const ms = Math.round((raw - 25569) * 86400 * 1000)
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) return formatYearMonthJst(d)
  }
  const s = String(raw ?? "").trim()
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return s
  const isoDay = /^(\d{4})-(0[1-9]|1[0-2])-\d{2}/.exec(s)
  if (isoDay) {
    return `${isoDay[1]}-${isoDay[2]}`
  }
  const loose = /^(\d{4})[/-](\d{1,2})$/.exec(s)
  if (loose) {
    const y = Number(loose[1])
    const mo = Math.min(12, Math.max(1, Number(loose[2])))
    return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}`
  }
  return null
}

function formatYearMonthJst(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d)
  const y = parts.find((p) => p.type === "year")?.value ?? "1970"
  const m = parts.find((p) => p.type === "month")?.value ?? "01"
  return `${y}-${m}`
}

/** 月間予算シート行（10列=営業日数あり / 9列=旧形式） */
export function parseMonthlyBudgetSheetRow(row: unknown[]): {
  enabledCol: number
  closedCol: number
  operatingDaysCol: number | null
} {
  const len = Array.isArray(row) ? row.length : 0
  if (len >= 10) {
    const enabledRaw = String(row[9] ?? "").trim().toLowerCase()
    if (
      enabledRaw === "true" || enabledRaw === "false" || enabledRaw === "有効"
      || enabledRaw === "0" || enabledRaw === ""
    ) {
      return { enabledCol: 9, closedCol: 7, operatingDaysCol: 8 }
    }
  }
  return { enabledCol: 8, closedCol: 7, operatingDaysCol: null }
}

export function buildBudgetOperatingDaysSheetUpdates(
  budgetRows: SheetValues,
  storePartitionKey: string,
): ReceiptSheetsGasOperatingDaysUpdate[] {
  const updates: ReceiptSheetsGasOperatingDaysUpdate[] = []
  for (let i = 0; i < budgetRows.length; i += 1) {
    const row = budgetRows[i]
    const month = normalizeMonthCell(row[0])
    const storeKey = normalizePilotStoreKey(row[2])
    const budgetCols = parseMonthlyBudgetSheetRow(row)
    if (!month || !pilotStorePartitionKeysMatch(storeKey, storePartitionKey)) continue
    if (!parseEnabledCell(row[budgetCols.enabledCol])) continue
    const closed = parseClosedDatesCell(row[budgetCols.closedCol], month)
    const operatingDays = countOperatingDaysInCalendarMonth(month, closed)
    if (operatingDays <= 0) continue
    updates.push({ row: i + 2, month, operating_days: operatingDays })
  }
  return updates
}

function parseEnabledCell(raw: unknown): boolean {
  const s = String(raw ?? "").trim().toLowerCase()
  if (!s || s === "false" || s === "0" || s === "no" || s === "いいえ") return false
  return true
}

function parseClosedDatesCell(raw: unknown, month: string): string[] {
  const s = String(raw ?? "").trim()
  if (!s) return []
  const allowed = new Set(buildJstDateKeysForMonth(month))
  const monthNum = Number(month.slice(5, 7))
  const tokens = s
    .split(/[\n\r]+/)
    .flatMap((line) => line.split(/[,、]+/))
    .map((p) => p.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const token of tokens) {
    out.push(...expandClosedDateToken(token, month, monthNum, allowed))
  }
  return [...new Set(out)].filter((d) => allowed.has(d)).sort()
}

function expandClosedDateToken(
  token: string,
  month: string,
  monthNum: number,
  allowed: Set<string>,
): string[] {
  const rangeFull = /^(\d{1,2})\/(\d{1,2})[〜~～\-－](\d{1,2})\/(\d{1,2})$/.exec(token)
  if (rangeFull) {
    const m1 = Number(rangeFull[1])
    const d1 = Number(rangeFull[2])
    const d2 = Number(rangeFull[4])
    if (m1 === monthNum) return daysInRange(month, d1, d2, allowed)
    return []
  }
  const rangeShort = /^(\d{1,2})\/(\d{1,2})[〜~～\-－](\d{1,2})$/.exec(token)
  if (rangeShort) {
    const m1 = Number(rangeShort[1])
    const d1 = Number(rangeShort[2])
    const d2 = Number(rangeShort[3])
    if (m1 === monthNum) return daysInRange(month, d1, d2, allowed)
    return []
  }
  const dayOnlyRange = /^(\d{1,2})[〜~～\-－](\d{1,2})$/.exec(token)
  if (dayOnlyRange) {
    return daysInRange(month, Number(dayOnlyRange[1]), Number(dayOnlyRange[2]), allowed)
  }

  let key = token
  if (/^\d{1,2}\/\d{1,2}$/.test(token)) {
    const [mRaw, dRaw] = token.split("/")
    const m = Number(mRaw)
    const d = Number(dRaw)
    if (m === monthNum) {
      key = `${month}-${String(d).padStart(2, "0")}`
    } else {
      key = `${month}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
    }
  } else if (/^\d{1,2}-\d{1,2}$/.test(token)) {
    const dayOnly = token.split("-")[1]
    key = `${month}-${String(dayOnly).padStart(2, "0")}`
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(key) && allowed.has(key)) {
    return [key]
  }
  return []
}

function daysInRange(
  month: string,
  startDay: number,
  endDay: number,
  allowed: Set<string>,
): string[] {
  const from = Math.min(startDay, endDay)
  const to = Math.max(startDay, endDay)
  const out: string[] = []
  for (let d = from; d <= to; d += 1) {
    const iso = `${month}-${String(d).padStart(2, "0")}`
    if (allowed.has(iso)) out.push(iso)
  }
  return out
}

function parseNonNegativeInt(raw: unknown): number {
  const s = normalizeSheetIntegerInput(raw)
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n)
}

function parsePositiveWeight(raw: unknown, fallback: number): number {
  const n = Number(normalizeSheetIntegerInput(raw))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

function buildJstMonthRange(month: string): { startIso: string; endIso: string } {
  const matched = month.match(/^(\d{4})-(\d{2})$/)
  if (!matched) {
    const fallbackStart = new Date()
    const fallbackEnd = new Date(fallbackStart.getTime() + 31 * 24 * 60 * 60 * 1000)
    return { startIso: fallbackStart.toISOString(), endIso: fallbackEnd.toISOString() }
  }
  const year = Number(matched[1])
  const monthNumber = Number(matched[2])
  const startUtc = Date.UTC(year, monthNumber - 1, 1, -9, 0, 0)
  const endUtc = Date.UTC(year, monthNumber, 1, -9, 0, 0)
  return { startIso: new Date(startUtc).toISOString(), endIso: new Date(endUtc).toISOString() }
}

function buildJstDateKeysForMonth(month: string): string[] {
  const matched = month.match(/^(\d{4})-(\d{2})$/)
  if (!matched) return []
  const year = Number(matched[1])
  const monthNum = Number(matched[2])
  const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate()
  const keys: string[] = []
  for (let day = 1; day <= lastDay; day += 1) {
    keys.push(`${String(year).padStart(4, "0")}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`)
  }
  return keys
}

function resolveReceiptEntryDateKeyForMonth(receiptDateValue: unknown, month: string): string | null {
  const receiptDate = String(receiptDateValue ?? "").trim()
  if (/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(receiptDate) && receiptDate.startsWith(`${month}-`)) {
    return receiptDate
  }
  return null
}
