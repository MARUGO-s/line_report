/** シート入力の数字文字列を半角・連続に正規化（全角数字・空白・カンマ混在対応） */ export function normalizeSheetIntegerInput(value) {
  let s = String(value ?? "");
  s = s.replace(/[\uFF10-\uFF19]/g, (ch)=>String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30));
  s = s.replace(/[\uFF0C\uFF0E，．]/g, "");
  s = s.replace(/[\s\u3000\u00a0,，、]/g, "");
  return s.trim();
}
/** シートの数値（"1 20"・"１２０"・"12０" 等）を整数に正規化 */ function parseOptionalNonNegativeInt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) return null;
    return Math.round(value);
  }
  const s = normalizeSheetIntegerInput(value);
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}
/** 営業日数（1以上）。0・空欄は null */ export function parseManualMonthOperatingDays(value) {
  const n = parseOptionalNonNegativeInt(value);
  if (n == null || n <= 0) return null;
  return n;
}
export function parseManualMonthPartyGuestFromUnknown(partyRaw, guestRaw) {
  return {
    party_count: parseOptionalNonNegativeInt(partyRaw),
    guest_count: parseOptionalNonNegativeInt(guestRaw)
  };
}
/** 過去売上シート行（7列=営業日数あり / 6列=組数客数あり / 4列=旧形式） */ export function parsePastSalesSheetRow(row) {
  const len = row.length;
  if (len >= 8) {
    const counts = parseManualMonthPartyGuestFromUnknown(row[3], row[4]);
    return {
      enabledCol: 6,
      party_count: counts.party_count,
      guest_count: counts.guest_count,
      operating_days_count: parseManualMonthOperatingDays(row[5]),
      updatedAtCol: 7
    };
  }
  if (len >= 7) {
    const counts = parseManualMonthPartyGuestFromUnknown(row[3], row[4]);
    return {
      enabledCol: 6,
      party_count: counts.party_count,
      guest_count: counts.guest_count,
      operating_days_count: parseManualMonthOperatingDays(row[5]),
      updatedAtCol: null
    };
  }
  if (len >= 6) {
    const counts = parseManualMonthPartyGuestFromUnknown(row[3], row[4]);
    return {
      enabledCol: 5,
      party_count: counts.party_count,
      guest_count: counts.guest_count,
      operating_days_count: null,
      updatedAtCol: null
    };
  }
  return {
    enabledCol: 3,
    party_count: null,
    guest_count: null,
    operating_days_count: null,
    updatedAtCol: null
  };
}
export function manualMonthSalesFromRow(row) {
  if (!row) return null;
  const gross = Number(row.gross_sales_yen);
  if (!Number.isFinite(gross) || gross < 0) return null;
  return {
    gross_sales_yen: Math.round(gross),
    party_count: parseOptionalNonNegativeInt(row.party_count),
    guest_count: parseOptionalNonNegativeInt(row.guest_count),
    operating_days_count: parseManualMonthOperatingDays(row.operating_days_count),
    updated_at: row.updated_at != null ? String(row.updated_at) : null
  };
}
export async function fetchManualMonthSales(supabase, storePartitionKey, salesMonthYyyyMm) {
  const key = String(storePartitionKey ?? "").trim().toLowerCase();
  const month = String(salesMonthYyyyMm ?? "").trim().slice(0, 7);
  if (!key || !/^\d{4}-\d{2}$/.test(month)) return null;
  const { data, error } = await supabase.from("line_sales_manual_month_gross").select("gross_sales_yen, party_count, guest_count, operating_days_count, updated_at").eq("store_partition_key", key).eq("sales_month", month).maybeSingle();
  if (error) {
    console.error(`fetchManualMonthSales failed (store=${key}, month=${month}):`, error.message);
    return null;
  }
  return manualMonthSalesFromRow(data);
}
export async function fetchManualMonthSalesMapForStore(supabase, storePartitionKey, salesMonths) {
  const key = String(storePartitionKey ?? "").trim().toLowerCase();
  const months = [
    ...new Set(salesMonths.map((m)=>String(m ?? "").trim().slice(0, 7)).filter((m)=>/^\d{4}-\d{2}$/.test(m)))
  ];
  const out = new Map();
  if (!key || months.length === 0) return out;
  const { data, error } = await supabase.from("line_sales_manual_month_gross").select("sales_month, gross_sales_yen, party_count, guest_count, operating_days_count, updated_at").eq("store_partition_key", key).in("sales_month", months);
  if (error) {
    console.error(`fetchManualMonthSalesMapForStore failed (store=${key}):`, error.message);
    return out;
  }
  for (const row of Array.isArray(data) ? data : []){
    const r = row;
    const sm = String(r.sales_month ?? "").trim().slice(0, 7);
    const parsed = manualMonthSalesFromRow(r);
    if (parsed) out.set(sm, parsed);
  }
  return out;
}
export async function upsertManualMonthSalesEntries(supabase, storePartitionKey, entries) {
  const key = String(storePartitionKey ?? "").trim().toLowerCase();
  const updatedAt = new Date().toISOString();
  for (const entry of entries){
    const salesMonth = String(entry.sales_month ?? "").trim().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(salesMonth)) continue;
    if (entry.gross_sales_yen === null) {
      const { error } = await supabase.from("line_sales_manual_month_gross").delete().eq("store_partition_key", key).eq("sales_month", salesMonth);
      if (error) throw new Error(error.message);
      continue;
    }
    const party = entry.party_count === undefined ? null : parseOptionalNonNegativeInt(entry.party_count);
    const guest = entry.guest_count === undefined ? null : parseOptionalNonNegativeInt(entry.guest_count);
    const operatingDays = entry.operating_days_count === undefined ? null : parseManualMonthOperatingDays(entry.operating_days_count);
    const { error } = await supabase.from("line_sales_manual_month_gross").upsert({
      store_partition_key: key,
      sales_month: salesMonth,
      gross_sales_yen: Math.round(entry.gross_sales_yen),
      party_count: party,
      guest_count: guest,
      operating_days_count: operatingDays,
      updated_at: updatedAt
    }, {
      onConflict: "store_partition_key,sales_month"
    });
    if (error) throw new Error(error.message);
  }
}
