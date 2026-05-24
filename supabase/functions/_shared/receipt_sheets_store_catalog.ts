/** スプレッドシート連携対象店舗（pages-config.js STORE_NAMES と同期） */
export const RECEIPT_SHEETS_STORE_CATALOG: Readonly<Record<string, string>> = {
  marugo: "マルゴ",
  marugosecond: "マルゴ セカンド",
  marugogrande: "マルゴ グランデ",
  sannanaichi: "サンナナイチ バル",
  shenlong: "シェンロン&クラウディア",
  claudia2: "クラウディア2",
  sauvage: "ソバージュ",
  barpelota: "バルぺロタ",
  briccola: "トラットリア ブリッコラ",
  violette: "ヴィオレット",
  marugootto: "マルゴ オット",
  donaiya: "元祖どないや 新宿三丁目店",
  marugoyotsuya: "マルゴ 四谷",
  sushikoruri: "鮨こるり",
  bistrocavacava: "ビストロ サヴァサヴァ",
  marugoS: "マルゴエス",
  marugoshinbashi: "マルゴ 新橋",
  marugomarunouchi: "マルゴ丸の内",
  yakinikumarugo: "焼肉マルゴ",
  erics: "エリックスバイエリックトロション",
  mitan: "ミタン",
  marugoD: "マルゴ D",
}

export type ReceiptSheetsStoreEntry = {
  storePartitionKey: string
  storeDisplayName: string
}

/** 正式な store_partition_key（marugoS / marugoD など大文字を保持） */
export function resolveReceiptSheetsStoreKey(raw: string): string | null {
  const trimmed = String(raw ?? "").trim().replace(/\s+/g, "")
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  for (const key of Object.keys(RECEIPT_SHEETS_STORE_CATALOG)) {
    if (key === trimmed || key.toLowerCase() === lower) {
      return key
    }
  }
  return null
}

/** @deprecated resolveReceiptSheetsStoreKey を使用 */
export function normalizeReceiptSheetsStoreKey(raw: string): string {
  return resolveReceiptSheetsStoreKey(raw) ?? String(raw ?? "").trim().toLowerCase()
}

export function isKnownReceiptSheetsStoreKey(storeKey: string): boolean {
  return resolveReceiptSheetsStoreKey(storeKey) !== null
}

export function resolveReceiptSheetsStoreDisplayName(storeKey: string): string | null {
  const canonical = resolveReceiptSheetsStoreKey(storeKey)
  if (!canonical) return null
  return RECEIPT_SHEETS_STORE_CATALOG[canonical] ?? null
}

export function listReceiptSheetsStores(): ReceiptSheetsStoreEntry[] {
  return Object.entries(RECEIPT_SHEETS_STORE_CATALOG)
    .map(([storePartitionKey, storeDisplayName]) => ({ storePartitionKey, storeDisplayName }))
    .sort((a, b) => a.storeDisplayName.localeCompare(b.storeDisplayName, "ja"))
}

/** DB の store_partition_key（marugoS / marugoD は小文字化しない） */
export function canonicalStorePartitionKeyForDb(raw: string): string {
  return resolveReceiptSheetsStoreKey(raw) ?? String(raw ?? "").trim().toLowerCase()
}

export function pilotStorePartitionKeysMatch(a: string, b: string): boolean {
  return canonicalStorePartitionKeyForDb(a) === canonicalStorePartitionKeyForDb(b)
}

/** GAS / Sheets API タブ名: {storeKey}_月間予算 など（正式キーで命名） */
export function receiptSheetsTabName(
  storePartitionKey: string,
  kind: "budgets" | "past" | "daily",
): string {
  const key = resolveReceiptSheetsStoreKey(storePartitionKey)
  if (!key) {
    throw new Error(`Unknown store key for sheet tab: ${storePartitionKey}`)
  }
  switch (kind) {
    case "budgets":
      return `${key}_月間予算`
    case "past":
      return `${key}_過去売上`
    case "daily":
      return `${key}_日次売上`
  }
}

export function receiptSheetsTabCandidates(
  storePartitionKey: string,
  kind: "budgets" | "past" | "daily",
): string[] {
  const primary = receiptSheetsTabName(storePartitionKey, kind)
  const key = resolveReceiptSheetsStoreKey(storePartitionKey)!
  if (kind === "budgets") return [primary, `${key}_monthly_budgets`]
  if (kind === "past") return [primary, `${key}_past_sales`]
  return [primary, `${key}_daily_sales`]
}
