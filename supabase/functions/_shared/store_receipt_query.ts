import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0'
import type { StoreRegistryRow } from './store_receipt.ts'
import { resolveStorePartitionKey } from './admin_utils.ts'

export type NormalizedReceiptRow = {
  store_partition_key: string
  store_name: string
  receipt_date: string | null
  created_at: string
  gross_sales_yen: number | null
  net_sales_yen: number | null
  tax_amount_yen: number | null
  party_count: number | null
  guest_count: number | null
}

const RECEIPT_SELECT =
  'store_name, receipt_date, created_at, gross_sales_yen, net_sales_yen, tax_amount_yen, party_count, guest_count'

export async function loadStoreRegistry(supabase: SupabaseClient): Promise<StoreRegistryRow[]> {
  const { data, error } = await supabase
    .from('store_webhook_tables')
    .select('store_partition_key, display_name, webhook_raw_table, receipt_table')
    .order('display_name', { ascending: true })

  if (error) {
    console.error('loadStoreRegistry failed:', error.message)
    return []
  }
  return (Array.isArray(data) ? data : []) as StoreRegistryRow[]
}

function normalizeReceiptRow(
  row: Record<string, unknown>,
  entry: StoreRegistryRow,
): NormalizedReceiptRow {
  const receiptDateRaw = row.receipt_date
  const receiptDate = receiptDateRaw != null ? String(receiptDateRaw).slice(0, 10) : null
  return {
    store_partition_key: entry.store_partition_key,
    store_name: String(row.store_name ?? '').trim() || entry.display_name,
    receipt_date: receiptDate,
    created_at: String(row.created_at ?? ''),
    gross_sales_yen: row.gross_sales_yen as number | null,
    net_sales_yen: row.net_sales_yen as number | null,
    tax_amount_yen: row.tax_amount_yen as number | null,
    party_count: row.party_count as number | null,
    guest_count: row.guest_count as number | null,
  }
}

async function queryOneStoreTable(
  supabase: SupabaseClient,
  entry: StoreRegistryRow,
  filters: {
    createdFrom?: string
    createdTo?: string
    receiptFrom?: string
    receiptTo?: string
    limit?: number
    orderByCreatedAt?: boolean
  },
): Promise<NormalizedReceiptRow[]> {
  let query = supabase.from(entry.receipt_table).select(RECEIPT_SELECT)
  if (filters.createdFrom) query = query.gte('created_at', filters.createdFrom)
  if (filters.createdTo) query = query.lt('created_at', filters.createdTo)
  if (filters.receiptFrom) query = query.gte('receipt_date', filters.receiptFrom)
  if (filters.receiptTo) query = query.lt('receipt_date', filters.receiptTo)
  query = query.order(filters.orderByCreatedAt ? 'created_at' : 'receipt_date', { ascending: true })
  query = query.limit(filters.limit ?? 20000)

  const { data, error } = await query
  if (error) {
    console.error(`query ${entry.receipt_table} failed:`, error.message)
    return []
  }

  return (Array.isArray(data) ? data : []).map((row) =>
    normalizeReceiptRow(row as Record<string, unknown>, entry)
  )
}

export async function queryStoreReceiptRows(
  supabase: SupabaseClient,
  opts: {
    storeKey?: string
    createdFrom?: string
    createdTo?: string
    receiptFrom?: string
    receiptTo?: string
    limit?: number
    orderByCreatedAt?: boolean
  },
): Promise<NormalizedReceiptRow[]> {
  const registry = await loadStoreRegistry(supabase)
  if (registry.length === 0) return []

  const registryKeys = registry.map((entry) => entry.store_partition_key)
  const resolvedKey = opts.storeKey
    ? resolveStorePartitionKey(opts.storeKey, registryKeys)
    : ''

  const targets = resolvedKey
    ? registry.filter((entry) => entry.store_partition_key === resolvedKey)
    : registry

  if (resolvedKey && targets.length === 0) return []

  const chunks = await Promise.all(
    targets.map((entry) => queryOneStoreTable(supabase, entry, opts)),
  )
  return chunks.flat()
}
