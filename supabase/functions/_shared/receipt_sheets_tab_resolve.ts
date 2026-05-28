import {
  addSpreadsheetSheet,
  formatSheetA1Range,
  listSpreadsheetSheetTitles,
  updateSpreadsheetValues,
} from "./google_sheets_client.ts"
import {
  receiptSheetsTabCandidates,
  receiptSheetsTabName,
  resolveReceiptSheetsStoreKey,
} from "./receipt_sheets_store_catalog.ts"

export const RECEIPT_SHEETS_LEGACY_TAB_ALIASES = {
  budgets: ["月間予算", "monthly_budgets"],
  past: ["過去売上", "past_sales"],
  daily: ["日次売上", "daily_sales"],
} as const

export type ReceiptSheetsTabKind = keyof typeof RECEIPT_SHEETS_LEGACY_TAB_ALIASES

const STORE_TAB_SUFFIX_RE: Record<ReceiptSheetsTabKind, RegExp> = {
  budgets: /_(月間予算|monthly_budgets)$/,
  past: /_(過去売上|past_sales)$/,
  daily: /_(日次売上|daily_sales)$/,
}

/** キャッシュエントリ。同一リクエスト内の重複 API 呼び出しを防ぐが、5分で強制失効 */
const TITLE_CACHE_TTL_MS = 5 * 60 * 1000
type TitleCacheEntry = { set: Set<string>; cachedAt: number }
const titleSetCache = new Map<string, TitleCacheEntry>()

export async function getSpreadsheetTitleSet(spreadsheetId: string): Promise<Set<string>> {
  const id = String(spreadsheetId ?? "").trim()
  if (!id) return new Set()
  const cached = titleSetCache.get(id)
  if (cached && Date.now() - cached.cachedAt < TITLE_CACHE_TTL_MS) return cached.set
  const titles = await listSpreadsheetSheetTitles(id)
  const set = new Set(titles)
  titleSetCache.set(id, { set, cachedAt: Date.now() })
  return set
}

export function invalidateSpreadsheetTitleCache(spreadsheetId: string): void {
  titleSetCache.delete(String(spreadsheetId ?? "").trim())
}

