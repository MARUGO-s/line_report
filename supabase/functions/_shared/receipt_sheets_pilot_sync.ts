import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import {
  fetchManualMonthSalesMapForStore,
  manualMonthSalesFromRow,
  upsertManualMonthSalesEntries,
  type ManualMonthSalesRecord,
  type ManualMonthSalesUpsertEntry,
  normalizeSheetIntegerInput,
  parsePastSalesSheetRow,
} from "./manual_month_sales.ts"
import {
  allocateDailyBudgetsForMonth,
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
  canonicalStorePartitionKeyForDb,
  resolveReceiptSheetsStoreDisplayName,
  resolveReceiptSheetsStoreKey,
  pilotStorePartitionKeysMatch,
  type ReceiptSheetsStoreEntry,
} from "./receipt_sheets_store_catalog.ts"
import {
  getSpreadsheetTitleSet,
  invalidateSpreadsheetTitleCache,
  listKnownStoreReceiptSheetsTabCandidates,
  resolveStoreReceiptSheetsTabs,
} from "./receipt_sheets_tab_resolve.ts"

/** Google スプレッドシートのタブ名（日本語・正） */
export const SHEET_MONTHLY_BUDGETS = "月間予算"
export const SHEET_PAST_SALES = "過去売上"
export const SHEET_DAILY_SALES = "日次売上"
export const SHEET_SYNC_LOG = "同期ログ"
export const SHEET_README = "使い方"

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
  /**
   * メニューからの手動同期向け。セル内容が DB と違う行は更新日時が古くてもシートを DB に反映し、
   * 同じ実行内の push ではその月を上書きしない。
   */
  preferSheetOnContentDiff?: boolean
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
    /** 今回の pull でシート→DB した月（both 時の push スキップ用） */
    sheet_won_budget_months?: string[]
    sheet_won_past_months?: string[]
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
  updated_at?: string | null
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
  /** DB の月間予算 → 月間予算タブ（A〜K 行まるごと） */
  budget_row_updates?: ReceiptSheetsGasBudgetRowUpdate[]
}

export type ReceiptSheetsGasBudgetRowUpdate = {
  row?: number
  sales_month: string
  values: string[]
}

type BudgetComparable = {
  budget_yen: number
  mon_weight: number
  tue_weight: number
  wed_weight: number
  thu_weight: number
  fri_weight: number
  sat_weight: number
  sun_weight: number
  holiday_weight: number | null
  pre_holiday_weight: number | null
  store_closed_dates: string[]
  updated_at?: string | null
}

const SYNC_SHEET_TIME_ZONE = "Asia/Tokyo"
const JST_OFFSET_MS = 9 * 60 * 60 * 1000
/** タイムゾーン無しの yyyy-MM-dd HH:mm:ss は日本時間として解釈（サーバーは UTC 実行のため） */
const JST_PLAIN_UPDATED_AT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?$/

