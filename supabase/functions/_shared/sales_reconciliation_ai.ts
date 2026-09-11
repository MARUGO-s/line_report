import type { fetchUnifiedSalesSummary } from "./sales_reconciliation.ts";

export type UnifiedSalesSummary = Awaited<
  ReturnType<typeof fetchUnifiedSalesSummary>
>;
type Range = { from: string; to: string };
type Period = { label: string; ranges: Range[] };
const dayMs = 86400000;
const dateValid = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s;
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};

/** Only dates are accepted from the browser. Store and financial facts are server-owned. */
export function resolveAiSalesPeriods(input: unknown): Period[] {
  const data = record(input);
  let periods = data.salesPeriods;
  if (periods == null) {
    // Compatibility with already-open journal tabs. No fuzzy date interpretation.
    const label = String(data.period ?? "");
    const match = label.match(
      /^(\d{4}[-/]\d{2}[-/]\d{2})(?:\s*[〜～~]\s*(\d{4}[-/]\d{2}[-/]\d{2}))?$/,
    );
    periods = match
      ? [{
        label,
        ranges: [{
          from: match[1].replaceAll("/", "-"),
          to: (match[2] || match[1]).replaceAll("/", "-"),
        }],
      }]
      : [];
  }
  if (!Array.isArray(periods) || periods.length > 24) {
    throw new Error("分析期間は24区分以内で指定してください。");
  }
  let totalDays = 0;
  const resolved = periods.map((p) => {
    const item = record(p);
    if (
      !Array.isArray(item.ranges) || !item.ranges.length ||
      item.ranges.length > 120
    ) throw new Error("分析期間の指定が不正です。");
    const ranges = item.ranges.map((r: unknown) => {
      const { from, to } = record(r);
      if (
        typeof from !== "string" || typeof to !== "string" ||
        !dateValid(from) || !dateValid(to) || from > to
      ) throw new Error("分析期間の日付が不正です。");
      totalDays += (Date.parse(to) - Date.parse(from)) / dayMs + 1;
      if (totalDays > 3660) {
        throw new Error("分析期間が長すぎます。期間を絞ってください。");
      }
      return { from, to };
    }).sort((a: Range, b: Range) => a.from.localeCompare(b.from));
    const merged: Range[] = [];
    for (const r of ranges) {
      const prev = merged.at(-1);
      if (prev && r.from <= prev.to) {
        throw new Error("同じ分析区分の期間が重複しています。");
      }
      if (prev && Date.parse(r.from) - Date.parse(prev.to) === dayMs) {
        prev.to = r.to;
      } else merged.push({ ...r });
    }
    return {
      label: String(item.label ?? "対象期間").slice(0, 120),
      ranges: merged,
    };
  });
  if (resolved.reduce((n, p) => n + p.ranges.length, 0) > 24) {
    throw new Error("分析期間は24範囲以内で指定してください。");
  }
  return resolved;
}

export function unifiedSalesFacts(summary: UnifiedSalesSummary) {
  const taxKnown =
    summary.series.every((d) =>
      d.source_by_field.tax_amount_yen !== "receipt" ||
      d.receipt_values?.tax_amount_yen != null
    ) && summary.monthly_fallbacks.every((m) => m.tax_amount_yen != null);
  const hasData = summary.series.length > 0 ||
    summary.monthly_fallbacks.length > 0;
  return {
    from: summary.from,
    to: summary.to,
    status: hasData ? "available" : "no_records",
    totals: hasData
      ? {
        ...summary.totals,
        net_sales_yen: summary.totals.net_sales_known
          ? summary.totals.net_sales_yen
          : null,
        tax_amount_yen: taxKnown ? summary.totals.tax_amount_yen : null,
        average_spend_yen: summary.totals.guest_count
          ? Math.round(
            summary.totals.gross_sales_yen / summary.totals.guest_count,
          )
          : null,
      }
      : null,
    daily_columns: [
      "date",
      "gross_sales_yen",
      "guest_count",
      "party_count",
      "tax_amount_yen",
      "net_sales_yen",
    ],
    daily: summary.series.map((
      d,
    ) => [
      d.date,
      d.gross_sales_yen,
      d.guest_count,
      d.party_count,
      d.source_by_field.tax_amount_yen === "receipt" &&
        d.receipt_values?.tax_amount_yen == null
        ? null
        : d.tax_amount_yen,
      d.net_sales_known ? d.net_sales_yen : null,
    ]),
    monthly_fallbacks: summary.monthly_fallbacks.map((m) => ({
      month: m.month,
      gross_sales_yen: m.gross_sales_yen,
      guest_count: m.guest_count ?? null,
      party_count: m.party_count ?? null,
      tax_amount_yen: m.tax_amount_yen ?? null,
      net_sales_yen: m.net_sales_yen ?? null,
    })),
    reconciliation: summary.reconciliation,
  };
}

/** Call only after session/store authorization. Fail closed on a database read error. */
export async function buildTrustedAiSalesData(
  input: unknown,
  authorizedStore: string,
  load: (
    store: string,
    from: string,
    to: string,
  ) => Promise<UnifiedSalesSummary>,
) {
  if (!authorizedStore) throw new Error("分析対象の店舗を指定してください。");
  const periods = resolveAiSalesPeriods(input);
  const facts = [];
  for (const period of periods) {
    const ranges = [];
    for (const range of period.ranges) {
      const summary = await load(authorizedStore, range.from, range.to);
      if (
        summary.store_key.toLowerCase() !== authorizedStore.toLowerCase() ||
        summary.from !== range.from ||
        summary.to !== range.to
      ) throw new Error("売上データの店舗・期間が一致しません。");
      ranges.push(unifiedSalesFacts(summary));
    }
    facts.push({ label: period.label, ranges });
  }
  // Explicit wrapper prevents any client-supplied "unified_sales" from becoming trusted.
  const { unified_sales: _forged, salesPeriods: _dates, ...original } = record(
    input,
  );
  return {
    unified_sales: {
      version: 1,
      store_key: authorizedStore,
      policy: "manual > journal > receipt",
      status: facts.length ? "resolved" : "period_not_provided",
      periods: facts,
    },
    original_reference: typeof input === "string" ? input : original,
  };
}

export const UNIFIED_SALES_AI_POLICY = `【統一売上の正本（サーバー固定・優先）】
sales_data.unified_sales は認証済み店舗・指定期間をサーバーで再集計した値です。総売上・税額・客数・組数・客単価・日別推移はこの値を最優先します。採用順は項目ごとに明示手修正 > 同期済みジャーナル日計 > レシート集計で、重複加算しません。
original_reference と client_context の総額や日別値は原本・過去スナップショットです。「確定済み」と書かれていても統一売上を上書きしません。商品・カテゴリ・決済・時間帯・昼夜別の内訳は原本参考値として残し、総額に合わせて補正・按分・捏造しません。原本と統一値が違う場合は違いと採用基準を明示します。
reconciliation に差異・税額要確認があれば知らせます。null、no_records、period_not_provided は0ではなく未確認です。期間未指定なら必要な期間を確認し、原本総額を現在の統一値と呼びません。monthly_fallbacks は日別データの無い月の登録月計で、架空の日別・曜日・天候傾向を作りません。複数期間は各label/rangeの範囲を厳守し、間の月や別店舗を混ぜません。`;