function uniqueNames(names: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const n = String(name ?? "").trim()
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

function hasAnyStorePrefixedTabOfKind(titles: Set<string>, kind: ReceiptSheetsTabKind): boolean {
  const suffix = STORE_TAB_SUFFIX_RE[kind]
  for (const title of titles) {
    if (suffix.test(title)) return true
  }
  return false
}

function findFuzzyStoreTab(
  storeKey: string,
  kind: ReceiptSheetsTabKind,
  titles: Set<string>,
): string | null {
  const escaped = storeKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const patterns: RegExp[] = []
  if (kind === "budgets") {
    patterns.push(new RegExp(`^${escaped}_月間予算$`, "i"), new RegExp(`^${escaped}_monthly_budgets$`, "i"))
  } else if (kind === "past") {
    patterns.push(new RegExp(`^${escaped}_過去売上$`, "i"), new RegExp(`^${escaped}_past_sales$`, "i"))
  } else {
    patterns.push(new RegExp(`^${escaped}_日次売上$`, "i"), new RegExp(`^${escaped}_daily_sales$`, "i"))
  }
  for (const title of titles) {
    if (patterns.some((re) => re.test(title))) return title
  }
  return null
}

function headerRowForNewTab(kind: ReceiptSheetsTabKind): string[][] {
  if (kind === "past") {
    return [[
      "売上月",
      "店舗キー",
      "店舗名",
      "総売上",
      "組数",
      "客数",
      "営業日数",
      "手入力",
      "更新日時",
    ]]
  }
  if (kind === "budgets") {
    return [[
      "対象月",
      "店舗キー",
      "店舗名",
      "予算",
      "月",
      "火",
      "水",
      "木",
      "金",
      "土",
      "日",
      "祝",
      "祝前",
      "休業日",
      "営業日数",
      "有効",
      "更新日時",
    ]]
  }
  return [[
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
  ]]
}

async function ensureStoreSheetTabExists(
  spreadsheetId: string,
  tabName: string,
  kind: ReceiptSheetsTabKind,
): Promise<void> {
  await addSpreadsheetSheet(spreadsheetId, tabName)
  invalidateSpreadsheetTitleCache(spreadsheetId)
  const titles = await getSpreadsheetTitleSet(spreadsheetId)
  titles.add(tabName)
  await updateSpreadsheetValues(
    spreadsheetId,
    formatSheetA1Range(tabName, "A1"),
    headerRowForNewTab(kind),
  )
}

function similarTabHints(
  storeKey: string,
  kind: ReceiptSheetsTabKind,
  titles: Set<string>,
): string[] {
  const hints: string[] = []
  const keyLower = storeKey.toLowerCase()
  const kindNeedle = kind === "past"
    ? "過去"
    : kind === "budgets"
    ? "予算"
    : "日次"
  for (const title of titles) {
    if (hints.length >= 8) break
    const tl = title.toLowerCase()
    if (tl.includes(keyLower) || title.includes(kindNeedle)) {
      hints.push(title)
    }
  }
  return hints
}

export type ResolveStoreReceiptSheetsTabsOptions = {
  /** false のとき存在しないタブは作らずエラー */
  createIfMissing?: boolean
}

/**
 * 店舗同期用タブ名を解決する。
 * 1. {storeKey}_過去売上 等の正式名
 * 2. 大文字小文字違いなどのファジー一致
 * 3. bistrocavacava または店舗別タブが1つも無い旧形式（過去売上 等）
 * 4. 無ければ正式名タブを新規作成
 */
export async function resolveStoreReceiptSheetsTabs(
  spreadsheetId: string,
  storePartitionKey: string,
  kind: ReceiptSheetsTabKind,
  titleSet?: Set<string>,
  options?: ResolveStoreReceiptSheetsTabsOptions,
): Promise<string[]> {
  const storeKey = resolveReceiptSheetsStoreKey(storePartitionKey)
  if (!storeKey) {
    throw new Error(`不明な店舗キーです: ${storePartitionKey}`)
  }
  const titles = titleSet ?? await getSpreadsheetTitleSet(spreadsheetId)
  const primary = receiptSheetsTabCandidates(storePartitionKey, kind)
  const existingPrimary = primary.filter((name) => titles.has(name))
  if (existingPrimary.length > 0) return existingPrimary

  const fuzzy = findFuzzyStoreTab(storeKey, kind, titles)
  if (fuzzy) return [fuzzy]

  const legacy = [...RECEIPT_SHEETS_LEGACY_TAB_ALIASES[kind]]
  const legacyExisting = legacy.filter((name) => titles.has(name))
  const allowLegacy = legacyExisting.length > 0 && (
    storeKey === "bistrocavacava" || !hasAnyStorePrefixedTabOfKind(titles, kind)
  )
  if (allowLegacy) return legacyExisting

  const createIfMissing = options?.createIfMissing !== false
  if (createIfMissing) {
    const tabName = receiptSheetsTabName(storePartitionKey, kind)
    await ensureStoreSheetTabExists(spreadsheetId, tabName, kind)
    return [tabName]
  }

  const tried = uniqueNames([...primary, ...legacy])
  const hints = similarTabHints(storeKey, kind, titles)
  const hintText = hints.length > 0 ? ` 類似タブ: ${hints.join("、")}` : ""
  throw new Error(`シートが見つかりません: ${tried.join(" / ")}。${hintText}`)
}

/** 既存タブのみ（作成しない）。pull/merge 用の候補リスト。 */
export function listKnownStoreReceiptSheetsTabCandidates(
  storePartitionKey: string,
  kind: ReceiptSheetsTabKind,
  titleSet: Set<string>,
): string[] {
  const storeKey = resolveReceiptSheetsStoreKey(storePartitionKey)
  if (!storeKey) return []
  const primary = receiptSheetsTabCandidates(storePartitionKey, kind).filter((n) => titleSet.has(n))
  if (primary.length > 0) return primary
  const fuzzy = findFuzzyStoreTab(storeKey, kind, titleSet)
  if (fuzzy) return [fuzzy]
  const legacy = [...RECEIPT_SHEETS_LEGACY_TAB_ALIASES[kind]].filter((n) => titleSet.has(n))
  if (legacy.length > 0 && (storeKey === "bistrocavacava" || !hasAnyStorePrefixedTabOfKind(titleSet, kind))) {
    return legacy
  }
  return receiptSheetsTabCandidates(storePartitionKey, kind)
}
