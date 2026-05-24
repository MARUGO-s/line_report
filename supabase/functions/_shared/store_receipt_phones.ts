/**
 * レシートに印字される店舗電話番号 → store_partition_key
 * （公式レシート・日計票の表記を確認して追加。未登録店舗は店名照合のみ）
 */
import { RECEIPT_SHEETS_STORE_CATALOG } from './receipt_sheets_store_catalog.ts'

/** 数字のみ（先頭0あり10〜11桁） */
export function normalizeReceiptPhoneDigits(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const digits = s.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 11) return null
  if (!/^0/.test(digits)) return null
  return digits
}

export function phoneDigitsEqual(a: string, b: string): boolean {
  const da = normalizeReceiptPhoneDigits(a)
  const db = normalizeReceiptPhoneDigits(b)
  if (!da || !db) return false
  if (da === db) return true
  const tailA = da.length >= 10 ? da.slice(-10) : da
  const tailB = db.length >= 10 ? db.slice(-10) : db
  return tailA === tailB
}

/** レシート本文・summary から電話番号を抽出 */
export function extractJapanesePhoneFromText(
  ...sources: Array<string | null | undefined>
): string | null {
  const pattern =
    /(?:TEL|Tel|tel|電話)?\s*(0\d{1,4}[-‐－ー\s]?\d{1,4}[-‐－ー\s]?\d{3,4})/g
  for (const src of sources) {
    const text = String(src ?? '')
    if (!text) continue
    const matches = text.matchAll(pattern)
    for (const m of matches) {
      const normalized = normalizeReceiptPhoneDigits(m[1])
      if (normalized) return normalized
    }
    const compact = text.replace(/\D/g, '')
    const m10 = compact.match(/(0\d{9,10})/)
    if (m10) {
      const normalized = normalizeReceiptPhoneDigits(m10[1])
      if (normalized) return normalized
    }
  }
  return null
}

/**
 * 店舗別電話（ハイフンなし）。複数店舗で同一番号の場合は resolve で曖昧扱い。
 * レシートで確認できた番号から順次追加してください。
 */
export const STORE_RECEIPT_PHONES: Readonly<Record<string, readonly string[]>> = {
  marugoyotsuya: ['0353616205'],
  bistrocavacava: ['0364574938'],
}

export function listStorePhonesForPartitionKey(storePartitionKey: string): readonly string[] {
  const pk = String(storePartitionKey ?? '').trim().toLowerCase()
  return STORE_RECEIPT_PHONES[pk] ?? []
}

export function resolveReceiptPhonePartitionKeys(receiptPhone: unknown): string[] {
  const digits = normalizeReceiptPhoneDigits(receiptPhone)
  if (!digits) return []
  const hits: string[] = []
  for (const pk of Object.keys(STORE_RECEIPT_PHONES)) {
    const phones = STORE_RECEIPT_PHONES[pk] ?? []
    if (phones.some((p) => phoneDigitsEqual(digits, p))) hits.push(pk)
  }
  return hits
}

/** 電話だけで一意に店舗が決まるときの partition key */
export function resolveReceiptPhonePartitionKey(receiptPhone: unknown): string | null {
  const keys = resolveReceiptPhonePartitionKeys(receiptPhone)
  if (keys.length === 1) return keys[0]
  return null
}

export function receiptPhoneMatchesRegistry(
  registryPartitionKey: string,
  receiptPhone: unknown,
): boolean {
  const pk = String(registryPartitionKey ?? '').trim().toLowerCase()
  if (!pk) return false
  const digits = normalizeReceiptPhoneDigits(receiptPhone)
  if (!digits) return false
  const known = listStorePhonesForPartitionKey(pk)
  return known.some((p) => phoneDigitsEqual(digits, p))
}

/** 管理画面表示用: 登録済み電話の有無 */
export function storeHasReceiptPhoneOnFile(storePartitionKey: string): boolean {
  return listStorePhonesForPartitionKey(storePartitionKey).length > 0
}

/** catalog に存在するキーのみ（typo 防止） */
export function validateStoreReceiptPhoneCatalog(): string[] {
  const warnings: string[] = []
  for (const pk of Object.keys(STORE_RECEIPT_PHONES)) {
    if (!(pk in RECEIPT_SHEETS_STORE_CATALOG)) {
      warnings.push(`STORE_RECEIPT_PHONES: unknown key ${pk}`)
    }
  }
  return warnings
}
