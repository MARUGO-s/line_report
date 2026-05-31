import { getJapaneseHolidayDateSet } from "./japanese_holidays.ts";
/** 暦日を 1 日進める（YYYY-MM-DD、UTC 暦） */ export function addCalendarDaysIso(isoDate, deltaDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate).trim());
  if (!m) return isoDate;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const next = new Date(t + deltaDays * 86400000);
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
/**
 * 日次予算・差額の「進行日」（JST）。
 * 暦日の 0〜(startHour-1) 時はまだ前日扱い（店舗の営業日切り替えを 5 時に合わせる想定）。
 * analytics / line-webhook の「今日より後は差 0」「累計差の締め日」と揃える。
 */ export const RECEIPT_BUDGET_BUSINESS_DAY_START_HOUR_JST = 5;
export function getJstBusinessDateForReceiptBudget(now = new Date(), startHourJst = RECEIPT_BUDGET_BUSINESS_DAY_START_HOUR_JST) {
  // sv-SE + hourCycle: ブラウザ／ランタイム差で hour が欠ける・12h 扱いになるのを避ける
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(now);
  const y = Number(parts.find((p)=>p.type === "year")?.value);
  const mo = Number(parts.find((p)=>p.type === "month")?.value);
  const d = Number(parts.find((p)=>p.type === "day")?.value);
  const h = Number(parts.find((p)=>p.type === "hour")?.value ?? 0);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    return new Date().toLocaleDateString("sv-SE", {
      timeZone: "Asia/Tokyo"
    });
  }
  let iso = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (Number.isFinite(h) && h < startHourJst) {
    iso = addCalendarDaysIso(iso, -1);
  }
  return iso;
}
/** 東京の暦日 YYYY-MM-DD（営業日の 5 時シフトはしない） */ export function getJstCalendarDateIsoTokyo(now = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(now);
  const y = Number(parts.find((p)=>p.type === "year")?.value);
  const mo = Number(parts.find((p)=>p.type === "month")?.value);
  const d = Number(parts.find((p)=>p.type === "day")?.value);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    return new Date().toLocaleDateString("sv-SE", {
      timeZone: "Asia/Tokyo"
    }).slice(0, 10);
  }
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
export function getJstHourInTokyo(now = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(now);
  const h = Number(parts.find((p)=>p.type === "hour")?.value ?? 0);
  return Number.isFinite(h) ? h : 0;
}
/**
 * 暦の当日で JST 5 時前かつ店休でないとき、当日按分による「日次予算差」だけをまだ立てない（差は g−0）。
 * 按分目標額そのものは営業日として表示する（analytics の予算列・LINE の当日目標は按分を出す）。
 */ export function shouldDeferDailyBudgetUntilJstOpen(params) {
  const now = params.now ?? new Date();
  const start = params.startHourJst ?? RECEIPT_BUDGET_BUSINESS_DAY_START_HOUR_JST;
  const iso = String(params.receiptDateIso ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  if (params.storeClosed.has(iso)) return false;
  if (getJstCalendarDateIsoTokyo(now) !== iso) return false;
  const h = getJstHourInTokyo(now);
  if (!Number.isFinite(h) || h >= start) return false;
  return true;
}
export function isHolidayLikeDay(isoDate, holidayDates) {
  const dt = new Date(`${isoDate}T12:00:00+09:00`);
  if (Number.isNaN(dt.getTime())) return false;
  if (dt.getDay() === 0) return true;
  return holidayDates.has(isoDate);
}
export function classifySalesBudgetDay(isoDate, holidayDates) {
  if (isHolidayLikeDay(isoDate, holidayDates)) return "holiday";
  const next = addCalendarDaysIso(isoDate, 1);
  if (isHolidayLikeDay(next, holidayDates)) return "pre_holiday";
  return "weekday";
}
function weightForDayKind(kind, w) {
  if (kind === "holiday") return w.holiday;
  if (kind === "pre_holiday") return w.pre_holiday;
  return w.weekday;
}
/** 暦月の日数 − 店休日数（1日1休業日としてカウント） */ export function countOperatingDaysInCalendarMonth(targetMonth, storeClosedDates) {
  const monthDays = enumerateMonthDates(targetMonth);
  if (monthDays.length === 0) return 0;
  const closed = new Set(parseStoreClosedDatesForMonth(storeClosedDates, targetMonth));
  return Math.max(0, monthDays.length - closed.size);
}
export function enumerateMonthDates(targetMonth) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(targetMonth).trim());
  if (!m) return [];
  const year = Number(m[1]);
  const month = Number(m[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const out = [];
  for(let day = 1; day <= lastDay; day++){
    out.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  return out;
}
/**
 * DB / JSON の店舗休日を文字列配列へ（Postgres `text[]` が `"{a,b}"` 文字列で返る場合がある）
 */ export function coerceStoreClosedDatesItems(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((x)=>String(x ?? "").trim()).filter(Boolean);
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const o = raw;
    const keys = Object.keys(o);
    if (keys.length > 0 && keys.every((k)=>/^\d+$/.test(k))) {
      return keys.sort((a, b)=>Number(a) - Number(b)).map((k)=>String(o[k] ?? "").trim()).filter(Boolean);
    }
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "" || t === "{}") return [];
    if (t.startsWith("{") && t.endsWith("}")) {
      const inner = t.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(",").map((s)=>s.replace(/^"|"$/g, "").trim()).filter(Boolean);
    }
    return [
      t
    ];
  }
  return [];
}
/** 対象月の暦日に限定した昇順ユニーク YYYY-MM-DD（PUT body と DB 読取りの両方で利用） */ export function parseStoreClosedDatesForMonth(raw, targetMonth) {
  const allowed = new Set(enumerateMonthDates(targetMonth));
  if (allowed.size === 0) return [];
  const out = [];
  for (const s of coerceStoreClosedDatesItems(raw)){
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;
    if (!allowed.has(s)) continue;
    out.push(s);
  }
  return [
    ...new Set(out)
  ].sort();
}
/** 専用テーブルの日付と予算行の jsonb をマージ（どちらか片方だけにデータがある環境向け） */ export function mergeStoreClosedDateLists(tableDates, jsonbRaw, month) {
  const allowed = new Set(enumerateMonthDates(month));
  const merged = new Set();
  for (const d of tableDates){
    if (allowed.has(d)) merged.add(d);
  }
  for (const d of parseStoreClosedDatesForMonth(jsonbRaw, month)){
    merged.add(d);
  }
  return [
    ...merged
  ].sort();
}
/**
 * 月間予算を「平日 / 休日前日 / 休日(日曜+祝)」の重みで日別に按分（端数は最大剰余法）
 * `storeClosedDates` に含まれる日は按分から除外（重み0）し、月間総額は残りの日へ再配分する。
 */ export function allocateDailyBudgetsForMonth(targetMonth, monthBudgetYen, weights, holidayDates, storeClosedDates) {
  const days = enumerateMonthDates(targetMonth);
  if (days.length === 0 || monthBudgetYen <= 0) return new Map();
  const kinds = days.map((d)=>classifySalesBudgetDay(d, holidayDates));
  const rawWeights = kinds.map((k)=>weightForDayKind(k, weights));
  const effectiveWeights = days.map((d, i)=>storeClosedDates?.has(d) ? 0 : rawWeights[i]);
  const sumW = effectiveWeights.reduce((a, b)=>a + b, 0);
  if (sumW <= 0) {
    const zeroMap = new Map();
    for (const d of days)zeroMap.set(d, 0);
    return zeroMap;
  }
  const fractions = effectiveWeights.map((rw)=>monthBudgetYen * rw / sumW);
  const floors = fractions.map((x)=>Math.floor(x));
  let allocated = floors.reduce((a, b)=>a + b, 0);
  const remainder = monthBudgetYen - allocated;
  /** 端数1円は「按分対象の日」（店舗休日・重み0は除外）にのみ付与する */ const remainders = fractions.map((x, i)=>({
      i,
      r: x - floors[i]
    })).filter((x)=>effectiveWeights[x.i] > 0);
  remainders.sort((a, b)=>b.r - a.r);
  const result = new Map();
  for(let i = 0; i < days.length; i++){
    result.set(days[i], floors[i]);
  }
  for(let k = 0; k < remainder && k < remainders.length; k++){
    const idx = remainders[k].i;
    const dateStr = days[idx];
    result.set(dateStr, (result.get(dateStr) ?? 0) + 1);
  }
  return result;
}
export function getDailyBudgetForDateFromAllocation(targetMonth, isoDate, monthBudgetYen, weights, holidayDates, storeClosedDates) {
  const map = allocateDailyBudgetsForMonth(targetMonth, monthBudgetYen, weights, holidayDates, storeClosedDates);
  const v = map.get(isoDate);
  return v == null ? null : v;
}
/** admin-api / line-webhook から共通で利用 */ export function getDefaultJapaneseHolidaySet() {
  return getJapaneseHolidayDateSet();
}
