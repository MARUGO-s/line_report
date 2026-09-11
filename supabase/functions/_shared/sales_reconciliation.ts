import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.0";
import {
  fetchManualDaySalesMapForStore,
  type ManualDaySalesRecord,
} from "./manual_day_sales.ts";
import { queryStoreReceiptRows } from "./store_receipt_query.ts";
import { canonicalStorePartitionKeyForDb } from "./receipt_sheets_store_catalog.ts";
import { sanitizeReceiptCountFromDb } from "./receipt_parse.ts";
import { fetchManualMonthSalesMapForStore } from "./manual_month_sales.ts";

export const SALES_FIELDS = [
  "gross_sales_yen",
  "tax_amount_yen",
  "guest_count",
  "party_count",
] as const;
export type SalesField = typeof SALES_FIELDS[number];
export type SalesValues = Record<SalesField, number | null>;
export type SalesSource = "manual" | "journal" | "receipt" | "mixed";
export type SalesDifference = {
  field: SalesField;
  journal: number;
  receipt: number;
  difference: number;
};
export type UnifiedSalesDay = {
  date: string;
  receipt_count: number;
  gross_sales_yen: number;
  net_sales_yen: number;
  tax_amount_yen: number;
  guest_count: number;
  party_count: number;
  manual_gross: boolean;
  manual_guest: boolean;
  manual_party: boolean;
  sales_source: SalesSource;
  source_by_field: Record<SalesField, SalesSource>;
  journal_values: SalesValues | null;
  receipt_values: SalesValues | null;
  source_differences: SalesDifference[];
  tax_needs_review: boolean;
  net_sales_known: boolean;
};

