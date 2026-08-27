/**
 * LINE Report / Journal Report 統合AI資料のコード網羅監査。
 *
 * 新しい公開画面・Edge Function・共有モジュール・管理APIルートが追加された際、
 * AI資料の区分へ結び付かないまま放置されることを防ぐ。
 */

export const PUBLIC_CODE_HELP_CODES: Record<string, string[]> = {
  'public/access-log.js': ['ADM-01', 'DEV-01'],
  'public/ai-usage.html': ['ADM-02', 'DEV-01'],
  'public/analytics.html': ['SAL-04', 'SAL-05', 'SAL-06', 'DEV-01'],
  'public/app-theme.js': ['DEV-01'],
  'public/auth-session.js': ['SYS-02', 'SEC-01', 'DEV-01'],
  'public/chat-admin.html': ['ADM-01', 'ADM-03', 'OPS-01', 'DEV-01'],
  'public/chat-sw.js': ['OPS-02', 'DEV-01'],
  'public/chat.html': ['SYS-01', 'OPS-01', 'OPS-02', 'RSV-01', 'JAI-02', 'DEV-01'],
  'public/chat.webmanifest': ['SYS-01', 'DEV-01'],
  'public/foodcourt-evolution.html': ['FCT-03', 'FCT-05', 'DEV-01'],
  'public/foodcourt-report.html': ['FCT-04', 'DEV-01'],
  'public/foodcourt-weekly-report.html': ['FCT-04', 'FCT-06', 'DEV-01'],
  'public/foodcourt.html': ['FCT-01', 'FCT-02', 'FCT-03', 'FCT-04', 'FCT-05', 'FCT-06', 'DEV-01'],
  'public/index.html': ['ADM-01', 'ADM-02', 'DEV-01'],
  'public/jnl2txt.html': ['JRN-01', 'JRN-02', 'JAI-01', 'JAI-02', 'DEV-01'],
  'public/jnm/ai-chat-pdf-history.html': ['JAI-02', 'JAI-05', 'DEV-01'],
  'public/jnm/ai-usage.html': ['JAI-05', 'ADM-02', 'DEV-01'],
  'public/jnm/app-theme.js': ['DEV-01'],
  'public/jnm/auth-session.js': ['SYS-02', 'SEC-01', 'DEV-01'],
  'public/jnm/index.html': ['JRN-01', 'DEV-01'],
  'public/jnm/jnl2txt.html': ['JRN-01', 'JRN-02', 'JRN-03', 'JRN-04', 'KNW-01', 'JAI-01', 'JAI-02', 'JAI-03', 'JAI-04', 'JAI-05', 'DEV-01'],
  'public/jnm/journal-ai-client.js': ['JAI-01', 'JAI-02', 'DEV-01'],
  'public/jnm/journal-ai-privacy.js': ['SEC-01', 'JAI-01', 'DEV-01'],
  'public/jnm/pages-config.js': ['SYS-02', 'DEV-01'],
  'public/line-report.webmanifest': ['SYS-01', 'DEV-01'],
  'public/media.html': ['OPS-02', 'OPS-04', 'DEV-01'],
  'public/menu-logout.js': ['SYS-02', 'DEV-01'],
  'public/message-search.html': ['OPS-02', 'DEV-01'],
  'public/mtalk-help.html': ['OPS-01', 'OPS-02', 'JAI-02', 'DEV-01'],
  'public/mtalk_journal_ai.html': ['JAI-02', 'DEV-01'],
  'public/mtalk_schedule.html': ['RSV-01', 'DEV-01'],
  'public/pages-config.js': ['SYS-01', 'SYS-02', 'DEV-01'],
  'public/petty_cash.html': ['OPS-03', 'DEV-01'],
  'public/pos-journal.html': ['JRN-02', 'JRN-05', 'JAI-04', 'DEV-01'],
  'public/reservation.html': ['RSV-01', 'DEV-01'],
  'public/reviews.html': ['REV-01', 'REV-02', 'DEV-01'],
  'public/room_settings.html': ['OPS-01', 'RSV-01', 'DEV-01'],
  'public/site-cache.js': ['DEV-01'],
  'public/system-map.html': ['ADM-02', 'DEV-01', 'DEV-04'],
  'public/system-map/environment.html': ['ADM-02', 'DEV-04'],
  'public/system-map/graph.html': ['ADM-02', 'DEV-04'],
}

