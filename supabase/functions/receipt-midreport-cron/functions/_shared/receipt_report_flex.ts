import { fetchManualMonthSales } from "./manual_month_sales.ts";
import { isFullCalendarMonthPeriod, loadReceiptReportAggregateForStoreByReceiptDate, shiftIsoDateByYears } from "./receipt_report_aggregate.ts";
import { buildReceiptBudgetComparisonRows } from "./receipt_budget_comparison.ts";
function formatYoyPercentChange(current, prior) {
  if (!Number.isFinite(prior) || prior <= 0) return null;
  const pct = (current - prior) / prior * 100;
  const sign = pct >= 0 ? "+" : "";
  const color = pct > 0 ? "#0a7c42" : pct < 0 ? "#c62828" : "#888888";
  return {
    text: ` ${sign}${pct.toFixed(1)}%`,
    color
  };
}
function countInclusiveCalendarDays(periodStartDate, periodEndDate) {
  const sm = periodStartDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const em = periodEndDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!sm || !em) return 0;
  const startUtc = Date.UTC(Number(sm[1]), Number(sm[2]) - 1, Number(sm[3]));
  const endUtc = Date.UTC(Number(em[1]), Number(em[2]) - 1, Number(em[3]));
  if (endUtc < startUtc) return 0;
  return Math.floor((endUtc - startUtc) / 86400000) + 1;
}
function calendarDaysInMonth(yyyyMm) {
  const m = yyyyMm.match(/^(\d{4})-(\d{2})$/);
  if (!m) return 30;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
}
/** 途中期間: 報告日数 ÷ その月の暦日数（営業日数の前年比表示用） */ function resolveManualMonthCalendarScale(periodStartDate, periodEndDate) {
  if (isFullCalendarMonthPeriod(periodStartDate, periodEndDate)) return 1;
  const monthDays = calendarDaysInMonth(periodStartDate.slice(0, 7));
  const periodDays = countInclusiveCalendarDays(periodStartDate, periodEndDate);
  return monthDays > 0 && periodDays > 0 ? periodDays / monthDays : 0;
}
/** 途中期間の前年比: 手入力に営業日数があれば「今年営業日÷昨年営業日」、なければ暦日数比（売上・組数・客数用） */ export function resolveManualMonthYoyScale(periodStartDate, periodEndDate, manual, currentPeriodOperatingDayCount) {
  if (isFullCalendarMonthPeriod(periodStartDate, periodEndDate)) return 1;
  const manualOp = manual.operating_days_count;
  if (manualOp != null && manualOp > 0 && currentPeriodOperatingDayCount != null && currentPeriodOperatingDayCount > 0) {
    return currentPeriodOperatingDayCount / manualOp;
  }
  return resolveManualMonthCalendarScale(periodStartDate, periodEndDate);
}
/** 報告期間の前年同日付範囲を集計（暦月全体のとき手入力を優先） */ export async function loadReceiptReportYoyComparison(supabase, storePartitionKey, periodStartDate, periodEndDate) {
  const key = String(storePartitionKey ?? "").trim().toLowerCase();
  if (!key) return null;
  const priorStart = shiftIsoDateByYears(periodStartDate, -1);
  const priorEnd = shiftIsoDateByYears(periodEndDate, -1);
  if (!priorStart || !priorEnd) return null;
  const currentAggregate = await loadReceiptReportAggregateForStoreByReceiptDate(supabase, key, periodStartDate, periodEndDate);
  const currentOperatingDays = currentAggregate?.operatingDayCount ?? null;
  const priorAggregate = await loadReceiptReportAggregateForStoreByReceiptDate(supabase, key, priorStart, priorEnd);
  let priorGrossSalesYen = priorAggregate?.totalGrossSalesYen ?? null;
  let priorPartyCount = priorAggregate?.totalPartyCount ?? null;
  let priorGuestCount = priorAggregate?.totalGuestCount ?? null;
  let priorOperatingDayCount = priorAggregate?.operatingDayCount ?? null;
  const priorYearMonth = `${Number(periodStartDate.slice(0, 4)) - 1}-${periodStartDate.slice(5, 7)}`;
  const manual = await fetchManualMonthSales(supabase, key, priorYearMonth);
  if (manual) {
    // 過去売上が登録されている月は、手入力に無い組数・客数へレシート集計を混ぜない
    // （総売上のみ登録時に昨年レシートや誤日付行で組数・客数の前年比が出るのを防ぐ）
    if (isFullCalendarMonthPeriod(periodStartDate, periodEndDate)) {
      priorGrossSalesYen = manual.gross_sales_yen;
      priorPartyCount = manual.party_count ?? null;
      priorGuestCount = manual.guest_count ?? null;
      if (manual.operating_days_count != null) {
        priorOperatingDayCount = manual.operating_days_count;
      }
    } else {
      const scale = resolveManualMonthYoyScale(periodStartDate, periodEndDate, manual, currentOperatingDays);
      if (scale > 0) {
        priorGrossSalesYen = Math.round(manual.gross_sales_yen * scale);
        priorPartyCount = manual.party_count != null ? Math.round(manual.party_count * scale) : null;
        priorGuestCount = manual.guest_count != null ? Math.round(manual.guest_count * scale) : null;
        // 営業日数の前年比はシートの月間値を暦日按分（23日×20/31≈15）。売上按分と同じ比率にすると今年=前年で常に±0%になる
        if (manual.operating_days_count != null) {
          const calScale = resolveManualMonthCalendarScale(periodStartDate, periodEndDate);
          if (calScale > 0) {
            priorOperatingDayCount = Math.round(manual.operating_days_count * calScale);
          }
        }
      }
    }
  }
  return {
    priorPeriodStartDate: priorStart,
    priorPeriodEndDate: priorEnd,
    priorGrossSalesYen,
    priorPartyCount,
    priorGuestCount,
    priorOperatingDayCount
  };
}
function formatYenAmount(value) {
  return `¥${Math.round(value).toLocaleString("ja-JP")}`;
}
function formatAverageCount(value) {
  if (value == null || !Number.isFinite(value)) return "-";
  const rounded = Math.round(value * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.001) return String(Math.round(rounded));
  return rounded.toFixed(1);
}
/** 例: 25 組（2.5 組/日） */ function formatTotalWithDailyAverage(total, dailyAvg, unit, dailySuffix) {
  const base = `${total.toLocaleString("ja-JP")} ${unit}`;
  const avg = formatAverageCount(dailyAvg);
  if (avg === "-") return base;
  return `${base}（${avg} ${dailySuffix}）`;
}
function flexBaselineRow(label, value, valueColor = "#1F1F1F") {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      {
        type: "text",
        text: label,
        size: "sm",
        color: "#888888",
        flex: 4,
        wrap: false
      },
      {
        type: "text",
        text: value,
        size: "sm",
        color: valueColor,
        flex: 6,
        wrap: true,
        weight: "bold"
      }
    ]
  };
}
function formatSignedYenDiffText(diffYen) {
  const x = Math.round(diffYen);
  const absStr = `¥${Math.abs(x).toLocaleString("ja-JP")}`;
  if (x > 0) return `（+${absStr}）`;
  if (x < 0) return `（-${absStr}）`;
  return "（±¥0）";
}
function formatSignedCountDiffText(diff, unit) {
  const x = Math.round(diff);
  const absStr = Math.abs(x).toLocaleString("ja-JP");
  if (x > 0) return `（+${absStr}${unit}）`;
  if (x < 0) return `（-${absStr}${unit}）`;
  return `（±0${unit}）`;
}
function formatYoyMetricValueLine(current, prior, formatAbsDiff) {
  if (prior == null || prior <= 0) return "—";
  const change = formatYoyPercentChange(current, prior);
  if (!change) return "—";
  const absDiff = formatAbsDiff ? formatAbsDiff(Math.round(current) - Math.round(prior)) : "";
  return `${change.text.trim()}${absDiff}`;
}
function pushReceiptYoyKvMetricRow(rows, label, current, prior, formatAbsDiff) {
  const value = formatYoyMetricValueLine(current, prior, formatAbsDiff);
  const change = prior != null && prior > 0 ? formatYoyPercentChange(current, prior) : null;
  rows.push({
    label,
    value,
    valueColor: change?.color ?? "#888888"
  });
}
function formatYoyPriorPeriodLabel(start, end) {
  const sm = start.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const em = end.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!sm || !em) return `${start}〜${end}`;
  if (sm[1] === em[1] && sm[2] === em[2]) {
    return `昨年 ${Number(sm[2])}/${Number(sm[3])}〜${Number(em[3])}`;
  }
  return `昨年 ${start}〜${end}`;
}
function formatYoyPctCompact(current, prior) {
  if (prior == null || prior <= 0) return {
    text: "—",
    color: "#888888"
  };
  const change = formatYoyPercentChange(current, prior);
  if (!change) return {
    text: "—",
    color: "#888888"
  };
  return {
    text: change.text.trim(),
    color: change.color
  };
}
/** レシート解析 Flex 用：【前年同月比】を2行（baseline 形式・span 不使用） */ export function buildReceiptYoyCompactKvRows(aggregate, yoy) {
  const periodLabel = formatYoyPriorPeriodLabel(yoy.priorPeriodStartDate, yoy.priorPeriodEndDate);
  const metrics = [
    {
      name: "売上",
      current: aggregate.totalGrossSalesYen,
      prior: yoy.priorGrossSalesYen
    },
    {
      name: "組",
      current: aggregate.totalPartyCount,
      prior: yoy.priorPartyCount
    },
    {
      name: "客",
      current: aggregate.totalGuestCount,
      prior: yoy.priorGuestCount
    },
    {
      name: "営業日",
      current: aggregate.operatingDayCount,
      prior: yoy.priorOperatingDayCount
    }
  ];
  const metricParts = [];
  for (const m of metrics){
    const pct = formatYoyPctCompact(m.current, m.prior);
    metricParts.push(`${m.name}${pct.text}`);
  }
  return [
    {
      label: "【前年同月比】",
      value: periodLabel,
      margin: "md"
    },
    {
      label: "比較",
      value: metricParts.join("  ")
    }
  ];
}
/** レシート解析返信など、baseline KV 向けの前年比行（前年データなしは「—」で常に4行） */ export function buildReceiptYoyKvRows(aggregate, yoy) {
  const rows = [];
  pushReceiptYoyKvMetricRow(rows, "売上", aggregate.totalGrossSalesYen, yoy.priorGrossSalesYen, formatSignedYenDiffText);
  pushReceiptYoyKvMetricRow(rows, "組数", aggregate.totalPartyCount, yoy.priorPartyCount, (d)=>formatSignedCountDiffText(d, "組"));
  pushReceiptYoyKvMetricRow(rows, "客数", aggregate.totalGuestCount, yoy.priorGuestCount, (d)=>formatSignedCountDiffText(d, "名"));
  pushReceiptYoyKvMetricRow(rows, "営業日数", aggregate.operatingDayCount, yoy.priorOperatingDayCount, (d)=>formatSignedCountDiffText(d, "日"));
  return rows;
}
function flexYoyMetricRow(label, current, prior, formatAbsDiff) {
  if (prior == null || prior <= 0) return flexBaselineRow(label, "—", "#888888");
  const change = formatYoyPercentChange(current, prior);
  if (!change) return flexBaselineRow(label, "—", "#888888");
  const pctText = change.text.trim();
  const absDiff = formatAbsDiff ? formatAbsDiff(Math.round(current) - Math.round(prior)) : null;
  if (!absDiff) return flexBaselineRow(label, pctText, change.color);
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      {
        type: "text",
        text: label,
        size: "sm",
        color: "#888888",
        flex: 4,
        wrap: false
      },
      {
        type: "text",
        size: "sm",
        wrap: true,
        weight: "bold",
        flex: 6,
        contents: [
          {
            type: "span",
            text: pctText,
            color: change.color
          },
          {
            type: "span",
            text: absDiff,
            color: "#666666"
          }
        ]
      }
    ]
  };
}
function appendReceiptReportYoySection(bodyContents, aggregate, yoy) {
  bodyContents.push(flexSectionDivider());
  bodyContents.push({
    type: "text",
    text: "【前年同月比】",
    size: "sm",
    weight: "bold",
    color: "#7A7A7A",
    margin: "md",
    wrap: true
  });
  bodyContents.push(flexBaselineRow("昨年差異日", `${yoy.priorPeriodStartDate}〜${yoy.priorPeriodEndDate}`, "#666666"));
  bodyContents.push(flexYoyMetricRow("売上", aggregate.totalGrossSalesYen, yoy.priorGrossSalesYen, formatSignedYenDiffText), flexYoyMetricRow("組数", aggregate.totalPartyCount, yoy.priorPartyCount, (d)=>formatSignedCountDiffText(d, "組")), flexYoyMetricRow("客数", aggregate.totalGuestCount, yoy.priorGuestCount, (d)=>formatSignedCountDiffText(d, "名")), flexYoyMetricRow("営業日数", aggregate.operatingDayCount, yoy.priorOperatingDayCount, (d)=>formatSignedCountDiffText(d, "日")));
}
function flexBudgetRow(row) {
  const suffix = row.valueSuffix;
  if (suffix) {
    return {
      type: "box",
      layout: "baseline",
      spacing: "sm",
      contents: [
        {
          type: "text",
          text: row.label,
          size: "sm",
          color: "#888888",
          flex: 4,
          wrap: false
        },
        {
          type: "text",
          size: "sm",
          wrap: true,
          weight: "bold",
          flex: 6,
          contents: [
            {
              type: "span",
              text: row.value,
              color: "#1F1F1F"
            },
            {
              type: "span",
              text: suffix.text,
              color: suffix.color
            }
          ]
        }
      ]
    };
  }
  return flexBaselineRow(row.label, row.value, row.valueColor ?? "#1F1F1F");
}
function flexSectionDivider() {
  return {
    type: "text",
    text: "────────",
    size: "xxs",
    color: "#AAAAAA",
    margin: "md"
  };
}
function receiptCountMatchesOperatingDays(aggregate) {
  return aggregate.receiptCount === aggregate.operatingDayCount;
}
export async function buildReceiptReportFlexMessages(supabase, aggregate, opts) {
  const adminToken = Deno.env.get("ADMIN_DASHBOARD_TOKEN") ?? "";
  const dashboardUri = `https://marugo-s.github.io/line_report/analytics.html${adminToken ? `?t=${encodeURIComponent(adminToken)}` : ""}`;
  const avgUnit = aggregate.avgGrossSalesYen == null ? null : aggregate.totalGuestCount > 0 ? Math.round(aggregate.totalGrossSalesYen / aggregate.totalGuestCount) : null;
  const altText = `【${opts.reportTitle}】${opts.periodStartDate}〜${opts.periodEndDate} 総売上: ${formatYenAmount(aggregate.totalGrossSalesYen)}`;
  const countMismatch = !receiptCountMatchesOperatingDays(aggregate);
  const bodyContents = [];
  if (countMismatch) {
    bodyContents.push({
      type: "text",
      text: `⚠ レシート${aggregate.receiptCount.toLocaleString("ja-JP")}件と営業日${aggregate.operatingDayCount.toLocaleString("ja-JP")}日が一致しません（通常は同数です）`,
      size: "sm",
      weight: "bold",
      color: "#c62828",
      margin: "md",
      wrap: true
    });
  }
  bodyContents.push(flexBaselineRow("総売上", formatYenAmount(aggregate.totalGrossSalesYen)), flexBaselineRow("組数合計", formatTotalWithDailyAverage(aggregate.totalPartyCount, aggregate.avgPartyCount, "組", "組/日")), flexBaselineRow("客数合計", formatTotalWithDailyAverage(aggregate.totalGuestCount, aggregate.avgGuestCount, "名", "名/日")));
  if (avgUnit != null) {
    bodyContents.push(flexBaselineRow("客単価", formatYenAmount(avgUnit)));
  }
  bodyContents.push(flexBaselineRow("1日平均売上", aggregate.avgDailyGrossSalesYen == null ? "-" : formatYenAmount(aggregate.avgDailyGrossSalesYen)), flexBaselineRow("営業日数", `${aggregate.operatingDayCount.toLocaleString("ja-JP")} 日`, countMismatch ? "#c62828" : "#1F1F1F"), flexBaselineRow("レシート件数", `${aggregate.receiptCount.toLocaleString("ja-JP")} 件`, countMismatch ? "#c62828" : "#1F1F1F"));
  const storeKey = String(opts.storePartitionKey ?? "").trim().toLowerCase();
  if (supabase && storeKey) {
    const yoy = await loadReceiptReportYoyComparison(supabase, storeKey, opts.periodStartDate, opts.periodEndDate);
    if (yoy) appendReceiptReportYoySection(bodyContents, aggregate, yoy);
    const receiptMonthYyyyMm = opts.periodStartDate.slice(0, 7);
    const budgetRows = await buildReceiptBudgetComparisonRows(supabase, {
      storePartitionKey: storeKey,
      asOfDateIso: opts.periodEndDate,
      receiptMonthYyyyMm,
      monthActualYen: aggregate.totalGrossSalesYen,
      budgetCumulativeThroughDate: opts.periodEndDate,
      omitDailyBudgetLines: true
    });
    if (budgetRows && budgetRows.length > 0) {
      bodyContents.push(flexSectionDivider());
      bodyContents.push({
        type: "text",
        text: "【予算】",
        size: "sm",
        weight: "bold",
        color: "#7A7A7A",
        margin: "md",
        wrap: true
      });
      for (const br of budgetRows){
        bodyContents.push(flexBudgetRow(br));
      }
    }
  }
  return [
    {
      type: "flex",
      altText: altText.slice(0, 400),
      contents: {
        type: "bubble",
        header: {
          type: "box",
          layout: "vertical",
          paddingTop: "md",
          paddingBottom: "md",
          paddingStart: "md",
          paddingEnd: "md",
          backgroundColor: "#006c3a",
          contents: [
            {
              type: "text",
              text: `📊 ${opts.reportTitle}`,
              size: "lg",
              weight: "bold",
              color: "#FFFFFF"
            },
            {
              type: "text",
              text: `${opts.periodStartDate}〜${opts.periodEndDate}`,
              size: "xs",
              color: "#CCFFDD",
              margin: "sm"
            }
          ]
        },
        body: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          paddingTop: "md",
          paddingBottom: "md",
          paddingStart: "md",
          paddingEnd: "md",
          contents: bodyContents
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          paddingTop: "md",
          paddingBottom: "md",
          paddingStart: "md",
          paddingEnd: "md",
          contents: [
            {
              type: "button",
              style: "secondary",
              height: "sm",
              action: {
                type: "uri",
                label: "📈 売上推移を見る",
                uri: dashboardUri
              }
            }
          ]
        }
      }
    }
  ];
}
