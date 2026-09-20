import {
  buildTrustedAiSalesData,
  type UnifiedSalesSummary,
} from "./sales_reconciliation_ai.ts";
import type { FoodCourtJournalDetail } from "./foodcourt_journal_detail.ts";

type Range = { from: string; to: string };
type LoadSales = (
  store: string,
  from: string,
  to: string,
) => Promise<UnifiedSalesSummary>;
const dateValid = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s;

/** Authorized store only. Discover actual bounds rather than inferring them from tenant receipts. */
export async function discoverFoodCourtSalesRange(
  db: any,
  store: string,
  comparisonDates: string[],
): Promise<Range[]> {
  if (!/^[a-z0-9_-]{1,80}$/i.test(store)) {
    throw new Error("Invalid sales store");
  }
  const storePattern = store.replaceAll("_", "\\_");
  const dates = comparisonDates.filter(dateValid);
  const sources = [
    { table: "line_sales_manual_day", column: "sales_date", scoped: true },
    {
      table: "line_sales_manual_month_gross",
      column: "sales_month",
      scoped: true,
    },
    { table: "pos_journal_files", column: "business_date", scoped: true },
  ];
  const registry = await db.from("store_webhook_tables").select("receipt_table")
    .ilike("store_partition_key", storePattern);
  if (registry.error || registry.data?.length !== 1) {
    throw new Error("Sales store registry unavailable");
  }
  const table = String(registry.data[0].receipt_table || "");
  if (!/^[a-zA-Z0-9_]+$/.test(table)) throw new Error("Invalid receipt table");
  sources.push({ table, column: "receipt_date", scoped: false });
  await Promise.all(
    sources.flatMap((source) =>
      [true, false].map(async (ascending) => {
        let query = db.from(source.table).select(source.column);
        if (source.scoped) {
          query = query.ilike("store_partition_key", storePattern);
        }
        if (source.table === "pos_journal_files") {
          query = query.is("storage_deleted_at", null);
        }
        const result = await query.not(source.column, "is", null).order(
          source.column,
          { ascending },
        ).limit(1);
        if (result.error) {
          throw new Error("Sales period discovery failed");
        }
        let date = String(result.data?.[0]?.[source.column] || "");
        if (source.column === "receipt_date") date = date.slice(0, 10);
        if (source.column === "sales_month" && /^\d{4}-\d{2}$/.test(date)) {
          date = ascending ? date + "-01" : new Date(
            Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0),
          ).toISOString().slice(0, 10);
        }
        if (date && !dateValid(date)) {
          throw new Error("Invalid stored sales date");
        }
        if (date) dates.push(date);
      })
    ),
  );
  // Shared Journal reports can predate the POS-file list. Read only metadata, with pagination.
  for (let offset = 0;; offset += 500) {
    const result = await db.from("saved_reports").select(
      "id,period,sourceMonths:data->sourceMonths",
    )
      .ilike("store_partition_key", storePattern).is("deleted_at", null).order(
        "id",
      ).range(offset, offset + 499);
    if (result.error) throw new Error("Shared journal period discovery failed");
    const rows = result.data || [];
    for (const row of rows) {
      const exactDates = String(row.period || "").match(/\d{4}-\d{2}-\d{2}/g) ||
        [];
      dates.push(...exactDates.filter(dateValid));
      // For month-only reports, the month bounds are search bounds, not claims of daily coverage.
      if (!exactDates.length && Array.isArray(row.sourceMonths)) {
        for (const month of row.sourceMonths) {
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month))) {
            continue;
          }
          dates.push(
            month + "-01",
            new Date(
              Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
            ).toISOString().slice(0, 10),
          );
        }
      }
    }
    if (rows.length < 500) break;
  }
  dates.sort();
  return dates.length ? [{ from: dates[0], to: dates.at(-1)! }] : [];
}

export const FOODCOURT_SALES_POLICY = `【自店売上と他店比較の出典・最優先】
自店の売上・税額・客数・組数・客単価・月別推移は「ジャーナル連携・統一売上」のサーバー集計を優先する。項目別に手修正 > 同期済みジャーナル > 自店レシート。テナント比較表は別資料の税抜値であり、統一売上へ足さない。比較表の99日などの件数を自店の全期間・営業日数と呼ばない。
同日でも税区分・客数定義が違うことがある。競合順位・シェア・店舗間相関は比較表の共通日・同じ税区分だけで評価し、比較表のない過去月へ推定で広げない。比較表からの要因分解・イベント相関は比較表がある期間だけの参考分析と明記する。
分析期間・データ源ごとの開始日/終了日・日数・不足範囲を説明する。月別の記録日数は営業日数とは限らず、未取得日は0円としない。nullは未確認。税込と税抜を区別し、数値の創作や再計算はしない。過去回答より今回取得した実績を優先する。`;