export const EDGE_FUNCTION_HELP_CODES: Record<string, string[]> = {
  'admin-api': ['SYS-02', 'SAL-04', 'SAL-06', 'RSV-01', 'OPS-03', 'OPS-04', 'JRN-02', 'JRN-05', 'KNW-01', 'JAI-02', 'FCT-01', 'FCT-05', 'REV-01', 'ADM-01', 'ADM-03', 'DEV-02', 'SEC-01', 'SEC-03'],
  'ai-analyze': ['JAI-01', 'JAI-02', 'DEV-02', 'SEC-01'],
  'calendar-tomorrow-cron': ['RSV-01', 'OPS-01', 'DEV-02'],
  'chat-knowledge': ['OPS-01', 'KNW-02', 'JAI-02', 'DEV-02'],
  'chat-push': ['OPS-02', 'DEV-02', 'SEC-01'],
  'chat-search': ['OPS-02', 'DEV-02'],
  'foodcourt-forecast-cron': ['FCT-03', 'FCT-05', 'DEV-02'],
  'gmail-alert-cron': ['RSV-01', 'DEV-02'],
  'line-admin-webhook': ['ADM-01', 'DEV-02', 'SEC-01'],
  'line-webhook': ['SAL-01', 'SAL-02', 'RSV-01', 'OPS-03', 'KNW-02', 'DEV-02', 'SEC-01'],
  'pv-japan-alert-cron': ['FCT-06', 'DEV-02'],
  'receipt-midreport-cron': ['SAL-05', 'DEV-02'],
  'receipt-sheets-sync-cron': ['SAL-05', 'SAL-06', 'DEV-02'],
  'reservation-ai-cache-cron': ['RSV-01', 'JAI-04', 'DEV-02'],
  'reservation-today-cron': ['RSV-01', 'DEV-02'],
  'review-alert-cron': ['REV-01', 'REV-02', 'DEV-02'],
  'room-messages-retention-cron': ['OPS-01', 'SEC-01', 'SEC-03', 'DEV-02'],
  'tokyo-dome-events-cron': ['FCT-01', 'FCT-06', 'DEV-02'],
  'tokyo-dome-weekly-cron': ['FCT-04', 'FCT-06', 'DEV-02'],
  'weather-daily-cron': ['FCT-01', 'FCT-06', 'DEV-02'],
}

type SharedModuleRule = {
  pattern: RegExp
  codes: string[]
}

