import { findBestStoreNameInText, normalizeStoreToken } from "./receipt_store_name_resolve.ts";
import { fetchReceiptDailyOverrideMap } from "./receipt_daily_overrides.ts";
export const RECEIPT_STORE_PARTITION_UNKNOWN = "unknown_store";
export function toReceiptStorePartitionKey(storeName) {
  const normalized = normalizeStoreToken(String(storeName ?? ""));
  if (!normalized) return RECEIPT_STORE_PARTITION_UNKNOWN;
  return normalized.slice(0, 120);
}
/** YYYY-MM-DD を年単位でずらす（2/29 → 2/28 など暦日に合わせる） */ export function shiftIsoDateByYears(isoDate, deltaYears) {
  const matched = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const targetYear = year + deltaYears;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return `${String(targetYear).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}
/** 期間が暦月 1 日〜末日（YYYY-MM）か */ export function isFullCalendarMonthPeriod(periodStartDate, periodEndDate) {
  const matched = periodStartDate.match(/^(\d{4})-(\d{2})-01$/);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const expectedEnd = `${matched[1]}-${matched[2]}-${String(lastDay).padStart(2, "0")}`;
  return periodEndDate === expectedEnd;
}
/** PostgREST の date 列（文字列 / ISO どちらも）を YYYY-MM-DD に正規化 */ export function receiptDateIsoFromValue(value) {
  if (value == null) return null;
  const raw = typeof value === "string" ? value.trim() : String(value).trim();
  const matched = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return matched ? matched[1] : null;
}
export function buildReceiptReportAggregateFromRows(rows) {
  if (rows.length === 0) return null;
  let totalGrossSalesYen = 0;
  let totalPartyCount = 0;
  let totalGuestCount = 0;
  let grossCount = 0;
  let partyCountRows = 0;
  let guestCountRows = 0;
  const operatingDates = new Set();
  for (const row of rows){
    const receiptDate = receiptDateIsoFromValue(row.receipt_date) ?? "";
    if (receiptDate) {
      operatingDates.add(receiptDate);
    }
    const gross = Number(row.gross_sales_yen);
    if (Number.isFinite(gross) && gross >= 0) {
      totalGrossSalesYen += Math.round(gross);
      grossCount += 1;
    }
    const party = Number(row.party_count);
    if (Number.isFinite(party) && party >= 0) {
      totalPartyCount += Math.round(party);
      partyCountRows += 1;
    }
    const guest = Number(row.guest_count);
    if (Number.isFinite(guest) && guest >= 0) {
      totalGuestCount += Math.round(guest);
      guestCountRows += 1;
    }
  }
  const operatingDayCount = operatingDates.size;
  return {
    receiptCount: rows.length,
    totalGrossSalesYen,
    totalPartyCount,
    totalGuestCount,
    avgGrossSalesYen: grossCount > 0 ? totalGrossSalesYen / grossCount : null,
    avgPartyCount: partyCountRows > 0 ? totalPartyCount / partyCountRows : null,
    avgGuestCount: guestCountRows > 0 ? totalGuestCount / guestCountRows : null,
    operatingDayCount,
    avgDailyGrossSalesYen: operatingDayCount > 0 ? Math.round(totalGrossSalesYen / operatingDayCount) : null
  };
}
async function buildReceiptReportAggregateWithDailyOverrides(supabase, storePartitionKey, periodStartDate, periodEndDate, rows) {
  const overrideMap = await fetchReceiptDailyOverrideMap(supabase, [
    storePartitionKey
  ], periodStartDate, periodEndDate);
  if (overrideMap.size === 0) {
    return buildReceiptReportAggregateFromRows(rows);
  }
  const byDate = new Map();
  for (const row of rows){
    const receiptDate = receiptDateIsoFromValue(row.receipt_date);
    if (!receiptDate || receiptDate < periodStartDate || receiptDate > periodEndDate) continue;
    const current = byDate.get(receiptDate) ?? {
      gross_sales_yen: 0,
      party_count: 0,
      guest_count: 0,
      receipt_count: 0
    };
    const gross = Number(row.gross_sales_yen);
    const party = Number(row.party_count);
    const guest = Number(row.guest_count);
    if (Number.isFinite(gross) && gross >= 0) current.gross_sales_yen += Math.round(gross);
    if (Number.isFinite(party) && party >= 0) current.party_count += Math.round(party);
    if (Number.isFinite(guest) && guest >= 0) current.guest_count += Math.round(guest);
    current.receipt_count += 1;
    byDate.set(receiptDate, current);
  }
  for (const override of overrideMap.values()){
    const current = byDate.get(override.receipt_date) ?? {
      gross_sales_yen: 0,
      party_count: 0,
      guest_count: 0,
      receipt_count: 0
    };
    byDate.set(override.receipt_date, {
      ...current,
      gross_sales_yen: override.gross_sales_yen,
      party_count: override.party_count,
      guest_count: override.guest_count
    });
  }
  if (byDate.size === 0) return null;
  let receiptCount = 0;
  let totalGrossSalesYen = 0;
  let totalPartyCount = 0;
  let totalGuestCount = 0;
  let grossCount = 0;
  let partyCountRows = 0;
  let guestCountRows = 0;
  for (const daily of byDate.values()){
    receiptCount += daily.receipt_count;
    totalGrossSalesYen += daily.gross_sales_yen;
    totalPartyCount += daily.party_count;
    totalGuestCount += daily.guest_count;
    grossCount += daily.receipt_count;
    partyCountRows += daily.receipt_count;
    guestCountRows += daily.receipt_count;
  }
  const operatingDayCount = byDate.size;
  return {
    receiptCount,
    totalGrossSalesYen,
    totalPartyCount,
    totalGuestCount,
    avgGrossSalesYen: grossCount > 0 ? totalGrossSalesYen / grossCount : null,
    avgPartyCount: partyCountRows > 0 ? totalPartyCount / partyCountRows : null,
    avgGuestCount: guestCountRows > 0 ? totalGuestCount / guestCountRows : null,
    operatingDayCount,
    avgDailyGrossSalesYen: operatingDayCount > 0 ? Math.round(totalGrossSalesYen / operatingDayCount) : null
  };
}
function normalizeConfiguredStorePartitionKey(value) {
  const key = String(value ?? "").trim().toLowerCase();
  if (!key || key === RECEIPT_STORE_PARTITION_UNKNOWN) return null;
  if (!/^[a-z0-9]{2,120}$/.test(key)) return null;
  return key;
}
/** ルーム設定の店舗指定を最優先。未設定時はルーム名・当ルームのレシート履歴から推定。 */ export async function resolveStorePartitionKeyForRoom(supabase, roomId) {
  const rid = String(roomId ?? "").trim();
  if (!rid) return null;
  const { data: settingsRow, error: settingsError } = await supabase.from("room_summary_settings").select("receipt_report_store_partition_key").eq("room_id", rid).maybeSingle();
  if (settingsError) {
    console.error(`resolveStorePartitionKeyForRoom settings lookup failed (room=${rid}):`, settingsError.message);
  } else {
    const configured = normalizeConfiguredStorePartitionKey(settingsRow?.receipt_report_store_partition_key);
    if (configured) return configured;
  }
  const { data: roomRow } = await supabase.from("line_room_names").select("room_name").eq("room_id", rid).maybeSingle();
  const roomName = String(roomRow?.room_name ?? "").trim();
  if (roomName) {
    const storeLabel = findBestStoreNameInText(roomName);
    if (storeLabel) {
      const key = toReceiptStorePartitionKey(storeLabel);
      if (key !== RECEIPT_STORE_PARTITION_UNKNOWN) return key;
    }
    const token = normalizeStoreToken(roomName);
    if (token.length >= 4 && token !== RECEIPT_STORE_PARTITION_UNKNOWN) {
      const fromToken = findBestStoreNameInText(token);
      if (fromToken) {
        const mapped = toReceiptStorePartitionKey(fromToken);
        if (mapped !== RECEIPT_STORE_PARTITION_UNKNOWN) return mapped;
      }
      return token.slice(0, 120);
    }
  }
  const lookbackIso = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  const { data: receiptRows, error } = await supabase.from("line_receipt_entries").select("store_partition_key").eq("room_id", rid).neq("store_partition_key", RECEIPT_STORE_PARTITION_UNKNOWN).gte("created_at", lookbackIso).limit(5000);
  if (error) {
    console.error(`resolveStorePartitionKeyForRoom failed (room=${rid}):`, error.message);
    return null;
  }
  const counts = new Map();
  for (const row of Array.isArray(receiptRows) ? receiptRows : []){
    const key = String(row.store_partition_key ?? "").trim();
    if (!key || key === RECEIPT_STORE_PARTITION_UNKNOWN) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let bestKey = null;
  let bestCount = 0;
  for (const [key, count] of counts.entries()){
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  return bestKey;
}
function buildJstMonthCreatedAtRange(month) {
  const matched = month.match(/^(\d{4})-(\d{2})$/);
  if (!matched) return null;
  const year = Number(matched[1]);
  const monthNumber = Number(matched[2]);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    return null;
  }
  const startUtc = Date.UTC(year, monthNumber - 1, 1, -9, 0, 0);
  const endUtc = Date.UTC(year, monthNumber, 1, -9, 0, 0);
  return {
    startIso: new Date(startUtc).toISOString(),
    endIso: new Date(endUtc).toISOString()
  };
}
function rowReceiptDateInPeriod(row, periodStartDate, periodEndDate) {
  const receiptDate = receiptDateIsoFromValue(row.receipt_date);
  if (!receiptDate) return false;
  return receiptDate >= periodStartDate && receiptDate <= periodEndDate;
}
/** 売上分析 `/receipts/sales` と同系統の取り込み窓（created_at）＋レシート日付で期間内を数える */ async function loadReceiptRowsAnalyticsAligned(supabase, storePartitionKey, periodStartDate, periodEndDate) {
  const key = String(storePartitionKey ?? "").trim().toLowerCase();
  const month = periodStartDate.slice(0, 7);
  const createdRange = buildJstMonthCreatedAtRange(month);
  if (!createdRange) return [];
  const { data, error } = await supabase.from("line_receipt_entries").select("gross_sales_yen, party_count, guest_count, receipt_date, created_at").eq("store_partition_key", key).gte("created_at", createdRange.startIso).lt("created_at", createdRange.endIso).limit(20000);
  if (error) {
    console.error(`loadReceiptRowsAnalyticsAligned failed (store=${key}, month=${month}):`, error.message);
    return [];
  }
  const rows = Array.isArray(data) ? data : [];
  return rows.filter((row)=>rowReceiptDateInPeriod(row, periodStartDate, periodEndDate));
}
/** 店舗 × レシート日付（inclusive）で集計。売上分析と揃えるため analytics 互換取得を優先する。 */ export async function loadReceiptReportAggregateForStoreByReceiptDate(supabase, storePartitionKey, periodStartDate, periodEndDate) {
  const key = String(storePartitionKey ?? "").trim().toLowerCase();
  if (!key || key === RECEIPT_STORE_PARTITION_UNKNOWN) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStartDate) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEndDate)) {
    return null;
  }
  let rows = await loadReceiptRowsAnalyticsAligned(supabase, key, periodStartDate, periodEndDate);
  if (rows.length === 0) {
    const { data, error } = await supabase.from("line_receipt_entries").select("gross_sales_yen, party_count, guest_count, receipt_date").eq("store_partition_key", key).gte("receipt_date", periodStartDate).lte("receipt_date", periodEndDate).limit(20000);
    if (error) {
      console.error(`loadReceiptReportAggregateForStoreByReceiptDate failed (store=${key}, ${periodStartDate}..${periodEndDate}):`, error.message);
      return null;
    }
    rows = Array.isArray(data) ? data : [];
  }
  return await buildReceiptReportAggregateWithDailyOverrides(supabase, key, periodStartDate, periodEndDate, rows);
}
export async function loadReceiptReportAggregateForRoom(supabase, roomId, periodStartDate, periodEndDate, storePartitionKeyOverride) {
  const configuredOverride = normalizeConfiguredStorePartitionKey(storePartitionKeyOverride);
  const storeKey = configuredOverride ?? await resolveStorePartitionKeyForRoom(supabase, roomId);
  if (!storeKey) {
    return {
      aggregate: null,
      storePartitionKey: null
    };
  }
  const aggregate = await loadReceiptReportAggregateForStoreByReceiptDate(supabase, storeKey, periodStartDate, periodEndDate);
  return {
    aggregate,
    storePartitionKey: storeKey
  };
}
