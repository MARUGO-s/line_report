/**
 * Journal Report 商品月次インデックスの純関数ロジック。
 * normalize 規則は admin-api の商品検索と一致させること。
 */

export type JournalProductIndexRow = {
  store_partition_key: string
  year_month: string
  product_name_norm: string
  display_name: string
  product_code: string
  unit_price: number
  qty: number
  amount: number
  day_count: number
  first_date: string | null
  last_date: string | null
}

export type JournalProductLineItem = {
  name: string
  code: string
  unit: number
  qty: number
  amount: number
  business_date: string
  year_month: string
}

/** product-search / インデックス共通の正規化。長音記号は検索互換のためハイフンへ寄せる。 */
export function normalizePosProductSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ーｰ‐‑–—−]/g, "-")
    .replace(/コース/g, "コ-ス")
    .replace(/スペシャル/g, "sp")
    .replace(/[\s　]+/g, "")
    .replace(/[ﾞﾟ]/g, "")
}

export function journalProductIndexKey(
  nameNorm: string,
  unitPrice: number,
): string {
  return `${nameNorm}\u0001${Math.max(0, Math.floor(unitPrice))}`
}

function toNonNegInt(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** parsed_data（1営業日）から商品行を抽出する。 */
export function extractProductLinesFromParsedDay(
  parsed: unknown,
  businessDate: string,
  yearMonth?: string,
): JournalProductLineItem[] {
  const date = String(businessDate ?? "").slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
  const month = String(yearMonth || date.slice(0, 7))
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return []
  if (!isRecord(parsed) || !Array.isArray(parsed.receipts)) return []

  const out: JournalProductLineItem[] = []
  for (const receipt of parsed.receipts) {
    if (!isRecord(receipt) || !Array.isArray(receipt.items)) continue
    for (const item of receipt.items) {
      if (!isRecord(item)) continue
      const name = String(item.name ?? "").trim()
      if (!name) continue
      const code = String(item.code ?? "").trim()
      const unit = toNonNegInt(item.unit)
      const qty = Math.max(1, toNonNegInt(item.qty) || 1)
      const amount = toNonNegInt(item.amount) || unit * qty
      out.push({
        name,
        code,
        unit,
        qty,
        amount,
        business_date: date,
        year_month: month,
      })
    }
  }
  return out
}

type Agg = {
  year_month: string
  product_name_norm: string
  unit_price: number
  qty: number
  amount: number
  days: Set<string>
  nameQty: Map<string, number>
  codeQty: Map<string, number>
  first_date: string | null
  last_date: string | null
}

/** 商品行配列を月次インデックス行へ集約する。 */
export function aggregateJournalProductMonthlyRows(
  storeKey: string,
  lines: readonly JournalProductLineItem[],
): JournalProductIndexRow[] {
  const store = String(storeKey || "").trim()
  if (!store) return []
  const byKey = new Map<string, Agg>()

  for (const line of lines) {
    const nameNorm = normalizePosProductSearchText(line.name)
    if (!nameNorm) continue
    const unit = Math.max(0, Math.floor(Number(line.unit) || 0))
    const month = String(line.year_month || "").trim()
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) continue
    const mapKey = `${month}\u0001${journalProductIndexKey(nameNorm, unit)}`
    let agg = byKey.get(mapKey)
    if (!agg) {
      agg = {
        year_month: month,
        product_name_norm: nameNorm,
        unit_price: unit,
        qty: 0,
        amount: 0,
        days: new Set(),
        nameQty: new Map(),
        codeQty: new Map(),
        first_date: null,
        last_date: null,
      }
      byKey.set(mapKey, agg)
    }
    const qty = Math.max(1, Math.floor(Number(line.qty) || 1))
    const amount = Math.max(0, Math.floor(Number(line.amount) || unit * qty))
    agg.qty += qty
    agg.amount += amount
    const day = String(line.business_date || "").slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      agg.days.add(day)
      if (!agg.first_date || day < agg.first_date) agg.first_date = day
      if (!agg.last_date || day > agg.last_date) agg.last_date = day
    }
    const display = String(line.name || "").trim()
    if (display) {
      agg.nameQty.set(display, (agg.nameQty.get(display) || 0) + qty)
    }
    const code = String(line.code || "").trim()
    if (code) {
      agg.codeQty.set(code, (agg.codeQty.get(code) || 0) + qty)
    }
  }

  const rows: JournalProductIndexRow[] = []
  for (const agg of byKey.values()) {
    const displayName = [...agg.nameQty.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
      [0]?.[0] || agg.product_name_norm
    const productCode = [...agg.codeQty.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
      [0]?.[0] || ""
    rows.push({
      store_partition_key: store,
      year_month: agg.year_month,
      product_name_norm: agg.product_name_norm,
      display_name: displayName,
      product_code: productCode,
      unit_price: agg.unit_price,
      qty: agg.qty,
      amount: agg.amount,
      day_count: agg.days.size,
      first_date: agg.first_date,
      last_date: agg.last_date,
    })
  }

  return rows.sort((a, b) =>
    a.year_month.localeCompare(b.year_month) ||
    a.product_name_norm.localeCompare(b.product_name_norm) ||
    a.unit_price - b.unit_price
  )
}

/** フィルタ用: インデックス行が商品検索条件に合うか（name_norm 前提）。 */
export function indexRowMatchesProductFilter(
  row: {
    product_name_norm: string
    product_code?: string
    unit_price: number
  },
  filter: {
    tokens: string[]
    joinedQ: string
    codeNorm: string
    unitMin: number | null
    unitMax: number | null
  },
): boolean {
  const nameNorm = row.product_name_norm
  const code = String(row.product_code || "")
  const unit = row.unit_price
  if (filter.codeNorm) {
    const itemCodeDigits = code.replace(/\D/g, "")
    if (
      !itemCodeDigits.endsWith(filter.codeNorm) &&
      itemCodeDigits !== filter.codeNorm
    ) {
      return false
    }
  }
  if (filter.unitMin != null && unit < filter.unitMin) return false
  if (filter.unitMax != null && unit > filter.unitMax) return false
  if (filter.tokens.length || filter.joinedQ) {
    const tokenOk = filter.tokens.length
      ? filter.tokens.every((t) => nameNorm.includes(t))
      : false
    const joinedOk = filter.joinedQ.length >= 2
      ? nameNorm.includes(filter.joinedQ)
      : false
    const wantsCourse =
      filter.tokens.some((t) => t.includes("コ-ス") || t.includes("course")) ||
      /コ-ス|course/.test(filter.joinedQ)
    const aliasTokens = filter.tokens.filter((t) =>
      t.length >= 1 &&
      t.length <= 8 &&
      !t.includes("コ-ス") &&
      t !== "course" &&
      !/^\d+$/.test(t)
    )
    const looseAliasCourse = wantsCourse && aliasTokens.some((t) =>
      nameNorm.includes(t) &&
      (nameNorm.includes("コ-ス") || nameNorm.includes("course"))
    )
    if (!tokenOk && !joinedOk && !looseAliasCourse) return false
  }
  return true
}