const SHARED_MODULE_RULES: SharedModuleRule[] = [
  { pattern: /^line_report_help_/, codes: ['DEV-04'] },
  { pattern: /^mtalk_help_/, codes: ['OPS-01', 'OPS-02', 'JAI-02', 'DEV-04'] },
  { pattern: /^(admin_access_log|admin_dashboard_link_auth|chat_admin_delegation|admin_utils|job_titles)\.ts$/, codes: ['ADM-01', 'ADM-03', 'SEC-01', 'DEV-02'] },
  { pattern: /^(admin_receipt_sales|manual_day_sales|manual_month_sales|sales_budget_allocation)\.ts$/, codes: ['SAL-04', 'SAL-05', 'SAL-06', 'DEV-02'] },
  { pattern: /^(bistrocavacava_sheet_push|clear_store_sheet_budget_tabs|daily_sales_import|google_service_account_auth|google_sheets_client|receipt_sheets_.*)\.ts$/, codes: ['SAL-05', 'SAL-06', 'DEV-02'] },
  { pattern: /^budget_entry_flow\.ts$/, codes: ['SAL-01', 'SAL-04', 'DEV-02'] },
  { pattern: /^(calendar_tomorrow_reminder|reservation_.*|mtalk_schedule_register)\.ts$/, codes: ['RSV-01', 'JAI-04', 'DEV-02'] },
  // M-talkの売上取込は、チャット全般ではなく過去売上の一括取込として索引する。
  // 汎用の mtalk_.* より前に置くこと（helpCodesForSharedModule は先勝ち）。
  { pattern: /^mtalk_daily_sales_import\.ts$/, codes: ['SAL-05', 'SAL-07', 'OPS-01', 'DEV-02'] },
  { pattern: /^(chat_.*|mtalk_.*|web_push)\.ts$/, codes: ['OPS-01', 'OPS-02', 'RSV-01', 'JAI-02', 'DEV-02'] },
  { pattern: /^competitor_review_context\.ts$/, codes: ['REV-01', 'REV-02', 'DEV-02'] },
  { pattern: /^(foodcourt_.*|tokyo_dome_schedule|weather_daily)\.ts$/, codes: ['FCT-01', 'FCT-02', 'FCT-03', 'FCT-04', 'FCT-05', 'FCT-06', 'DEV-02'] },
  { pattern: /^groq_model\.ts$/, codes: ['JAI-01', 'FCT-02', 'DEV-02'] },
  { pattern: /^japanese_holidays\.ts$/, codes: ['SAL-04', 'FCT-03', 'DEV-02'] },
  { pattern: /^(journal_.*|pos_journal.*|paged_row_scan)\.ts$/, codes: ['JRN-02', 'JRN-03', 'JRN-04', 'JRN-05', 'JAI-01', 'JAI-02', 'JAI-03', 'JAI-04', 'SEC-03', 'DEV-02'] },
  { pattern: /^(knowledge_.*)\.ts$/, codes: ['KNW-01', 'KNW-02', 'JAI-01', 'DEV-02'] },
  { pattern: /^(auto_link_room|line_admin_webhook|line_user_approval|room_config_link|room_hard_delete)\.ts$/, codes: ['ADM-01', 'OPS-01', 'SEC-01', 'DEV-02'] },
  { pattern: /^(line_client|line_display_names|line_flex_messages|line_media_store|line_room_.*|line_search_bot|line_webhook_delivery_log|search_help_guide)\.ts$/, codes: ['SAL-01', 'OPS-02', 'OPS-04', 'ADM-01', 'DEV-02'] },
  { pattern: /^marugo_group_stores\.ts$/, codes: ['SYS-01', 'DEV-02'] },
  { pattern: /^petty_cash_flow\.ts$/, codes: ['OPS-03', 'DEV-02'] },
  { pattern: /^(receipt_.*|store_receipt.*)\.ts$/, codes: ['SAL-02', 'SAL-03', 'SAL-04', 'SAL-05', 'SAL-06', 'OPS-03', 'DEV-02'] },
]

export function helpCodesForSharedModule(filename: string): string[] {
  const name = String(filename ?? '').trim()
  const match = SHARED_MODULE_RULES.find((rule) => rule.pattern.test(name))
  return match?.codes ?? []
}

export function helpCodesForAuxiliaryCode(path: string): string[] {
  const value = String(path ?? '').trim()
  if (!value) return []
  if (value.startsWith('google-apps-script/')) return ['SAL-06', 'DEV-05']
  if (value.startsWith('cloudflare-worker/')) return ['DEV-05', 'SEC-01']
  if (value.startsWith('ocr-bridge/')) return ['SAL-02', 'DEV-05']
  if (value.startsWith('src/') || value === 'schema.sql') return ['DEV-05']
  if (value === 'scripts/parse-pos-journal.py') return ['JRN-02', 'JRN-05', 'DEV-04']
  if (
    value.startsWith('scripts/setup-gas-') ||
    value.includes('bistrocavacava') ||
    value.includes('budget') ||
    value.includes('dummy-sales') ||
    value.includes('purge-sales') ||
    value.includes('migrate-')
  ) return ['SAL-04', 'SAL-06', 'DEV-04', 'SEC-01']
  if (value === 'scripts/import-profile-icons.mjs') return ['OPS-01', 'DEV-04']
  if (value.startsWith('scripts/')) return ['DEV-04']
  return []
}

