import type { ReceiptReplyContext } from './receipt_reply_context.ts'
import {
  formatSignedCount,
  formatSignedPctWithDiff,
  formatSignedYen,
} from './receipt_reply_context.ts'
import {
  buildReceiptAnalysisDeletionCommandTextForLineMessageId,
  buildReceiptCorrectionCommandTextForLineMessageId,
  clampLineMessageActionText,
} from './receipt_line_actions.ts'
import { formatYenAmount } from './receipt_parse.ts'

const NEGATIVE_COLOR = '#E53935'
const LABEL_COLOR = '#666666'
const VALUE_COLOR = '#111111'

function formatReceiptDateJa(dateText: string, isoFallback: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoFallback).slice(0, 10))
  if (iso) {
    return `${iso[1]}年${Number(iso[2])}月${Number(iso[3])}日`
  }
  const ja = String(dateText ?? '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (ja) return `${ja[1]}年${Number(ja[2])}月${Number(ja[3])}日`
  return String(dateText || isoFallback || '-')
}

function formatYenOrDash(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return formatYenAmount(value)
}

function formatCountOrDash(value: number | null, unit: string): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${Math.round(value)}${unit}`
}

function formatDecimalOrDash(value: number | null, unit: string): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value}${unit}`
}

function valueColorForSigned(value: number | null): string {
  if (value != null && Number.isFinite(value) && value < 0) return NEGATIVE_COLOR
  return VALUE_COLOR
}

function valueColorForSignedOrNegativePct(
  value: number | null,
  pct: number | null,
): string {
  if (value != null && Number.isFinite(value) && value < 0) return NEGATIVE_COLOR
  if (pct != null && Number.isFinite(pct) && pct < 0) return NEGATIVE_COLOR
  return VALUE_COLOR
}

function valueColorForAchievementPct(pct: number | null): string {
  if (pct != null && Number.isFinite(pct) && pct < 100) return NEGATIVE_COLOR
  return VALUE_COLOR
}

function kvRow(label: string, value: string, valueColor = VALUE_COLOR) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    margin: 'xs',
    contents: [
      {
        type: 'text',
        text: label,
        size: 'sm',
        color: LABEL_COLOR,
        flex: 4,
        wrap: true,
      },
      {
        type: 'text',
        text: value,
        size: 'sm',
        color: valueColor,
        flex: 6,
        align: 'start',
        wrap: true,
      },
    ],
  }
}

function sectionTitle(text: string) {
  return {
    type: 'text',
    text,
    size: 'sm',
    weight: 'bold',
    color: VALUE_COLOR,
    margin: 'md',
  }
}

export type ReceiptReplyVisibilityOptions = {
  showExecutiveDetail?: boolean
}