function parseSyncUpdatedAtToMs(value: string): number | null {
  const s = value.trim()
  if (!s) return null
  if (/[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const ms = Date.parse(s)
    return Number.isFinite(ms) ? ms : null
  }
  const plain = JST_PLAIN_UPDATED_AT_RE.exec(s)
  if (plain) {
    const y = Number(plain[1])
    const mo = Number(plain[2])
    const d = Number(plain[3])
    const h = Number(plain[4])
    const mi = Number(plain[5])
    const sec = Number(plain[6] ?? "0")
    return Date.UTC(y, mo - 1, d, h, mi, sec) - JST_OFFSET_MS
  }
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : null
}

/** シートの更新日時列用（日本時間・Z なし）。UTC の ISO をそのまま入れると東京設定でも 9 時間ずれて見える */
function formatSyncUpdatedAtForSheet(value?: unknown): string {
  let ms: number | null = null
  if (value != null && String(value).trim() !== "") {
    ms = parseSyncUpdatedAtToMs(String(value))
  }
  const date = new Date(ms ?? Date.now())
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SYNC_SHEET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00"
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`
}

function normalizeSyncUpdatedAt(value: unknown): string | null {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null
  const ms = parseSyncUpdatedAtToMs(s)
  if (ms == null) return null
  return new Date(ms).toISOString()
}

function updatedAtMillis(value: unknown): number | null {
  const normalized = normalizeSyncUpdatedAt(value)
  if (!normalized) return null
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? ms : null
}

function isDbNewerThanSheet(
  dbUpdatedAt: unknown,
  sheetUpdatedAt: unknown,
): boolean {
  const dbMs = updatedAtMillis(dbUpdatedAt)
  const sheetMs = updatedAtMillis(sheetUpdatedAt)
  if (dbMs == null && sheetMs == null) return false
  if (dbMs == null) return false
  if (sheetMs == null) return false
  return dbMs > sheetMs
}

/** both の pull: シート行を DB に取り込むか（新しい方＋内容差分） */
function shouldPreferSheetOnPull(
  dbUpdatedAt: unknown,
  sheetUpdatedAt: unknown,
  valuesDiffer: boolean,
  preferSheetOnContentDiff = false,
): boolean {
  if (preferSheetOnContentDiff && valuesDiffer) return true
  const dbMs = updatedAtMillis(dbUpdatedAt)
  const sheetMs = updatedAtMillis(sheetUpdatedAt)
  if (sheetMs != null && dbMs != null) {
    if (sheetMs > dbMs) return true
    if (dbMs > sheetMs) return false
    return valuesDiffer
  }
  if (sheetMs != null) return true
  if (dbMs != null) return valuesDiffer
  return valuesDiffer
}

function sheetPastRowUpdatedAt(row: SheetValues | undefined): string | null {
  if (!row) return null
  const pastCols = parsePastSalesSheetRow(row)
  if (pastCols.updatedAtCol == null) return null
  return normalizeSyncUpdatedAt(row[pastCols.updatedAtCol])
}

/** 過去売上シートの「手入力」列（TRUE） */
function sheetPastRowIsManualEntry(row: SheetValues | undefined): boolean {
  if (!row) return false
  return String(row[7] ?? "").trim().toUpperCase() === "TRUE"
}

function sheetBudgetRowUpdatedAt(row: SheetValues | undefined): string | null {
  if (!row) return null
  const budgetCols = parseMonthlyBudgetSheetRow(row)
  if (budgetCols.updatedAtCol == null) return null
  return normalizeSyncUpdatedAt(row[budgetCols.updatedAtCol])
}

function sheetColumnLetter1Based(col: number): string {
  let n = col
  let s = ""
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function latestSyncTimestamp(...values: Array<string | null | undefined>): string | null {
  let bestMs: number | null = null
  let best: string | null = null
  for (const v of values) {
    const normalized = normalizeSyncUpdatedAt(v)
    const ms = updatedAtMillis(normalized)
    if (ms == null) continue
    if (bestMs == null || ms > bestMs) {
      bestMs = ms
      best = normalized
    }
  }
  return best
}

/** シート側の削除を DB に反映するか（both: 更新日時比較 / pull: シート優先） */
function shouldDeleteDbRowMissingFromSheet(
  dbUpdatedAt: unknown,
  sheetWatermark: string | null,
  mode: "pull" | "both",
): boolean {
  if (mode === "pull") return true
  if (sheetWatermark == null) return false
  return !isDbNewerThanSheet(dbUpdatedAt, sheetWatermark)
}

/** push で DB→シート復元してよいか（both は行の更新日時で新しい方のみ書き戻す） */
function shouldPushDbMonthToSheet(
  month: string,
  dbUpdatedAt: unknown,
  monthsOnSheet: Set<string>,
  sheetWatermark: string | null,
  mode: "pull" | "push" | "both",
  sheetRowUpdatedAt?: string | null,
): boolean {
  if (mode === "pull") return false
  if (mode === "push") return true
  if (monthsOnSheet.has(month)) {
    return isDbNewerThanSheet(dbUpdatedAt, sheetRowUpdatedAt ?? null)
  }
  return isDbNewerThanSheet(dbUpdatedAt, sheetWatermark)
}

type SheetDeletionMergeContext = {
  mode: "pull" | "both"
  budgetWatermark: string | null
  pastWatermark: string | null
  dailyWatermark: string | null
  budgetMonthsOnSheet: Set<string>
  pastMonthsOnSheet: Set<string>
  dailyDatesOnSheet: Set<string>
}

async function fetchSheetTabMetaWatermark(
  spreadsheetId: string,
  tabCandidates: string[],
  updatedAtCol1Based: number,
): Promise<string | null> {
  const col = sheetColumnLetter1Based(updatedAtCol1Based)
  try {
    const { values } = await getSheetValuesForTab(
      spreadsheetId,
      tabCandidates,
      `A1:${col}1`,
    )
    const row = values[0]
    if (!row) return null
    return normalizeSyncUpdatedAt(row[updatedAtCol1Based - 1])
  } catch {
    return null
  }
}

function collectBudgetMonthsOnSheet(
  budgetRows: SheetValues,
  storePartitionKey: string,
): Set<string> {
  const months = new Set<string>()
  for (const row of budgetRows) {
    const month = normalizeMonthCell(row[0])
    if (!month) continue
    if (!pilotStorePartitionKeysMatch(storeKeyFromBudgetRow(row), storePartitionKey)) continue
    months.add(month)
  }
  return months
}

function maxBudgetRowUpdatedAtOnSheet(
  budgetRows: SheetValues,
  storePartitionKey: string,
): string | null {
  const stamps: Array<string | null> = []
  for (const row of budgetRows) {
    if (!pilotStorePartitionKeysMatch(storeKeyFromBudgetRow(row), storePartitionKey)) continue
    const cols = parseMonthlyBudgetSheetRow(row)
    if (cols.updatedAtCol == null) continue
    stamps.push(normalizeSyncUpdatedAt(row[cols.updatedAtCol]))
  }
  return latestSyncTimestamp(...stamps)
}

function collectPastMonthsOnSheet(
  pastRows: SheetValues,
  storePartitionKey: string,
): Set<string> {
  const months = new Set<string>()
  for (const row of pastRows) {
    const month = normalizeMonthCell(row[0])
    if (!month) continue
    if (!pilotStorePartitionKeysMatch(normalizePilotStoreKey(row[1]), storePartitionKey)) continue
    months.add(month)
  }
  return months
}

function maxPastRowUpdatedAtOnSheet(
  pastRows: SheetValues,
  storePartitionKey: string,
): string | null {
  const stamps: Array<string | null> = []
  for (const row of pastRows) {
    if (!pilotStorePartitionKeysMatch(normalizePilotStoreKey(row[1]), storePartitionKey)) continue
    const cols = parsePastSalesSheetRow(row)
    if (cols.updatedAtCol == null) continue
    stamps.push(normalizeSyncUpdatedAt(row[cols.updatedAtCol]))
  }
  return latestSyncTimestamp(...stamps)
}

function collectDailyDatesOnSheet(dailyRows: SheetValues, storePartitionKey: string): Set<string> {
  const dates = new Set<string>()
  for (const row of dailyRows) {
    const dateKey = String(row[0] ?? "").trim().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue
    if (!pilotStorePartitionKeysMatch(normalizePilotStoreKey(row[1]), storePartitionKey)) continue
    dates.add(dateKey)
  }
  return dates
}

function maxDailyRowUpdatedAtOnSheet(
  dailyRows: SheetValues,
  storePartitionKey: string,
): string | null {
  const stamps: Array<string | null> = []
  for (const row of dailyRows) {
    if (!pilotStorePartitionKeysMatch(normalizePilotStoreKey(row[1]), storePartitionKey)) continue
    const at = normalizeSyncUpdatedAt(row[9])
    stamps.push(at)
  }
  return latestSyncTimestamp(...stamps)
}

type ResolvedStoreSheetTabs = {
  budget: string[]
  past: string[]
  daily: string[]
}

async function buildSheetDeletionMergeContext(
  config: ReceiptSheetsPilotConfig,
  budgetRows: SheetValues,
  pastRows: SheetValues,
  mode: "pull" | "both",
  resolvedTabs?: ResolvedStoreSheetTabs,
): Promise<SheetDeletionMergeContext> {
  const titleSet = await getSpreadsheetTitleSet(config.spreadsheetId)
  const budgetTabs = resolvedTabs?.budget ?? listKnownStoreReceiptSheetsTabCandidates(
    config.storePartitionKey,
    "budgets",
    titleSet,
  )
  const pastTabs = resolvedTabs?.past ?? listKnownStoreReceiptSheetsTabCandidates(
    config.storePartitionKey,
    "past",
    titleSet,
  )
  const dailyTabs = resolvedTabs?.daily ?? listKnownStoreReceiptSheetsTabCandidates(
    config.storePartitionKey,
    "daily",
    titleSet,
  )

  let dailyRows: SheetValues = []
  try {
    const daily = await getSheetValuesForTab(config.spreadsheetId, dailyTabs, "A2:J2000")
    dailyRows = daily.values
  } catch {
    dailyRows = []
  }

  const [budgetMeta, pastMeta, dailyMeta] = await Promise.all([
    fetchSheetTabMetaWatermark(config.spreadsheetId, budgetTabs, 17),
    fetchSheetTabMetaWatermark(config.spreadsheetId, pastTabs, 9),
    fetchSheetTabMetaWatermark(config.spreadsheetId, dailyTabs, 10),
  ])

  return {
    mode,
    budgetWatermark: latestSyncTimestamp(budgetMeta, maxBudgetRowUpdatedAtOnSheet(budgetRows, config.storePartitionKey)),
    pastWatermark: latestSyncTimestamp(pastMeta, maxPastRowUpdatedAtOnSheet(pastRows, config.storePartitionKey)),
    dailyWatermark: latestSyncTimestamp(dailyMeta, maxDailyRowUpdatedAtOnSheet(dailyRows, config.storePartitionKey)),
    budgetMonthsOnSheet: collectBudgetMonthsOnSheet(budgetRows, config.storePartitionKey),
    pastMonthsOnSheet: collectPastMonthsOnSheet(pastRows, config.storePartitionKey),
    dailyDatesOnSheet: collectDailyDatesOnSheet(dailyRows, config.storePartitionKey),
  }
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

function summarizeStoreSyncError(store: ReceiptSheetsStoreEntry, reason: unknown): string {
  const raw = String(reason ?? "unknown error").replace(/\s+/g, " ").trim()
  const compact = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw
  return `${store.storePartitionKey}: ${compact}`
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

  // isolate 再利用でキャッシュが残ると旧タブ名を誤候補にするため、同期前にクリアする
  invalidateSpreadsheetTitleCache(spreadsheetId)

  await supabase.from("receipt_sheets_sync_status").upsert(
    {
      id: 1,
      last_completed_at: new Date().toISOString(),
      direction,
      failed: false,
      error_message: `進行中 0/${stores.length} 店舗完了`,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  )

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
    const failedStores = settled.flatMap((result, index) =>
      result.status === "rejected"
        ? [summarizeStoreSyncError(stores[index], result.reason)]
        : []
    )
    const summary = `失敗 ${errors.length}/${stores.length} 店舗: ${failedStores.slice(0, 3).join(" | ")}${
      failedStores.length > 3 ? ` | 他${failedStores.length - 3}件` : ""
    }`
    console.warn(`runReceiptSheetsPilotSync: ${summary}`)
    await supabase.from("receipt_sheets_sync_status").upsert(
      {
        id: 1,
        last_completed_at: new Date().toISOString(),
        direction,
        failed: true,
        error_message: summary.slice(0, 500),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    ).catch(() => {})
    try {
      await appendReceiptSheetsBackgroundSyncSummaryLog(spreadsheetId, direction, {
        failed: true,
        errorMessage: summary,
        storeCount: stores.length,
      })
    } catch (e) {
      console.error("appendReceiptSheetsBackgroundSyncSummaryLog failed:", e)
    }
    throw new Error(summary)
  }

  const lastFulfilled = [...settled].reverse().find((result) => result.status === "fulfilled")
  const result = lastFulfilled
    ? lastFulfilled.value
    : { ok: false, store_partition_key: "", spreadsheet_id: spreadsheetId, direction, log_appended: false, generated_at: new Date().toISOString() }

  try {
    await appendReceiptSheetsBackgroundSyncSummaryLog(spreadsheetId, direction, {
      failed: false,
      storeCount: stores.length,
    })
    result.log_appended = true
  } catch (e) {
    console.error("appendReceiptSheetsBackgroundSyncSummaryLog failed:", e)
  }

  return result
}

export type ReceiptSheetsChainedSyncContinuePayload = {
  background_sync_continue: true
  direction: ReceiptSheetsSyncDirection
  offset: number
  started_at: string
  failed_stores?: string[]
  prefer_sheet_on_content_diff?: boolean
}

/** チェーン同期: 1回の Edge 呼び出しあたり CHAINED_STORE_CONCURRENCY 店舗を並列処理 */
const CHAINED_STORE_CONCURRENCY = 2

/** 店舗を小さな並列バッチで処理し、完了後に次の Edge 呼び出しへチェーン（waitUntil タイムアウト回避） */
export async function runReceiptSheetsPilotSyncChainedStep(
  supabase: ReturnType<typeof createClient>,
  direction: ReceiptSheetsSyncDirection,
  offset: number,
  startedAt: string,
  failedStoreKeys: string[],
  preferSheetOnContentDiff = false,
): Promise<void> {
  const spreadsheetId = (Deno.env.get("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID") ?? "").trim()
  if (!spreadsheetId) {
    throw new Error("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID is not set.")
  }

  const stores = listReceiptSheetsStores()
  if (stores.length === 0) {
    throw new Error("No receipt sheets stores configured.")
  }

  // isolate 再利用でキャッシュが残ると旧タブ名を誤候補にするため、毎ステップ先頭でクリアする
  invalidateSpreadsheetTitleCache(spreadsheetId)

  const safeOffset = Math.max(0, Math.min(offset, stores.length))
  const failed = [...failedStoreKeys]

  // 連続店舗処理で Sheets Read クォータ（429）に当たりにくくする
  if (safeOffset > 0) {
    await new Promise((r) => setTimeout(r, 4000))
  }

  if (safeOffset === 0) {
    await supabase.from("receipt_sheets_sync_status").upsert(
      {
        id: 1,
        last_completed_at: startedAt,
        direction,
        failed: false,
        error_message: `進行中 0/${stores.length} 店舗完了`,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
  }

  if (safeOffset >= stores.length) {
    return
  }

  const chunk = stores.slice(safeOffset, safeOffset + CHAINED_STORE_CONCURRENCY)
  const settled = await Promise.allSettled(
    chunk.map((store) =>
      runReceiptSheetsPilotSyncForStore(
        supabase,
        { spreadsheetId, skipSyncLog: false, preferSheetOnContentDiff, ...store },
        direction,
      )
    ),
  )
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === "rejected") {
      console.error(`chained sync failed for ${chunk[i].storePartitionKey}:`, settled[i].reason)
      failed.push(summarizeStoreSyncError(chunk[i], settled[i].reason))
    }
  }

  const doneCount = safeOffset + chunk.length
  const isFinal = doneCount >= stores.length

  if (!isFinal) {
    await supabase.from("receipt_sheets_sync_status").upsert(
      {
        id: 1,
        last_completed_at: new Date().toISOString(),
        direction,
        failed: false,
        error_message: `進行中 ${doneCount}/${stores.length} 店舗完了`,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
    await scheduleReceiptSheetsSyncContinue({
      direction,
      offset: doneCount,
      started_at: startedAt,
      failed_stores: failed,
      prefer_sheet_on_content_diff: preferSheetOnContentDiff || undefined,
    })
    return
  }

  if (failed.length > 0) {
    const summary = `失敗 ${failed.length}/${stores.length} 店舗: ${failed.slice(0, 3).join(" | ")}${
      failed.length > 3 ? ` | 他${failed.length - 3}件` : ""
    }`
    await supabase.from("receipt_sheets_sync_status").upsert(
      {
        id: 1,
        last_completed_at: new Date().toISOString(),
        direction,
        failed: true,
        error_message: summary.slice(0, 500),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
    try {
      await appendReceiptSheetsBackgroundSyncSummaryLog(spreadsheetId, direction, {
        failed: true,
        errorMessage: summary,
        storeCount: stores.length,
        pullSummary: "失敗",
        memo: `background_sync 失敗（${stores.length}店舗）。${summary.slice(0, 180)}`,
      })
    } catch (e) {
      console.error("chained sync failure log failed:", e)
    }
    throw new Error(summary)
  }

  await supabase.from("receipt_sheets_sync_status").upsert(
    {
      id: 1,
      last_completed_at: new Date().toISOString(),
      direction,
      failed: false,
      error_message: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  )
  try {
    await appendReceiptSheetsBackgroundSyncSummaryLog(spreadsheetId, direction, {
      failed: false,
      storeCount: stores.length,
      pullSummary: "成功",
      memo: `background_sync 完了（${stores.length}店舗・${CHAINED_STORE_CONCURRENCY}店舗ずつ並列）。日次タブのJ列が今のISO時刻なら反映済み。`,
    })
  } catch (e) {
    console.error("chained sync success log failed:", e)
  }
}

export async function scheduleReceiptSheetsSyncContinue(
  payload: Omit<ReceiptSheetsChainedSyncContinuePayload, "background_sync_continue">,
): Promise<void> {
  const baseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/$/, "")
  const secret = (Deno.env.get("RECEIPT_SHEETS_SYNC_SECRET") ?? "").trim()
  if (!baseUrl || !secret) {
    throw new Error("SUPABASE_URL or RECEIPT_SHEETS_SYNC_SECRET is not set for sync continue.")
  }
  const url = `${baseUrl}/functions/v1/receipt-sheets-sync-cron`
  const body: ReceiptSheetsChainedSyncContinuePayload = {
    background_sync_continue: true,
    direction: payload.direction,
    offset: payload.offset,
    started_at: payload.started_at,
    failed_stores: payload.failed_stores ?? [],
    prefer_sheet_on_content_diff: payload.prefer_sheet_on_content_diff || undefined,
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "x-receipt-sheets-sync-key": secret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`sync continue HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
}

export async function runReceiptSheetsPilotSyncForStore(
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
  // isolate 再利用や並列処理で別店舗が書き換えたキャッシュを使わないよう、店舗ごとにクリアして取得
  invalidateSpreadsheetTitleCache(config.spreadsheetId)
  const titleSet = await getSpreadsheetTitleSet(config.spreadsheetId)
  const [budgetTabCandidates, pastTabCandidates, dailyTabCandidates] = await Promise.all([
    resolveStoreReceiptSheetsTabs(config.spreadsheetId, config.storePartitionKey, "budgets", titleSet),
    resolveStoreReceiptSheetsTabs(config.spreadsheetId, config.storePartitionKey, "past", titleSet),
    resolveStoreReceiptSheetsTabs(config.spreadsheetId, config.storePartitionKey, "daily", titleSet),
  ])
  const resolvedTabs: ResolvedStoreSheetTabs = {
    budget: budgetTabCandidates,
    past: pastTabCandidates,
    daily: dailyTabCandidates,
  }

  const [budgetTabData, pastTabData, dailyTabData] = await Promise.all([
    getSheetValuesForTab(config.spreadsheetId, budgetTabCandidates, "A2:Q500"),
    getSheetValuesForTab(config.spreadsheetId, pastTabCandidates, "A2:I500"),
    getSheetValuesForTab(config.spreadsheetId, dailyTabCandidates, "A2:J2000"),
  ])

  const sheetDeletionMode = direction === "both"
    ? "both"
    : direction === "pull"
    ? "pull"
    : null
  const mergeCtxForPush = sheetDeletionMode
    ? await buildSheetDeletionMergeContext(
      config,
      budgetTabData.values,
      pastTabData.values,
      sheetDeletionMode,
      resolvedTabs,
    )
    : null

  let skipPushPastMonths = new Set<string>()
  let skipPushBudgetMonths = new Set<string>()

  // both: 先にシート→DB、後に DB→シート（更新日時の新しい側を優先）
  if (direction === "pull" || direction === "both") {
    result.pull = await processPullRowsToDb(
      supabase,
      config,
      budgetTabData.values,
      pastTabData.values,
      logLines,
      {
        bothMerge: direction === "both",
        sheetDeletionMode: sheetDeletionMode ?? undefined,
      },
    )
    skipPushPastMonths = new Set(result.pull.sheet_won_past_months ?? [])
    skipPushBudgetMonths = new Set(result.pull.sheet_won_budget_months ?? [])
    if (skipPushPastMonths.size > 0 || skipPushBudgetMonths.size > 0) {
      logLines.push(
        `sheet_won_skip_push past=${skipPushPastMonths.size} budget=${skipPushBudgetMonths.size}`,
      )
    }
  }

  let dailyExportBuilt: Awaited<ReturnType<typeof buildDailySalesExportRows>> | null = null
  if (direction === "push" || direction === "both") {
    dailyExportBuilt = await buildDailySalesExportRows(supabase, config)
  }
  if (
    config.preferSheetOnContentDiff === true
    && dailyExportBuilt
    && (direction === "pull" || direction === "both")
  ) {
    const dailyPulledMonths = await pullDailySheetEditsToManualMonthGross(
      supabase,
      config,
      dailyExportBuilt.rows,
      dailyTabData.values,
      logLines,
    )
    for (const month of dailyPulledMonths) {
      skipPushPastMonths.add(month)
    }
  }

  if (direction === "push" || direction === "both") {
    result.push = await pushDailySalesToSheet(
      supabase,
      config,
      logLines,
      mergeCtxForPush,
      direction,
      dailyExportBuilt,
      dailyTabData.values,
    )
    const pastExport = await exportPastSalesFromDbToPastSheet(
      supabase,
      config,
      logLines,
      pastTabData,
      mergeCtxForPush,
      direction,
      skipPushPastMonths,
    )
    const budgetExport = await exportBudgetFromDbToBudgetSheet(
      supabase,
      config,
      logLines,
      budgetTabData,
      mergeCtxForPush,
      direction,
      skipPushBudgetMonths,
    )
    if (result.push) {
      result.push.past_sales_rows_written = pastExport.rows_written
      result.push.budget_rows_written = budgetExport.rows_written
    }
  }
  if (direction === "pull" || direction === "push" || direction === "both") {
    result.closed_dates_export = await exportClosedDatesFromDbToBudgetSheet(
      supabase,
      config,
      budgetTabData,
      mergeCtxForPush,
      direction,
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
    const sheetDeletionMode = direction === "both" ? "both" : "pull"
    result.pull = await processPullRowsToDb(
      supabase,
      config,
      input.monthly_budget_rows,
      input.past_sales_rows,
      logLines,
      { bothMerge: direction === "both", sheetDeletionMode },
    )
    if (direction === "both") {
      logLines.push("both: pull(merge) then push")
    }
  }

  if (direction === "push" || direction === "both") {
    const sheetDeletionMode = direction === "both" ? "both" : direction === "pull" ? "pull" : null
    const mergeCtxForPush = sheetDeletionMode && input.monthly_budget_rows && input.past_sales_rows
      ? await buildSheetDeletionMergeContext(
        config,
        input.monthly_budget_rows,
        input.past_sales_rows,
        sheetDeletionMode,
      )
      : null
    const built = await buildDailySalesExportRows(supabase, config)
    let dailyExportRows = built.rows
    if (mergeCtxForPush && (direction === "both" || direction === "pull")) {
      if (mergeCtxForPush.dailyDatesOnSheet.size === 0) {
        if (shouldDeleteDbRowMissingFromSheet(null, mergeCtxForPush.dailyWatermark, mergeCtxForPush.mode)) {
          dailyExportRows = []
        }
      } else {
        dailyExportRows = dailyExportRows.filter((row) =>
          mergeCtxForPush.dailyDatesOnSheet.has(String(row[0] ?? "").slice(0, 10))
        )
      }
    }
    const pastUpdates = await buildPastSalesSheetUpdatesFromDb(
      supabase,
      config.storePartitionKey,
      input.past_sales_rows,
      mergeCtxForPush,
      direction,
    )
    result.push = {
      months_written: built.months_written,
      rows_written: dailyExportRows.length,
      closed_dates_rows_updated: 0,
      past_sales_rows_written: pastUpdates.length,
    }
    sheetExport.daily_sales = { header: built.header, rows: dailyExportRows }
    const budgetUpdates = await buildBudgetSheetRowUpdatesFromDb(
      supabase,
      config,
      input.monthly_budget_rows,
      mergeCtxForPush,
      direction,
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
  const [budgetTabCandidates, pastTabCandidates] = await Promise.all([
    resolveStoreReceiptSheetsTabs(config.spreadsheetId, config.storePartitionKey, "budgets"),
    resolveStoreReceiptSheetsTabs(config.spreadsheetId, config.storePartitionKey, "past"),
  ])
  const [{ values: budgetRows }, { values: pastRows }] = await Promise.all([
    getSheetValuesForTab(config.spreadsheetId, budgetTabCandidates, "A2:Q500"),
    getSheetValuesForTab(config.spreadsheetId, pastTabCandidates, "A2:I500"),
  ])
  return processPullRowsToDb(supabase, config, budgetRows, pastRows, logLines, {
    bothMerge,
    sheetDeletionMode: bothMerge ? "both" : "pull",
  })
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

function budgetComparableFromRow(
  row: Record<string, unknown>,
): BudgetComparable | null {
  const month = normalizeMonthCell(row.target_month)
  if (!month) return null
  const budgetYen = parseNonNegativeInt(row.budget_yen)
  if (budgetYen <= 0) return null
  const hw = Number(row.holiday_weight)
  const phw = Number(row.pre_holiday_weight)
  return {
    budget_yen: budgetYen,
    mon_weight: parsePositiveWeight(row.mon_weight, 1),
    tue_weight: parsePositiveWeight(row.tue_weight, 1),
    wed_weight: parsePositiveWeight(row.wed_weight, 1),
    thu_weight: parsePositiveWeight(row.thu_weight, 1),
    fri_weight: parsePositiveWeight(row.fri_weight, 1),
    sat_weight: parsePositiveWeight(row.sat_weight, 1.5),
    sun_weight: parsePositiveWeight(row.sun_weight, 2),
    holiday_weight: (Number.isFinite(hw) && hw > 0) ? hw : null,
    pre_holiday_weight: (Number.isFinite(phw) && phw > 0) ? phw : null,
    store_closed_dates: parseStoreClosedDatesForMonth(row.store_closed_dates, month).sort(),
    updated_at: normalizeSyncUpdatedAt(row.updated_at),
  }
}

function budgetComparableFromSheetRow(
  row: unknown[],
  month: string,
  budgetCols: { closedCol: number; holidayWeightCol?: number; preHolidayWeightCol?: number },
  storeClosedDates?: string[],
): BudgetComparable | null {
  const budgetYen = parseNonNegativeInt(row[3])
  if (budgetYen <= 0) return null
  const hwRaw = budgetCols.holidayWeightCol != null ? Number(row[budgetCols.holidayWeightCol]) : NaN
  const phwRaw = budgetCols.preHolidayWeightCol != null ? Number(row[budgetCols.preHolidayWeightCol]) : NaN
  return {
    budget_yen: budgetYen,
    mon_weight: parsePositiveWeight(row[4], 1),
    tue_weight: parsePositiveWeight(row[5], 1),
    wed_weight: parsePositiveWeight(row[6], 1),
    thu_weight: parsePositiveWeight(row[7], 1),
    fri_weight: parsePositiveWeight(row[8], 1),
    sat_weight: parsePositiveWeight(row[9], 1.5),
    sun_weight: parsePositiveWeight(row[10], 2),
    holiday_weight: (Number.isFinite(hwRaw) && hwRaw > 0) ? hwRaw : null,
    pre_holiday_weight: (Number.isFinite(phwRaw) && phwRaw > 0) ? phwRaw : null,
    store_closed_dates: (storeClosedDates ?? parseClosedDatesCell(row[budgetCols.closedCol], month)).sort(),
    updated_at: null,
  }
}

function budgetComparableEqual(a: BudgetComparable, b: BudgetComparable): boolean {
  return a.budget_yen === b.budget_yen
    && a.mon_weight === b.mon_weight
    && a.tue_weight === b.tue_weight
    && a.wed_weight === b.wed_weight
    && a.thu_weight === b.thu_weight
    && a.fri_weight === b.fri_weight
    && a.sat_weight === b.sat_weight
    && a.sun_weight === b.sun_weight
    && a.holiday_weight === b.holiday_weight
    && a.pre_holiday_weight === b.pre_holiday_weight
    && a.store_closed_dates.length === b.store_closed_dates.length
    && a.store_closed_dates.every((date, idx) => date === b.store_closed_dates[idx])
}

async function fetchBudgetMapForStore(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  months: string[],
): Promise<Map<string, BudgetComparable>> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  const normalizedMonths = [...new Set(
    months.map((m) => String(m ?? "").trim().slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)),
  )]
  const out = new Map<string, BudgetComparable>()
  if (!key || normalizedMonths.length === 0) return out

  const { data, error } = await supabase
    .from("line_sales_month_budgets")
    .select("target_month, budget_yen, mon_weight, tue_weight, wed_weight, thu_weight, fri_weight, sat_weight, sun_weight, holiday_weight, pre_holiday_weight, store_closed_dates, updated_at")
    .eq("store_partition_key", key)
    .in("target_month", normalizedMonths)

  if (error) {
    console.error(`fetchBudgetMapForStore failed (store=${key}):`, error.message)
    return out
  }

  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const month = normalizeMonthCell(r.target_month)
    if (!month) continue
    const parsed = budgetComparableFromRow(r)
    if (parsed) out.set(month, parsed)
  }
  return out
}

async function fetchAllBudgetMapForStore(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
): Promise<Map<string, BudgetComparable>> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  const out = new Map<string, BudgetComparable>()
  if (!key) return out

  const { data, error } = await supabase
    .from("line_sales_month_budgets")
    .select("target_month, budget_yen, mon_weight, tue_weight, wed_weight, thu_weight, fri_weight, sat_weight, sun_weight, holiday_weight, pre_holiday_weight, store_closed_dates, updated_at")
    .eq("store_partition_key", key)

  if (error) {
    console.error(`fetchAllBudgetMapForStore failed (store=${key}):`, error.message)
    return out
  }

  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const month = normalizeMonthCell(r.target_month)
    if (!month) continue
    const parsed = budgetComparableFromRow(r)
    if (parsed) out.set(month, parsed)
  }
  return out
}

