import { normalizeInlineText, normalizeReceiptFieldText } from './receipt_parse.ts'
import {
  resolveBestStoreName,
  resolveReceiptNamePartitionKey,
  sanitizeReceiptOcrStoreName,
} from './receipt_store_name_resolve.ts'

function normalizeStoreCompareKey(raw: string): string {
  return normalizeInlineText(String(raw ?? '').normalize('NFKC'))
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[　\t]/g, '')
    .replace(/[・·\-ー—―_]/g, '')
}

/** Webhook 登録店名とレシート解析店名が実質同じか */
export function receiptStoreNameMatchesRegistry(
  registryDisplayName: string,
  registryPartitionKey: string,
  receiptStoreName: string | null,
): boolean {
  const parsedRaw = normalizeReceiptFieldText(receiptStoreName, 80)
  const parsed = parsedRaw ? sanitizeReceiptOcrStoreName(parsedRaw) : null
  if (!parsed) return true

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

  const registryPk = String(registryPartitionKey ?? '').trim().toLowerCase()
  const parsedPk = resolveReceiptNamePartitionKey(parsed)
  if (registryPk && parsedPk && registryPk === parsedPk) {
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
  return normalizeReceiptFieldText(receiptStoreName, 80) ?? '（読み取れませんでした）'
}

type StoreRegistryMatchCandidate = {
  store_partition_key: string
  display_name: string
}

/** レシート解析店名に一致する登録店舗を探す（複数候補のうち先頭） */
export function findRegistryEntryForParsedStoreName<T extends StoreRegistryMatchCandidate>(
  registry: T[],
  parsedStoreName: string,
  excludePartitionKey?: string,
): T | null {
  const parsed = normalizeReceiptFieldText(parsedStoreName, 80)
  if (!parsed) return null

  for (const entry of registry) {
    if (excludePartitionKey && entry.store_partition_key === excludePartitionKey) continue
    if (receiptStoreNameMatchesRegistry(
      entry.display_name,
      entry.store_partition_key,
      parsed,
    )) {
      return entry
    }
  }
  return null
}