export function buildReceiptFlexMessage(
  context: ReceiptReplyContext,
  options: ReceiptReplyVisibilityOptions = {},
): Record<string, unknown> {
  const showExecutiveDetail = options.showExecutiveDetail !== false
  const dateText = formatReceiptDateJa(context.receiptDateText, context.receiptDateIso)
  const unitPrice = context.unitPriceYen ?? (
    context.grossSalesYen != null && context.guestCount != null && context.guestCount > 0
      ? Math.round(context.grossSalesYen / context.guestCount)
      : null
  )

  const monthActualText = context.monthBudgetAchievementPct != null && context.monthGrossSalesYen != null
    ? `${formatYenAmount(context.monthGrossSalesYen)} (${context.monthBudgetAchievementPct.toFixed(1)}%)`
    : formatYenOrDash(context.monthGrossSalesYen)

  const bodyContents: Record<string, unknown>[] = [
    kvRow('店名', context.storeDisplayName),
    kvRow('日付', dateText),
    kvRow('消費税', formatYenOrDash(context.taxAmountYen)),
    kvRow('総売上（税込）', formatYenOrDash(context.grossSalesYen)),
    kvRow('会計組数', formatCountOrDash(context.partyCount, ' 組')),
    kvRow('客数', formatCountOrDash(context.guestCount, ' 人')),
    kvRow('客単価', formatYenOrDash(unitPrice)),
  ]

  if (showExecutiveDetail) {
    bodyContents.push(
      { type: 'separator', margin: 'md' },
      kvRow('営業日数', formatCountOrDash(context.businessDays, ' 日')),
      kvRow('月間総売上', formatYenOrDash(context.monthGrossSalesYen)),
      kvRow('1日平均', formatYenOrDash(context.monthDailyAvgGross)),
      kvRow('月間会計組数', formatCountOrDash(context.monthPartyCount, ' 組')),
      kvRow('1日平均', formatDecimalOrDash(context.monthDailyAvgParty, ' 組')),
      kvRow('月間客数', formatCountOrDash(context.monthGuestCount, ' 人')),
      kvRow('1日平均', formatDecimalOrDash(context.monthDailyAvgGuest, ' 名')),
    )
  }

  if (showExecutiveDetail && context.monthBudgetYen != null) {
    bodyContents.push(
      { type: 'separator', margin: 'md' },
      sectionTitle('【予算】'),
      kvRow('月次目標', formatYenOrDash(context.monthBudgetYen)),
      kvRow(
        '月次実績',
        monthActualText,
        valueColorForAchievementPct(context.monthBudgetAchievementPct),
      ),
      kvRow('当日目標', formatYenOrDash(context.dailyBudgetYen)),
      kvRow(
        '日次予算差',
        formatSignedYen(context.dailyBudgetDiffYen),
        valueColorForSigned(context.dailyBudgetDiffYen),
      ),
      kvRow(
        '日次予算累計',
        formatSignedYen(context.cumulativeBudgetDiffYen),
        valueColorForSigned(context.cumulativeBudgetDiffYen),
      ),
    )
  }

  if (showExecutiveDetail && context.yoyPeriodLabel) {
    const yoySalesDiffLabel = context.yoySalesDiffYen != null
      ? formatSignedYen(context.yoySalesDiffYen).replace(/^\+/, '')
      : '-'
    const yoyPartyDiffLabel = context.yoyPartyDiff != null
      ? formatSignedCount(context.yoyPartyDiff, '組').replace(/^\+/, '')
      : '-'
    const yoyGuestDiffLabel = context.yoyGuestDiff != null
      ? formatSignedCount(context.yoyGuestDiff, '名').replace(/^\+/, '')
      : '-'
    const yoyDaysDiffLabel = context.yoyBusinessDaysDiff != null
      ? formatSignedCount(context.yoyBusinessDaysDiff, '日').replace(/^\+/, '±')
      : '-'

    bodyContents.push(
      { type: 'separator', margin: 'md' },
      sectionTitle('【前年同月比】'),
      kvRow('昨年差異日', context.yoyPeriodLabel),
      kvRow(
        '売上',
        formatSignedPctWithDiff(context.yoySalesPct, yoySalesDiffLabel),
        valueColorForSignedOrNegativePct(context.yoySalesDiffYen, context.yoySalesPct),
      ),
      kvRow(
        '組数',
        formatSignedPctWithDiff(context.yoyPartyPct, yoyPartyDiffLabel),
        valueColorForSignedOrNegativePct(context.yoyPartyDiff, context.yoyPartyPct),
      ),
      kvRow(
        '客数',
        formatSignedPctWithDiff(context.yoyGuestPct, yoyGuestDiffLabel),
        valueColorForSignedOrNegativePct(context.yoyGuestDiff, context.yoyGuestPct),
      ),
      kvRow(
        '営業日数',
        formatSignedPctWithDiff(context.yoyBusinessDaysPct, yoyDaysDiffLabel),
        valueColorForSignedOrNegativePct(context.yoyBusinessDaysDiff, context.yoyBusinessDaysPct),
      ),
    )
  }

  const trendUrl = context.analyticsDashboardUrl

  return {
    type: 'flex',
    altText: `${context.storeDisplayName} ${dateText} 売上レポート`,
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: bodyContents,
        paddingAll: '16px',
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'message',
              label: 'この結果を修正',
              text: clampLineMessageActionText(
                buildReceiptCorrectionCommandTextForLineMessageId(context.lineMessageId),
              ),
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'message',
              label: 'この解析結果を削除',
              text: clampLineMessageActionText(
                buildReceiptAnalysisDeletionCommandTextForLineMessageId(context.lineMessageId),
              ),
            },
          },
          ...(showExecutiveDetail ? [{
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'uri',
              label: '売上推移を見る',
              uri: trendUrl,
            },
          }] : []),
          ...(context.foodcourtReportUrl ? [{
            type: 'button',
            style: 'primary',
            color: '#1a6fa8',
            height: 'sm',
            action: {
              type: 'uri',
              label: '📋 日報を記入する',
              uri: context.foodcourtReportUrl,
            },
          }] : []),
        ],
        paddingAll: '12px',
      },
    },
  }
}