async function fetchAllManualMonthSalesMapForStore(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
): Promise<Map<string, ManualMonthSalesRecord>> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  const out = new Map<string, ManualMonthSalesRecord>()
  if (!key) return out

  const { data, error } = await supabase
    .from("line_sales_manual_month_gross")
    .select("sales_month, gross_sales_yen, party_count, guest_count, operating_days_count, updated_at")
    .eq("store_partition_key", key)

  if (error) {
    console.error(`fetchAllManualMonthSalesMapForStore failed (store=${key}):`, error.message)
    return out
  }

  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const sm = String(r.sales_month ?? "").trim().slice(0, 7)
    const parsed = manualMonthSalesFromRow(r)
    if (parsed) out.set(sm, parsed)
  }
  return out
}

async function deleteBudgetMonthFromDb(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  month: string,
): Promise<void> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)
  const { error: delClosedErr } = await supabase
    .from("line_sales_month_store_closed_days")
    .delete()
    .eq("store_partition_key", key)
    .eq("target_month", month)
  if (delClosedErr) throw new Error(delClosedErr.message)

  const { error } = await supabase
    .from("line_sales_month_budgets")
    .delete()
    .eq("store_partition_key", key)
    .eq("target_month", month)
  if (error) throw new Error(error.message)
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

async function applySheetMissingMonthDeletions(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  mergeCtx: SheetDeletionMergeContext,
  logLines: string[],
  pastEntries: ManualMonthSalesUpsertEntry[],
  pastSnapshotDeletes: string[],
  errors: string[],
): Promise<{ budgetsDeleted: number; pastDeleted: number }> {
  let budgetsDeleted = 0
  let pastDeleted = 0

  const allBudgetDb = await fetchAllBudgetMapForStore(supabase, config.storePartitionKey)
  for (const [month, dbBudget] of allBudgetDb) {
    if (mergeCtx.budgetMonthsOnSheet.has(month)) continue
    if (!shouldDeleteDbRowMissingFromSheet(dbBudget.updated_at, mergeCtx.budgetWatermark, mergeCtx.mode)) {
      continue
    }
    try {
      await deleteBudgetMonthFromDb(supabase, config.storePartitionKey, month)
      budgetsDeleted += 1
    } catch (e) {
      errors.push(`${SHEET_MONTHLY_BUDGETS} ${month} 削除: ${String(e)}`)
    }
  }

  const allManualDb = await fetchAllManualMonthSalesMapForStore(supabase, config.storePartitionKey)
  for (const [month, dbManual] of allManualDb) {
    if (mergeCtx.pastMonthsOnSheet.has(month)) continue
    if (!shouldDeleteDbRowMissingFromSheet(dbManual.updated_at, mergeCtx.pastWatermark, mergeCtx.mode)) {
      continue
    }
    pastEntries.push({ sales_month: month, gross_sales_yen: null })
    pastSnapshotDeletes.push(month)
    pastDeleted += 1
  }

  logLines.push(
    `sheet_missing_deletions mode=${mergeCtx.mode} budgets=${budgetsDeleted} past=${pastDeleted} budget_wm=${mergeCtx.budgetWatermark ?? "(none)"} past_wm=${mergeCtx.pastWatermark ?? "(none)"}`,
  )
  return { budgetsDeleted, pastDeleted }
}