function amount(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function values(row: Record<string, unknown>): SalesValues {
  return Object.fromEntries(
    SALES_FIELDS.map((f) => [f, amount(row[f])]),
  ) as SalesValues;
}

/** Pure, shared source resolution. Original inputs are never changed or added twice. */
export function reconcileDailySales(
  receipts: Array<Record<string, unknown>>,
  overrides: Map<string, ManualDaySalesRecord>,
): UnifiedSalesDay[] {
  const receiptDays = new Map<
    string,
    {
      values: SalesValues;
      count: number;
      net: number;
      netKnown: boolean;
      missing: Set<SalesField>;
    }
  >();
  for (const r of receipts) {
    const date = String(r.receipt_date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const agg = receiptDays.get(date) ??
      {
        values: values({}),
        count: 0,
        net: 0,
        netKnown: true,
        missing: new Set<SalesField>(),
      };
    for (const f of SALES_FIELDS) {
      let n = amount(r[f]);
      if (n != null && (f === "guest_count" || f === "party_count")) {
        n = sanitizeReceiptCountFromDb(n, f === "guest_count" ? 99999 : 9999);
      }
      if (n == null) agg.missing.add(f);
      if (n != null) agg.values[f] = (agg.values[f] ?? 0) + n;
    }
    agg.net += amount(r.net_sales_yen) ?? 0;
    agg.netKnown = agg.netKnown && amount(r.net_sales_yen) != null;
    agg.count++;
    receiptDays.set(date, agg);
  }
  return [...new Set([...receiptDays.keys(), ...overrides.keys()])].sort().map(
    (date) => {
      const receipt = receiptDays.get(date);
      if (receipt) {
        for (const f of receipt.missing) {
          receipt.values[f] = null;
        }
      }
      const md = overrides.get(date);
      const journal = md?.journal_values
        ? values(md.journal_values)
        : md?.source === "journal"
        ? values(md as unknown as Record<string, unknown>)
        : null;
      const manual = md?.manual_values ??
        (md && md.source !== "journal"
          ? Object.fromEntries(
            SALES_FIELDS.filter((f) => md[f] != null).map((f) => [f, md[f]]),
          )
          : {});
      const selected = {} as Record<SalesField, number>;
      const sources = {} as Record<SalesField, SalesSource>;
      for (const f of SALES_FIELDS) {
        const m = amount(manual[f]);
        const j = journal?.[f] ?? null;
        selected[f] = m ?? j ?? receipt?.values[f] ?? 0;
        sources[f] = m != null ? "manual" : j != null ? "journal" : "receipt";
      }
      const sourceSet = new Set(Object.values(sources));
      const differences: SalesDifference[] = [];
      if (journal && receipt) {
        for (const field of SALES_FIELDS) {
          const j = journal[field], r = receipt.values[field];
          if (j != null && r != null && j !== r) {
            differences.push({
              field,
              journal: j,
              receipt: r,
              difference: j - r,
            });
          }
        }
      }
      // Preserve receipt net when its tax is unknown; never infer a tax rate.
      const receiptNet = sources.gross_sales_yen === "receipt" &&
        sources.tax_amount_yen === "receipt";
      const taxKnown = amount(manual.tax_amount_yen) != null ||
        journal?.tax_amount_yen != null ||
        receipt?.values.tax_amount_yen != null;
      const netKnown = receiptNet ? receipt?.netKnown === true : taxKnown;
      const net = receiptNet || !netKnown
        ? receipt?.net ?? 0
        : Math.max(0, selected.gross_sales_yen - selected.tax_amount_yen);
      return {
        date,
        receipt_count: receipt?.count ?? 0,
        ...selected,
        net_sales_yen: net,
        net_sales_known: netKnown,
        manual_gross: sources.gross_sales_yen !== "receipt",
        manual_party: sources.party_count !== "receipt",
        manual_guest: sources.guest_count !== "receipt",
        sales_source: sourceSet.size === 1 ? [...sourceSet][0] : "mixed",
        source_by_field: sources,
        journal_values: journal,
        receipt_values: receipt?.values ?? null,
        source_differences: differences,
        tax_needs_review: amount(manual.gross_sales_yen) != null &&
          amount(manual.tax_amount_yen) == null &&
          selected.gross_sales_yen !==
            (journal?.gross_sales_yen ?? receipt?.values.gross_sales_yen),
      };
    },
  );
}

export function nextSalesDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function validSalesDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date;
}

export function emptyUnifiedSalesDay(date: string): UnifiedSalesDay {
  return reconcileDailySales(
    [],
    new Map([[date, {
      gross_sales_yen: null,
      guest_count: null,
      party_count: null,
    }]]),
  )[0];
}

/** All consumers use business dates, strict reads and the same per-field resolver. */
export async function fetchUnifiedDailySales(
  supabase: SupabaseClient,
  storeKey: string,
  from: string,
  toInclusive: string,
): Promise<UnifiedSalesDay[]> {
  const key = canonicalStorePartitionKeyForDb(storeKey);
  if (
    !key || !validSalesDate(from) || !validSalesDate(toInclusive) ||
    from > toInclusive
  ) throw new Error("Invalid sales period or store");
  const to = nextSalesDate(toInclusive);
  const [receipts, overrides] = await Promise.all([
    queryStoreReceiptRows(supabase, {
      storeKey: key,
      receiptFrom: from,
      receiptTo: to,
      strict: true,
    }),
    fetchManualDaySalesMapForStore(supabase, key, from, to),
  ]);
  return reconcileDailySales(
    receipts as unknown as Record<string, unknown>[],
    overrides,
  )
    .filter((day) => day.date >= from && day.date <= toInclusive);
}

export function summarizeSalesReconciliation(days: UnifiedSalesDay[]) {
  const different = days.filter((d) => d.source_differences.length > 0);
  return {
    policy: "manual > journal > receipt",
    compared_days:
      days.filter((d) => d.journal_values && d.receipt_values).length,
    discrepancy_days: different.length,
    gross_difference_yen: different.reduce(
      (sum, d) =>
        sum +
        (d.source_differences.find((f) => f.field === "gross_sales_yen")
          ?.difference ?? 0),
      0,
    ),
    tax_review_days: days.filter((d) => d.tax_needs_review).length,
    days: days.filter((d) => d.source_differences.length || d.tax_needs_review)
      .map((d) => ({
        date: d.date,
        sales_source: d.sales_source,
        source_by_field: d.source_by_field,
        source_differences: d.source_differences,
        tax_needs_review: d.tax_needs_review,
      })),
  };
}

export function salesReconciliationNotice(
  days: UnifiedSalesDay[],
): string | null {
  const summary = summarizeSalesReconciliation(days);
  if (!summary.discrepancy_days && !summary.tax_review_days) return null;
  const delta = summary.gross_difference_yen;
  return [
    summary.discrepancy_days
      ? `⚠ ジャーナル・レシート差異 ${summary.discrepancy_days}日（売上差 ${
        delta >= 0 ? "+" : ""
      }${delta.toLocaleString("ja-JP")}円／ジャーナル−レシート）`
      : "",
    summary.tax_review_days
      ? `税込手修正後の税額要確認 ${summary.tax_review_days}日`
      : "",
    "採用値は日別修正→ジャーナル→レシート。詳細は売上分析。",
  ].filter(Boolean).join("\n");
}

export async function fetchUnifiedSalesSummary(
  supabase: SupabaseClient,
  store: string,
  from: string,
  to: string,
) {
  if (
    !validSalesDate(from) || !validSalesDate(to) || from > to ||
    Date.parse(to) - Date.parse(from) > 3660 * 86400000
  ) throw new Error("Invalid sales period");
  const series = await fetchUnifiedDailySales(supabase, store, from, to);
  const months: string[] = [];
  for (let cursor = from.slice(0, 7) + "-01"; cursor <= to;) {
    const d = new Date(cursor + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + 1);
    const next = d.toISOString().slice(0, 10);
    if (
      cursor >= from && next > cursor && next <= nextSalesDate(to) &&
      !series.some((day) => day.date.slice(0, 7) === cursor.slice(0, 7))
    ) months.push(cursor.slice(0, 7));
    cursor = next;
  }
  const monthly = months.length
    ? await fetchManualMonthSalesMapForStore(supabase, store, months, true)
    : new Map();
  const monthly_fallbacks = [...monthly].map(([month, value]) => ({
    month,
    ...value,
  }));
  const totals = {
    gross_sales_yen: 0,
    net_sales_yen: 0,
    tax_amount_yen: 0,
    guest_count: 0,
    party_count: 0,
    net_sales_known: true,
  };
  for (const day of series) {
    for (const f of SALES_FIELDS) totals[f] += day[f];
    totals.net_sales_yen += day.net_sales_yen;
    totals.net_sales_known &&= day.net_sales_known;
  }
  for (const month of monthly_fallbacks) {
    for (const f of SALES_FIELDS) totals[f] += month[f] ?? 0;
    totals.net_sales_yen += month.net_sales_yen ??
      (month.tax_amount_yen != null
        ? Math.max(0, month.gross_sales_yen - month.tax_amount_yen)
        : 0);
    totals.net_sales_known &&= month.net_sales_yen != null ||
      month.tax_amount_yen != null;
  }
  return {
    store_key: canonicalStorePartitionKeyForDb(store),
    from,
    to,
    series,
    monthly_fallbacks,
    totals,
    reconciliation: summarizeSalesReconciliation(series),
    generated_at: new Date().toISOString(),
  };
}
