export function buildReceiptDailyOverrideKey(storePartitionKey, receiptDate) {
  return `${String(storePartitionKey ?? "").trim().toLowerCase()}::${String(receiptDate ?? "").trim().slice(0, 10)}`;
}
function toSafeOverrideStoreKey(value) {
  return String(value ?? "").trim().toLowerCase();
}
function toSafeReceiptDate(value) {
  return String(value ?? "").trim().slice(0, 10);
}
function toNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}
export async function fetchReceiptDailyOverrideMap(supabase, storePartitionKeys, startDateIso, endDateIso) {
  const keys = [
    ...new Set(storePartitionKeys.map((v)=>toSafeOverrideStoreKey(v)).filter((v)=>/^[a-z0-9_]{2,120}$/.test(v)))
  ];
  const out = new Map();
  if (keys.length === 0) return out;
  const start = toSafeReceiptDate(startDateIso);
  const end = toSafeReceiptDate(endDateIso);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return out;
  let query = supabase.from("line_sales_daily_overrides").select("store_partition_key, receipt_date, gross_sales_yen, party_count, guest_count, updated_at").gte("receipt_date", start).lte("receipt_date", end);
  if (keys.length === 1) {
    query = query.eq("store_partition_key", keys[0]);
  } else {
    query = query.in("store_partition_key", keys);
  }
  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to fetch line_sales_daily_overrides: ${error.message}`);
  }
  for (const row of Array.isArray(data) ? data : []){
    const r = row;
    const storeKey = toSafeOverrideStoreKey(r.store_partition_key);
    const receiptDate = toSafeReceiptDate(r.receipt_date);
    if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) continue;
    out.set(buildReceiptDailyOverrideKey(storeKey, receiptDate), {
      store_partition_key: storeKey,
      receipt_date: receiptDate,
      gross_sales_yen: toNonNegativeInt(r.gross_sales_yen),
      party_count: toNonNegativeInt(r.party_count),
      guest_count: toNonNegativeInt(r.guest_count),
      updated_at: r.updated_at != null ? String(r.updated_at) : null
    });
  }
  return out;
}
export async function upsertReceiptDailyOverrides(supabase, entries) {
  if (!entries.length) return;
  const updatedAt = new Date().toISOString();
  const payload = entries.map((entry)=>({
      store_partition_key: toSafeOverrideStoreKey(entry.store_partition_key),
      receipt_date: toSafeReceiptDate(entry.receipt_date),
      gross_sales_yen: toNonNegativeInt(entry.gross_sales_yen),
      party_count: toNonNegativeInt(entry.party_count),
      guest_count: toNonNegativeInt(entry.guest_count),
      updated_at: entry.updated_at ?? updatedAt
    })).filter((row)=>/^[a-z0-9_]{2,120}$/.test(row.store_partition_key) && /^\d{4}-\d{2}-\d{2}$/.test(row.receipt_date));
  if (!payload.length) return;
  const { error } = await supabase.from("line_sales_daily_overrides").upsert(payload, {
    onConflict: "store_partition_key,receipt_date"
  });
  if (error) {
    throw new Error(`Failed to upsert line_sales_daily_overrides: ${error.message}`);
  }
}
export async function deleteReceiptDailyOverrides(supabase, keys) {
  for (const key of keys){
    const storePartitionKey = toSafeOverrideStoreKey(key.store_partition_key);
    const receiptDate = toSafeReceiptDate(key.receipt_date);
    if (!/^[a-z0-9_]{2,120}$/.test(storePartitionKey) || !/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) continue;
    const { error } = await supabase.from("line_sales_daily_overrides").delete().eq("store_partition_key", storePartitionKey).eq("receipt_date", receiptDate);
    if (error) {
      throw new Error(`Failed to delete line_sales_daily_overrides: ${error.message}`);
    }
  }
}