async function processPullRowsToDb(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  budgetRows: SheetValues,
  pastRows: SheetValues,
  logLines: string[],
  opts?: { bothMerge?: boolean; sheetDeletionMode?: "pull" | "both" },
): Promise<NonNullable<ReceiptSheetsSyncResult["pull"]>> {
  const errors: string[] = []
  let budgetsApplied = 0
  let budgetsSkipped = 0
  let pastApplied = 0
  let pastSkipped = 0
  const bothMerge = opts?.bothMerge === true
  const sheetDeletionMode = opts?.sheetDeletionMode
  const budgetMonthsForDb: string[] = []
  const pastMonthsForDb: string[] = []
  if (bothMerge) {
    for (const row of budgetRows) {
      const month = normalizeMonthCell(row[0])
      if (month) budgetMonthsForDb.push(month)
    }
    for (const row of pastRows) {
      const month = normalizeMonthCell(row[0])
      if (month) pastMonthsForDb.push(month)
    }
  }
  const [budgetDbMap, dbMap] = bothMerge
    ? await Promise.all([
      fetchBudgetMapForStore(supabase, config.storePartitionKey, budgetMonthsForDb),
      fetchManualMonthSalesMapForStore(supabase, config.storePartitionKey, pastMonthsForDb),
    ])
    : [
      new Map<string, BudgetComparable>(),
      new Map<string, ManualMonthSalesRecord>(),
    ]
  let budgetDbWins = 0
  let pastDbWins = 0
  const preferSheetOnContentDiff = config.preferSheetOnContentDiff === true
  const sheetWonBudgetMonths = new Set<string>()
  const sheetWonPastMonths = new Set<string>()
  const budgetOperatingDaysByMonth = new Map<string, number>()

  for (let i = 0; i < budgetRows.length; i += 1) {
    const row = budgetRows[i]
    const rowNum = i + 2
    const month = normalizeMonthCell(row[0])
    const storeKey = storeKeyFromBudgetRow(row)
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
    const sheetUpdatedAt = budgetCols.updatedAtCol != null
      ? normalizeSyncUpdatedAt(row[budgetCols.updatedAtCol])
      : null
    const dbBudget = budgetDbMap.get(month)
    const closedCellRaw = String(row[budgetCols.closedCol] ?? "").trim()
    const sheetSpecifiedClosed = closedCellRaw.length > 0
    const storeClosedDates = sheetSpecifiedClosed
      ? parseClosedDatesCell(row[budgetCols.closedCol], month)
      : (dbBudget?.store_closed_dates ?? [])
    const operatingDays = countOperatingDaysInCalendarMonth(month, storeClosedDates)
    if (operatingDays > 0) {
      budgetOperatingDaysByMonth.set(month, operatingDays)
    }
    const sheetComparable = budgetComparableFromSheetRow(row, month, budgetCols, storeClosedDates)
    if (!sheetComparable) {
      errors.push(`${SHEET_MONTHLY_BUDGETS} 行${rowNum}: 予算行の解析に失敗しました`)
      budgetsSkipped += 1
      continue
    }
    if (bothMerge) {
      if (dbBudget) {
        if (budgetComparableEqual(sheetComparable, dbBudget)) {
          budgetsSkipped += 1
          continue
        }
        if (
          !preferSheetOnContentDiff
          && !shouldPreferSheetOnPull(dbBudget.updated_at, sheetUpdatedAt, true, false)
        ) {
          budgetsSkipped += 1
          budgetDbWins += 1
          continue
        }
      }
    }
    try {
      let effectiveClosedDates = storeClosedDates
      if (!sheetSpecifiedClosed) {
        effectiveClosedDates = await loadStoreClosedDatesForMonth(
          supabase,
          config.storePartitionKey,
          month,
        )
      }
      const operatingDays = countOperatingDaysInCalendarMonth(month, effectiveClosedDates)
      if (operatingDays > 0) {
        budgetOperatingDaysByMonth.set(month, operatingDays)
      }
      const hwRaw = budgetCols.holidayWeightCol != null ? Number(row[budgetCols.holidayWeightCol]) : NaN
      const phwRaw = budgetCols.preHolidayWeightCol != null ? Number(row[budgetCols.preHolidayWeightCol]) : NaN
      await upsertBudgetRow(supabase, {
        store_partition_key: config.storePartitionKey,
        month,
        budget_yen: budgetYen,
        mon_weight: parsePositiveWeight(row[4], 1),
        tue_weight: parsePositiveWeight(row[5], 1),
        wed_weight: parsePositiveWeight(row[6], 1),
        thu_weight: parsePositiveWeight(row[7], 1),
        fri_weight: parsePositiveWeight(row[8], 1),
        sat_weight: parsePositiveWeight(row[9], 1.5),
        sun_weight: parsePositiveWeight(row[10], 2),
        holiday_weight: (Number.isFinite(hwRaw) && hwRaw > 0) ? hwRaw : null,
        pre_holiday_weight: (Number.isFinite(phwRaw) && phwRaw > 0) ? phwRaw : null,
        store_closed_dates: effectiveClosedDates,
        updated_at: sheetUpdatedAt ?? new Date().toISOString(),
      })
      budgetsApplied += 1
      sheetWonBudgetMonths.add(month)
    } catch (e) {
      errors.push(`${SHEET_MONTHLY_BUDGETS} 行${rowNum}: ${String(e)}`)
    }
  }

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
    const sheetUpdatedAt = pastCols.updatedAtCol != null
      ? normalizeSyncUpdatedAt(row[pastCols.updatedAtCol])
      : null
    const rawGross = String(row[pastCols.grossCol] ?? "").trim()
    if (rawGross === "") {
      const db = dbMap.get(salesMonth)
      if (
        bothMerge && db
        && !preferSheetOnContentDiff
        && !shouldPreferSheetOnPull(db.updated_at, sheetUpdatedAt, true, false)
      ) {
        pastSkipped += 1
        pastDbWins += 1
        continue
      }
      pastEntries.push({ sales_month: salesMonth, gross_sales_yen: null })
      pastSnapshotDeletes.push(salesMonth)
      pastApplied += 1
      sheetWonPastMonths.add(salesMonth)
    } else {
      const gross = parseNonNegativeInt(rawGross)
      const opDaysFromBudget = budgetOperatingDaysByMonth.get(salesMonth) ?? null
      const entry: ManualMonthSalesUpsertEntry = {
        sales_month: salesMonth,
        gross_sales_yen: gross,
        party_count: pastCols.party_count,
        guest_count: pastCols.guest_count,
        operating_days_count: pastCols.operating_days_count ?? opDaysFromBudget,
        updated_at: sheetUpdatedAt ?? new Date().toISOString(),
      }
      const sheetComparable = pastSalesComparableFromEntry(
        entry as ManualMonthSalesUpsertEntry & { gross_sales_yen: number },
      )
      const db = dbMap.get(salesMonth)
      if (bothMerge && db) {
        const valuesDiffer = !pastSalesComparableEqual(sheetComparable, pastSalesComparableFromManual(db))
        if (!valuesDiffer) {
          pastSkipped += 1
          continue
        }
        if (
          !preferSheetOnContentDiff
          && !shouldPreferSheetOnPull(db.updated_at, sheetUpdatedAt, valuesDiffer, false)
        ) {
          pastSkipped += 1
          pastDbWins += 1
          continue
        }
      }
      pastEntries.push(entry)
      pastSnapshotWrites.push(sheetComparable)
      pastSnapshotMonths.push(salesMonth)
      pastApplied += 1
      sheetWonPastMonths.add(salesMonth)
    }
  }

  if (sheetDeletionMode) {
    const mergeCtx = await buildSheetDeletionMergeContext(
      config,
      budgetRows,
      pastRows,
      sheetDeletionMode,
    )
    const deleted = await applySheetMissingMonthDeletions(
      supabase,
      config,
      mergeCtx,
      logLines,
      pastEntries,
      pastSnapshotDeletes,
      errors,
    )
    budgetsApplied += deleted.budgetsDeleted
    pastApplied += deleted.pastDeleted
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

  if (bothMerge && budgetDbWins > 0) {
    logLines.push(`both budget_db_wins=${budgetDbWins}`)
  }
  if (bothMerge && pastDbWins > 0) {
    logLines.push(`both past_db_wins=${pastDbWins}`)
  }
  if (preferSheetOnContentDiff && (sheetWonBudgetMonths.size > 0 || sheetWonPastMonths.size > 0)) {
    logLines.push(
      `prefer_sheet_content_diff budget=${sheetWonBudgetMonths.size} past=${sheetWonPastMonths.size}`,
    )
  }
  logLines.push(`pull budgets=${budgetsApplied} past=${pastApplied}`)
  return {
    budgets_applied: budgetsApplied,
    budgets_skipped: budgetsSkipped,
    past_sales_applied: pastApplied,
    past_sales_skipped: pastSkipped,
    errors,
    sheet_won_budget_months: [...sheetWonBudgetMonths],
    sheet_won_past_months: [...sheetWonPastMonths],
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
  const updatedAt = formatSyncUpdatedAtForSheet()

  for (const month of months) {
    const series = await buildDailySeriesForStoreMonth(supabase, config.storePartitionKey, month)
    const budgetRow = await fetchBudgetRow(supabase, config.storePartitionKey, month)
    let dailyBudgetMap: Map<string, number> | null = null
    if (budgetRow && budgetRow.budget_yen > 0) {
      const weights: SalesBudgetAllocationWeights = {
        mon: budgetRow.mon_weight,
        tue: budgetRow.tue_weight,
        wed: budgetRow.wed_weight,
        thu: budgetRow.thu_weight,
        fri: budgetRow.fri_weight,
        sat: budgetRow.sat_weight,
        sun: budgetRow.sun_weight,
        holiday: budgetRow.holiday_weight,
        pre_holiday: budgetRow.pre_holiday_weight,
      }
      dailyBudgetMap = allocateDailyBudgetsForMonth(
        month,
        budgetRow.budget_yen,
        weights,
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

type ParsedDailySheetRow = {
  date: string
  gross_sales_yen: number
  party_count: number
  guest_count: number
  updated_at: string
}

function parseDailySheetDataRow(
  row: unknown[],
  storePartitionKey: string,
): ParsedDailySheetRow | null {
  const date = String(row[0] ?? "").trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  if (!pilotStorePartitionKeysMatch(normalizePilotStoreKey(row[1]), storePartitionKey)) return null
  const updatedRaw = normalizeSyncUpdatedAt(row[9])
  return {
    date,
    gross_sales_yen: parseNonNegativeInt(row[3]),
    party_count: parseNonNegativeInt(row[4]),
    guest_count: parseNonNegativeInt(row[5]),
    updated_at: updatedRaw ? formatSyncUpdatedAtForSheet(updatedRaw) : "",
  }
}

function dailyExportRowDiffersFromSheet(
  exportRow: string[],
  sheetRow: ParsedDailySheetRow,
): boolean {
  return parseNonNegativeInt(exportRow[3]) !== sheetRow.gross_sales_yen
    || parseNonNegativeInt(exportRow[4]) !== sheetRow.party_count
    || parseNonNegativeInt(exportRow[5]) !== sheetRow.guest_count
}

function mergeDailyExportRowsPreservingSheetEdits(
  exportRows: string[][],
  dailySheetRows: SheetValues,
  storePartitionKey: string,
): { rows: string[][]; preservedDates: number } {
  const sheetByDate = new Map<string, ParsedDailySheetRow>()
  for (const row of dailySheetRows) {
    const parsed = parseDailySheetDataRow(row, storePartitionKey)
    if (parsed) sheetByDate.set(parsed.date, parsed)
  }
  let preservedDates = 0
  const rows = exportRows.map((exportRow) => {
    const date = String(exportRow[0] ?? "").trim().slice(0, 10)
    const sheetRow = sheetByDate.get(date)
    if (!sheetRow || !dailyExportRowDiffersFromSheet(exportRow, sheetRow)) return exportRow
    preservedDates += 1
    const budgetYen = parseNonNegativeInt(exportRow[6])
    return [
      exportRow[0],
      exportRow[1],
      exportRow[2],
      String(sheetRow.gross_sales_yen),
      String(sheetRow.party_count),
      String(sheetRow.guest_count),
      exportRow[6],
      String(sheetRow.gross_sales_yen - budgetYen),
      exportRow[8],
      sheetRow.updated_at || exportRow[9],
    ]
  })
  return { rows, preservedDates }
}

/** 日次タブで DB 集計と違う月は、シート上の日次合計を月次手入力 DB に反映する */
async function pullDailySheetEditsToManualMonthGross(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  exportRows: string[][],
  dailySheetRows: SheetValues,
  logLines: string[],
): Promise<string[]> {
  const sheetByDate = new Map<string, ParsedDailySheetRow>()
  for (const row of dailySheetRows) {
    const parsed = parseDailySheetDataRow(row, config.storePartitionKey)
    if (parsed) sheetByDate.set(parsed.date, parsed)
  }

  const monthsTouched = new Set<string>()
  for (const exportRow of exportRows) {
    const date = String(exportRow[0] ?? "").trim().slice(0, 10)
    const sheetRow = sheetByDate.get(date)
    if (!sheetRow || !dailyExportRowDiffersFromSheet(exportRow, sheetRow)) continue
    monthsTouched.add(date.slice(0, 7))
  }
  if (monthsTouched.size === 0) {
    logLines.push("daily_sheet_pull=0")
    return []
  }

  const entries: ManualMonthSalesUpsertEntry[] = []
  for (const month of [...monthsTouched].sort()) {
    let gross = 0
    let party = 0
    let guest = 0
    let latestMs: number | null = null
    for (const [date, sheetRow] of sheetByDate) {
      if (!date.startsWith(month)) continue
      gross += sheetRow.gross_sales_yen
      party += sheetRow.party_count
      guest += sheetRow.guest_count
      const ms = parseSyncUpdatedAtToMs(sheetRow.updated_at)
      if (ms != null && (latestMs == null || ms > latestMs)) latestMs = ms
    }
    entries.push({
      sales_month: month,
      gross_sales_yen: gross,
      party_count: party > 0 ? party : null,
      guest_count: guest > 0 ? guest : null,
      updated_at: latestMs != null ? new Date(latestMs).toISOString() : new Date().toISOString(),
    })
  }

  await upsertManualMonthSalesEntries(supabase, config.storePartitionKey, entries)
  logLines.push(`daily_sheet_pull months=${entries.map((e) => e.sales_month).join(",")}`)
  return entries.map((e) => e.sales_month)
}

async function pushDailySalesToSheet(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  logLines: string[],
  mergeCtx?: SheetDeletionMergeContext | null,
  direction: ReceiptSheetsSyncDirection = "push",
  prebuilt?: Awaited<ReturnType<typeof buildDailySalesExportRows>> | null,
  dailySheetRows?: SheetValues,
): Promise<NonNullable<ReceiptSheetsSyncResult["push"]>> {
  const built = prebuilt ?? await buildDailySalesExportRows(supabase, config)
  // DB→シートの push では常に DB 集計の全日次を書き出す（both でもシート既存日付に絞らない）。
  // 絞り込みはシート削除の取込側のみ。手動同期時はシートと違う日次行だけ上書きしない。
  let dataRows = built.rows
  if (config.preferSheetOnContentDiff === true && dailySheetRows && dailySheetRows.length > 0) {
    const merged = mergeDailyExportRowsPreservingSheetEdits(
      dataRows,
      dailySheetRows,
      config.storePartitionKey,
    )
    dataRows = merged.rows
    if (merged.preservedDates > 0) {
      logLines.push(`daily_sheet_preserve=${merged.preservedDates}`)
    }
  }
  const allRows: string[][] = [built.header, ...dataRows]
  const dailyTabCandidates = await resolveStoreReceiptSheetsTabs(
    config.spreadsheetId,
    config.storePartitionKey,
    "daily",
  )
  await updateSheetValuesForTab(
    config.spreadsheetId,
    dailyTabCandidates,
    "A1",
    allRows,
  )
  logLines.push(`push rows=${dataRows.length}`)
  return {
    months_written: built.months_written,
    rows_written: dataRows.length,
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
    const storeKey = storeKeyFromBudgetRow(row)
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

/** store_webhook_tables からレシートテーブル名を取得して月次集計を返す
 * DB の store_partition_key と catalog のキーで大文字小文字が異なる場合があるため
 * DB 側の集計関数へ寄せて取得する */
async function fetchReceiptMonthlyAggregatesForStore(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
): Promise<Map<string, { gross_sales_yen: number; party_count: number; guest_count: number }>> {
  const threeYearsAgo = new Date()
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3)
  const fromDate = threeYearsAgo.toISOString().slice(0, 10)

  const byMonth = new Map<string, { gross_sales_yen: number; party_count: number; guest_count: number }>()
  const { data, error } = await supabase.rpc("aggregate_store_receipt_monthly_sales", {
    p_store_partition_key: storePartitionKey,
    p_from_date: fromDate,
  })
  if (error) {
    console.error(`fetchReceiptMonthlyAggregatesForStore rpc failed (store=${storePartitionKey}):`, error.message)
    return byMonth
  }

  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const month = String(r.sales_month ?? "").trim().slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(month)) continue
    const gross = Number(r.gross_sales_yen)
    if (!Number.isFinite(gross) || gross <= 0) continue
    byMonth.set(month, {
      gross_sales_yen: Math.round(gross),
      party_count: parseOptionalPastSalesInt(r.party_count) ?? 0,
      guest_count: parseOptionalPastSalesInt(r.guest_count) ?? 0,
    })
  }
  return byMonth
}

/** DB の過去売上（手入力優先・レシート集計で補完）を「過去売上」タブへ書き出す */
async function buildPastSalesSheetUpdatesFromDb(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  existingPastRows?: SheetValues,
  mergeCtx?: SheetDeletionMergeContext | null,
  direction: ReceiptSheetsSyncDirection = "push",
  skipPushMonths?: Set<string>,
): Promise<ReceiptSheetsGasPastSalesUpdate[]> {
  const key = canonicalStorePartitionKeyForDb(storePartitionKey)

  const [manualResult, receiptByMonth] = await Promise.all([
    supabase
      .from("line_sales_manual_month_gross")
      .select("sales_month, gross_sales_yen, party_count, guest_count, operating_days_count, updated_at")
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
    updated_at: string | null
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
      updated_at: normalizeSyncUpdatedAt(r.updated_at),
    })
  }

  const allMonths = [...new Set([...manualByMonth.keys(), ...receiptByMonth.keys()])].sort()
  const monthsOnSheet = mergeCtx?.pastMonthsOnSheet

  const monthToRow = new Map<string, number>()
  const pastMonthToRowIndex = new Map<string, number>()
  if (existingPastRows) {
    for (let i = 0; i < existingPastRows.length; i += 1) {
      const month = normalizeMonthCell(existingPastRows[i][0])
      if (!month) continue
      monthToRow.set(month, i + 2)
      pastMonthToRowIndex.set(month, i)
    }
  }

  const pushMode = direction === "both" && mergeCtx ? "both" : direction
  const updates: ReceiptSheetsGasPastSalesUpdate[] = []
  for (const month of allMonths) {
    if (skipPushMonths?.has(month)) continue
    const sheetRowIdx = pastMonthToRowIndex.get(month)
    const pastSheetRow = sheetRowIdx != null && existingPastRows
      ? existingPastRows[sheetRowIdx]
      : undefined
    const sheetRowUpdatedAt = sheetPastRowUpdatedAt(pastSheetRow)
    const manual = manualByMonth.get(month)

    if (monthsOnSheet) {
      if (monthsOnSheet.has(month)) {
        if (manual) {
          if (!shouldPushDbMonthToSheet(
            month,
            manual.updated_at ?? null,
            monthsOnSheet,
            mergeCtx?.pastWatermark ?? null,
            pushMode,
            sheetRowUpdatedAt,
          )) {
            continue
          }
        } else if (sheetPastRowIsManualEntry(pastSheetRow)) {
          continue
        }
      } else if (!shouldPushDbMonthToSheet(
        month,
        manual?.updated_at ?? null,
        monthsOnSheet,
        mergeCtx?.pastWatermark ?? null,
        pushMode,
        sheetRowUpdatedAt,
      )) {
        continue
      }
    }
    if (manual) {
      updates.push({
        row: monthToRow.get(month),
        sales_month: month,
        gross_sales_yen: manual.gross_sales_yen,
        party_count: manual.party_count,
        guest_count: manual.guest_count,
        operating_days_count: manual.operating_days_count,
        updated_at: manual.updated_at,
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
  storeDisplayName: string,
  update: ReceiptSheetsGasPastSalesUpdate,
): SheetValues {
  return [[
    update.sales_month,
    storePartitionKey,
    storeDisplayName,
    update.gross_sales_yen,
    update.party_count ?? "",
    update.guest_count ?? "",
    update.operating_days_count ?? "",
    update.from_receipt ? "FALSE" : "TRUE",
    update.updated_at ? formatSyncUpdatedAtForSheet(update.updated_at) : "",
  ]]
}

async function buildBudgetSheetRowUpdatesFromDb(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  existingBudgetRows?: SheetValues,
  mergeCtx?: SheetDeletionMergeContext | null,
  direction: ReceiptSheetsSyncDirection = "push",
  skipPushMonths?: Set<string>,
): Promise<ReceiptSheetsGasBudgetRowUpdate[]> {
  const dbKey = canonicalStorePartitionKeyForDb(config.storePartitionKey)
  const { data, error } = await supabase
    .from("line_sales_month_budgets")
    .select(
      "target_month, budget_yen, mon_weight, tue_weight, wed_weight, thu_weight, fri_weight, sat_weight, sun_weight, holiday_weight, pre_holiday_weight, updated_at",
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
    const rowStore = storeKeyFromBudgetRow(sheetRows[i])
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
  const monthsOnSheet = mergeCtx?.budgetMonthsOnSheet
  for (const raw of dbRows) {
    const row = raw as Record<string, unknown>
    const month = normalizeMonthCell(row.target_month)
    if (!month) continue
    if (skipPushMonths?.has(month)) continue
    const budgetYen = parseNonNegativeInt(row.budget_yen)
    if (budgetYen <= 0) continue
    const sheetRowIdx = monthToRowIndex.get(month)
    const sheetRowUpdatedAt = sheetBudgetRowUpdatedAt(
      sheetRowIdx !== undefined ? sheetRows[sheetRowIdx] : undefined,
    )
    if (monthsOnSheet && !shouldPushDbMonthToSheet(
      month,
      normalizeSyncUpdatedAt(row.updated_at),
      monthsOnSheet,
      mergeCtx?.budgetWatermark ?? null,
      direction === "both" && mergeCtx ? "both" : direction,
      sheetRowUpdatedAt,
    )) {
      continue
    }
    const closed = closedByMonth.get(month) ?? []
    const operatingDays = countOperatingDaysInCalendarMonth(month, closed)
    const hw = Number(row.holiday_weight)
    const phw = Number(row.pre_holiday_weight)
    const values = [
      month,
      config.storePartitionKey,
      config.storeDisplayName,
      String(budgetYen),
      String(parsePositiveWeight(row.mon_weight, 1)),
      String(parsePositiveWeight(row.tue_weight, 1)),
      String(parsePositiveWeight(row.wed_weight, 1)),
      String(parsePositiveWeight(row.thu_weight, 1)),
      String(parsePositiveWeight(row.fri_weight, 1)),
      String(parsePositiveWeight(row.sat_weight, 1.5)),
      String(parsePositiveWeight(row.sun_weight, 2)),
      (Number.isFinite(hw) && hw > 0) ? String(hw) : "",
      (Number.isFinite(phw) && phw > 0) ? String(phw) : "",
      formatClosedDatesForSheetCell(closed, month),
      operatingDays > 0 ? String(operatingDays) : "",
      "TRUE",
      formatSyncUpdatedAtForSheet(row.updated_at),
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
  mergeCtx?: SheetDeletionMergeContext | null,
  direction: ReceiptSheetsSyncDirection = "push",
  skipPushMonths?: Set<string>,
): Promise<{ rows_written: number }> {
  const { values: sheetRows, tabName } = preloadedBudgetTab ?? await (async () => {
    const budgetTabCandidates = await resolveStoreReceiptSheetsTabs(
      config.spreadsheetId,
      config.storePartitionKey,
      "budgets",
    )
    return getSheetValuesForTab(config.spreadsheetId, budgetTabCandidates, "A2:Q500")
  })()
  const updates = await buildBudgetSheetRowUpdatesFromDb(
    supabase,
    config,
    sheetRows,
    mergeCtx,
    direction,
    skipPushMonths,
  )
  if (updates.length === 0) {
    logLines.push("budget_export=0")
    return { rows_written: 0 }
  }
  const batch: Array<{ range: string; values: SheetValues }> = updates.map((u) => ({
    range: formatSheetA1Range(tabName, `A${u.row}:Q${u.row}`),
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
  mergeCtx?: SheetDeletionMergeContext | null,
  direction: ReceiptSheetsSyncDirection = "push",
  skipPushMonths?: Set<string>,
): Promise<{ rows_written: number }> {
  const { values: pastRows, tabName } = preloadedPastTab ?? await (async () => {
    const pastTabCandidates = await resolveStoreReceiptSheetsTabs(
      config.spreadsheetId,
      config.storePartitionKey,
      "past",
    )
    return getSheetValuesForTab(config.spreadsheetId, pastTabCandidates, "A2:I500")
  })()
  const updates = await buildPastSalesSheetUpdatesFromDb(
    supabase,
    config.storePartitionKey,
    pastRows,
    mergeCtx,
    direction,
    skipPushMonths,
  )
  if (updates.length === 0) {
    logLines.push("past_sales_export=0")
    return { rows_written: 0 }
  }

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
      range: formatSheetA1Range(tabName, `A${rowNum}:I${rowNum}`),
      values: pastSalesSheetRowValues(config.storePartitionKey, config.storeDisplayName, update),
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

/** DB の休業日を「月間予算」シートの休業日列（N・17列形式）へ書き戻す */
async function exportClosedDatesFromDbToBudgetSheet(
  supabase: ReturnType<typeof createClient>,
  config: ReceiptSheetsPilotConfig,
  preloadedBudgetTab?: { values: SheetValues; tabName: string },
  mergeCtx?: SheetDeletionMergeContext | null,
  direction: ReceiptSheetsSyncDirection = "push",
): Promise<NonNullable<ReceiptSheetsSyncResult["closed_dates_export"]>> {
  const datesByMonth: Record<string, string[]> = {}
  const batch: Array<{ range: string; values: SheetValues }> = []

  const { values: budgetRows, tabName } = preloadedBudgetTab ?? await (async () => {
    const budgetTabCandidates = await resolveStoreReceiptSheetsTabs(
      config.spreadsheetId,
      config.storePartitionKey,
      "budgets",
    )
    return getSheetValuesForTab(config.spreadsheetId, budgetTabCandidates, "A2:Q500")
  })()

  const months: string[] = []
  for (const row of budgetRows) {
    const month = normalizeMonthCell(row[0])
    const storeKey = storeKeyFromBudgetRow(row)
    if (month && pilotStorePartitionKeysMatch(storeKey, config.storePartitionKey) && !months.includes(month)) {
      months.push(month)
    }
  }
  const closedByMonth = await loadStoreClosedDatesBatchForMonths(supabase, config.storePartitionKey, months)

  let rowsUpdated = 0
  for (let i = 0; i < budgetRows.length; i += 1) {
    const row = budgetRows[i]
    const month = normalizeMonthCell(row[0])
    const storeKey = storeKeyFromBudgetRow(row)
    if (!month || !pilotStorePartitionKeysMatch(storeKey, config.storePartitionKey)) continue

    const closed = closedByMonth.get(month) ?? []
    datesByMonth[month] = closed
    const rowNum = i + 2
    batch.push({
      range: formatSheetA1Range(tabName, `N${rowNum}`),
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

/** 月間予算: B=店舗キー(1) / 旧形式 C=店舗キー(2) */
function budgetRowStoreKeyIndex(row: unknown[]): 1 | 2 {
  const c1 = String(row[1] ?? "").trim()
  const c2 = String(row[2] ?? "").trim()
  if (!c1 && !c2) return 2
  if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(c1) && c2 && !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(c2)) return 1
  if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(c2) && c1 && !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(c1)) return 2
  const k1 = normalizePilotStoreKey(c1)
  const k2 = normalizePilotStoreKey(c2)
  if (k1 && c1 === k1) return 1
  if (k2 && c2 === k2) return 2
  return 2
}

function storeKeyFromBudgetRow(row: unknown[]): string {
  const idx = budgetRowStoreKeyIndex(row)
  return normalizePilotStoreKey(row[idx]) ?? ""
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

/** 全店舗 background_sync の受付・完了時に同期ログへ1行追記（店舗別ログは skipSyncLog のため出ない） */
export async function appendReceiptSheetsBackgroundSyncSummaryLog(
  spreadsheetId: string,
  direction: ReceiptSheetsSyncDirection,
  opts: {
    failed: boolean
    errorMessage?: string
    storeCount: number
    /** 取込結果列（既定: 成功/失敗） */
    pullSummary?: string
    /** メモ列（未指定時は成功/失敗の定型文） */
    memo?: string
    storeKeyLabel?: string
  },
): Promise<void> {
  const label = opts.storeKeyLabel ?? "(全店舗)"
  const pullCol = opts.pullSummary ?? (opts.failed ? "失敗" : "成功")
  const memo = opts.memo ?? (opts.failed
    ? `background_sync 失敗（${opts.storeCount}店舗中）。${String(opts.errorMessage ?? "").slice(0, 200)}`
    : `background_sync 成功（${opts.storeCount}店舗）。日次タブのJ列が今のISO時刻なら反映済み。`)
  await appendSyncLog(spreadsheetId, [
    new Date().toISOString(),
    direction,
    label,
    pullCol,
    "-",
    memo,
  ])
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
  mon_weight: number
  tue_weight: number
  wed_weight: number
  thu_weight: number
  fri_weight: number
  sat_weight: number
  sun_weight: number
  holiday_weight: number | null
  pre_holiday_weight: number | null
  store_closed_dates: string[]
}

async function fetchBudgetRow(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  month: string,
): Promise<BudgetRow | null> {
  const { data, error } = await supabase
    .from("line_sales_month_budgets")
    .select("budget_yen, mon_weight, tue_weight, wed_weight, thu_weight, fri_weight, sat_weight, sun_weight, holiday_weight, pre_holiday_weight, store_closed_dates")
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

  const closedMerged = await loadStoreClosedDatesForMonth(
    supabase,
    storePartitionKey,
    month,
    row.store_closed_dates,
  )

  const hw = Number(row.holiday_weight)
  const phw = Number(row.pre_holiday_weight)
  return {
    budget_yen: budgetYen,
    mon_weight: parsePositiveWeight(row.mon_weight, 1),
    tue_weight: parsePositiveWeight(row.tue_weight, 1),
    wed_weight: parsePositiveWeight(row.wed_weight, 1),
    thu_weight: parsePositiveWeight(row.thu_weight, 1),
    fri_weight: parsePositiveWeight(row.fri_weight, 1),
    sat_weight: parsePositiveWeight(row.sat_weight, 1.5),
    sun_weight: parsePositiveWeight(row.sun_weight, 2),
    holiday_weight: (Number.isFinite(hw) && hw > 0) ? hw : null,
    pre_holiday_weight: (Number.isFinite(phw) && phw > 0) ? phw : null,
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
    mon_weight: number
    tue_weight: number
    wed_weight: number
    thu_weight: number
    fri_weight: number
    sat_weight: number
    sun_weight: number
    holiday_weight: number | null
    pre_holiday_weight: number | null
    store_closed_dates: string[]
    updated_at?: string
  },
): Promise<void> {
  const updatedAt = normalizeSyncUpdatedAt(input.updated_at) ?? new Date().toISOString()
  const { error } = await supabase
    .from("line_sales_month_budgets")
    .upsert(
      {
        store_partition_key: input.store_partition_key,
        target_month: input.month,
        budget_yen: input.budget_yen,
        mon_weight: input.mon_weight,
        tue_weight: input.tue_weight,
        wed_weight: input.wed_weight,
        thu_weight: input.thu_weight,
        fri_weight: input.fri_weight,
        sat_weight: input.sat_weight,
        sun_weight: input.sun_weight,
        holiday_weight: input.holiday_weight,
        pre_holiday_weight: input.pre_holiday_weight,
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

/** 月間予算シート行（17列=祭日重みあり / 15列=7曜日重みのみ / 11列=旧3区分版 / 10列=旧営業日数あり / 9列=旧形式） */
export function parseMonthlyBudgetSheetRow(row: unknown[]): {
  enabledCol: number
  closedCol: number
  operatingDaysCol: number | null
  updatedAtCol: number | null
  holidayWeightCol?: number
  preHolidayWeightCol?: number
} {
  const len = Array.isArray(row) ? row.length : 0
  // 17列形式: A-Q (enabledCol=P=15, closedCol=N=13, opDaysCol=O=14, updatedAtCol=Q=16, holiday=L=11, pre_holiday=M=12)
  if (len >= 17) {
    const enabledRaw = String(row[15] ?? "").trim().toLowerCase()
    if (
      enabledRaw === "true" || enabledRaw === "false" || enabledRaw === "有効"
      || enabledRaw === "0" || enabledRaw === ""
    ) {
      return { enabledCol: 15, closedCol: 13, operatingDaysCol: 14, updatedAtCol: 16, holidayWeightCol: 11, preHolidayWeightCol: 12 }
    }
  }
  // 15列形式: A-O (enabledCol=N=13, closedCol=L=11, opDaysCol=M=12, updatedAtCol=O=14)
  if (len >= 15) {
    const enabledRaw = String(row[13] ?? "").trim().toLowerCase()
    if (
      enabledRaw === "true" || enabledRaw === "false" || enabledRaw === "有効"
      || enabledRaw === "0" || enabledRaw === ""
    ) {
      return { enabledCol: 13, closedCol: 11, operatingDaysCol: 12, updatedAtCol: 14 }
    }
  }
  if (len >= 11) {
    const enabledRaw = String(row[9] ?? "").trim().toLowerCase()
    if (
      enabledRaw === "true" || enabledRaw === "false" || enabledRaw === "有効"
      || enabledRaw === "0" || enabledRaw === ""
    ) {
      return { enabledCol: 9, closedCol: 7, operatingDaysCol: 8, updatedAtCol: 10 }
    }
  }
  if (len >= 10) {
    const enabledRaw = String(row[9] ?? "").trim().toLowerCase()
    if (
      enabledRaw === "true" || enabledRaw === "false" || enabledRaw === "有効"
      || enabledRaw === "0" || enabledRaw === ""
    ) {
      return { enabledCol: 9, closedCol: 7, operatingDaysCol: 8, updatedAtCol: null }
    }
  }
  return { enabledCol: 8, closedCol: 7, operatingDaysCol: null, updatedAtCol: null }
}

export function buildBudgetOperatingDaysSheetUpdates(
  budgetRows: SheetValues,
  storePartitionKey: string,
): ReceiptSheetsGasOperatingDaysUpdate[] {
  const updates: ReceiptSheetsGasOperatingDaysUpdate[] = []
  for (let i = 0; i < budgetRows.length; i += 1) {
    const row = budgetRows[i]
    const month = normalizeMonthCell(row[0])
    const storeKey = storeKeyFromBudgetRow(row)
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