/** Uses the same canonical loader as Journal AI, with no writes or client-supplied financial values. */
export async function buildFoodCourtSalesContext(
  store: string,
  ranges: Range[],
  loadSales: LoadSales,
) {
  const summaries: UnifiedSalesSummary[] = [];
  const trusted = await buildTrustedAiSalesData(
    { salesPeriods: ranges.length ? [{ label: "Q&A自店売上", ranges }] : [] },
    store,
    async (key, from, to) => {
      const summary = await loadSales(key, from, to);
      summaries.push(summary);
      return summary;
    },
  );
  const days = summaries.flatMap((s) => s.series);
  const journalDates = days.filter((d) => d.journal_values != null).map((d) =>
    d.date
  ).sort();
  const usedDates = days.map((d) => d.date).sort();
  const coverage = {
    requested_ranges: ranges,
    from: usedDates[0] ?? null,
    to: usedDates.at(-1) ?? null,
    recorded_days: days.length,
    journal_from: journalDates[0] ?? null,
    journal_to: journalDates.at(-1) ?? null,
    journal_days: journalDates.length,
    monthly_fallback_count: summaries.reduce(
      (n, s) => n + s.monthly_fallbacks.length,
      0,
    ),
  };
  const facts = trusted.unified_sales.periods.flatMap((p) => p.ranges);
  const compact = facts.map((f, index) => {
    // The shared UI resolver represents missing counts as zero; restore unknowns for AI.
    const sourceDays = new Map(summaries[index].series.map((d) => [d.date, d]));
    for (const row of f.daily) {
      const day = sourceDays.get(String(row[0]))!;
      for (
        const [field, column] of [["guest_count", 2], [
          "party_count",
          3,
        ]] as const
      ) {
        if (
          day.source_by_field[field] === "receipt" &&
          day.receipt_values?.[field] == null
        ) row[column] = null;
      }
    }
    const unknownGuests = f.daily.some((d) => d[2] == null) ||
      f.monthly_fallbacks.some((m) => m.guest_count == null);
    const unknownParties = f.daily.some((d) => d[3] == null) ||
      f.monthly_fallbacks.some((m) => m.party_count == null);
    const totals = f.totals
      ? {
        ...f.totals,
        guest_count: unknownGuests ? null : f.totals.guest_count,
        party_count: unknownParties ? null : f.totals.party_count,
        average_spend_yen: unknownGuests ? null : f.totals.average_spend_yen,
      }
      : null;
    const months = [...new Set(f.daily.map((d) => String(d[0]).slice(0, 7)))]
      .sort().map((month) => {
        const rows = f.daily.filter((d) => String(d[0]).startsWith(month));
        const sum = (i: number) =>
          rows.every((d) => d[i] != null)
            ? rows.reduce((n, d) => n + Number(d[i]), 0)
            : null;
        const gross = sum(1), guests = sum(2);
        return {
          month,
          from: rows[0][0],
          to: rows.at(-1)![0],
          recorded_days: rows.length,
          gross_sales_yen: gross,
          net_sales_yen: sum(5),
          tax_amount_yen: sum(4),
          guest_count: guests,
          party_count: sum(3),
          average_spend_yen: gross != null && guests
            ? Math.round(gross / guests)
            : null,
        };
      });
    // Entire month coverage is always present; bound daily prompt volume for multi-year histories.
    return {
      ...f,
      totals,
      reconciliation: {
        policy: f.reconciliation.policy,
        discrepancy_days: f.reconciliation.discrepancy_days,
        tax_review_days: f.reconciliation.tax_review_days,
      },
      monthly: months,
      daily: f.daily.slice(-366),
      daily_omitted_count: Math.max(0, f.daily.length - 366),
    };
  });
  const summary = `自店売上（ジャーナル連携・統一売上）: ${
    coverage.from ? coverage.from + "〜" + coverage.to : "日別記録なし"
  }・${coverage.recorded_days}日。うちジャーナル: ${
    coverage.journal_from
      ? coverage.journal_from + "〜" + coverage.journal_to
      : "記録なし"
  }・${coverage.journal_days}日。月計のみの補完: ${coverage.monthly_fallback_count}件。`;
  const evaluationBlock =
    `【ジャーナル連携・統一売上／サーバー確定集計】\n${summary}\n${
      JSON.stringify({
        monthly_columns: [
          "month",
          "from",
          "to",
          "recorded_days",
          "gross_sales_yen",
          "net_sales_yen",
          "tax_amount_yen",
          "guest_count",
          "party_count",
          "average_spend_yen",
        ],
        ranges: compact.map(({ daily: _daily, monthly, ...rest }) => ({
          ...rest,
          monthly: monthly.map(
            (m) => [
              m.month,
              m.from,
              m.to,
              m.recorded_days,
              m.gross_sales_yen,
              m.net_sales_yen,
              m.tax_amount_yen,
              m.guest_count,
              m.party_count,
              m.average_spend_yen,
            ],
          ),
        })),
      })
    }`;
  const block = evaluationBlock +
    `\n日別列: ${JSON.stringify(facts[0]?.daily_columns || [])}\n` +
    JSON.stringify(
      compact.map((f) => ({ from: f.from, to: f.to, daily: f.daily })),
    ) +
    "\n日別詳細が省略された場合も月別集計は全件。省略日の個別分析は期間を絞る。";
  return {
    coverage,
    summary,
    block,
    evaluationBlock,
    journalDetail: null as FoodCourtJournalDetail | null,
    hasData: days.length > 0 || coverage.monthly_fallback_count > 0,
  };
}
export type FoodCourtSalesContext = Awaited<
  ReturnType<typeof buildFoodCourtSalesContext>
>;