export function helpCodesForApiPath(path: string): string[] {
  const value = String(path ?? '').trim()
  if (!value.startsWith('/')) return []
  if (value.startsWith('/auth/')) return ['SYS-02', 'SEC-01', 'DEV-02']
  if (value.startsWith('/access/')) return ['ADM-01', 'ADM-02', 'DEV-02']
  if (value.startsWith('/chat-admin')) return ['ADM-01', 'ADM-03', 'OPS-01', 'DEV-02']
  if (value.startsWith('/chat-schedule')) return ['RSV-01', 'OPS-01', 'DEV-02']
  if (value.startsWith('/chat-media')) return ['OPS-02', 'OPS-04', 'DEV-02']
  if (value.startsWith('/chat-room') || value.startsWith('/room-config')) return ['OPS-01', 'DEV-02']
  if (value.startsWith('/messages/search')) return ['OPS-02', 'DEV-02']
  if (value.startsWith('/calendar-events/search')) return ['OPS-02', 'RSV-01', 'DEV-02']
  if (value.startsWith('/reservations') || value.startsWith('/gmail')) return ['RSV-01', 'JAI-04', 'DEV-02']
  if (value.startsWith('/petty-cash')) return ['OPS-03', 'DEV-02']
  if (value.startsWith('/pos-journals/knowledge')) return ['KNW-01', 'KNW-02', 'DEV-02']
  if (value.startsWith('/pos-journals/product') || value.startsWith('/pos-journals/cohort')) return ['JAI-03', 'DEV-02']
  if (
    value.startsWith('/pos-journals/ai') ||
    value.startsWith('/pos-journals/report-ai') ||
    value.startsWith('/pos-journals/chat-pdf') ||
    value.startsWith('/pos-journals/sales-forecasts')
  ) return ['JAI-01', 'JAI-02', 'JAI-04', 'JAI-05', 'DEV-02']
  if (value.startsWith('/pos-journals')) return ['JRN-01', 'JRN-02', 'JRN-03', 'JRN-04', 'JRN-05', 'DEV-02']
  if (
    value.startsWith('/foodcourt/ai-distillation') ||
    value.startsWith('/foodcourt/ai-loop') ||
    value.startsWith('/foodcourt/ai-rag') ||
    value.startsWith('/foodcourt/evolution') ||
    value.startsWith('/foodcourt/prompt-') ||
    value.startsWith('/foodcourt/monthly-retrospective')
  ) return ['FCT-02', 'FCT-05', 'DEV-02']
  if (value.startsWith('/foodcourt/dome-weekly') || value.startsWith('/foodcourt/events/attendance')) {
    return ['FCT-01', 'FCT-04', 'FCT-06', 'DEV-02']
  }
  if (value.startsWith('/foodcourt')) return ['FCT-01', 'FCT-02', 'FCT-03', 'FCT-04', 'DEV-02']
  if (value.startsWith('/weather')) return ['FCT-01', 'FCT-06', 'DEV-02']
  if (value.startsWith('/receipts/competitors')) return ['REV-02', 'DEV-02']
  if (value.startsWith('/receipts/store-reviews')) return ['REV-01', 'DEV-02']
  if (
    value.startsWith('/receipts/sales-manual') ||
    value.startsWith('/receipts/daily-receipts-import') ||
    value.startsWith('/receipts/sheets-pilot') ||
    value.startsWith('/receipts/analysis-prompt') ||
    value.startsWith('/receipts/webhook-status') ||
    value.startsWith('/receipts/store-receipt-phones')
  ) return ['SAL-05', 'SAL-06', 'ADM-01', 'DEV-02']
  if (value.startsWith('/receipts') || value.startsWith('/analytics')) return ['SAL-02', 'SAL-04', 'SAL-05', 'DEV-02']
  if (value.startsWith('/media') || value.startsWith('/documents')) return ['OPS-02', 'OPS-04', 'DEV-02']
  if (
    value.startsWith('/settings') ||
    value.startsWith('/permissions') ||
    value.startsWith('/rooms') ||
    value.startsWith('/state') ||
    value.startsWith('/room-settings')
  ) return ['ADM-01', 'ADM-03', 'OPS-01', 'DEV-02']
  if (value.startsWith('/ai-usage') || value.startsWith('/usage')) return ['ADM-02', 'DEV-02']
  if (value.startsWith('/actions/run-summary') || value.startsWith('/actions/test-receipt-report')) {
    return ['SAL-05', 'ADM-01', 'DEV-02']
  }
  if (value === '/health' || value === '/verify') return ['DEV-02', 'SEC-01']
  return []
}

export function extractStaticApiPaths(source: string): string[] {
  const paths = new Set<string>()
  const pattern = /["'`](\/[A-Za-z0-9][^"'`\s]*)["'`]/g
  for (const match of String(source ?? '').matchAll(pattern)) {
    const raw = String(match[1] ?? '')
      .replace(/[),;]+$/g, '')
      .replace(/\\\//g, '/')
    if (
      raw.startsWith('//') ||
      raw.includes('${') ||
      raw.includes('<') ||
      raw.includes('>') ||
      raw.includes('\\') ||
      /\.(html|js|css|json|svg|png|jpg|jpeg|webp)$/i.test(raw)
    ) continue
    paths.add(raw)
  }
  return [...paths].sort()
}
