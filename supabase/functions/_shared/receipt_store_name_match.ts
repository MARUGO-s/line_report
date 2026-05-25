import { normalizeInlineText, normalizeReceiptFieldText } from './receipt_parse.ts'
import {
  resolveBestStoreName,
  resolveReceiptNamePartitionKey,
  sanitizeReceiptOcrStoreName,
} from './receipt_store_name_resolve.ts'
import {
  buildStoreReceiptPhoneIndex,
  receiptPhoneMatchesRegistry,
  resolveReceiptPhonePartitionKey,
  type StoreReceiptPhoneIndex,
} from './store_receipt_phones.ts'
import type { StoreRegistryRow } from './store_receipt.ts'

function normalizeStoreCompareKey(raw: string): string {
  return normalizeInlineText(String(raw ?? '').normalize('NFKC'))
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[　\t]/g, '')
    .replace(/[・·\-ー—―_]/g, '')
}

/**
 * Webhook 登録店舗とレシートが同一か。
 * 店名（揺らぎ補正あり）または電話番号のどちらかが一致すれば true。
 */
export function receiptStoreNameMatchesRegistry(
  registryDisplayName: string,
  registryPartitionKey: string,
  receiptStoreName: string | null,
  receiptStorePhone?: string | null,
  registryReceiptPhones?: readonly string[] | null,
  phoneIndex?: StoreReceiptPhoneIndex,
): boolean {
  const registryPk = String(registryPartitionKey ?? '').trim().toLowerCase()
  if (registryPk && receiptPhoneMatchesRegistry(registryPk, receiptStorePhone, registryReceiptPhones)) {
    return true
  }

  const parsedRaw = normalizeReceiptFieldText(receiptStoreName, 80)
  const parsed = parsedRaw ? sanitizeReceiptOcrStoreName(parsedRaw) : null
  if (!parsed) {
    return !!receiptPhoneMatchesRegistry(registryPk, receiptStorePhone, registryReceiptPhones)
  }

  const registered =
    normalizeReceiptFieldText(registryDisplayName, 80)
    ?? normalizeReceiptFieldText(registryPartitionKey, 80)
  if (!registered) return true

  const parsedKey = normalizeStoreCompareKey(parsed)
  const registeredKey = normalizeStoreCompareKey(registered)
  if (!parsedKey || !registeredKey) return true
  if (parsedKey === registeredKey) return true

  const minLen = Math.min(parsedKey.length, registeredKey.length)
  if (minLen >= 4 && (parsedKey.includes(registeredKey) || registeredKey.includes(parsedKey))) {
    return true
  }

  const parsedPk = resolveReceiptNamePartitionKey(parsed)
  const phonePk = resolveReceiptPhonePartitionKey(receiptStorePhone, phoneIndex)
  if (registryPk && parsedPk && registryPk === parsedPk) {
    return true
  }
  if (registryPk && phonePk && registryPk === phonePk) {
    return true
  }

  const parsedResolved = resolveBestStoreName(parsed)
  const registeredResolved = resolveBestStoreName(registered) ?? registered
  if (parsedResolved && registeredResolved) {
    const pr = normalizeStoreCompareKey(parsedResolved)
    const rr = normalizeStoreCompareKey(registeredResolved)
    if (pr && rr && (pr === rr || pr.includes(rr) || rr.includes(pr))) {
      return true
    }
    const resolvedParsedPk = resolveReceiptNamePartitionKey(parsedResolved)
    if (registryPk && resolvedParsedPk && registryPk === resolvedParsedPk) {
      return true
    }
  }

  return false
}

export function resolveParsedStoreNameForDisplay(receiptStoreName: string | null): string {
  const parsed = normalizeReceiptFieldText(receiptStoreName, 80)
  if (!parsed) return '（読み取れませんでした）'
  return resolveBestStoreName(parsed) ?? sanitizeReceiptOcrStoreName(parsed) ?? parsed
}

type StoreRegistryMatchCandidate = {
  store_partition_key: string
  display_name: string
  receipt_phones?: string[] | null
}

/** レシート解析店名に一致する登録店舗を探す（複数候補のうち先頭） */
export function findRegistryEntryForParsedStoreName<T extends StoreRegistryMatchCandidate>(
  registry: T[],
  parsedStoreName: string,
  excludePartitionKey?: string,
  receiptStorePhone?: string | null,
): T | null {
  const phoneIndex = buildStoreReceiptPhoneIndex(registry as StoreRegistryRow[])
  const phonePk = resolveReceiptPhonePartitionKey(receiptStorePhone, phoneIndex)
  if (phonePk && phonePk !== excludePartitionKey) {
    for (const entry of registry) {
      if (entry.store_partition_key === phonePk) return entry
    }
  }

  const parsed = normalizeReceiptFieldText(parsedStoreName, 80)
  if (!parsed) return null

  const parsedPk = resolveReceiptNamePartitionKey(parsed)
  if (parsedPk && parsedPk !== excludePartitionKey) {
    for (const entry of registry) {
      if (entry.store_partition_key === parsedPk) return entry
    }
  }

  for (const entry of registry) {
    if (excludePartitionKey && entry.store_partition_key === excludePartitionKey) continue
    if (receiptStoreNameMatchesRegistry(
      entry.display_name,
      entry.store_partition_key,
      parsed,
      receiptStorePhone,
      entry.receipt_phones,
      phoneIndex,
    )) {
      return entry
    }
  }
  return null
}
