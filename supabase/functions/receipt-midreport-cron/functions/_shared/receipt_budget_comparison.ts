import { allocateDailyBudgetsForMonth, enumerateMonthDates, getDefaultJapaneseHolidaySet, getJstBusinessDateForReceiptBudget, mergeStoreClosedDateLists, shouldDeferDailyBudgetUntilJstOpen } from "./sales_budget_allocation.ts";
import { buildReceiptDailyOverrideKey, fetchReceiptDailyOverrideMap } from "./receipt_daily_overrides.ts";
export const RECEIPT_BUDGET_STORE_UNKNOWN = "unknown_store";
function formatYenAmount(value) {
  return `¥${Math.round(value).toLocaleString("ja-JP")}`;
}
export function formatYenSignedDiff(value) {
  const x = Math.round(value);
  const absStr = `¥${Math.abs(x).toLocaleString("ja-JP")}`;
  if (x > 0) return `+${absStr}`;
  if (x < 0) return `-${absStr}`;
  return "¥0";
}
function receiptDateIsAfterProgressDate(dateKey, progressThroughDate) {
  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return false;
  if (!progressThroughDate || !/^\d{4}-\d{2}-\d{2}$/.test(progressThroughDate)) return false;
  return dateKey > progressThroughDate;
}
/** 正の重みを取り出す（未設定/0以下は既定値）。曜日別モデルは _shared/receipt_reply_context.ts と同一既定。 */
function parsePositiveBudgetWeight(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
async function fetchSalesBudgetRow(supabase, storePartitionKey, targetMonth) {
  if (!storePartitionKey || storePartitionKey === RECEIPT_BUDGET_STORE_UNKNOWN) return null;
  // 曜日別ウェイト（mon..sun）＋祝日/前日。旧 weekday_weight 列は廃止済み（存在しない列をSELECTすると
  // PostgREST がエラー→予算行 null→予算セクションが静かに消える）。売上分析/レシート返信と同じ列・既定に揃える。
  const { data, error } = await supabase.from("line_sales_month_budgets").select("budget_yen, mon_weight, tue_weight, wed_weight, thu_weight, fri_weight, sat_weight, sun_weight, holiday_weight, pre_holiday_weight, store_closed_dates").eq("store_partition_key", storePartitionKey).eq("target_month", targetMonth).maybeSingle();
  if (error || !data) return null;
  const row = data;
  const budgetYen = Number(row.budget_yen);
  if (!Number.isFinite(budgetYen) || budgetYen <= 0) return null;
  const hw = Number(row.holiday_weight);
  const phw = Number(row.pre_holiday_weight);
  let fromTable = [];
  const { data: closedRows, error: closedErr } = await supabase.from("line_sales_month_store_closed_days").select("closed_on").eq("store_partition_key", storePartitionKey).eq("target_month", targetMonth);
  if (!closedErr && Array.isArray(closedRows)) {
    const allowed = new Set(enumerateMonthDates(targetMonth));
    for (const cr of closedRows){
      const s = String(cr.closed_on ?? "").trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;
      if (!allowed.has(s)) continue;
      fromTable.push(s);
    }
    fromTable = [
      ...new Set(fromTable)
    ].sort();
  }
  const closedArr = mergeStoreClosedDateLists(fromTable, row.store_closed_dates, targetMonth);
  return {
    budget_yen: Math.round(budgetYen),
    mon_weight: parsePositiveBudgetWeight(row.mon_weight, 1),
    tue_weight: parsePositiveBudgetWeight(row.tue_weight, 1),
    wed_weight: parsePositiveBudgetWeight(row.wed_weight, 1),
    thu_weight: parsePositiveBudgetWeight(row.thu_weight, 1),
    fri_weight: parsePositiveBudgetWeight(row.fri_weight, 1),
    sat_weight: parsePositiveBudgetWeight(row.sat_weight, 1.5),
    sun_weight: parsePositiveBudgetWeight(row.sun_weight, 2),
    holiday_weight: Number.isFinite(hw) && hw > 0 ? hw : null,
    pre_holiday_weight: Number.isFinite(phw) && phw > 0 ? phw : null,
    store_closed_dates: closedArr
  };
}
async function loadStoreDayGrossSumForDate(supabase, storePartitionKey, receiptDateIso) {
  const overrideMap = await fetchReceiptDailyOverrideMap(supabase, [
    storePartitionKey
  ], receiptDateIso, receiptDateIso);
  const override = overrideMap.get(buildReceiptDailyOverrideKey(storePartitionKey, receiptDateIso));
  if (override) return override.gross_sales_yen;
  const { data, error } = await supabase.from("line_receipt_entries").select("gross_sales_yen").eq("store_partition_key", storePartitionKey).eq("receipt_date", receiptDateIso);
  if (error || !Array.isArray(data)) return 0;
  let sum = 0;
  for (const row of data){
    const g = Number(row.gross_sales_yen);
    if (Number.isFinite(g) && g >= 0) sum += Math.round(g);
  }
  return sum;
}
async function loadStoreGrossSumsByMonthDates(supabase, storePartitionKey, receiptMonthYyyyMm) {
  const dates = enumerateMonthDates(receiptMonthYyyyMm);
  const sums = new Map();
  for (const d of dates)sums.set(d, 0);
  if (dates.length === 0) return sums;
  const start = dates[0];
  const end = dates[dates.length - 1];
  const { data, error } = await supabase.from("line_receipt_entries").select("receipt_date, gross_sales_yen").eq("store_partition_key", storePartitionKey).gte("receipt_date", start).lte("receipt_date", end);
  if (error || !Array.isArray(data)) return sums;
  for (const row of data){
    const dk = String(row.receipt_date ?? "").slice(0, 10);
    if (!sums.has(dk)) continue;
    const g = Number(row.gross_sales_yen);
    if (Number.isFinite(g) && g >= 0) sums.set(dk, (sums.get(dk) ?? 0) + Math.round(g));
  }
  const overrideMap = await fetchReceiptDailyOverrideMap(supabase, [
    storePartitionKey
  ], start, end);
  for (const override of overrideMap.values()){
    if (sums.has(override.receipt_date)) {
      sums.set(override.receipt_date, override.gross_sales_yen);
    }
  }
  return sums;
}
function computeReceiptDailyDiffTotalLikeAnalyticsFooter(dailyMap, storeClosed, receiptMonthYyyyMm, grossByDate, progressThroughDate, now = new Date()) {
  let diffTotal = 0;
  let anyB = false;
  for (const dk of enumerateMonthDates(receiptMonthYyyyMm)){
    let b;
    if (storeClosed.has(dk)) {
      b = 0;
    } else {
      const lb = dailyMap.get(dk);
      if (lb == null || !Number.isFinite(lb) || lb < 0) continue;
      b = lb;
    }
    anyB = true;
    if (storeClosed.has(dk)) continue;
    if (dk > progressThroughDate) continue;
    const g = grossByDate.get(dk) ?? 0;
    if (shouldDeferDailyBudgetUntilJstOpen({
      receiptDateIso: dk,
      storeClosed,
      now
    })) {
      diffTotal += Math.round(g - 0);
      continue;
    }
    diffTotal += Math.round(g - b);
  }
  if (!anyB) return null;
  return diffTotal;
}
/**
 * レシート解析返信・売上中間／月末レポート共通の【予算】行（analytics の予算 KPI と同系統）
 */ export async function buildReceiptBudgetComparisonRows(supabase, opts) {
  const storePartitionKey = String(opts.storePartitionKey ?? "").trim().toLowerCase();
  const asOfDateIso = String(opts.asOfDateIso ?? "").trim().slice(0, 10);
  const receiptMonthYyyyMm = String(opts.receiptMonthYyyyMm ?? "").trim();
  if (!storePartitionKey || storePartitionKey === RECEIPT_BUDGET_STORE_UNKNOWN) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDateIso)) return null;
  if (!/^(\d{4})-(\d{2})$/.test(receiptMonthYyyyMm)) return null;
  const row = await fetchSalesBudgetRow(supabase, storePartitionKey, receiptMonthYyyyMm);
  if (!row) return null;
  const weights = {
    mon: row.mon_weight,
    tue: row.tue_weight,
    wed: row.wed_weight,
    thu: row.thu_weight,
    fri: row.fri_weight,
    sat: row.sat_weight,
    sun: row.sun_weight,
    holiday: row.holiday_weight,
    pre_holiday: row.pre_holiday_weight
  };
  const holidaySet = getDefaultJapaneseHolidaySet();
  const storeClosed = new Set(row.store_closed_dates ?? []);
  // 正本 allocateDailyBudgetsForMonth の引数順: (month, budget, weights, storeClosed, holidayOverride)
  const dailyMap = allocateDailyBudgetsForMonth(receiptMonthYyyyMm, row.budget_yen, weights, storeClosed, holidaySet);
  const omitDaily = !!opts.omitDailyBudgetLines;
  const dailyTarget = dailyMap.get(asOfDateIso);
  if (!omitDaily && dailyTarget == null) return null;
  const monthActual = Math.max(0, Math.round(Number(opts.monthActualYen) || 0));
  const monthPctNum = row.budget_yen > 0 ? monthActual / row.budget_yen * 100 : null;
  const monthPct = monthPctNum != null ? monthPctNum.toFixed(1) : "-";
  const now = opts.now ?? new Date();
  const grossByMonth = await loadStoreGrossSumsByMonthDates(supabase, storePartitionKey, receiptMonthYyyyMm);
  const todayJst = getJstBusinessDateForReceiptBudget(now);
  const throughRaw = String(opts.budgetCumulativeThroughDate ?? "").trim().slice(0, 10);
  const progressThroughDate = /^\d{4}-\d{2}-\d{2}$/.test(throughRaw) && throughRaw < todayJst ? throughRaw : todayJst;
  let dailyBudgetDiffStr = "";
  let dailyDiffYen = null;
  let displayDailyTarget = dailyTarget ?? 0;
  if (!omitDaily && dailyTarget != null) {
    const dayActual = await loadStoreDayGrossSumForDate(supabase, storePartitionKey, asOfDateIso);
    const isStoreClosed = storeClosed.has(asOfDateIso);
    const deferBudget = !isStoreClosed && shouldDeferDailyBudgetUntilJstOpen({
      receiptDateIso: asOfDateIso,
      storeClosed,
      now
    });
    if (isStoreClosed) {
      dailyBudgetDiffStr = dayActual === 0 ? "-" : formatYenSignedDiff(dayActual);
    } else if (deferBudget) {
      dailyBudgetDiffStr = formatYenSignedDiff(0);
    } else if (receiptDateIsAfterProgressDate(asOfDateIso, progressThroughDate)) {
      dailyBudgetDiffStr = formatYenSignedDiff(0);
    } else {
      dailyBudgetDiffStr = formatYenSignedDiff(dayActual - dailyTarget);
    }
    displayDailyTarget = dailyTarget;
    const canStyleDayDiff = !isStoreClosed && !deferBudget && !receiptDateIsAfterProgressDate(asOfDateIso, progressThroughDate);
    dailyDiffYen = canStyleDayDiff ? dayActual - dailyTarget : null;
  }
  const cumDiffYen = computeReceiptDailyDiffTotalLikeAnalyticsFooter(dailyMap, storeClosed, receiptMonthYyyyMm, grossByMonth, progressThroughDate, now);
  const cumStr = cumDiffYen == null ? null : formatYenSignedDiff(cumDiffYen);
  const out = [
    {
      label: "月次目標",
      value: formatYenAmount(row.budget_yen),
      margin: "md"
    },
    {
      label: "月次実績",
      value: formatYenAmount(monthActual),
      ...monthPct !== "-" ? {
        valueSuffix: {
          text: `（${monthPct}%）`,
          color: monthPctNum != null && monthPctNum < 100 ? "#C62828" : "#1F1F1F"
        }
      } : {}
    }
  ];
  if (!omitDaily) {
    out.push({
      label: "当日目標",
      value: formatYenAmount(displayDailyTarget)
    }, {
      label: "日次予算差",
      value: dailyBudgetDiffStr,
      ...dailyDiffYen != null && dailyDiffYen < 0 ? {
        valueColor: "#C62828"
      } : {}
    });
  }
  if (cumStr != null && cumDiffYen != null) {
    out.push({
      label: "日次予算累計",
      value: cumStr,
      ...cumDiffYen < 0 ? {
        valueColor: "#C62828"
      } : {}
    });
  }
  return out;
}
