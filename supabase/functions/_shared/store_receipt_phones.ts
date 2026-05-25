/**
 * レシートに印字される店舗電話番号 → store_partition_key
 * 主データ: store_webhook_tables.receipt_phones（管理画面）
 * フォールバック: STORE_RECEIPT_PHONES（未移行店舗）
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import { RECEIPT_SHEETS_STORE_CATALOG } from './receipt_sheets_store_catalog.ts'
import type { StoreRegistryRow } from './store_receipt.ts'

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

/** コード内フォールバック（DB 未設定店舗） */
export const STORE_RECEIPT_PHONES: Readonly<Record<string, readonly string[]>> = {
  marugoyotsuya: ['0353616205'],
  bistrocavacava: ['0364574938'],
}

export type StoreReceiptPhoneIndex = Readonly<Record<string, readonly string[]>>

function normalizePhonesList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const d = normalizeReceiptPhoneDigits(item)
    if (!d || seen.has(d)) continue
    seen.add(d)
    out.push(d)
  }
  return out
}

/** 受信レシートの電話番号を主データへ学習保存（新規時のみ）。 */
export async function persistLearnedReceiptPhone(
  supabase: SupabaseClient,
  storePartitionKey: string,
  receiptPhone: unknown,
  knownPhones?: readonly string[] | null,
): Promise<string[]> {
  const storeKey = String(storePartitionKey ?? '').trim()
  const digits = normalizeReceiptPhoneDigits(receiptPhone)
  const existing = normalizePhonesList(knownPhones ?? [])
  if (!storeKey || !digits) return existing
  if (existing.includes(digits)) return existing

  const merged = [...existing, digits]
  const { data, error } = await supabase
    .from('store_webhook_tables')
    .update({ receipt_phones: merged })
    .eq('store_partition_key', storeKey)
    .select('receipt_phones')
    .maybeSingle()

  if (error) {
    throw new Error(`persistLearnedReceiptPhone failed: ${error.message}`)
  }

  const saved = data as { receipt_phones?: unknown } | null
  return normalizePhonesList(saved?.receipt_phones ?? merged)
}

/** 管理画面・API 入力（改行・カンマ区切り） */
export function parseReceiptPhonesInput(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const out: string[] = []
    for (const item of raw) {
      out.push(...parseReceiptPhonesInput(item))
    }
    return [...new Set(out)]
  }
  const text = String(raw ?? '').trim()
  if (!text) return []
  const parts = text.split(/[\n\r,、，;；]+/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    const d = normalizeReceiptPhoneDigits(part.trim())
    if (!d || seen.has(d)) continue
    seen.add(d)
    out.push(d)
  }
  return out
}

export function listStorePhonesForPartitionKey(
  storePartitionKey: string,
  knownPhones?: readonly string[] | null,
): readonly string[] {
  const fromKnown = normalizePhonesList(knownPhones ?? [])
  if (fromKnown.length > 0) return fromKnown
  const pk = String(storePartitionKey ?? '').trim().toLowerCase()
  return STORE_RECEIPT_PHONES[pk] ?? []
}

export function buildStoreReceiptPhoneIndex(
  registry: Pick<StoreRegistryRow, 'store_partition_key' | 'receipt_phones'>[],
): StoreReceiptPhoneIndex {
  const index: Record<string, string[]> = {}
  for (const entry of registry) {
    const pk = String(entry.store_partition_key ?? '').trim().toLowerCase()
    if (!pk) continue
    const merged = [
      ...normalizePhonesList(entry.receipt_phones),
      ...normalizePhonesList(STORE_RECEIPT_PHONES[pk]),
    ]
    const seen = new Set<string>()
    const phones: string[] = []
    for (const p of merged) {
      if (seen.has(p)) continue
      seen.add(p)
      phones.push(p)
    }
    if (phones.length) index[pk] = phones
  }
  for (const pk of Object.keys(STORE_RECEIPT_PHONES)) {
    if (index[pk]?.length) continue
    const fallback = normalizePhonesList(STORE_RECEIPT_PHONES[pk])
    if (fallback.length) index[pk] = fallback
  }
  return index
}

export function resolveReceiptPhonePartitionKeys(
  receiptPhone: unknown,
  phoneIndex?: StoreReceiptPhoneIndex,
): string[] {
  const digits = normalizeReceiptPhoneDigits(receiptPhone)
  if (!digits) return []
  const index = phoneIndex ?? STORE_RECEIPT_PHONES
  const hits: string[] = []
  for (const pk of Object.keys(index)) {
    const phones = index[pk] ?? []
    if (phones.some((p) => phoneDigitsEqual(digits, p))) hits.push(pk)
  }
  return hits
}

/** 電話だけで一意に店舗が決まるときの partition key */
export function resolveReceiptPhonePartitionKey(
  receiptPhone: unknown,
  phoneIndex?: StoreReceiptPhoneIndex,
): string | null {
  const keys = resolveReceiptPhonePartitionKeys(receiptPhone, phoneIndex)
  if (keys.length === 1) return keys[0]
  return null
}

export function receiptPhoneMatchesRegistry(
  registryPartitionKey: string,
  receiptPhone: unknown,
  knownPhones?: readonly string[] | null,
): boolean {
  const pk = String(registryPartitionKey ?? '').trim().toLowerCase()
  if (!pk) return false
  const digits = normalizeReceiptPhoneDigits(receiptPhone)
  if (!digits) return false
  const known = listStorePhonesForPartitionKey(pk, knownPhones)
  return known.some((p) => phoneDigitsEqual(digits, p))
}

/** 管理画面表示用: 登録済み電話の有無 */
export function storeHasReceiptPhoneOnFile(
  storePartitionKey: string,
  knownPhones?: readonly string[] | null,
): boolean {
  return listStorePhonesForPartitionKey(storePartitionKey, knownPhones).length > 0
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
