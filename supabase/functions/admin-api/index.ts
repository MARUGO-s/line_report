import "jsr:@supabase/functions-js/edge-runtime.d.ts"
// deploy re-trigger marker (2026-07-09)
import {
  importDailyReceiptsOverwrite,
  importManualMonthSalesOverwrite,
  clearDailyReceiptsForMonth,
  parseMonthlyDailySalesWorkbook,
  resolveReceiptTableForStore,
  countExistingReceiptsForDates,
  type DailySalesImportEntry,
  type ManualMonthImportEntry,
} from "../_shared/daily_sales_import.ts"
import { isJobTitleLabel, JOB_TITLE_OPTIONS, jobTitleSortRank } from "../_shared/job_titles.ts"
import {
  isMarugoGroupStoreLabel,
  MARUGO_GROUP_STORE_OPTIONS,
} from "../_shared/marugo_group_stores.ts"
import {
  allocateDailyBudgetsForMonth,
  enumerateMonthDates,
  mergeStoreClosedDateLists,
  parseStoreClosedDatesForMonth,
  type SalesBudgetAllocationWeights,
} from "../_shared/sales_budget_allocation.ts"
import { fetchJapaneseHolidayMap } from "../_shared/japanese_holidays.ts"
import { EXPENSE_RECEIPT_PROMPT_ADDITION, RECEIPT_VISION_SYSTEM_PROMPT_BASE, STORE_RECEIPT_PROMPT_MAX_CHARS } from "../_shared/receipt_prompt.ts"
import { GROQ_VISION_BASE64_MAX_BYTES } from "../_shared/receipt_types.ts"
import { analyzeExpenseReceiptWithGroqScout, analyzeLineImageWithGroqScout, type LineImageVisionUsage } from "../_shared/receipt_vision.ts"
import { extractExpenseFromReceipt } from "../_shared/petty_cash_flow.ts"
import {
  answerFoodCourtQuestion,
  FOODCOURT_ANALYSIS_AI_VERSION,
  resolveFoodCourtDailyAnalysisVersion,
  generateFoodCourtDailySummary,
  generateFoodCourtPeriodSummary,
  generateFoodCourtWeeklyReport,
  fcSalesDate,
} from "../_shared/foodcourt_compare.ts"
import {
  pushLineMessagesToTarget,
  resolveChannelAccessToken,
} from "../_shared/line_client.ts"
import {
  fetchManualMonthSales,
  fetchManualMonthSalesMapForStore,
  upsertManualMonthSalesEntries,
} from "../_shared/manual_month_sales.ts"
import {
  upsertManualDayBudgetEntries,
  upsertManualDaySalesEntries,
} from "../_shared/manual_day_sales.ts"
import {
  RECEIPT_STORE_PARTITION_UNKNOWN,
  toReceiptStorePartitionKey,
} from "../_shared/receipt_report_aggregate.ts"
import { resolveReceiptNamePartitionKey } from "../_shared/receipt_store_name_resolve.ts"
import {
  fetchAnalyticsMonthly as fetchStoreAnalyticsMonthly,
  fetchManualMonthsForYearState as fetchStoreManualMonthsForYearState,
  fetchReceiptDailyAggForRange,
  fetchReceiptSalesState as fetchStoreReceiptSalesState,
  fetchReceiptStoreOptions as fetchStorePartitionReceiptOptions,
  fetchReceiptWebhookStatus,
  upsertManualMonthEntries as upsertStoreManualMonthEntries,
  upsertReceiptSalesBudget as upsertStoreReceiptSalesBudget,
  updateStoreReceiptPhones,
} from "../_shared/admin_receipt_sales.ts"
import {
  deactivateCompetitorPlace,
  deactivateStoreReviewPlace,
  ensureStoreReviewProfile,
  fetchCompetitorReviewContext,
  fetchStoreReviewContext,
  nearbySearchGooglePlaces,
  refreshCompetitorReviews,
  refreshStoreReview,
  searchStoreReviewPlaces,
  upsertCompetitorPlace,
  upsertStoreReviewPlace,
} from "../_shared/competitor_review_context.ts"
import { isReceiptRoomAutoLinkEnabled } from "../_shared/auto_link_room.ts"
import {
  authenticateAdminDashboardSessionToken,
  exchangeAdminDashboardLoginLinkToken,
  exchangeRoomConfigLoginLink,
  hashRoomConfigPassword,
  issueAdminDashboardLoginLinkToken,
  issueAdminDashboardSessionToken,
  REUSABLE_VIEW_LINK_TTL_SEC,
  revokeAdminDashboardSessionToken,
  revokeAllAdminDashboardAuthTokens,
  ROOM_CONFIG_SCOPE,
} from "../_shared/admin_dashboard_link_auth.ts"
import { fetchWeatherDailyState } from "../_shared/weather_daily.ts"
import {
  fetchLineRoomCalendarSearchState,
  fetchLineRoomMessageSearchState,
} from "../_shared/line_room_message_search.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import JSZip from "https://esm.sh/jszip@3.10.1"

const ADMIN_SURFACE_LEGACY = "legacy"
const ADMIN_SURFACE_LINE_REPORT = "line_report"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token, x-admin-surface",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
}

const FOODCOURT_WEEKLY_REPORT_PAGE_BASE = "https://marugo-s.github.io/line_report/foodcourt-weekly-report.html"

function weeklyReportHtml(report: string): string {
  const escape = (value: string) => value.replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] ?? c))
  return `<article class="weekly-report-content">${escape(report).replace(/\n/g, "<br>")}</article>`
}

async function buildFoodCourtWeeklyReportLink(supabase: ReturnType<typeof createClient>, storeKey: string, weekStart: string): Promise<string> {
  // 閲覧専用（設定変更なし）のレポートリンクなので、単一使用・期限つきにせず何度でも開けるようにする。
  const issued = await issueAdminDashboardLoginLinkToken(
    supabase,
    { source: "line_foodcourt_weekly", store_partition_key: storeKey, reusable: true },
    { ttlSeconds: REUSABLE_VIEW_LINK_TTL_SEC },
  )
  const params = new URLSearchParams({ store_key: storeKey, week_start: weekStart, from: "line", lt: issued.token })
  return `${FOODCOURT_WEEKLY_REPORT_PAGE_BASE}?${params.toString()}`
}

/**
 * ルーム×週で1回だけLINE送信を許可する（先に予約行を確保してから送信する方式）。
 * foodcourt-weekly-report-cron は5分おきに±5分の許容誤差で起動するため、分ぴったりの設定
 * （例: minute=0）だと同一時間帯に複数回一致し、二重送信が起きる。この関数で吸収する。
 */
async function reserveFoodCourtWeeklyReportSend(
  supabase: ReturnType<typeof createClient>,
  roomId: string,
  weekStart: string,
): Promise<boolean> {
  const { error } = await supabase
    .from("foodcourt_weekly_report_sends")
    .insert({ room_id: roomId, week_start: weekStart })
  if (error) {
    if (String((error as { code?: string }).code ?? "") === "23505") return false
    console.error("reserveFoodCourtWeeklyReportSend insert failed:", error.message)
    return false
  }
  return true
}

function buildWeeklyReportFlexMessage(weekStart: string, weekEnd: string, reportUrl: string): Record<string, unknown> {
  return {
    type: "flex",
    altText: `📊 フードコート週次レポート（${weekStart}〜${weekEnd}）を作成しました。`,
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#1a3a5c",
        paddingAll: "16px",
        contents: [
          { type: "text", text: "📊 フードコート週次レポート", color: "#ffffff", size: "sm", weight: "bold" },
          { type: "text", text: `${weekStart}（月）〜 ${weekEnd}（日）`, color: "#a8c4e0", size: "xs", margin: "xs" },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "16px",
        contents: [
          {
            type: "box", layout: "horizontal", spacing: "sm",
            contents: [
              { type: "text", text: "週売上合計", color: "#666666", size: "xs", flex: 1 },
              { type: "text", text: "客数・客単価", color: "#666666", size: "xs", flex: 1 },
              { type: "text", text: "週平均売上順位", color: "#666666", size: "xs", flex: 1 },
            ],
          },
          { type: "text", text: "Webで詳細・グラフを確認できます", color: "#888888", size: "xxs", margin: "md", wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        contents: [
          {
            type: "button",
            action: { type: "uri", label: "📈 レポートを開く", uri: reportUrl },
            style: "primary",
            color: "#1a3a5c",
            height: "sm",
          },
        ],
      },
    },
  }
}

type AppError = {
  status: number
  message: string
}

type MessageCleanupTiming = "after_each_delivery" | "end_of_day"
type LastDeliverySummaryMode = "independent" | "daily_rollup"
type MessageRetentionDays = 0 | 60 | 120 | 180 | 365 | 730 | 1095
type StorageUsageTableStat = {
  table_name: string
  size_bytes: number
  size_pretty: string
}
type StorageUsageStats = {
  database_size_bytes: number
  database_size_pretty: string
  managed_tables_total_bytes: number
  managed_tables_total_pretty: string
  managed_tables: StorageUsageTableStat[]
}
type MediaType = "image" | "video" | "audio" | "file"
type MediaListRow = {
  id: number
  message_id: string | null
  line_message_id: string
  room_id: string
  room_name: string | null
  user_id: string | null
  sender_display_name: string | null
  media_type: MediaType
  storage_bucket: string
  storage_path: string
  original_file_name: string | null
  mime_type: string | null
  file_size_bytes: number
  content_preview: string | null
  created_at: string
}
type MediaMessageContext = {
  before_text: string | null
  before_at: string | null
  after_text: string | null
  after_at: string | null
}
type DocumentMimeType =
  | "text/plain"
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
type DocumentListRow = {
  id: number
  room_id: string | null
  room_name: string | null
  storage_bucket: string
  storage_path: string
  original_file_name: string
  mime_type: DocumentMimeType
  file_size_bytes: number
  extracted_text: string
  source: string
  created_at: string
  updated_at: string
}
type DocumentViewerPermissionState = {
  document_id: number
  mode: "public" | "restricted"
  allowed_user_ids: string[]
}
type LineUserPermissionRow = {
  line_user_id: string
  display_name: string | null
  is_active: boolean
  can_message_search: boolean
  can_library_search: boolean
  can_calendar_create: boolean
  can_calendar_update: boolean
  can_calendar_view: boolean
  can_media_access: boolean
  excluded_message_search_room_ids: string[]
  assigned_store: string | null
  assigned_job_title: string | null
  updated_at: string
}

const MEDIA_SIGNED_URL_EXPIRES_SEC = 60 * 30
const MEDIA_LIST_DEFAULT_LIMIT = 24
const MEDIA_LIST_MAX_LIMIT = 100
const MEDIA_STORAGE_CAP_BYTES = 2 * 1024 * 1024 * 1024
const DEFAULT_MEDIA_UPLOAD_MAX_MB = 10
const MAX_MEDIA_UPLOAD_MAX_MB = 20
const LINE_DOCUMENT_BUCKET = "line-documents"
const DOCUMENT_LIST_DEFAULT_LIMIT = 20
const DOCUMENT_LIST_MAX_LIMIT = 100
const DOCUMENT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024
const DOCUMENT_EXTRACT_MAX_CHARS = 250000
const DOCUMENT_PREVIEW_MAX_CHARS = 240
const DOCUMENT_PDF_EXTRACT_MAX_PAGES = 120
const DOCUMENT_TEXT_BINARY_RATIO_MAX = 0.08
const PETTY_CASH_RECEIPT_IMAGE_BUCKET = "line-media"
const PETTY_CASH_RECEIPT_IMAGE_MAX_BYTES = GROQ_VISION_BASE64_MAX_BYTES
const GROQ_RECEIPT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
const PDFJS_MODULE_URL = "https://esm.sh/pdfjs-dist@4.10.38/build/pdf.mjs"
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/** OOXML SpreadsheetML — explicit NS first; fall back when DOM omits default NS or `*` behaves oddly. */
const OFFICE_SPREADSHEETML_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

function getSheetElementsLive(root: Document | Element, localName: string): HTMLCollectionOf<Element> {
  const byNs = root.getElementsByTagNameNS(OFFICE_SPREADSHEETML_NS, localName)
  if (byNs.length > 0) return byNs
  const byStar = root.getElementsByTagNameNS("*", localName)
  if (byStar.length > 0) return byStar
  return root.getElementsByTagName(localName) as HTMLCollectionOf<Element>
}
const DOCUMENT_ARCHIVE_MAX_XML_ENTRIES = 120
const DOCUMENT_ARCHIVE_MAX_ENTRIES = 400
const DOCUMENT_ARCHIVE_TOTAL_UNCOMPRESSED_MAX_BYTES = 80 * 1024 * 1024
const DOCUMENT_ARCHIVE_SINGLE_ENTRY_MAX_BYTES = 24 * 1024 * 1024
const DOCUMENT_ARCHIVE_MAX_COMPRESSION_RATIO = 40
const DOCUMENT_ARCHIVE_ENTRY_MAX_BYTES = 8 * 1024 * 1024
const ADMIN_RATE_LIMIT_DEFAULT_WINDOW_MS = 60 * 1000
const ADMIN_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 180
const ADMIN_RATE_LIMIT_UPLOAD_WINDOW_MS = 60 * 1000
const ADMIN_RATE_LIMIT_UPLOAD_MAX_REQUESTS = 12
const USER_PERMISSION_LIST_DEFAULT_LIMIT = 100
const USER_PERMISSION_LIST_MAX_LIMIT = 300
/** Max rows fetched before in-memory sort (pagination applied after sort). */
const USER_PERMISSION_SORT_FETCH_CAP = 10000
const RESERVATION_SEARCH_DEFAULT_LIMIT = 100
const RESERVATION_SEARCH_MAX_LIMIT = 200
const RESERVATION_SEARCH_SOURCE_FETCH_CAP = 240
const RESERVATION_CUSTOMER_HISTORY_FETCH_CAP = 10000
const RESERVATION_CANCELLATION_RE = /(キャンセル|取消|取り消し|cancel(?:led|ed)?)/i

type LineUserPermissionSortable = {
  display_name?: string | null
  line_user_id?: string | null
  assigned_job_title?: string | null
}

function userPermissionDisplaySortKey(row: LineUserPermissionSortable): string {
  const name = String(row.display_name ?? "").trim()
  if (name) return name.normalize("NFKC")
  return String(row.line_user_id ?? "").trim().normalize("NFKC")
}

function sortLineUserPermissionsForAdminDisplay<T extends LineUserPermissionSortable>(rows: T[]): T[] {
  const collator = new Intl.Collator("ja-JP", { sensitivity: "base", usage: "sort" })
  return [...rows].sort((a, b) => {
    const ra = jobTitleSortRank(a.assigned_job_title)
    const rb = jobTitleSortRank(b.assigned_job_title)
    if (ra !== rb) return ra - rb
    const sa = userPermissionDisplaySortKey(a)
    const sb = userPermissionDisplaySortKey(b)
    const c = collator.compare(sa, sb)
    if (c !== 0) return c
    return collator.compare(
      String(a.line_user_id ?? "").trim(),
      String(b.line_user_id ?? "").trim(),
    )
  })
}

type MediaUsageStats = {
  total_files: number
  total_bytes: number
}
type GmailLinkedAccountState = {
  enabled: boolean
  configured: boolean
  email_address: string | null
  history_id: string | null
  checked_at: string
  error: string | null
}
type PdfJsTextItem = {
  str?: unknown
}
type PdfJsTextContent = {
  items?: unknown
}
type PdfJsPage = {
  getTextContent: () => Promise<PdfJsTextContent>
  cleanup?: () => void
}
type PdfJsDocument = {
  numPages: number
  getPage: (pageNumber: number) => Promise<PdfJsPage>
  cleanup?: () => void
  destroy?: () => void | Promise<void>
}
type PdfJsLoadingTask = {
  promise: Promise<PdfJsDocument>
  destroy?: () => void | Promise<void>
}
type PdfJsModule = {
  getDocument: (source: Record<string, unknown>) => PdfJsLoadingTask
}
type OfficeZipEntry = {
  name: string
  dir: boolean
  async: (type: "string") => Promise<string>
}

let cachedPdfJsModulePromise: Promise<PdfJsModule | null> | null = null

// ルーム・セルフ設定で「ルームのユーザーが編集してよい安全なサブセット」(機能ON/OFF＋予約通知時刻)。
// bot_access_approved(承認) / receipt_report_store_partition_key(集計店舗) / is_enabled / room_name /
// パスワード列 などの機微フィールドはここに含めない＝room スコープからは絶対に変更させない。
const ROOM_CONFIG_SAFE_BOOL_FIELDS = [
  "bot_reply_enabled", "bot_reply_hard_mute_enabled",
  "message_search_enabled", "message_search_library_enabled",
  "send_room_summary", "receive_overall_summary_enabled",
  "media_file_access_enabled", "image_analysis_reply_enabled",
  "receipt_reply_executive_detail_enabled",
  "receipt_correction_reply_enabled", "non_receipt_image_reply_enabled",
  "media_save_enabled", "budget_entry_enabled", "petty_receipt_analysis_enabled",
  "receipt_midreport_enabled", "receipt_monthend_report_enabled",
  "gmail_reservation_alert_enabled", "today_reservation_alert_enabled",
  "calendar_tomorrow_reminder_enabled", "calendar_ai_auto_create_enabled",
  "calendar_silent_auto_register_enabled", "calendar_low_confidence_confirm_reply_enabled",
  "calendar_registration_reply_enabled", "dome_weekly_enabled",
  "review_alert_enabled", "foodcourt_weekly_report_enabled",
]
const ROOM_CONFIG_SAFE_SELECT = "room_id,room_name,room_config_access_enabled," +
  ROOM_CONFIG_SAFE_BOOL_FIELDS.join(",") +
  ",today_reservation_alert_hour,today_reservation_alert_minute" +
  ",dome_weekly_dow,dome_weekly_hour,dome_weekly_minute" +
  ",foodcourt_weekly_dow,foodcourt_weekly_hour,foodcourt_weekly_minute" +
  ",review_alert_hour,review_alert_minute" +
  ",gmail_alert_interval_minutes"

// 予約メール通知(gmail-alert-cron)の配信間隔（分）として許可する値。
// 1(既定・null扱い)=毎分チェック(リアルタイム)。それ以外は「N分おきにまとめて配信」。
const GMAIL_ALERT_INTERVAL_MINUTES_ALLOWED = new Set([1, 15, 30, 60, 120, 180, 360, 720, 1440])

function buildRoomConfigSafePayload(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of ROOM_CONFIG_SAFE_BOOL_FIELDS) {
    if (f in body) out[f] = body[f] === true || body[f] === "true" || body[f] === 1
  }
  if ("today_reservation_alert_hour" in body) {
    const h = Number(body.today_reservation_alert_hour)
    out.today_reservation_alert_hour = (Number.isInteger(h) && h >= 0 && h <= 23) ? h : null
  }
  if ("today_reservation_alert_minute" in body) {
    const m = Number(body.today_reservation_alert_minute)
    out.today_reservation_alert_minute = (Number.isInteger(m) && m >= 0 && m <= 59) ? m : null
  }
  // 東京ドーム週次配信の曜日・時刻（NULL許容＝既定 土6/10時/0分）
  if ("dome_weekly_dow" in body) {
    const v = Number(body.dome_weekly_dow)
    out.dome_weekly_dow = (Number.isInteger(v) && v >= 0 && v <= 6) ? v : null
  }
  if ("dome_weekly_hour" in body) {
    const v = Number(body.dome_weekly_hour)
    out.dome_weekly_hour = (Number.isInteger(v) && v >= 0 && v <= 23) ? v : null
  }
  if ("dome_weekly_minute" in body) {
    const v = Number(body.dome_weekly_minute)
    out.dome_weekly_minute = (Number.isInteger(v) && v >= 0 && v <= 59) ? v : null
  }
  // フードコート週次レポートの曜日・時刻（NULL許容＝既定 月曜1/9時/0分）
  if ("foodcourt_weekly_dow" in body) {
    const v = Number(body.foodcourt_weekly_dow)
    out.foodcourt_weekly_dow = (Number.isInteger(v) && v >= 0 && v <= 6) ? v : null
  }
  if ("foodcourt_weekly_hour" in body) {
    const v = Number(body.foodcourt_weekly_hour)
    out.foodcourt_weekly_hour = (Number.isInteger(v) && v >= 0 && v <= 23) ? v : null
  }
  if ("foodcourt_weekly_minute" in body) {
    const v = Number(body.foodcourt_weekly_minute)
    out.foodcourt_weekly_minute = (Number.isInteger(v) && v >= 0 && v <= 59) ? v : null
  }
  // 口コミ新着通知の配信時刻（毎日・NULL許容＝既定 8時/10分）
  if ("review_alert_hour" in body) {
    const v = Number(body.review_alert_hour)
    out.review_alert_hour = (Number.isInteger(v) && v >= 0 && v <= 23) ? v : null
  }
  if ("review_alert_minute" in body) {
    const v = Number(body.review_alert_minute)
    out.review_alert_minute = (Number.isInteger(v) && v >= 0 && v <= 59) ? v : null
  }
  // 予約メール通知の配信間隔（分）。NULL/1=リアルタイム（毎分チェック）。
  if ("gmail_alert_interval_minutes" in body) {
    const v = Number(body.gmail_alert_interval_minutes)
    out.gmail_alert_interval_minutes = GMAIL_ALERT_INTERVAL_MINUTES_ALLOWED.has(v) ? v : null
  }
  return out
}

// room_summary_settings の行から password ハッシュを除き、設定済みかの boolean(room_config_password_set)
// に置き換える（ハッシュをフロントへ出さない）。
function stripRoomConfigSecret<T extends Record<string, unknown>>(row: T | null): T | null {
  if (!row || typeof row !== "object") return row
  const rest = { ...(row as Record<string, unknown>) }
  const hash = rest.room_config_password_hash
  delete rest.room_config_password_hash
  rest.room_config_password_set = !!String(hash ?? "")
  return rest as unknown as T
}

// 会場（東京ドーム）のイベントを、レポートの期間に合わせて取得する。
// マルゴSは東京ドーム内フードコートのため、客数増減と会場イベントが相関する。
// 対象はマルゴS（store_key が marugoS）のみ。期間はレポート最古〜最新＋45日先（予定先取り）。
async function loadVenueEventsForReports(
  supabase: ReturnType<typeof createClient>,
  storeKey: string,
  reports: Array<Record<string, unknown>>,
): Promise<Array<{ event_date: string; title: string; category: string; venue: string; is_japan: boolean; note: string; expected_attendance: number | null }>> {
  if (String(storeKey ?? "").trim().toLowerCase() !== "marugos") return []
  const dates: string[] = []
  for (const r of (Array.isArray(reports) ? reports : [])) {
    const rd = String((r as { report_date?: unknown }).report_date ?? "").slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(rd)) dates.push(rd)
  }
  dates.sort()
  // レポートが無い場合でも、当月前後の予定を返せるよう today を基準にフォールバック。
  // イベント一覧（ページ側）として過去〜先まで広めに返す（過去90日〜先400日 と レポート期間の和集合）。
  const todayIso = new Date().toISOString().slice(0, 10)
  const minDate = dates[0] ?? todayIso
  const maxBase = dates[dates.length - 1] ?? todayIso
  const loCand = [addDaysIso(minDate, -7), addDaysIso(todayIso, -90)].sort()
  const hiCand = [addDaysIso(maxBase > todayIso ? maxBase : todayIso, 45), addDaysIso(todayIso, 400)].sort()
  const lo = loCand[0]
  const hi = hiCand[hiCand.length - 1]
  const { data: gamesData } = await supabase
    .from("giants_game_results")
    .select("game_date, game_result, opponent, venue, attendance, game_score, score_margin, game_duration, start_time")
    .order("game_date", { ascending: true })
    
  interface GiantsGameRow {
    game_date: string
    game_result: string | null
    opponent: string
    venue: string
    attendance: number | null
    game_score: string | null
    score_margin: number | null
    game_duration: string | null
    start_time: string | null
  }
  const gamesMap: Record<string, GiantsGameRow> = {}
  const streakBeforeMap: Record<string, number> = {}
  const streakAfterMap: Record<string, number> = {}
  let currentStreak = 0
  if (gamesData && Array.isArray(gamesData)) {
    for (const g of gamesData) {
      const d = String(g.game_date ?? "").slice(0, 10)
      if (!d) continue
      
      gamesMap[d] = g as unknown as GiantsGameRow
      streakBeforeMap[d] = currentStreak
      
      const res = g.game_result
      if (res === "○") {
        if (currentStreak > 0) {
          currentStreak += 1
        } else {
          currentStreak = 1
        }
      } else if (res === "●") {
        if (currentStreak < 0) {
          currentStreak -= 1
        } else {
          currentStreak = -1
        }
      } else if (res === "△") {
        currentStreak = 0
      }
      
      streakAfterMap[d] = currentStreak
    }
  }

  let data: any[] = []
  const firstTry = await supabase
    .from("tokyo_dome_events")
    .select("event_date, title, category, venue, is_japan, note, expected_attendance, start_time, game_duration, game_result, game_score, score_margin")
    .gte("event_date", lo)
    .lte("event_date", hi)
    .order("event_date", { ascending: true })
    .limit(600)
  if (!firstTry.error && Array.isArray(firstTry.data)) {
    data = firstTry.data
  } else {
    const secondTry = await supabase
      .from("tokyo_dome_events")
      .select("event_date, title, category, venue, is_japan, note, expected_attendance")
      .gte("event_date", lo)
      .lte("event_date", hi)
      .order("event_date", { ascending: true })
      .limit(600)
    if (secondTry.error || !Array.isArray(secondTry.data)) return []
    data = secondTry.data
  }
  return data.map((e) => {
    const dateStr = String((e as { event_date?: unknown }).event_date ?? "").slice(0, 10)
    const isBaseball = String((e as { category?: unknown }).category ?? "") === "プロ野球"
    const g = isBaseball ? gamesMap[dateStr] : null
    
    return {
      event_date: dateStr,
      title: String((e as { title?: unknown }).title ?? ""),
      category: String((e as { category?: unknown }).category ?? ""),
      venue: String((e as { venue?: unknown }).venue ?? "tokyo-dome"),
      is_japan: (e as { is_japan?: unknown }).is_japan === true,
      note: String((e as { note?: unknown }).note ?? ""),
      expected_attendance: g
        ? (g.attendance != null ? Number(g.attendance) : null)
        : ((e as { expected_attendance?: unknown }).expected_attendance == null
          ? null
          : Number((e as { expected_attendance?: unknown }).expected_attendance)),
      start_time: g ? g.start_time : ((e as { start_time?: unknown }).start_time ? String((e as { start_time?: unknown }).start_time) : null),
      game_duration: g ? g.game_duration : ((e as { game_duration?: unknown }).game_duration ? String((e as { game_duration?: unknown }).game_duration) : null),
      game_result: g ? g.game_result : ((e as { game_result?: unknown }).game_result ? String((e as { game_result?: unknown }).game_result) : null),
      game_score: g ? g.game_score : ((e as { game_score?: unknown }).game_score ? String((e as { game_score?: unknown }).game_score) : null),
      score_margin: g
        ? (g.score_margin != null ? Number(g.score_margin) : null)
        : ((e as { score_margin?: unknown }).score_margin == null ? null : Number((e as { score_margin?: unknown }).score_margin)),
      streak_before: streakBeforeMap[dateStr] ?? 0,
      streak_after: streakAfterMap[dateStr] ?? 0,
    }
  }).filter((e) => e.event_date && e.title)
}

// 基準店(marugoS)の日次「正本」客数/売上/組数。
// 取得元は売上分析(/receipts/sales = fetchReceiptSalesState)と同一の日次集計
// 「受領レシート集計(line_receipt__marugoS)＋日次手入力上書き(line_sales_manual_day)」で一本化（唯一の正本）。
// 以前は foodcourt_base_daily ビューを読んでいたが、ビューは手入力の売上を反映せず・客数サニタイズも無いため
// 売上分析とズレる余地があった。共有関数 fetchReceiptDailyAggForRange に載せ替えて差異を解消。
// 日報(foodcourt_tenant_reports)が投稿されない日（例 6/14 等）も含めて全日返す＝取りこぼし解消。
async function loadBaseDailyForReports(
  supabase: ReturnType<typeof createClient>,
  storeKey: string,
): Promise<Array<{ date: string; guests: number | null; sales: number | null; party: number | null; has_manual: boolean; attendance: number | null }>> {
  if (String(storeKey ?? "").trim().toLowerCase() !== "marugos") return []
  const todayIso = new Date().toISOString().slice(0, 10)
  const lo = addDaysIso(todayIso, -400)
  const hi = addDaysIso(todayIso, 1)
  const rows = await fetchReceiptDailyAggForRange(supabase, storeKey, lo, hi)
  // 売上(sales)は税抜net＝日報と一致させる正本。手入力上書きは売上分析と同じく総売上(gross)側にのみ効くため、
  // net はレシート集計のまま（受領レシートが無い手入力のみの日は net=null＝当店売上未確定として扱う）。
  const base = rows.map((r) => ({
    date: r.date,
    guests: (r.manual_guest || r.receipt_count > 0) ? r.guest_count : null,
    sales: r.receipt_count > 0 ? r.net_sales_yen : null,
    party: (r.manual_party || r.receipt_count > 0) ? r.party_count : null,
    has_manual: r.manual_guest || r.manual_party || r.manual_gross,
    attendance: null as number | null,
  }))
  // 日報(foodcourt_daily_logs)の動員数を baseDaily にマージ。
  const { data: attRows, error: attErr } = await supabase
    .from("foodcourt_daily_logs")
    .select("log_date, daily_attendance")
    .ilike("store_partition_key", storeKey)
    .gte("log_date", lo)
    .lte("log_date", hi)
    .not("daily_attendance", "is", null)
  if (attErr) {
    console.error("loadBaseDailyForReports daily_logs attendance failed:", attErr.message)
  }
  if (Array.isArray(attRows) && attRows.length > 0) {
    const attMap = new Map(
      attRows.map((r) => [String((r as { log_date?: unknown }).log_date ?? "").slice(0, 10), Number((r as { daily_attendance?: unknown }).daily_attendance)])
    )
    for (const b of base) {
      const v = attMap.get(b.date)
      if (v != null && Number.isFinite(v)) b.attendance = v
    }
  }
  return base
}

/** フードコート日報を AI 分析用に読み込む。失敗時は error を返し、呼び出し側で可視化できるようにする。 */
async function loadFoodCourtDailyLogs(
  supabase: ReturnType<typeof createClient>,
  storeKey: string,
  opts?: { from?: string; to?: string; limit?: number },
): Promise<{ logs: Array<Record<string, unknown>>; error: string | null; count: number }> {
  const key = String(storeKey ?? "").trim()
  if (!key) return { logs: [], error: "store_key is required", count: 0 }
  const limit = Math.min(Math.max(1, opts?.limit ?? 60), 120)
  let q = supabase
    .from("foodcourt_daily_logs")
    .select(
      "log_date, handler, actions, guest_impact, sales_impact, weather_note, event_note, daily_attendance, issues, next_actions, memo",
    )
    .ilike("store_partition_key", key)
    .order("log_date", { ascending: false })
    .limit(limit)
  const from = String(opts?.from ?? "").slice(0, 10)
  const to = String(opts?.to ?? "").slice(0, 10)
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) q = q.gte("log_date", from)
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) q = q.lte("log_date", to)
  const { data, error } = await q
  if (error) {
    console.error("loadFoodCourtDailyLogs failed:", key, error.message)
    return { logs: [], error: error.message, count: 0 }
  }
  const logs = Array.isArray(data) ? data as Array<Record<string, unknown>> : []
  return { logs, error: null, count: logs.length }
}

/** JST 基準の YYYY-MM-DD（日報の「今日」と 60 日窓を UTC ずれなく揃える） */
function jstDateIso(offsetDays = 0): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 24 * 3600 * 1000)
  return jst.toISOString().slice(0, 10)
}

/** 先週の月曜〜日曜（JST） */
function lastWeekMonSunJst(): { weekStart: string; weekEnd: string } {
  const jstNow = new Date(Date.now() + 9 * 3600 * 1000)
  // getUTC* は JST シフト後の UTC 表現なので曜日・日付として使える
  const dow = jstNow.getUTCDay() // 0=日
  // 今週月曜 = 今日 - ((dow+6)%7) 日
  const daysSinceMon = (dow + 6) % 7
  const thisMon = new Date(jstNow)
  thisMon.setUTCDate(jstNow.getUTCDate() - daysSinceMon)
  const lastMon = new Date(thisMon)
  lastMon.setUTCDate(thisMon.getUTCDate() - 7)
  const lastSun = new Date(lastMon)
  lastSun.setUTCDate(lastMon.getUTCDate() + 6)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { weekStart: fmt(lastMon), weekEnd: fmt(lastSun) }
}

// 自己再学習型の来客予測（forecast_predictions）を返す。基準店（マルゴS）のみ。当日前後の窓で guests/sales。
async function loadForecastForStore(
  supabase: ReturnType<typeof createClient>,
  storeKey: string,
): Promise<Array<{ target_date: string; metric: string; predicted: number; predicted_low: number | null; predicted_high: number | null; actual: number | null; model_version: string; features: unknown }>> {
  if (String(storeKey ?? "").trim().toLowerCase() !== "marugos") return []
  const todayIso = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  const lo = addDaysIso(todayIso, -14)
  const hi = addDaysIso(todayIso, 21)
  const { data, error } = await supabase
    .from("forecast_predictions")
    .select("target_date, metric, predicted, predicted_low, predicted_high, actual, model_version, features")
    .eq("tenant_name", "MARUGO S")
    .gte("target_date", lo)
    .lte("target_date", hi)
    .order("target_date", { ascending: true })
    .limit(200)
  if (error || !Array.isArray(data)) return []
  return data.map((r) => ({
    target_date: String((r as { target_date?: unknown }).target_date ?? "").slice(0, 10),
    metric: String((r as { metric?: unknown }).metric ?? ""),
    predicted: Number((r as { predicted?: unknown }).predicted ?? 0),
    predicted_low: (r as { predicted_low?: unknown }).predicted_low == null ? null : Number((r as { predicted_low?: unknown }).predicted_low),
    predicted_high: (r as { predicted_high?: unknown }).predicted_high == null ? null : Number((r as { predicted_high?: unknown }).predicted_high),
    actual: (r as { actual?: unknown }).actual == null ? null : Number((r as { actual?: unknown }).actual),
    model_version: String((r as { model_version?: unknown }).model_version ?? ""),
    features: (r as { features?: unknown }).features ?? null,
  })).filter((r) => r.target_date && r.metric)
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// businessDateIso を含む月の「前月」の範囲を返す（月次振り返りは常に完全に終わった月を対象にする）。
function previousMonthRange(businessDateIso: string): { yearMonth: string; monthStart: string; monthEnd: string } | null {
  const d = new Date(`${businessDateIso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  const firstOfThisMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 24 * 3600 * 1000)
  const firstOfPrevMonth = new Date(Date.UTC(lastOfPrevMonth.getUTCFullYear(), lastOfPrevMonth.getUTCMonth(), 1))
  const yearMonth = `${lastOfPrevMonth.getUTCFullYear()}-${String(lastOfPrevMonth.getUTCMonth() + 1).padStart(2, "0")}`
  return {
    yearMonth,
    monthStart: firstOfPrevMonth.toISOString().slice(0, 10),
    monthEnd: lastOfPrevMonth.toISOString().slice(0, 10),
  }
}

// 「先月の振り返り」を store_partition_key + year_month でキャッシュしつつ取得する。
// 未生成なら generateFoodCourtPeriodSummary を月境界で呼んで生成・保存する（月に1回だけAI生成・以降はキャッシュ）。
// データ不足等でnullが返ることもあり、その場合は日次分析側で単に「先月の振り返り」ブロックなしとして扱う。
async function getOrGenerateMonthlyRetrospective(
  supabase: ReturnType<typeof createClient>,
  storeKey: string,
  baseName: string,
  yearMonth: string,
  monthStart: string,
  monthEnd: string,
  groqApiKey: string,
  reports: Array<Record<string, unknown>>,
  events: Awaited<ReturnType<typeof loadVenueEventsForReports>>,
  weather: Awaited<ReturnType<typeof loadWeatherForReports>>,
  forecast: Awaited<ReturnType<typeof loadForecastForStore>>,
  dailyLogs: Array<Record<string, unknown>>,
): Promise<string | null> {
  const { data: cached, error: cacheErr } = await supabase
    .from("foodcourt_monthly_retrospective")
    .select("summary_text")
    .eq("store_partition_key", storeKey)
    .eq("year_month", yearMonth)
    .maybeSingle()
  if (cacheErr) console.error("foodcourt_monthly_retrospective select failed:", cacheErr.message)
  if (cached && (cached as { summary_text?: unknown }).summary_text) {
    return String((cached as { summary_text: string }).summary_text)
  }
  const summary = await generateFoodCourtPeriodSummary(
    reports, baseName, monthStart, monthEnd, groqApiKey, events, weather, forecast, supabase, storeKey, dailyLogs,
  )
  if (!summary) return null
  const { error: upErr } = await supabase.from("foodcourt_monthly_retrospective").upsert({
    store_partition_key: storeKey,
    year_month: yearMonth,
    month_start: monthStart,
    month_end: monthEnd,
    summary_text: summary,
    model_version: "v1",
  }, { onConflict: "store_partition_key,year_month" })
  if (upErr) console.error("foodcourt_monthly_retrospective upsert failed:", upErr.message)
  return summary
}

// 東京ドーム周辺の日次天気を、レポート期間に合わせて取得する（マルゴSのみ）。
// マルゴSは東京ドーム内フードコートのため、天気（雨/気温）と客数・売上が相関する。
async function loadWeatherForReports(
  supabase: ReturnType<typeof createClient>,
  storeKey: string,
  reports: Array<Record<string, unknown>>,
): Promise<Array<{ weather_date: string; weather_code: number | null; temp_max: number | null; temp_min: number | null; precipitation_mm: number | null; precip_prob: number | null; summary: string }>> {
  if (String(storeKey ?? "").trim().toLowerCase() !== "marugos") return []
  const dates: string[] = []
  for (const r of (Array.isArray(reports) ? reports : [])) {
    const rd = String((r as { report_date?: unknown }).report_date ?? "").slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(rd)) dates.push(rd)
  }
  dates.sort()
  const todayIso = new Date().toISOString().slice(0, 10)
  const minDate = dates[0] ?? todayIso
  const maxBase = dates[dates.length - 1] ?? todayIso
  // 過去90日〜先16日（天気予報の上限）とレポート期間の和集合。
  const loCand = [addDaysIso(minDate, -7), addDaysIso(todayIso, -90)].sort()
  const hiCand = [addDaysIso(maxBase > todayIso ? maxBase : todayIso, 16), addDaysIso(todayIso, 16)].sort()
  const lo = loCand[0]
  const hi = hiCand[hiCand.length - 1]
  const { data, error } = await supabase
    .from("weather_daily")
    .select("weather_date, weather_code, temp_max, temp_min, precipitation_mm, precip_prob, summary")
    .eq("location", "tokyo_dome")
    .gte("weather_date", lo)
    .lte("weather_date", hi)
    .order("weather_date", { ascending: true })
    .limit(400)
  if (error || !Array.isArray(data)) return []
  const num = (v: unknown) => { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n }
  return data.map((w) => ({
    weather_date: String((w as { weather_date?: unknown }).weather_date ?? "").slice(0, 10),
    weather_code: num((w as { weather_code?: unknown }).weather_code),
    temp_max: num((w as { temp_max?: unknown }).temp_max),
    temp_min: num((w as { temp_min?: unknown }).temp_min),
    precipitation_mm: num((w as { precipitation_mm?: unknown }).precipitation_mm),
    precip_prob: num((w as { precip_prob?: unknown }).precip_prob),
    summary: String((w as { summary?: unknown }).summary ?? ""),
  })).filter((w) => w.weather_date)
}

Deno.serve(async (req, info) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const path = normalizePath(url.pathname)
  const clientIp = extractClientIp(req.headers, info)
  // 店舗スコープ強制で body を差し替えたいときに使う実効リクエスト（既定は元のreq）。
  let workReq = req

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing." }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const rateLimit = resolveAdminRateLimit(req.method, path)
  const rateLimitResult = await consumeRateLimitFromDb(
    supabase,
    `${clientIp}:${req.method}:${path}`,
    rateLimit.maxRequests,
    rateLimit.windowMs,
  )
  if (!rateLimitResult.allowed) {
    return json({
      error: "Too many requests. Please retry later.",
      code: "rate_limited",
      retry_after_ms: rateLimitResult.retryAfterMs,
    }, 429)
  }

  if (req.method === "POST" && path === "/auth/verify") {
    try {
      const fallbackToken = Deno.env.get("ADMIN_DASHBOARD_TOKEN") ?? ""
      const authResult = await authenticate(req, supabase, fallbackToken)
      if (!authResult.ok) {
        return json({ error: authResult.message }, authResult.status)
      }
      return json({
        ok: true,
        storeScope: authResult.storeScope,
        roomScope: authResult.roomScope,
        scopeKind: authResult.scopeKind,
      }, 200)
    } catch (e) {
      const err = asAppError(e)
      return json({ error: err.message }, err.status)
    }
  }

  if (req.method === "POST" && path === "/auth/link-login") {
    try {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const loginToken = String(body.login_token ?? "").trim()
      if (!loginToken) {
        throw { status: 400, message: "login_token is required." } satisfies AppError
      }
      const rememberLogin = body.remember_login !== false
      const adminSurface = resolveAdminSurface(req, url)
      const session = await exchangeAdminDashboardLoginLinkToken(supabase, loginToken, {
        rememberLogin,
        metadata: {
          admin_surface: adminSurface,
          exchanged_via: "admin_api",
        },
      })
      return json({
        ok: true,
        session_token: session.token,
        expires_at: session.expires_at,
      }, 200)
    } catch (e) {
      if (e instanceof Error && /invalid|expired/i.test(e.message)) {
        return json({ error: e.message }, 401)
      }
      const err = asAppError(e)
      return json({ error: err.message }, err.status)
    }
  }

  if (req.method === "POST" && path === "/auth/room-config-login") {
    try {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const loginToken = String(body.login_token ?? "").trim()
      const password = String(body.password ?? "")
      if (!loginToken) {
        throw { status: 400, message: "login_token is required." } satisfies AppError
      }
      if (!password) {
        throw { status: 400, message: "password is required." } satisfies AppError
      }
      const rememberLogin = body.remember_login !== false
      const adminSurface = resolveAdminSurface(req, url)
      const session = await exchangeRoomConfigLoginLink(supabase, loginToken, password, {
        rememberLogin,
        metadata: { admin_surface: adminSurface, exchanged_via: "admin_api" },
      })
      return json({ ok: true, session_token: session.token, expires_at: session.expires_at }, 200)
    } catch (e) {
      // パスワード誤り/無効リンク/未有効化はすべて 401 で曖昧に返す（攻撃者に情報を与えない）。
      if (e instanceof Error) {
        return json({ error: "リンクまたはパスワードが正しくありません。" }, 401)
      }
      const err = asAppError(e)
      return json({ error: err.message }, err.status)
    }
  }

  if (req.method === "POST" && path === "/auth/session") {
    try {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const provided = String(body.admin_token ?? "").trim()
      if (!provided) {
        throw { status: 400, message: "admin_token is required." } satisfies AppError
      }
      const rememberLogin = body.remember_login !== false
      const fallbackAdminToken = Deno.env.get("ADMIN_DASHBOARD_TOKEN") ?? ""
      const authResult = await authenticateRawAdminToken(provided, supabase, fallbackAdminToken)
      if (!authResult.ok) {
        return json({ error: authResult.message }, authResult.status)
      }
      const adminSurface = resolveAdminSurface(req, url)
      const session = await issueAdminDashboardSessionToken(supabase, {
        rememberLogin,
        metadata: {
          admin_surface: adminSurface,
          exchanged_via: "admin_api_manual_login",
        },
      })
      return json({
        ok: true,
        session_token: session.token,
        expires_at: session.expires_at,
      }, 200)
    } catch (e) {
      const err = asAppError(e)
      return json({ error: err.message }, err.status)
    }
  }

  const fallbackAdminToken = Deno.env.get("ADMIN_DASHBOARD_TOKEN") ?? ""
  const authResult = await authenticate(req, supabase, fallbackAdminToken)
  if (!authResult.ok) {
    return json({ error: authResult.message }, authResult.status)
  }

  // 店舗スコープ強制(IDOR対策): 店舗別ログインリンク由来のセッションは、その店舗のページ
  // (petty_cash.html / analytics.html)が使うパスだけに限定し、店舗キーをスコープへ固定する。
  // 生adminトークン由来(storeScope=null)は全店アクセスのまま(従来どおり)。
  const storeScope = authResult.storeScope
  if (storeScope) {
    const STORE_SCOPED_ALLOWED_PATHS = new Set<string>([
      "/auth/logout",
      "/reservations/calendar",
      "/reservations/search",
      "/reservations/event",
      "/reservations/customer-suggest",
      "/petty-cash",
      "/petty-cash/receipt-image",
      "/petty-cash/receipt-media",
      "/foodcourt/reports",
      "/foodcourt/ask",
      "/foodcourt/dome-weekly",
      "/foodcourt/evolution-history",
      "/foodcourt/ai-loop-runs",
      "/foodcourt/daily-logs",
      "/foodcourt/daily-summary",
      "/foodcourt/daily-summary/list",
      "/foodcourt/period-summary",
      "/foodcourt/weekly-report",
      "/foodcourt/weekly-report/list",
      "/foodcourt/monthly-retrospective",
      "/foodcourt/events/attendance",
      "/analytics/holidays",
      "/analytics/monthly",
      "/weather/daily",
      "/receipts/sales",
      "/receipts/sheets-pilot-link",
      "/receipts/sales-budget",
      "/receipts/sales-daily-budget",
      "/receipts/sales-manual-days",
      "/receipts/sales-manual-days/import",
      "/receipts/sales-manual-months",
      "/receipts/daily-receipts-import",
      "/receipts/daily-receipts",
      "/receipts/competitors",
      "/receipts/competitors/refresh",
      "/receipts/competitors/nearby-search",
      "/receipts/store-reviews",
      "/receipts/store-reviews/profile/ensure",
      "/receipts/store-reviews/refresh",
      "/receipts/store-reviews/search",
    ])
    if (!STORE_SCOPED_ALLOWED_PATHS.has(path)) {
      return json({ error: "この店舗用ログインからはこの操作はできません。" }, 403)
    }
    // URLクエリの店舗キーをスコープへ強制(他店舗を明示要求していたら拒否)。
    for (const p of ["store", "store_key"]) {
      const requested = String(url.searchParams.get(p) ?? "").trim().toLowerCase()
      if (requested && requested !== storeScope.toLowerCase()) {
        return json({ error: "他店舗のデータにはアクセスできません。" }, 403)
      }
      url.searchParams.set(p, storeScope)
    }
    // 書込系(POST/PUT/PATCH)の JSON ボディは店舗フィールドをスコープへ強制し、差し替えたRequestを使う。
    // ※ multipart(ファイルアップロード=sales-manual-days/import の解析専用・店舗無し)は body を消費せず素通し。
    const contentType = String(req.headers.get("content-type") ?? "").toLowerCase()
    if (
      (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") &&
      contentType.includes("application/json")
    ) {
      let raw = ""
      try { raw = await req.text() } catch { raw = "" }
      if (raw) {
        let bodyObj: unknown = null
        try { bodyObj = JSON.parse(raw) } catch { bodyObj = null }
        if (isRecord(bodyObj)) {
          for (const p of ["store", "store_key", "store_partition_key"]) {
            if (p in bodyObj) {
              const v = String(bodyObj[p] ?? "").trim().toLowerCase()
              if (v && v !== storeScope.toLowerCase()) {
                return json({ error: "他店舗のデータにはアクセスできません。" }, 403)
              }
              bodyObj[p] = storeScope
            }
          }
          raw = JSON.stringify(bodyObj)
        }
      }
      const fwdHeaders = new Headers(req.headers)
      fwdHeaders.delete("content-length")
      workReq = new Request(req.url, { method: req.method, headers: fwdHeaders, body: raw })
    }
  }

  // ルームスコープ強制(IDOR対策): room_config セッション(LINEワンパス＋パスワード由来)は
  // /room-config(GET/PUT) のみに限定し、room_id をスコープへ固定。他ルーム・他admin操作は一切不可。
  const roomScope = authResult.scopeKind === ROOM_CONFIG_SCOPE ? authResult.roomScope : null
  if (roomScope) {
    const ROOM_SCOPED_ALLOWED_PATHS = new Set<string>(["/room-config", "/auth/logout"])
    if (!ROOM_SCOPED_ALLOWED_PATHS.has(path)) {
      return json({ error: "このルーム用ログインからはこの操作はできません。" }, 403)
    }
    const requestedRoom = String(url.searchParams.get("room_id") ?? "").trim()
    if (requestedRoom && requestedRoom !== roomScope) {
      return json({ error: "他のルームのデータにはアクセスできません。" }, 403)
    }
    url.searchParams.set("room_id", roomScope)
    const contentType = String(req.headers.get("content-type") ?? "").toLowerCase()
    if (
      (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") &&
      contentType.includes("application/json")
    ) {
      let raw = ""
      try { raw = await req.text() } catch { raw = "" }
      if (raw) {
        let bodyObj: unknown = null
        try { bodyObj = JSON.parse(raw) } catch { bodyObj = null }
        if (isRecord(bodyObj)) {
          const bodyRoom = String(bodyObj.room_id ?? "").trim()
          if (bodyRoom && bodyRoom !== roomScope) {
            return json({ error: "他のルームのデータにはアクセスできません。" }, 403)
          }
          bodyObj.room_id = roomScope
          raw = JSON.stringify(bodyObj)
        }
      }
      const fwdHeaders = new Headers(req.headers)
      fwdHeaders.delete("content-length")
      workReq = new Request(req.url, { method: req.method, headers: fwdHeaders, body: raw })
    }
  }

  try {
    if (req.method === "POST" && path === "/auth/logout") {
      const provided = req.headers.get("x-admin-token") ?? ""
      const revoked = await revokeAdminDashboardSessionToken(supabase, provided)
      return json({ success: true, revoked }, 200)
    }

    // ── ルーム・セルフ設定（room_config スコープ専用。room_id は上のブロックでスコープへ強制済み）──
    if (req.method === "GET" && path === "/room-config") {
      const roomId = String(url.searchParams.get("room_id") ?? "").trim()
      if (!roomId) throw { status: 400, message: "room_id is required." } satisfies AppError
      const { data, error } = await supabase
        .from("room_summary_settings")
        .select(ROOM_CONFIG_SAFE_SELECT)
        .eq("room_id", roomId)
        .maybeSingle()
      if (error) throw { status: 500, message: `Failed to load room config: ${error.message}` } satisfies AppError
      return json({ room_config: data ?? null }, 200)
    }

    if (req.method === "PUT" && path === "/room-config") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      const roomId = String(body.room_id ?? url.searchParams.get("room_id") ?? "").trim()
      if (!roomId) throw { status: 400, message: "room_id is required." } satisfies AppError
      // 安全サブセットのみ採用（bot_access_approved / receipt_report_store_partition_key 等の機微フィールドは
      // クライアントが送っても無視＝サーバ側 whitelist で守る）。
      const safe = buildRoomConfigSafePayload(body)
      const { data, error } = await supabase
        .from("room_summary_settings")
        .update({ ...safe, updated_at: new Date().toISOString() })
        .eq("room_id", roomId)
        .select(ROOM_CONFIG_SAFE_SELECT)
        .maybeSingle()
      if (error) throw { status: 500, message: `Failed to save room config: ${error.message}` } satisfies AppError
      if (!data) throw { status: 404, message: "Room not found." } satisfies AppError
      return json({ room_config: data }, 200)
    }

    if (req.method === "GET" && path === "/state") {
      const adminSurface = resolveAdminSurface(req, url)
      const state = await fetchState(supabase, url, adminSurface)
      return json(state, 200)
    }

    if (req.method === "GET" && path === "/usage/ai-cost") {
      const result = await fetchAiUsageCostState(supabase, url)
      return json(result, 200)
    }

    if (req.method === "GET" && path === "/permissions/users") {
      const users = await fetchLineUserPermissions(supabase, url)
      return json(users, 200)
    }

    if (req.method === "GET" && path === "/gmail/account") {
      const gmailAccount = await fetchGmailLinkedAccountState()
      return json({ gmail_account: gmailAccount }, 200)
    }

    if (req.method === "GET" && path === "/receipts/sheets-pilot-link") {
      const link = await fetchReceiptSheetsPilotLinkState()
      return json(link, 200)
    }

    if (req.method === "GET" && path === "/media") {
      const mediaState = await fetchMediaState(supabase, url)
      return json(mediaState, 200)
    }

    if (req.method === "GET" && path === "/documents") {
      const documentState = await fetchDocumentState(supabase, url)
      return json(documentState, 200)
    }

    if (req.method === "GET" && path === "/reservations/calendar") {
      const reservationCalendarState = await fetchReservationCalendarState(supabase, url)
      return json(reservationCalendarState, 200)
    }
    if (req.method === "GET" && path === "/reservations/search") {
      const reservationSearchState = await fetchReservationSearchState(supabase, url)
      return json(reservationSearchState, 200)
    }
    // 予約表の手動編集: 新規作成（手入力）/ 編集・非表示(ソフト削除)・復元 / 氏名・電話サジェスト。
    if (req.method === "POST" && path === "/reservations/event") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await createManualReservationEvent(supabase, body, storeScope)
      return json(result, 200)
    }
    if (req.method === "PATCH" && path === "/reservations/event") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await updateReservationEvent(supabase, body, storeScope)
      return json(result, 200)
    }
    if (req.method === "POST" && path === "/reservations/customer-suggest") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await suggestReservationCustomers(supabase, body, storeScope)
      return json(result, 200)
    }
    // 完全削除（ハードデリート）: キャンセル(非表示)と異なり行を物理削除し履歴も残さない。
    // source/id は URL クエリで受ける（PII を含まない）。
    if (req.method === "DELETE" && path === "/reservations/event") {
      const result = await deleteReservationEvent(supabase, url, storeScope)
      return json(result, 200)
    }

    // ── 小口現金（出金/経費）台帳: 一覧+月集計 / 追加(手入力) / 論理削除 ──
    if (req.method === "GET" && path === "/petty-cash") {
      const state = await fetchPettyCashState(supabase, url)
      return json(state, 200)
    }
    // 出金(レシート画像由来)の元レシート画像の署名URLを返す（別ページで開く用）。
    if (req.method === "GET" && path === "/petty-cash/receipt-media") {
      const result = await fetchPettyCashReceiptMedia(supabase, url, storeScope)
      return json(result, 200)
    }
    // フードコート「テナント一覧」レポートの抽出結果（分析専用・店舗スコープ）。専用ページ foodcourt.html 用。
    if (req.method === "GET" && path === "/foodcourt/reports") {
      // 店舗キーは大文字小文字ゆらぎ（例: marugoS）があるため ilike で照合（スコープ強制側は小文字化される）。
      const storeKey = String(url.searchParams.get("store_key") ?? url.searchParams.get("store") ?? "").trim()
      if (!storeKey) return json({ error: "store_key is required." }, 400)
      const limitRaw = Number(url.searchParams.get("limit") ?? "60")
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 60
      const { data, error } = await supabase
        .from("foodcourt_tenant_reports")
        .select("id, report_date, base_tenant_name, tenants, created_at, line_message_id")
        .ilike("store_partition_key", storeKey)
        .order("created_at", { ascending: false })
        .limit(limit)
      if (error) return json({ error: error.message }, 500)
      const reports = Array.isArray(data) ? data : []
      // 会場イベント（東京ドーム）・天気を併せて返す。マルゴSは東京ドーム内のため客数増減と相関する。
      const events = await loadVenueEventsForReports(supabase, storeKey, reports)
      const weather = await loadWeatherForReports(supabase, storeKey, reports)
      const forecast = await loadForecastForStore(supabase, storeKey)
      // 客数/売上/組数の正本（管理表＝レシート集計＋手入力）。日報が無い日も含む。画面はこれを優先採用。
      const baseDaily = await loadBaseDailyForReports(supabase, storeKey)
      return json({ store_key: storeKey, reports, events, weather, forecast, baseDaily }, 200)
    }
    // 「レポート一覧」タブ用：日次AIサマリーの一覧（本文は含まない軽量版。クリック時に
    // /foodcourt/daily-summary?report_id=... で本文を取得する）。
    if (req.method === "GET" && path === "/foodcourt/daily-summary/list") {
      const storeKey = String(url.searchParams.get("store_key") ?? url.searchParams.get("store") ?? "").trim()
      if (!storeKey) return json({ error: "store_key is required." }, 400)
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 90) || 90, 1), 365)
      const { data, error } = await supabase
        .from("foodcourt_daily_ai_summary")
        .select("report_id, business_date, model_version, created_at")
        .ilike("store_partition_key", storeKey)
        .order("business_date", { ascending: false })
        .limit(limit)
      if (error) return json({ error: error.message }, 500)
      return json({ items: data ?? [] }, 200)
    }
    // 「分析サマリー（自動）」カードのAI版。report_id単位でキャッシュし、閲覧のたびに再生成・再課金しない。
    // 初回閲覧時にGroq(専門AI2体→統合AI)で生成しDBへ保存、以降は保存済みテキストを即返す。
    if (req.method === "GET" && path === "/foodcourt/daily-summary") {
      const storeKey = String(url.searchParams.get("store_key") ?? url.searchParams.get("store") ?? "").trim()
      if (!storeKey) return json({ error: "store_key is required." }, 400)
      const reportIdParam = url.searchParams.get("report_id")
      // 実効バージョン: ループが日次で有効なときだけ v12-loop（無効の間は v11 のまま＝既存キャッシュを維持）。
      const dailyAiVersion = resolveFoodCourtDailyAnalysisVersion()
      const { data, error } = await supabase
        .from("foodcourt_tenant_reports")
        .select("id, report_date, base_tenant_name, tenants, created_at")
        .ilike("store_partition_key", storeKey)
        .order("created_at", { ascending: false })
        .limit(90)
      if (error) return json({ error: error.message }, 500)
      const reports = Array.isArray(data) ? data as Array<Record<string, unknown>> : []
      if (!reports.length) return json({ summary: null, reportCount: 0 }, 200)
      const target = reportIdParam
        ? reports.find((r) => String((r as { id?: unknown }).id ?? "") === reportIdParam)
        : reports[0]
      if (!target) return json({ error: "report_id not found." }, 404)
      const reportId = (target as { id?: unknown }).id
      const { data: cached, error: cacheErr } = await supabase
        .from("foodcourt_daily_ai_summary")
        .select("summary_text")
        .eq("report_id", reportId)
        .eq("model_version", dailyAiVersion)
        .maybeSingle()
      if (cacheErr) return json({ error: cacheErr.message }, 500)
      if (cached && (cached as { summary_text?: unknown }).summary_text) {
        return json({ summary: (cached as { summary_text: string }).summary_text, cached: true, reportCount: reports.length }, 200)
      }
      const groqApiKey = Deno.env.get("GROQ_API_KEY") ?? ""
      if (!groqApiKey) return json({ error: "GROQ_API_KEY is missing." }, 500)
      const baseName = String((target as { base_tenant_name?: unknown }).base_tenant_name ?? "MARUGO S")
      const events = await loadVenueEventsForReports(supabase, storeKey, reports)
      const weather = await loadWeatherForReports(supabase, storeKey, reports)
      const forecast = await loadForecastForStore(supabase, storeKey)
      const modelVersion = dailyAiVersion
      const businessDate = fcSalesDate(target) || null
      // 前回（直近の1つ前の営業日）に生成済みのAI分析を、自己検証の材料として渡す（日々の分析に連続性を持たせる）。
      let priorSummary: { businessDate: string; summaryText: string } | null = null
      if (businessDate) {
        const { data: priorRow } = await supabase
          .from("foodcourt_daily_ai_summary")
          .select("business_date, summary_text")
          .eq("store_partition_key", storeKey)
          .eq("model_version", dailyAiVersion)
          .lt("business_date", businessDate)
          .order("business_date", { ascending: false })
          .limit(1)
          .maybeSingle()
        if (priorRow && (priorRow as { summary_text?: unknown }).summary_text) {
          priorSummary = {
            businessDate: String((priorRow as { business_date?: unknown }).business_date ?? ""),
            summaryText: String((priorRow as { summary_text: string }).summary_text),
          }
        }
      }
      // 現場日報: 対象日の前後14日＋対象日を含めて AI に渡す（施策効果の照合用）。
      const logsTo = businessDate || jstDateIso(0)
      const logsFrom = addDaysIso(logsTo, -14)
      const { logs: dailyLogs, error: dailyLogsError, count: dailyLogsCount } = await loadFoodCourtDailyLogs(
        supabase,
        storeKey,
        { from: logsFrom, to: logsTo, limit: 30 },
      )
      if (dailyLogsError) {
        console.error("foodcourt/daily-summary daily_logs load failed:", dailyLogsError)
      }
      // 「先月の振り返り」を学習材料として渡す（月に1回だけAI生成・以降は月末までキャッシュ再利用）。
      // reportsは既に読み込み済みの直近90件（前月分は通常この範囲に収まる）を再利用し、追加クエリはしない。
      let monthlyRetro: string | null = null
      if (businessDate) {
        const monthRange = previousMonthRange(businessDate)
        if (monthRange) {
          monthlyRetro = await getOrGenerateMonthlyRetrospective(
            supabase, storeKey, baseName, monthRange.yearMonth, monthRange.monthStart, monthRange.monthEnd,
            groqApiKey, reports, events, weather, forecast, dailyLogs,
          )
        }
      }
      // 曜日/イベント種別/天気ごとの統計パターンはgenerateFoodCourtDailySummary内でreportsから毎回
      // 計算し直す（コード計算・状態を持たない＝データが増えるほど自動的に確度が上がる）。
      const summary = await generateFoodCourtDailySummary(
        reports, baseName, target, groqApiKey, events, weather, forecast, supabase, storeKey, priorSummary, dailyLogs, monthlyRetro,
      )
      if (!summary) {
        return json({
          summary: null,
          error: "生成に失敗しました。",
          reportCount: reports.length,
          daily_logs_count: dailyLogsCount,
          daily_logs_error: dailyLogsError,
        }, 200)
      }
      const { error: upErr } = await supabase.from("foodcourt_daily_ai_summary").upsert({
        report_id: reportId,
        store_partition_key: storeKey,
        business_date: businessDate,
        summary_text: summary,
        model_version: modelVersion,
      }, { onConflict: "report_id" })
      if (upErr) console.error("foodcourt_daily_ai_summary upsert failed:", upErr.message)
      return json({
        summary,
        cached: false,
        reportCount: reports.length,
        daily_logs_count: dailyLogsCount,
        daily_logs_error: dailyLogsError,
      }, 200)
    }
    // 「分析サマリー（自動）」カードの期間集計版。「期間で見る」モード専用（単日と違いreport_idを持たないため
    // 店舗+開始日+終了日でキャッシュ）。ロジックはdaily-summaryと同じ考え方。
    if (req.method === "GET" && path === "/foodcourt/period-summary") {
      const storeKey = String(url.searchParams.get("store_key") ?? url.searchParams.get("store") ?? "").trim()
      if (!storeKey) return json({ error: "store_key is required." }, 400)
      const startRaw = String(url.searchParams.get("start") ?? "").trim()
      const endRaw = String(url.searchParams.get("end") ?? "").trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(endRaw)) {
        return json({ error: "start/end must be YYYY-MM-DD." }, 400)
      }
      const startDate = startRaw <= endRaw ? startRaw : endRaw
      const endDate = startRaw <= endRaw ? endRaw : startRaw
      const { data: cached, error: cacheErr } = await supabase
        .from("foodcourt_period_ai_summary")
        .select("summary_text")
        .eq("store_partition_key", storeKey)
        .eq("start_date", startDate)
        .eq("end_date", endDate)
        .eq("model_version", FOODCOURT_ANALYSIS_AI_VERSION)
        .maybeSingle()
      if (cacheErr) return json({ error: cacheErr.message }, 500)
      if (cached && (cached as { summary_text?: unknown }).summary_text) {
        return json({ summary: (cached as { summary_text: string }).summary_text, cached: true }, 200)
      }
      const { data, error } = await supabase
        .from("foodcourt_tenant_reports")
        .select("id, report_date, base_tenant_name, tenants, created_at")
        .ilike("store_partition_key", storeKey)
        .order("created_at", { ascending: false })
        .limit(90)
      if (error) return json({ error: error.message }, 500)
      const reports = Array.isArray(data) ? data as Array<Record<string, unknown>> : []
      if (!reports.length) return json({ summary: null, reportCount: 0 }, 200)
      const groqApiKey = Deno.env.get("GROQ_API_KEY") ?? ""
      if (!groqApiKey) return json({ error: "GROQ_API_KEY is missing." }, 500)
      const baseName = String((reports[0] as { base_tenant_name?: unknown }).base_tenant_name ?? "MARUGO S")
      const events = await loadVenueEventsForReports(supabase, storeKey, reports)
      const weather = await loadWeatherForReports(supabase, storeKey, reports)
      const forecast = await loadForecastForStore(supabase, storeKey)
      const modelVersion = FOODCOURT_ANALYSIS_AI_VERSION
      const { logs: dailyLogs, error: dailyLogsError, count: dailyLogsCount } = await loadFoodCourtDailyLogs(
        supabase,
        storeKey,
        { from: startDate, to: endDate, limit: 90 },
      )
      if (dailyLogsError) {
        console.error("foodcourt/period-summary daily_logs load failed:", dailyLogsError)
      }
      const summary = await generateFoodCourtPeriodSummary(
        reports, baseName, startDate, endDate, groqApiKey, events, weather, forecast, supabase, storeKey, dailyLogs,
      )
      if (!summary) {
        return json({
          summary: null,
          error: "生成に失敗しました。",
          daily_logs_count: dailyLogsCount,
          daily_logs_error: dailyLogsError,
        }, 200)
      }
      const { error: upErr } = await supabase.from("foodcourt_period_ai_summary").upsert({
        store_partition_key: storeKey,
        start_date: startDate,
        end_date: endDate,
        summary_text: summary,
        model_version: modelVersion,
      }, { onConflict: "store_partition_key,start_date,end_date" })
      if (upErr) console.error("foodcourt_period_ai_summary upsert failed:", upErr.message)
      return json({
        summary,
        cached: false,
        daily_logs_count: dailyLogsCount,
        daily_logs_error: dailyLogsError,
      }, 200)
    }
    // 蓄積データへの質問応答（Q&A）。蓄積された全レポートを根拠に Groq が回答（毎回の自動出力はしない運用）。
    if (req.method === "POST" && path === "/foodcourt/ask") {
      const body = await workReq.json().catch(() => ({})) as Record<string, unknown>
      const storeKey = String(body.store_key ?? body.store ?? url.searchParams.get("store_key") ?? "").trim()
      const question = String(body.question ?? "").trim()
      if (!storeKey) return json({ error: "store_key is required." }, 400)
      if (!question) return json({ error: "question is required." }, 400)
      // 会話継続: 直前までのQ&A履歴を受け取り、文脈として渡す（指示語が効くように）。最新8件・各4000字まで。
      const historyRaw = Array.isArray((body as { history?: unknown }).history) ? (body.history as unknown[]) : []
      const history = historyRaw.map((h) => {
        const o = (h && typeof h === "object") ? h as Record<string, unknown> : {}
        const role = String(o.role ?? "")
        const content = String(o.content ?? "").slice(0, 4000)
        return (role === "user" || role === "assistant") && content ? { role, content } : null
      }).filter((x): x is { role: string; content: string } => x != null).slice(-8)
      const groqApiKey = Deno.env.get("GROQ_API_KEY") ?? ""
      if (!groqApiKey) return json({ error: "GROQ_API_KEY is missing." }, 500)
      const { data, error } = await supabase
        .from("foodcourt_tenant_reports")
        .select("id, report_date, tenants, created_at, base_tenant_name")
        .ilike("store_partition_key", storeKey)
        .order("created_at", { ascending: false })
        .limit(90)
      if (error) return json({ error: error.message }, 500)
      const reports = Array.isArray(data) ? data as Array<Record<string, unknown>> : []
      if (!reports.length) {
        return json({ answer: "まだデータがありません。フードコートのテナント一覧画像を送ると蓄積されます。", reportCount: 0 }, 200)
      }
      const baseName = String((reports[0] as { base_tenant_name?: unknown }).base_tenant_name ?? "MARUGO S")
      // 会場イベント（東京ドーム）・天気も根拠に渡す。客数増減との相関を踏まえて回答させる。
      const events = await loadVenueEventsForReports(supabase, storeKey, reports)
      const weather = await loadWeatherForReports(supabase, storeKey, reports)
      const forecast = await loadForecastForStore(supabase, storeKey)
      // 現場日報（foodcourt_daily_logs）: Q&A分析の精度向上のため直近60日分を取得してAIに渡す。
      // 失敗時は空配列にせず error をレスポンス・ログに出し、サイレント劣化を防ぐ。
      const todayForLogs = jstDateIso(0)
      const logsFrom = jstDateIso(-60)
      const { logs: dailyLogs, error: dailyLogsError, count: dailyLogsCount } = await loadFoodCourtDailyLogs(
        supabase,
        storeKey,
        { from: logsFrom, to: todayForLogs, limit: 60 },
      )
      if (dailyLogsError) {
        console.error("foodcourt/ask daily_logs load failed:", dailyLogsError)
      }
      // 画面に表示中の単日レポート(viewing_report_id)を、特に日付指定のない質問のデフォルト対象日としてAIに伝える。
      // これが無いと、AIは全履歴のどの日の話かを画面と無関係に(会話文脈だけで)決めてしまい、時間軸がずれる。
      const viewingReportIdRaw = (body as { viewing_report_id?: unknown }).viewing_report_id
      const viewingReportId = viewingReportIdRaw != null ? String(viewingReportIdRaw) : ""
      const viewingReport = viewingReportId ? reports.find((r) => String((r as { id?: unknown }).id ?? "") === viewingReportId) : null
      const viewingDate = viewingReport ? fcSalesDate(viewingReport) : null
      try {
        const qaResult = await answerFoodCourtQuestion(reports, baseName, question, groqApiKey, events, weather, supabase, storeKey, history, forecast, viewingDate, dailyLogs)
        let answer = qaResult.answer || "回答を生成できませんでした。もう一度お試しください。"
        // 日報テーブル読込失敗時は回答末尾に注意を付与（AIは「日報なし」と誤認するため）。
        if (dailyLogsError) {
          answer += `\n\n⚠️ システム注意: 現場日報の取得に失敗したため、施策記録は未参照です（${dailyLogsError}）。`
        }
        return json({
          answer,
          reportCount: reports.length,
          loop_score: qaResult.loopScore,
          loop_count: qaResult.loopCount,
          daily_logs_count: dailyLogsCount,
          daily_logs_error: dailyLogsError,
        }, 200)
      } catch (e) {
        console.error("foodcourt/ask error:", e)
        return json({
          answer: "⚠️ データの容量が大きい、または一時的な負荷のため、回答の生成に失敗しました。\n少し時間をおいてもう一度お試しいただくか、質問をもう少し短く・具体的にしてみてください。",
          reportCount: reports.length,
          loop_score: null,
          loop_count: 0,
          daily_logs_count: dailyLogsCount,
          daily_logs_error: dailyLogsError,
        }, 200)
      }
    }
    // 学習進化トラッキング: foodcourt_forecast_history の全行を返す（foodcourt-evolution.html 用）。
    if (req.method === "GET" && path === "/foodcourt/evolution-history") {
      const storeKey = String(url.searchParams.get("store_key") ?? url.searchParams.get("store") ?? "marugoS").trim()
      const storeKeyNorm = storeKey.toLowerCase().replace(/[\s_\-]+/g, "")
      const tenantName = storeKeyNorm === "marugos" ? "MARUGO S" : storeKey
      const { data, error } = await supabase
        .from("foodcourt_forecast_history")
        .select("log_date, model_version, history_days, backtest_days, mape_guests, mape_sales, mean_guests, created_at")
        .eq("tenant_name", tenantName)
        .order("log_date", { ascending: true })
      if (error) return json({ error: error.message }, 500)
      // model_selection detail from factors (single row per tenant)
      const { data: factors } = await supabase
        .from("foodcourt_forecast_factors")
        .select("model_selection, updated_at")
        .eq("tenant_name", tenantName)
        .maybeSingle()

      // line_admin_console_settings から foodcourt_evolution_passing_score を読み込む
      const { data: passSetting } = await supabase
        .from("line_admin_console_settings")
        .select("setting_value")
        .eq("setting_key", "foodcourt_evolution_passing_score")
        .maybeSingle()

      let passingScore = 65
      if (passSetting?.setting_value) {
        const parsed = parseInt(passSetting.setting_value, 10)
        if (!isNaN(parsed)) passingScore = parsed
      }

      return json({
        rows: data ?? [],
        model_selection: factors?.model_selection ?? null,
        passing_score: passingScore
      }, 200)
    }
    if (req.method === "GET" && path === "/foodcourt/ai-loop-runs") {
      const limit = Math.min(parseInt(String(url.searchParams.get("limit") ?? "30")), 50)
      const { data: runs, error: runsErr } = await supabase
        .from("foodcourt_ai_loop_runs")
        .select("id, surface, source_ref, final_score, returned_reason, created_at")
        .order("created_at", { ascending: false })
        .limit(limit)
      if (runsErr) return json({ error: runsErr.message }, 500)
      if (!runs || runs.length === 0) return json({ runs: [] }, 200)
      const runIds = runs.map((r: Record<string, unknown>) => r.id as string)
      const { data: iters, error: itersErr } = await supabase
        .from("foodcourt_ai_loop_iterations")
        .select("run_id, loop_index, total_score, score_accuracy, score_logic, score_expertise, score_practicality, score_evidence, passed, evaluation, created_at")
        .in("run_id", runIds)
        .order("loop_index", { ascending: true })
      if (itersErr) return json({ error: itersErr.message }, 500)
      const itersByRun = new Map<string, unknown[]>()
      for (const it of (iters ?? [])) {
        const rid = (it as Record<string, unknown>).run_id as string
        if (!itersByRun.has(rid)) itersByRun.set(rid, [])
        itersByRun.get(rid)!.push(it)
      }
      const result = runs.map((r: Record<string, unknown>) => ({
        ...r,
        iterations: itersByRun.get(r.id as string) ?? [],
      }))
      return json({ runs: result }, 200)
    }
    // 東京ドーム週次イベント配信（per-room）の設定を取得/保存（管理画面のカレンダー/予約タブから利用）。
    if (req.method === "GET" && path === "/foodcourt/dome-weekly") {
      const roomId = String(url.searchParams.get("room_id") ?? "").trim()
      if (!roomId) return json({ error: "room_id is required." }, 400)
      const { data, error } = await supabase
        .from("room_summary_settings")
        .select("room_id, room_name, dome_weekly_enabled, dome_weekly_dow, dome_weekly_hour, dome_weekly_minute")
        .eq("room_id", roomId)
        .maybeSingle()
      if (error) return json({ error: error.message }, 500)
      return json({ config: data ?? null }, 200)
    }
    if (req.method === "PUT" && path === "/foodcourt/dome-weekly") {
      const body = await workReq.json().catch(() => ({})) as Record<string, unknown>
      const roomId = String(body.room_id ?? "").trim()
      if (!roomId) return json({ error: "room_id is required." }, 400)
      const dowN = Number(body.dome_weekly_dow)
      const hourN = Number(body.dome_weekly_hour)
      const minN = Number(body.dome_weekly_minute)
      const upd: Record<string, unknown> = {
        dome_weekly_enabled: body.dome_weekly_enabled === true,
        dome_weekly_dow: (Number.isInteger(dowN) && dowN >= 0 && dowN <= 6) ? dowN : null,
        dome_weekly_hour: (Number.isInteger(hourN) && hourN >= 0 && hourN <= 23) ? hourN : null,
        dome_weekly_minute: (Number.isInteger(minN) && minN >= 0 && minN <= 59) ? minN : null,
        updated_at: new Date().toISOString(),
      }
      const { data, error } = await supabase
        .from("room_summary_settings")
        .update(upd)
        .eq("room_id", roomId)
        .select("room_id, dome_weekly_enabled, dome_weekly_dow, dome_weekly_hour, dome_weekly_minute")
        .maybeSingle()
      if (error) return json({ error: error.message }, 500)
      return json({ ok: true, config: data ?? null }, 200)
    }
    // 東京ドームイベントの予想動員数を手入力で更新する（自動取得元に動員数が無いため）。
    // 来客予測モデル(foodcourt-forecast-cron)が「最強ドライバー」として使う唯一の入力経路。
    if (req.method === "PUT" && path === "/foodcourt/events/attendance") {
      const body = await workReq.json().catch(() => ({})) as Record<string, unknown>
      const eventDate = String(body.event_date ?? "").slice(0, 10)
      const venue = String(body.venue ?? "").trim()
      const title = String(body.title ?? "").trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !venue || !title) {
        return json({ error: "event_date, venue, title are required." }, 400)
      }
      let attendance: number | null = null
      if (body.expected_attendance !== null && body.expected_attendance !== undefined && body.expected_attendance !== "") {
        const v = Number(body.expected_attendance)
        if (!Number.isFinite(v) || v < 0) return json({ error: "expected_attendance must be a non-negative number." }, 400)
        attendance = Math.round(v)
      }
      const { data, error } = await supabase
        .from("tokyo_dome_events")
        .update({ expected_attendance: attendance, updated_at: new Date().toISOString() })
        .eq("event_date", eventDate)
        .eq("venue", venue)
        .eq("title", title)
        .select("event_date, venue, title, category, expected_attendance")
        .maybeSingle()
      if (error) return json({ error: error.message }, 500)
      if (!data) return json({ error: "event not found." }, 404)
      return json({ ok: true, event: data }, 200)
    }
    // フードコート日報 CRUD ────────────────────────────────────────────────
    if (req.method === "GET" && path === "/foodcourt/daily-logs") {
      const storeKey = String(url.searchParams.get("store_key") ?? url.searchParams.get("store") ?? "").trim()
      if (!storeKey) return json({ error: "store_key is required." }, 400)
      const from = String(url.searchParams.get("from") ?? "").slice(0, 10)
      const to = String(url.searchParams.get("to") ?? "").slice(0, 10)
      const limit = Math.min(parseInt(String(url.searchParams.get("limit") ?? "90")), 366)
      let q = supabase
        .from("foodcourt_daily_logs")
        .select("id, log_date, handler, actions, guest_impact, sales_impact, weather_note, event_note, issues, next_actions, memo, daily_attendance, created_at, updated_at")
        .ilike("store_partition_key", storeKey)
        .order("log_date", { ascending: false })
        .limit(limit)
      if (/^\d{4}-\d{2}-\d{2}$/.test(from)) q = q.gte("log_date", from)
      if (/^\d{4}-\d{2}-\d{2}$/.test(to)) q = q.lte("log_date", to)
      const { data, error } = await q
      if (error) return json({ error: error.message }, 500)
      return json({ logs: data ?? [] }, 200)
    }

    if (req.method === "PUT" && path === "/foodcourt/daily-logs") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) return json({ error: "Invalid JSON body." }, 400)
      const storeKey = String(body.store_key ?? body.store ?? url.searchParams.get("store_key") ?? "").trim()
      if (!storeKey) return json({ error: "store_key is required." }, 400)
      const logDate = String(body.log_date ?? "").slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(logDate)) return json({ error: "log_date (YYYY-MM-DD) is required." }, 400)
      const actions = Array.isArray(body.actions) ? body.actions : []
      const now = new Date().toISOString()
      const { data, error } = await supabase
        .from("foodcourt_daily_logs")
        .upsert({
          store_partition_key: storeKey,
          log_date: logDate,
          handler: String(body.handler ?? "").slice(0, 100) || null,
          actions,
          guest_impact: String(body.guest_impact ?? "").slice(0, 2000) || null,
          sales_impact: String(body.sales_impact ?? "").slice(0, 2000) || null,
          weather_note: String(body.weather_note ?? "").slice(0, 500) || null,
          event_note: String(body.event_note ?? "").slice(0, 500) || null,
          issues: String(body.issues ?? "").slice(0, 2000) || null,
          next_actions: String(body.next_actions ?? "").slice(0, 2000) || null,
          memo: String(body.memo ?? "").slice(0, 3000) || null,
          daily_attendance: (body.daily_attendance !== null && body.daily_attendance !== undefined && body.daily_attendance !== "")
            ? (() => { const v = Number(body.daily_attendance); return Number.isFinite(v) && v >= 0 ? Math.round(v) : null })()
            : null,
          updated_at: now,
        }, { onConflict: "store_partition_key,log_date" })
        .select("id, log_date, handler, actions, guest_impact, sales_impact, weather_note, event_note, issues, next_actions, memo, daily_attendance, created_at, updated_at")
        .single()
      if (error) return json({ error: error.message }, 500)
      return json({ ok: true, log: data }, 200)
    }

    if (req.method === "DELETE" && path === "/foodcourt/daily-logs") {
      const storeKey = String(url.searchParams.get("store_key") ?? url.searchParams.get("store") ?? "").trim()
      const logDate = String(url.searchParams.get("log_date") ?? "").slice(0, 10)
      if (!storeKey) return json({ error: "store_key is required." }, 400)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(logDate)) return json({ error: "log_date is required." }, 400)
      const { error } = await supabase
        .from("foodcourt_daily_logs")
        .delete()
        .ilike("store_partition_key", storeKey)
        .eq("log_date", logDate)
      if (error) return json({ error: error.message }, 500)
      return json({ ok: true }, 200)
    }

    // 「レポート一覧」タブ用：週次レポートの一覧（本文は含まない軽量版。クリック時に
    // /foodcourt/weekly-report?week_start=... で本文を取得する）。
    if (req.method === "GET" && path === "/foodcourt/weekly-report/list") {
      const storeKey = String(url.searchParams.get("store_key") ?? url.searchParams.get("store") ?? "").trim()
      if (!storeKey) return json({ error: "store_key is required." }, 400)
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 52) || 52, 1), 260)
      const { data, error } = await supabase
        .from("foodcourt_weekly_reports")
        .select("week_start, week_end, loop_score, created_at")
        .ilike("store_partition_key", storeKey)
        .order("week_start", { ascending: false })
        .limit(limit)
      if (error) return json({ error: error.message }, 500)
      return json({ items: data ?? [] }, 200)
    }

    if (req.method === "GET" && path === "/foodcourt/weekly-report") {
      const storeKey = String(url.searchParams.get("store_key") ?? url.searchParams.get("store") ?? "").trim()
      const weekStart = String(url.searchParams.get("week_start") ?? "").slice(0, 10)
      if (!storeKey || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return json({ error: "store_key and week_start are required." }, 400)
      const { data, error } = await supabase.from("foodcourt_weekly_reports")
        .select("store_partition_key,week_start,week_end,ai_report,report_html,raw_data,loop_score,loop_count,created_at")
        .ilike("store_partition_key", storeKey).eq("week_start", weekStart).order("created_at", { ascending: false }).limit(1).maybeSingle()
      if (error) return json({ error: error.message }, 500)
      if (!data) return json({ error: "週次レポートが見つかりません。" }, 404)
      const row = data as Record<string, unknown>
      const report = String(row.ai_report ?? "")
      return json({ ...row, report_html: String(row.report_html ?? "") || weeklyReportHtml(report) }, 200)
    }

    // 月次振り返り（AI生成・キャッシュ済み）を単独で確認するための参照用エンドポイント。
    // 通常は日次分析生成が内部で自動的に取得・生成するため、これは検証・将来のUI表示用。
    if (req.method === "GET" && path === "/foodcourt/monthly-retrospective") {
      const storeKey = String(url.searchParams.get("store_key") ?? url.searchParams.get("store") ?? "").trim()
      const yearMonth = String(url.searchParams.get("year_month") ?? "").trim()
      if (!storeKey || !/^\d{4}-\d{2}$/.test(yearMonth)) return json({ error: "store_key and year_month(YYYY-MM) are required." }, 400)
      const { data, error } = await supabase.from("foodcourt_monthly_retrospective")
        .select("store_partition_key,year_month,month_start,month_end,summary_text,model_version,created_at")
        .ilike("store_partition_key", storeKey).eq("year_month", yearMonth).maybeSingle()
      if (error) return json({ error: error.message }, 500)
      if (!data) return json({ error: "月次振り返りが見つかりません（まだ生成されていません）。" }, 404)
      return json(data, 200)
    }

    // フードコート週次経営レポート生成（cron または管理画面から）。
    // cron: POST body { room_id, store_key, cron: true } + Authorization: Bearer <CRON_AUTH_TOKEN>
    // 手動: 同上 + x-admin-token。week_start/week_end 省略時は先週(月〜日 JST)。
    if (req.method === "POST" && path === "/foodcourt/weekly-report") {
      let body: Record<string, unknown> = {}
      try {
        const raw = await parseJson(workReq)
        if (isRecord(raw)) body = raw
      } catch {
        body = {}
      }
      const storeKey = String(body.store_key ?? body.store ?? url.searchParams.get("store_key") ?? "").trim()
      if (!storeKey) return json({ error: "store_key is required." }, 400)
      const roomId = String(body.room_id ?? "").trim()
      const pushToLine = body.cron === true || body.push === true
      let weekStart = String(body.week_start ?? "").slice(0, 10)
      let weekEnd = String(body.week_end ?? "").slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) {
        const w = lastWeekMonSunJst()
        weekStart = w.weekStart
        weekEnd = w.weekEnd
      }
      if (weekStart > weekEnd) {
        const t = weekStart
        weekStart = weekEnd
        weekEnd = t
      }

      // キャッシュヒット（同週・同店舗）
      const { data: cachedRow } = await supabase
        .from("foodcourt_weekly_reports")
        .select("id, ai_report, report_html, raw_data, loop_score, loop_count, created_at")
        .eq("store_partition_key", storeKey)
        .eq("week_start", weekStart)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      const force = body.force === true
      if (!force && cachedRow && (cachedRow as { ai_report?: unknown }).ai_report) {
        const report = String((cachedRow as { ai_report: string }).ai_report)
        let linePush: { ok: boolean; error?: string } | null = null
        if (pushToLine && roomId) {
          if (await reserveFoodCourtWeeklyReportSend(supabase, roomId, weekStart)) {
            const token = resolveChannelAccessToken(storeKey)
            if (token) {
              const link = await buildFoodCourtWeeklyReportLink(supabase, storeKey, weekStart)
              linePush = await pushLineMessagesToTarget(roomId, [buildWeeklyReportFlexMessage(weekStart, weekEnd, link)], token)
            } else {
              linePush = { ok: false, error: "LINE channel access token not configured for store." }
            }
            if (!linePush.ok) {
              // 送信失敗時は予約行を取り消し、次回起動（cron再試行）で再送できるようにする
              await supabase.from("foodcourt_weekly_report_sends").delete().eq("room_id", roomId).eq("week_start", weekStart)
            }
          } else {
            linePush = { ok: false, error: "already_sent_this_week" }
          }
        }
        return json({
          ok: true,
          cached: true,
          store_key: storeKey,
          week_start: weekStart,
          week_end: weekEnd,
          report,
          report_html: String((cachedRow as { report_html?: unknown }).report_html ?? "") || weeklyReportHtml(report),
          raw_data: (cachedRow as { raw_data?: unknown }).raw_data ?? null,
          loop_score: (cachedRow as { loop_score?: unknown }).loop_score ?? null,
          loop_count: (cachedRow as { loop_count?: unknown }).loop_count ?? null,
          line_push: linePush,
        }, 200)
      }

      const groqApiKey = Deno.env.get("GROQ_API_KEY") ?? ""
      if (!groqApiKey) return json({ error: "GROQ_API_KEY is missing." }, 500)
      const { data, error } = await supabase
        .from("foodcourt_tenant_reports")
        .select("id, report_date, tenants, created_at, base_tenant_name")
        .ilike("store_partition_key", storeKey)
        .order("created_at", { ascending: false })
        .limit(90)
      if (error) return json({ error: error.message }, 500)
      const reports = Array.isArray(data) ? data as Array<Record<string, unknown>> : []
      if (!reports.length) {
        return json({ error: "まだフードコートレポートがありません。", store_key: storeKey, week_start: weekStart, week_end: weekEnd }, 200)
      }
      const baseName = String((reports[0] as { base_tenant_name?: unknown }).base_tenant_name ?? "MARUGO S")
      const events = await loadVenueEventsForReports(supabase, storeKey, reports)
      const weather = await loadWeatherForReports(supabase, storeKey, reports)
      const forecast = await loadForecastForStore(supabase, storeKey)
      const { logs: dailyLogs, error: dailyLogsError, count: dailyLogsCount } = await loadFoodCourtDailyLogs(
        supabase,
        storeKey,
        { from: weekStart, to: weekEnd, limit: 14 },
      )
      if (dailyLogsError) console.error("foodcourt/weekly-report daily_logs load failed:", dailyLogsError)

      let result: Awaited<ReturnType<typeof generateFoodCourtWeeklyReport>>
      try {
        result = await generateFoodCourtWeeklyReport(
          reports, baseName, weekStart, weekEnd, groqApiKey, events, weather, forecast, supabase, storeKey, dailyLogs,
        )
      } catch (e) {
        console.error("foodcourt/weekly-report generate error:", e)
        return json({
          error: "週次レポートの生成に失敗しました。",
          detail: e instanceof Error ? e.message : String(e),
          daily_logs_count: dailyLogsCount,
          daily_logs_error: dailyLogsError,
        }, 500)
      }
      if (!result.report) {
        return json({
          error: "週次レポートを生成できませんでした（期間内データ不足の可能性）。",
          store_key: storeKey,
          week_start: weekStart,
          week_end: weekEnd,
          daily_logs_count: dailyLogsCount,
          daily_logs_error: dailyLogsError,
          raw_data: result.rawData,
        }, 200)
      }

      const reportHtml = weeklyReportHtml(result.report)
      const { error: upErr } = await supabase.from("foodcourt_weekly_reports").insert({
        store_partition_key: storeKey,
        week_start: weekStart,
        week_end: weekEnd,
        ai_report: result.report,
        report_html: reportHtml,
        raw_data: result.rawData,
        loop_score: result.loopScore,
        loop_count: result.loopCount,
      })
      if (upErr) console.error("foodcourt_weekly_reports insert failed:", upErr.message)

      let linePush: { ok: boolean; error?: string } | null = null
      if (pushToLine && roomId) {
        if (await reserveFoodCourtWeeklyReportSend(supabase, roomId, weekStart)) {
          const token = resolveChannelAccessToken(storeKey)
          if (token) {
            const link = await buildFoodCourtWeeklyReportLink(supabase, storeKey, weekStart)
            linePush = await pushLineMessagesToTarget(roomId, [buildWeeklyReportFlexMessage(weekStart, weekEnd, link)], token)
            if (!linePush.ok) console.error("weekly-report LINE push failed:", linePush.error)
          } else {
            linePush = { ok: false, error: "LINE channel access token not configured for store." }
          }
          if (!linePush.ok) {
            // 送信失敗時は予約行を取り消し、次回起動（cron再試行）で再送できるようにする
            await supabase.from("foodcourt_weekly_report_sends").delete().eq("room_id", roomId).eq("week_start", weekStart)
          }
        } else {
          linePush = { ok: false, error: "already_sent_this_week" }
        }
      }

      return json({
        ok: true,
        cached: false,
        store_key: storeKey,
        week_start: weekStart,
        week_end: weekEnd,
        report: result.report,
        report_html: reportHtml,
        raw_data: result.rawData,
        loop_score: result.loopScore,
        loop_count: result.loopCount,
        daily_logs_count: dailyLogsCount,
        daily_logs_error: dailyLogsError,
        line_push: linePush,
      }, 200)
    }

    if (req.method === "POST" && path === "/petty-cash/receipt-image") {
      const result = await createPettyCashEntryFromReceiptImage(supabase, workReq, storeScope)
      return json(result, 200)
    }
    if (req.method === "POST" && path === "/petty-cash") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await createPettyCashEntry(supabase, body)
      return json(result, 200)
    }
    if (req.method === "PATCH" && path === "/petty-cash") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await updatePettyCashEntry(supabase, body, storeScope)
      return json(result, 200)
    }
    if (req.method === "DELETE" && path === "/petty-cash") {
      const result = await deletePettyCashEntry(supabase, url, storeScope)
      return json(result, 200)
    }

    if (req.method === "GET" && path === "/messages/search") {
      const messageSearchState = await fetchLineRoomMessageSearchState(supabase, url)
      return json(messageSearchState, 200)
    }

    if (req.method === "GET" && path === "/calendar-events/search") {
      const calendarSearchState = await fetchLineRoomCalendarSearchState(supabase, url)
      return json(calendarSearchState, 200)
    }
    if (req.method === "GET" && path === "/receipts/store-options") {
      const options = await fetchStorePartitionReceiptOptions(supabase)
      return json({ store_options: options }, 200)
    }

    if (req.method === "GET" && path === "/receipts/webhook-status") {
      const includeDetectedRooms = url.searchParams.get("include_detected_rooms") !== "0"
      const autoLinkDetected = url.searchParams.get("auto_link") !== "0"
      const { webhook_status, auto_link } = await fetchReceiptWebhookStatus(supabase, {
        includeDetectedRooms,
        autoLinkDetected,
      })
      return json({
        webhook_status,
        auto_link,
        room_auto_link_enabled: isReceiptRoomAutoLinkEnabled(),
        generated_at: new Date().toISOString(),
      }, 200)
    }

    if (req.method === "PUT" && path === "/receipts/store-receipt-phones") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await updateStoreReceiptPhones(supabase, body)
      return json(result, 200)
    }

    if (req.method === "GET" && path === "/receipts/analysis-prompt") {
      const storeKey = toSafeString(url.searchParams.get("store_key")).trim()
      if (!storeKey || !/^[A-Za-z0-9_]{1,120}$/.test(storeKey)) {
        throw { status: 400, message: "store_key is required." } satisfies AppError
      }
      const { data, error } = await supabase
        .from("store_receipt_analysis_prompts")
        .select("prompt, enabled, updated_at")
        .eq("store_partition_key", storeKey)
        .maybeSingle()
      if (error) {
        throw { status: 500, message: `Failed to load analysis prompt: ${error.message}` } satisfies AppError
      }
      const row = data as { prompt?: string; enabled?: boolean; updated_at?: string } | null
      return json({
        store_key: storeKey,
        default_prompt: RECEIPT_VISION_SYSTEM_PROMPT_BASE,
        custom_prompt: row ? String(row.prompt ?? "") : "",
        enabled: row ? row.enabled !== false : true,
        max_chars: STORE_RECEIPT_PROMPT_MAX_CHARS,
        updated_at: row ? row.updated_at ?? null : null,
      }, 200)
    }

    if (req.method === "PUT" && path === "/receipts/analysis-prompt") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const storeKey = toSafeString(body.store_key).trim()
      if (!storeKey || !/^[A-Za-z0-9_]{1,120}$/.test(storeKey)) {
        throw { status: 400, message: "store_key is required." } satisfies AppError
      }
      const promptRaw = typeof body.prompt === "string" ? body.prompt : ""
      if (promptRaw.length > STORE_RECEIPT_PROMPT_MAX_CHARS) {
        throw { status: 400, message: `prompt must be <= ${STORE_RECEIPT_PROMPT_MAX_CHARS} chars.` } satisfies AppError
      }
      const enabled = body.enabled === undefined ? true : body.enabled === true
      const { error } = await supabase
        .from("store_receipt_analysis_prompts")
        .upsert({
          store_partition_key: storeKey,
          prompt: promptRaw,
          enabled,
          updated_at: new Date().toISOString(),
        }, { onConflict: "store_partition_key" })
      if (error) {
        throw { status: 500, message: `Failed to save analysis prompt: ${error.message}` } satisfies AppError
      }
      return json({ ok: true, store_key: storeKey, enabled }, 200)
    }

    if (req.method === "GET" && path === "/receipts/sales") {
      const receiptSalesState = await fetchStoreReceiptSalesState(supabase, url)
      return json(receiptSalesState, 200)
    }

    if (req.method === "GET" && path === "/receipts/competitors") {
      const storeKey = String(url.searchParams.get("store_key") ?? "").trim()
      const result = await fetchCompetitorReviewContext(supabase, storeKey)
      return json(result, 200)
    }

    if (req.method === "GET" && path === "/receipts/store-reviews") {
      const storeKey = String(url.searchParams.get("store_key") ?? "").trim()
      const result = await fetchStoreReviewContext(supabase, storeKey)
      return json(result, 200)
    }

    if (req.method === "PUT" && path === "/receipts/store-reviews") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await upsertStoreReviewPlace(supabase, body)
      return json(result, 200)
    }

    if (req.method === "DELETE" && path === "/receipts/store-reviews") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await deactivateStoreReviewPlace(supabase, body)
      return json(result, 200)
    }

    if (req.method === "POST" && path === "/receipts/store-reviews/refresh") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await refreshStoreReview(supabase, body)
      return json(result, 200)
    }

    if (req.method === "POST" && path === "/receipts/store-reviews/profile/ensure") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await ensureStoreReviewProfile(supabase, body)
      return json(result, 200)
    }

    if (req.method === "POST" && path === "/receipts/store-reviews/search") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await searchStoreReviewPlaces(body)
      return json(result, 200)
    }

    if (req.method === "PUT" && path === "/receipts/competitors") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await upsertCompetitorPlace(supabase, body)
      return json(result, 200)
    }

    if (req.method === "DELETE" && path === "/receipts/competitors") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await deactivateCompetitorPlace(supabase, body)
      return json(result, 200)
    }

    if (req.method === "POST" && path === "/receipts/competitors/refresh") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await refreshCompetitorReviews(supabase, body)
      return json(result, 200)
    }

    if (req.method === "POST" && path === "/receipts/competitors/nearby-search") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await nearbySearchGooglePlaces(supabase, body)
      return json(result, 200)
    }

    if (req.method === "PUT" && path === "/receipts/sales-budget") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await upsertStoreReceiptSalesBudget(supabase, body)
      return json(result, 200)
    }

    if (req.method === "GET" && path === "/receipts/sales-manual-months") {
      const result = await fetchStoreManualMonthsForYearState(supabase, url)
      return json(result, 200)
    }

    if (req.method === "PUT" && path === "/receipts/sales-manual-months") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await upsertStoreManualMonthEntries(supabase, body)
      return json(result, 200)
    }

    if (req.method === "PUT" && path === "/receipts/sales-manual-days") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await upsertManualDayEntries(supabase, body)
      return json(result, 200)
    }
    // 日別予算の直接入力（手動上書き）の保存。budget_yen が null/空の日は上書き解除（自動按分へ戻る）。
    if (req.method === "PUT" && path === "/receipts/sales-daily-budget") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await upsertDailyBudgetEntries(supabase, body)
      return json(result, 200)
    }
    // 月次日別売上管理表（Excel/CSV）を解析し、日次の entries を返す（解析のみ・DB書込なし）。
    // フロントがプレビュー→店舗解決→下の import-commit で確定投入する。
    if (req.method === "POST" && path === "/receipts/sales-manual-days/import") {
      const result = await parseManualDaySalesImport(req)
      return json(result, 200)
    }
    // 解析した日次売上を「画像解析レシートと同等」に登録: 各日1件の合成レシートを line_receipt__店舗 へ upsert。
    if (req.method === "POST" && path === "/receipts/daily-receipts-import") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await importDailyReceiptsCommit(supabase, body)
      return json(result, 200)
    }
    // 「月別売上の手入力」画面から、対象月の登録済みデータ（日別レシート・日別手入力・月合計手入力）をまとめて削除。
    if (req.method === "DELETE" && path === "/receipts/daily-receipts") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const key = toSafeString(body.store_key).trim().toLowerCase()
      if (!key || key === "__all__") {
        throw { status: 400, message: "store_key（店舗）を指定してください。" } satisfies AppError
      }
      const salesMonth = toSafeString(body.sales_month).trim().slice(0, 7)
      const result = await clearDailyReceiptsForMonth(supabase, key, salesMonth)
      return json(result, 200)
    }

    if (req.method === "GET" && path === "/analytics/monthly") {
      const result = await fetchStoreAnalyticsMonthly(supabase, url)
      return json(result, 200)
    }

    if (req.method === "GET" && path === "/analytics/holidays") {
      // 内閣府CSV（正本）から国民の祝日を取得。失敗時はハードコード表へフォールバック。
      const { map, source } = await fetchJapaneseHolidayMap()
      const dates: Record<string, string> = {}
      for (const [iso, name] of map) dates[iso] = name
      return json({ ok: true, source, count: map.size, dates }, 200)
    }

    if (req.method === "GET" && path === "/weather/daily") {
      const result = await fetchWeatherDailyState(supabase, url)
      return json(result, 200)
    }
    if (req.method === "GET" && path === "/usage/push-monthly") {
      const result = await fetchMonthlyPushUsageSummary(supabase)
      return json(result, 200)
    }

    if (req.method === "POST" && path === "/documents") {
      const created = await uploadDocumentFile(req, supabase)
      return json({ success: true, document: created }, 200)
    }

    const permissionPath = parseDocumentPermissionPath(path)
    if (permissionPath != null) {
      if (req.method === "GET") {
        const permissionState = await fetchDocumentPermissionStateById(supabase, permissionPath)
        return json({ success: true, permissions: permissionState }, 200)
      }
      if (req.method === "PUT") {
        const body = await parseJson(workReq)
        if (!isRecord(body)) {
          throw { status: 400, message: "Invalid JSON body." } satisfies AppError
        }
        const permissionState = await updateDocumentPermissionStateById(supabase, permissionPath, body)
        return json({ success: true, permissions: permissionState }, 200)
      }
    }

    if (req.method === "PUT" && path === "/settings/media-upload-limit") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const maxMb = normalizeMediaUploadMaxMb(body.media_upload_max_mb)
      await fetchGlobalSettings(supabase)
      const updatedAt = new Date().toISOString()
      const { data, error } = await supabase
        .from("summary_settings")
        .update({
          media_upload_max_mb: maxMb,
          updated_at: updatedAt,
        })
        .eq("id", 1)
        .select("id, media_upload_max_mb, updated_at")
        .single()
      if (error) {
        throw { status: 500, message: `Failed to update media upload limit: ${error.message}` } satisfies AppError
      }
      return json({
        success: true,
        media_upload_max_mb: Number(data?.media_upload_max_mb ?? maxMb),
        updated_at: data?.updated_at ?? updatedAt,
      }, 200)
    }

    if (req.method === "PUT" && path === "/settings/console") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const settings = isRecord(body.settings) ? body.settings : null
      if (!settings) {
        throw { status: 400, message: "settings object is required." } satisfies AppError
      }
      const keys = Object.keys(settings)
      if (keys.length > 1000) {
        throw { status: 400, message: "Too many settings (max 1000)." } satisfies AppError
      }
      const now = new Date().toISOString()
      const rows: { setting_key: string; setting_value: string; updated_at: string }[] = []
      for (const rawKey of keys) {
        const key = String(rawKey).trim()
        if (!key || key.length > 200) continue
        const raw = settings[rawKey]
        const value = raw == null ? "" : (typeof raw === "string" ? raw : String(raw))
        if (value.length > 20000) continue
        rows.push({ setting_key: key, setting_value: value, updated_at: now })
      }
      if (rows.length === 0) {
        return json({ ok: true, saved: 0 }, 200)
      }
      const { error } = await supabase
        .from("line_admin_console_settings")
        .upsert(rows, { onConflict: "setting_key" })
      if (error) {
        throw { status: 500, message: `Failed to save console settings: ${error.message}` } satisfies AppError
      }
      return json({ ok: true, saved: rows.length }, 200)
    }

    if (req.method === "DELETE" && path.startsWith("/media/")) {
      const mediaIdRaw = path.replace("/media/", "")
      const mediaId = Number(mediaIdRaw)
      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        throw { status: 400, message: "media_id must be a positive integer." } satisfies AppError
      }
      const deleted = await deleteMediaItemById(supabase, mediaId)
      return json({ success: true, deleted }, 200)
    }

    if (req.method === "DELETE" && path.startsWith("/documents/")) {
      const documentIdRaw = path.replace("/documents/", "")
      const documentId = Number(documentIdRaw)
      if (!Number.isInteger(documentId) || documentId <= 0) {
        throw { status: 400, message: "document_id must be a positive integer." } satisfies AppError
      }
      const deleted = await deleteDocumentById(supabase, documentId)
      return json({ success: true, deleted }, 200)
    }

    if (req.method === "PUT" && path === "/auth/token") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }

      const newToken = String(body.new_token ?? "").trim()
      if (newToken.length < 8) {
        throw { status: 400, message: "new_token must be at least 8 characters." } satisfies AppError
      }

      await fetchGlobalSettings(supabase)
      const tokenHash = await hashToken(newToken)
      const updatedAt = new Date().toISOString()
      const { error } = await supabase
        .from("summary_settings")
        .update({
          admin_dashboard_token_hash: tokenHash,
          admin_dashboard_token_updated_at: updatedAt,
          updated_at: updatedAt,
        })
        .eq("id", 1)

      if (error) {
        throw { status: 500, message: `Failed to update admin token: ${error.message}` } satisfies AppError
      }

      await revokeAllAdminDashboardAuthTokens(supabase)

      return json({
        success: true,
        token_updated_at: updatedAt,
      }, 200)
    }

    if (req.method === "PUT" && path === "/settings/global") {
      const body = await parseJson(workReq)
      const payload = buildGlobalSettingsPayload(body)
      const { data, error } = await supabase
        .from("summary_settings")
        .upsert({
          id: 1,
          delivery_hours: payload.delivery_hours,
          is_enabled: payload.is_enabled,
          message_cleanup_timing: payload.message_cleanup_timing,
          last_delivery_summary_mode: payload.last_delivery_summary_mode,
          message_retention_days: payload.message_retention_days,
          calendar_tomorrow_reminder_enabled: payload.calendar_tomorrow_reminder_enabled,
          calendar_tomorrow_reminder_hours: payload.calendar_tomorrow_reminder_hours,
          calendar_tomorrow_reminder_only_if_events: payload.calendar_tomorrow_reminder_only_if_events,
          calendar_tomorrow_reminder_max_items: payload.calendar_tomorrow_reminder_max_items,
          ...(payload.media_upload_max_mb != null ? { media_upload_max_mb: payload.media_upload_max_mb } : {}),
          updated_at: new Date().toISOString(),
        }, { onConflict: "id" })
        .select("id, delivery_hours, is_enabled, message_cleanup_timing, last_delivery_summary_mode, message_retention_days, calendar_tomorrow_reminder_enabled, calendar_tomorrow_reminder_hours, calendar_tomorrow_reminder_only_if_events, calendar_tomorrow_reminder_max_items, media_upload_max_mb, updated_at")
        .single()

      if (error) {
        throw { status: 500, message: `Failed to update global settings: ${error.message}` } satisfies AppError
      }
      return json({ global_settings: data }, 200)
    }

    if (req.method === "PUT" && path === "/settings/rooms") {
      const body = await parseJson(workReq)
      const payload = buildRoomSettingsPayload(body)
      // 管理者専用: ルーム・セルフ設定の有効化＋アクセスパスワード（平文受領→ハッシュ化保存・空でクリア）。
      // ここはフル管理者セッションのみ到達する（room スコープは /settings/rooms に来られない）。
      const roomConfigExtra: Record<string, unknown> = {}
      if (isRecord(body)) {
        if ("room_config_access_enabled" in body) {
          roomConfigExtra.room_config_access_enabled =
            body.room_config_access_enabled === true || body.room_config_access_enabled === "true"
        }
        if ("room_config_password" in body) {
          const pw = String(body.room_config_password ?? "")
          roomConfigExtra.room_config_password_hash = pw ? await hashRoomConfigPassword(pw) : null
        }
      }
      console.log(
        "[admin-api] room settings upsert request:",
        JSON.stringify({
          room_id: payload.room_id,
          is_enabled: payload.is_enabled,
          bot_reply_enabled: payload.bot_reply_enabled,
          bot_reply_hard_mute_enabled: payload.bot_reply_hard_mute_enabled,
          message_search_enabled: payload.message_search_enabled,
          message_search_library_enabled: payload.message_search_library_enabled,
          media_file_access_enabled: payload.media_file_access_enabled,
          image_analysis_reply_enabled: payload.image_analysis_reply_enabled,
        }),
      )
      const { data, error } = await supabase
        .from("room_summary_settings")
        .upsert({
          room_id: payload.room_id,
          room_name: payload.room_name,
          is_enabled: payload.is_enabled,
          bot_reply_enabled: payload.bot_reply_enabled,
          bot_reply_hard_mute_enabled: payload.bot_reply_hard_mute_enabled,
          send_room_summary: payload.send_room_summary,
          receive_overall_summary_enabled: payload.receive_overall_summary_enabled,
          calendar_tomorrow_reminder_enabled: payload.calendar_tomorrow_reminder_enabled,
          calendar_ai_auto_create_enabled: payload.calendar_ai_auto_create_enabled,
          calendar_silent_auto_register_enabled: payload.calendar_silent_auto_register_enabled,
          calendar_low_confidence_confirm_reply_enabled: payload.calendar_low_confidence_confirm_reply_enabled,
          calendar_registration_reply_enabled: payload.calendar_registration_reply_enabled,
          message_search_enabled: payload.message_search_enabled,
          message_search_library_enabled: payload.message_search_library_enabled,
          media_file_access_enabled: payload.media_file_access_enabled,
          image_analysis_reply_enabled: payload.image_analysis_reply_enabled,
          receipt_reply_executive_detail_enabled: payload.receipt_reply_executive_detail_enabled,
          receipt_correction_reply_enabled: payload.receipt_correction_reply_enabled,
          non_receipt_image_reply_enabled: payload.non_receipt_image_reply_enabled,
          media_save_enabled: payload.media_save_enabled,
          review_alert_enabled: payload.review_alert_enabled,
          budget_entry_enabled: payload.budget_entry_enabled,
          petty_receipt_analysis_enabled: payload.petty_receipt_analysis_enabled,
          receipt_sales_registration_enabled: payload.receipt_sales_registration_enabled,
          gmail_reservation_alert_enabled: payload.gmail_reservation_alert_enabled,
          today_reservation_alert_enabled: payload.today_reservation_alert_enabled,
          today_reservation_alert_hour: payload.today_reservation_alert_hour,
          today_reservation_alert_minute: payload.today_reservation_alert_minute,
          receipt_midreport_enabled: payload.receipt_midreport_enabled,
          receipt_monthend_report_enabled: payload.receipt_monthend_report_enabled,
          receipt_schedule_override: payload.receipt_schedule_override,
          receipt_midreport_day: payload.receipt_midreport_day,
          receipt_midreport_hour: payload.receipt_midreport_hour,
          receipt_midreport_minute: payload.receipt_midreport_minute,
          receipt_monthend_day: payload.receipt_monthend_day,
          receipt_monthend_hour: payload.receipt_monthend_hour,
          receipt_monthend_minute: payload.receipt_monthend_minute,
          receipt_report_store_partition_key: payload.receipt_report_store_partition_key,
          room_sort_order: payload.room_sort_order,
          delivery_hours: payload.delivery_hours,
          message_cleanup_timing: payload.message_cleanup_timing,
          last_delivery_summary_mode: payload.last_delivery_summary_mode,
          ...roomConfigExtra,
          updated_at: new Date().toISOString(),
        }, { onConflict: "room_id" })
        .select("*")
        .single()

      if (error) {
        throw { status: 500, message: `Failed to update room settings: ${error.message}` } satisfies AppError
      }
      const adminSurface = resolveAdminSurface(req, url)
      const { error: undismissError } = await supabase
        .from("line_room_dismissed")
        .delete()
        .eq("room_id", payload.room_id)
        .eq("admin_surface", adminSurface)
      if (undismissError) {
        throw { status: 500, message: `Failed to restore dismissed room: ${undismissError.message}` } satisfies AppError
      }
      console.log(
        "[admin-api] room settings upsert result:",
        JSON.stringify({
          room_id: data.room_id,
          is_enabled: data.is_enabled,
          bot_reply_enabled: data.bot_reply_enabled,
          bot_reply_hard_mute_enabled: data.bot_reply_hard_mute_enabled,
          message_search_enabled: data.message_search_enabled,
          message_search_library_enabled: data.message_search_library_enabled,
          media_file_access_enabled: data.media_file_access_enabled,
          image_analysis_reply_enabled: data.image_analysis_reply_enabled,
          updated_at: data.updated_at,
        }),
      )
      return json({ room_settings: stripRoomConfigSecret(data) }, 200)
    }

    if (req.method === "PUT" && path === "/permissions/users") {
      const body = await parseJson(workReq)
      const payload = buildLineUserPermissionPayload(body)
      const { data, error } = await supabase
        .from("line_user_permissions")
        .upsert({
          line_user_id: payload.line_user_id,
          display_name: payload.display_name,
          is_active: payload.is_active,
          can_message_search: payload.can_message_search,
          can_library_search: payload.can_library_search,
          can_calendar_create: payload.can_calendar_create,
          can_calendar_update: payload.can_calendar_update,
          can_calendar_view: payload.can_calendar_view,
          can_media_access: payload.can_media_access,
          excluded_message_search_room_ids: payload.excluded_message_search_room_ids,
          assigned_store: payload.assigned_store,
          assigned_job_title: payload.assigned_job_title,
          updated_at: new Date().toISOString(),
        }, { onConflict: "line_user_id" })
        .select("line_user_id, display_name, is_active, can_message_search, can_library_search, can_calendar_create, can_calendar_update, can_calendar_view, can_media_access, excluded_message_search_room_ids, assigned_store, assigned_job_title, registration_source_store, updated_at")
        .single()
      if (error) {
        throw { status: 500, message: `Failed to upsert line user permission: ${error.message}` } satisfies AppError
      }
      return json({ user_permission: data }, 200)
    }

    if (req.method === "POST" && path === "/permissions/users/backfill") {
      const result = await backfillLineUserPermissionsFromMessages(supabase)
      return json({ success: true, backfill: result }, 200)
    }

    if (req.method === "POST" && path === "/rooms/refresh-names") {
      const body = await parseJson(workReq).catch(() => ({}))
      const roomId = isRecord(body) ? String(body.room_id ?? "").trim() : ""
      const result = await refreshRoomNamesFromLine(supabase, roomId || null)
      return json({ success: true, refresh: result }, 200)
    }

    if (req.method === "POST" && path === "/rooms/sync-chat-members") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const roomId = String(body.room_id ?? "").trim()
      if (!roomId) {
        throw { status: 400, message: "room_id is required." } satisfies AppError
      }
      const sync = await syncLineUserPermissionsFromChatMembers(supabase, roomId)
      return json({ success: true, sync }, 200)
    }

    if (req.method === "DELETE" && path.startsWith("/settings/rooms/")) {
      const roomId = decodeURIComponent(path.replace("/settings/rooms/", ""))
      if (!roomId) {
        throw { status: 400, message: "room_id is required." } satisfies AppError
      }

      const { error } = await supabase
        .from("room_summary_settings")
        .delete()
        .eq("room_id", roomId)

      if (error) {
        throw { status: 500, message: `Failed to delete room settings: ${error.message}` } satisfies AppError
      }
      return json({ success: true, room_id: roomId }, 200)
    }

    if (req.method === "DELETE" && path.startsWith("/permissions/users/")) {
      const lineUserId = decodeURIComponent(path.replace("/permissions/users/", "")).trim()
      if (!lineUserId) {
        throw { status: 400, message: "line_user_id is required." } satisfies AppError
      }
      const { error } = await supabase
        .from("line_user_permissions")
        .delete()
        .eq("line_user_id", lineUserId)
      if (error) {
        throw { status: 500, message: `Failed to delete line user permission: ${error.message}` } satisfies AppError
      }
      return json({ success: true, line_user_id: lineUserId }, 200)
    }

    if (req.method === "DELETE" && path.startsWith("/rooms/")) {
      const roomId = decodeURIComponent(path.replace("/rooms/", ""))
      if (!roomId) {
        throw { status: 400, message: "room_id is required." } satisfies AppError
      }

      const adminSurface = resolveAdminSurface(req, url)
      const unregister = await unregisterRoomFromAdmin(supabase, roomId, adminSurface)
      if (!unregister.ok) {
        throw { status: 500, message: unregister.message } satisfies AppError
      }

      return json({
        success: true,
        room_id: roomId,
        unregistered: unregister.unregistered,
        retained: unregister.retained,
      }, 200)
    }

    if (req.method === "POST" && path === "/actions/run-summary") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      if (body.force != null && typeof body.force !== "boolean") {
        throw { status: 400, message: "force must be boolean when provided." } satisfies AppError
      }
      const forceRun = body.force == null ? true : body.force

      const { data: beforeLog } = await supabase
        .from("summary_delivery_logs")
        .select("id")
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle()
      const beforeId = beforeLog?.id ?? 0

      const { error: invokeError } = await supabase.rpc("invoke_summary_cron", { force_run: forceRun })
      if (invokeError) {
        throw { status: 500, message: `Failed to invoke summary cron: ${invokeError.message}` } satisfies AppError
      }

      const latestLog = await waitForNewLog(supabase, beforeId)
      if (!latestLog) {
        return json({
          success: true,
          queued: true,
          forced: forceRun,
          before_log_id: beforeId,
          latest_log: null,
          warning: "手動実行を受け付けました。ログ反映まで時間がかかっています。",
        }, 200)
      }

      return json({
        success: true,
        queued: true,
        forced: forceRun,
        before_log_id: beforeId,
        latest_log: {
          id: latestLog.id,
          run_at: latestLog.run_at,
          status: latestLog.status,
          reason: latestLog.reason,
        },
      }, 200)
    }

    if (req.method === "POST" && path === "/actions/test-receipt-report") {
      const body = await parseJson(workReq)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const roomId = String(body.room_id ?? "").trim()
      if (!roomId) {
        throw { status: 400, message: "room_id is required." } satisfies AppError
      }
      const testKey = (Deno.env.get("RECEIPT_MIDREPORT_CRON_TEST_KEY") ?? "").trim()
      if (!testKey) {
        throw {
          status: 503,
          message:
            "レポートのテスト送信が未設定です。admin-api と receipt-midreport-cron の両方に Edge secret RECEIPT_MIDREPORT_CRON_TEST_KEY（同一の値）を設定してください。",
        } satisfies AppError
      }
      const reportKindRaw = String(body.report_kind ?? "mid_month").trim().toLowerCase()
      const reportKind = reportKindRaw === "month_end" ? "month_end" : "mid_month"
      let year: number | undefined
      let month: number | undefined
      if (body.year != null) {
        const yn = Number(body.year)
        if (Number.isInteger(yn) && yn >= 2000 && yn <= 2100) year = yn
      }
      if (body.month != null) {
        const mn = Number(body.month)
        if (Number.isInteger(mn) && mn >= 1 && mn <= 12) month = mn
      }
      let storePartitionKey: string | undefined
      if (body.store_partition_key != null) {
        const rawKey = String(body.store_partition_key ?? "").trim().toLowerCase()
        if (rawKey && /^[a-z0-9]{2,120}$/.test(rawKey) && rawKey !== RECEIPT_STORE_PARTITION_UNKNOWN) {
          storePartitionKey = rawKey
        }
      }

      const { status, payload } = await invokeReceiptMidreportCronTestSend({
        supabaseUrl,
        serviceRoleKey,
        testKey,
        roomId,
        reportKind,
        year,
        month,
        storePartitionKey,
      })
      return json(payload, status)
    }

    return json({ error: "Not found." }, 404)
  } catch (e) {
    const err = asAppError(e)
    return json({ error: err.message }, err.status)
  }
})

async function authenticate(
  req: Request,
  supabase: ReturnType<typeof createClient>,
  fallbackToken: string,
): Promise<
  | { ok: true; storeScope: string | null; roomScope: string | null; scopeKind: string | null }
  | { ok: false; status: number; message: string }
> {
  const provided = req.headers.get("x-admin-token") ?? ""
  // cron から admin-api を叩く経路（週次レポート等）: Authorization: Bearer <CRON_AUTH_TOKEN|ADMIN_DASHBOARD_TOKEN>
  if (!provided) {
    const authHeader = req.headers.get("Authorization") ?? ""
    const bearer = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() ?? ""
    if (bearer) {
      const cronTok = String(Deno.env.get("CRON_AUTH_TOKEN") ?? "").trim()
      if (cronTok && secureEqual(bearer, cronTok)) {
        return { ok: true, storeScope: null, roomScope: null, scopeKind: "cron" }
      }
      // DB cron は Vault のトークンを使う。Edge Function の環境変数が未同期でも、
      // service-role 経由で同じ Vault 値と照合できれば許可する（値はレスポンスに出さない）。
      try {
        const { data: vaultCronToken } = await supabase.rpc("resolve_edge_cron_auth_token")
        const dbCronToken = String(vaultCronToken ?? "").trim()
        if (dbCronToken && secureEqual(bearer, dbCronToken)) {
          return { ok: true, storeScope: null, roomScope: null, scopeKind: "cron" }
        }
      } catch (_err) {
        // Vault 未設定時は既存の環境変数・管理トークン照合を継続する。
      }
      // vault が ADMIN_DASHBOARD_TOKEN と同値で運用されている場合も許可
      if (fallbackToken && secureEqual(bearer, fallbackToken)) {
        return { ok: true, storeScope: null, roomScope: null, scopeKind: null }
      }
    }
    return { ok: false, status: 401, message: "Unauthorized." }
  }

  const session = await authenticateAdminDashboardSessionToken(supabase, provided)
  if (session.ok) {
    // ログインリンク由来のセッションは storeScope か roomScope を持つ＝その店舗/ルームだけに制限。
    return {
      ok: true,
      storeScope: session.storeScope,
      roomScope: session.roomScope,
      scopeKind: session.scopeKind,
    }
  }

  const raw = await authenticateRawAdminToken(provided, supabase, fallbackToken)
  if (raw.ok) {
    return { ok: true, storeScope: null, roomScope: null, scopeKind: null } // 生adminトークン＝全店アクセス
  }
  return raw
}

async function authenticateRawAdminToken(
  provided: string,
  supabase: ReturnType<typeof createClient>,
  fallbackToken: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const token = String(provided ?? "")
  if (!token) {
    return { ok: false, status: 401, message: "Unauthorized." }
  }

  const dbHashResult = await getStoredAdminTokenHash(supabase)
  if (!dbHashResult.ok) {
    return dbHashResult
  }

  if (dbHashResult.hash) {
    const providedHash = await hashToken(token)
    if (secureEqual(providedHash, dbHashResult.hash)) {
      return { ok: true }
    }
    return { ok: false, status: 401, message: "Unauthorized." }
  }

  if (!fallbackToken) {
    return { ok: false, status: 500, message: "ADMIN_DASHBOARD_TOKEN is not configured." }
  }

  if (!secureEqual(token, fallbackToken)) {
    return { ok: false, status: 401, message: "Unauthorized." }
  }

  return { ok: true }
}

async function getStoredAdminTokenHash(
  supabase: ReturnType<typeof createClient>,
): Promise<{ ok: true; hash: string | null } | { ok: false; status: number; message: string }> {
  const { data, error } = await supabase
    .from("summary_settings")
    .select("admin_dashboard_token_hash")
    .eq("id", 1)
    .maybeSingle()

  if (error) {
    return { ok: false, status: 500, message: `Failed to load admin token settings: ${error.message}` }
  }

  const hash = typeof data?.admin_dashboard_token_hash === "string"
    ? data.admin_dashboard_token_hash.trim()
    : ""
  return { ok: true, hash: hash || null }
}

async function hashToken(value: string): Promise<string> {
  const input = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", input)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

async function fetchState(
  supabase: ReturnType<typeof createClient>,
  url: URL,
  adminSurface: string,
) {
  const logsLimit = clampInt(url.searchParams.get("logs_limit"), 100, 10, 200)
  const logsFetchLimit = logsLimit * 8
  const webhookStoreKeyRaw = String(url.searchParams.get("webhook_store_key") ?? "").trim().toLowerCase()

  const globalSettings = await fetchGlobalSettings(supabase)
  let webhookLogsQuery = supabase
    .from("line_webhook_delivery_logs")
    .select("id, created_at, jst_hour, status, reason, method, context, line_send_attempted, line_send_success, line_http_status, target_room_id, store_partition_key, details")
    .order("id", { ascending: false })
    .limit(logsFetchLimit)
  if (webhookStoreKeyRaw) {
    webhookLogsQuery = webhookLogsQuery.eq("store_partition_key", webhookStoreKeyRaw)
  }

  const [roomSettingsRes, roomOverviewRes, logsRes, webhookLogsRes, storageUsageState, userPermissionsRes, pushUsageSummary] =
    await Promise.all([
      supabase
        .from("room_summary_settings")
        .select("*")
        .order("updated_at", { ascending: false }),
      supabase.rpc("get_room_overview", { p_admin_surface: adminSurface }),
      supabase
        .from("summary_delivery_logs")
        .select("id, run_at, jst_hour, status, reason, should_send_overall, rooms_targeted, messages_in_queue, messages_marked_processed, line_send_attempted, line_send_success, line_http_status, target_room_id, details")
        .order("id", { ascending: false })
        .limit(logsFetchLimit),
      webhookLogsQuery,
      fetchStorageUsageState(supabase),
      supabase
        .from("line_user_permissions")
        .select("line_user_id, display_name, is_active, can_message_search, can_library_search, can_calendar_create, can_calendar_update, can_calendar_view, can_media_access, excluded_message_search_room_ids, assigned_store, assigned_job_title, registration_source_store, updated_at")
        .limit(USER_PERMISSION_SORT_FETCH_CAP),
      fetchMonthlyPushUsageSummary(supabase),
    ])

  if (roomSettingsRes.error) {
    throw { status: 500, message: `Failed to fetch room settings: ${roomSettingsRes.error.message}` } satisfies AppError
  }
  if (roomOverviewRes.error) {
    throw { status: 500, message: `Failed to fetch room overview: ${roomOverviewRes.error.message}` } satisfies AppError
  }
  if (logsRes.error) {
    throw { status: 500, message: `Failed to fetch delivery logs: ${logsRes.error.message}` } satisfies AppError
  }
  if (webhookLogsRes.error) {
    throw { status: 500, message: `Failed to fetch webhook delivery logs: ${webhookLogsRes.error.message}` } satisfies AppError
  }
  if (userPermissionsRes.error) {
    throw { status: 500, message: `Failed to fetch user permissions: ${userPermissionsRes.error.message}` } satisfies AppError
  }

  const filteredLogs = (logsRes.data ?? [])
    .filter((row) => isActionableDeliveryLogStatus(row.status, row.details))
    .slice(0, logsLimit)

  const { data: consoleSettingsRows } = await supabase
    .from("line_admin_console_settings")
    .select("setting_key, setting_value")
  const consoleSettings: Record<string, string> = {}
  for (const row of (Array.isArray(consoleSettingsRows) ? consoleSettingsRows : [])) {
    const k = String((row as { setting_key?: unknown })?.setting_key ?? "").trim()
    if (k) consoleSettings[k] = String((row as { setting_value?: unknown })?.setting_value ?? "")
  }

  return {
    global_settings: globalSettings,
    console_settings: consoleSettings,
    room_settings: (roomSettingsRes.data ?? []).map((r) => stripRoomConfigSecret(r as Record<string, unknown>)),
    user_permissions: sortLineUserPermissionsForAdminDisplay(userPermissionsRes.data ?? []).slice(
      0,
      USER_PERMISSION_LIST_MAX_LIMIT,
    ),
    marugo_group_store_options: [...MARUGO_GROUP_STORE_OPTIONS],
    receipt_store_options: await fetchStorePartitionReceiptOptions(supabase),
    job_title_options: [...JOB_TITLE_OPTIONS],
    room_overview: roomOverviewRes.data ?? [],
    delivery_logs: filteredLogs,
    webhook_delivery_logs: (webhookLogsRes.data ?? []).slice(0, logsLimit),
    push_usage_monthly: pushUsageSummary,
    storage_usage: storageUsageState.stats,
    storage_usage_error: storageUsageState.error,
    generated_at: new Date().toISOString(),
  }
}

function getCurrentJstMonthUtcBounds(): { monthLabel: string; startUtcIso: string; endUtcIso: string } {
  const now = new Date()
  const nowJstMs = now.getTime() + 9 * 60 * 60 * 1000
  const nowJst = new Date(nowJstMs)
  const y = nowJst.getUTCFullYear()
  const m = nowJst.getUTCMonth()
  const startUtc = new Date(Date.UTC(y, m, 1, 0, 0, 0) - (9 * 60 * 60 * 1000))
  const endUtc = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0) - (9 * 60 * 60 * 1000))
  return {
    monthLabel: `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}`,
    startUtcIso: startUtc.toISOString(),
    endUtcIso: endUtc.toISOString(),
  }
}

type PushUsageItem = { source: string; context: string; count: number }
type PushByStore = { store_key: string; push: number; reply: number; total: number }
type PushByRoom = { room_id: string; room_name: string; store_key: string; push: number; reply: number; total: number }

// 当月(JST)の LINE 送信量を「実際の全送信元テーブル」から集計する。
//  - LINE PUSH（定期・ジョブ・枠を消費）: gmail予約通知 / 本日の予約配信 / 東京ドーム週次 / レシート報告 /
//    line_webhook(method='push') / summary_delivery_logs(成功)。各テーブルに分散記録されているため全部見る。
//  - WEBHOOK PUSH（メッセージ受信による返信）: line_webhook_delivery_logs(method='reply', 成功)。返信は枠を消費しない。
//  - ルーム別・店舗別にもカウント（room_id→店舗は room_summary_settings で対応付け）。
async function fetchMonthlyPushUsageSummary(
  supabase: ReturnType<typeof createClient>,
): Promise<{
  month_jst: string
  total_push_rows: number
  webhook_push_rows: number
  summary_push_rows: number
  webhook_reply_rows: number
  webhook_success_rows: number
  free_quota_limit: number
  free_quota_remaining: number
  by_source_context: PushUsageItem[]
  by_store: PushByStore[]
  by_room: PushByRoom[]
}> {
  const bounds = getCurrentJstMonthUtcBounds()
  const lo = bounds.startUtcIso, hi = bounds.endUtcIso
  const [webhookRes, summaryRes, gmailRes, resvTodayRes, domeRes, receiptRes, roomMapRes] = await Promise.all([
    supabase.from("line_webhook_delivery_logs").select("method, target_room_id, store_partition_key, context")
      .eq("line_send_success", true).gte("created_at", lo).lt("created_at", hi),
    supabase.from("summary_delivery_logs").select("target_room_id, reason, details")
      .eq("line_send_attempted", true).eq("line_send_success", true).gte("run_at", lo).lt("run_at", hi),
    supabase.from("gmail_reservation_alert_logs").select("line_target_room_id")
      .not("line_message_sent_at", "is", null).gte("line_message_sent_at", lo).lt("line_message_sent_at", hi),
    supabase.from("reservation_today_alert_logs").select("room_id, store_partition_key").gte("sent_at", lo).lt("sent_at", hi),
    supabase.from("tokyo_dome_weekly_logs").select("room_id, store_partition_key").gte("sent_at", lo).lt("sent_at", hi),
    supabase.from("line_receipt_mid_reports").select("room_id, report_kind").gte("sent_at", lo).lt("sent_at", hi),
    supabase.from("room_summary_settings").select("room_id, room_name, receipt_report_store_partition_key"),
  ])
  const dataOf = (res: { data?: unknown }) => (Array.isArray(res?.data) ? res.data as Array<Record<string, unknown>> : [])

  const roomToStore = new Map<string, string>()
  const roomToName = new Map<string, string>()
  for (const r of dataOf(roomMapRes)) {
    const rid = String(r.room_id ?? "").trim()
    const sk = String(r.receipt_report_store_partition_key ?? "").trim().toLowerCase()
    const nm = String(r.room_name ?? "").trim()
    if (rid && sk) roomToStore.set(rid, sk)
    if (rid && nm) roomToName.set(rid, nm)
  }
  const storeOf = (roomId: unknown, storeKey: unknown): string => {
    const sk = String(storeKey ?? "").trim().toLowerCase()
    if (sk) return sk
    const rid = String(roomId ?? "").trim()
    return rid ? (roomToStore.get(rid) ?? "") : ""
  }

  const srcCounter = new Map<string, number>()
  const byRoom = new Map<string, { store: string; push: number; reply: number }>()
  const byStore = new Map<string, { push: number; reply: number }>()
  const addSrc = (source: string, context: string) => {
    const k = `${source}\t${context || "unknown"}`
    srcCounter.set(k, (srcCounter.get(k) ?? 0) + 1)
  }
  const add = (roomId: unknown, store: string, kind: "push" | "reply", source?: string, context?: string) => {
    const rid = String(roomId ?? "").trim()
    if (rid) {
      const e = byRoom.get(rid) ?? { store: store || "", push: 0, reply: 0 }
      e[kind] += 1
      if (store && !e.store) e.store = store
      byRoom.set(rid, e)
    }
    if (store) {
      const s = byStore.get(store) ?? { push: 0, reply: 0 }
      s[kind] += 1
      byStore.set(store, s)
    }
    if (kind === "push" && source) addSrc(source, context ?? "")
  }

  let pushTotal = 0, replyTotal = 0
  for (const r of dataOf(webhookRes)) {
    const method = String(r.method ?? "").trim()
    const store = storeOf(r.target_room_id, r.store_partition_key)
    if (method === "reply") { replyTotal += 1; add(r.target_room_id, store, "reply") }
    else { pushTotal += 1; add(r.target_room_id, store, "push", "LINE webhook", String(r.context ?? "").trim() || "push") }
  }
  for (const r of dataOf(summaryRes)) {
    const details = (r.details && typeof r.details === "object") ? r.details as Record<string, unknown> : {}
    const source = String(details.source ?? "summary").trim() || "summary"
    const context = String(details.context ?? "").trim() || String(r.reason ?? "").trim() || "summary"
    pushTotal += 1; add(r.target_room_id, storeOf(r.target_room_id, ""), "push", source, context)
  }
  for (const r of dataOf(gmailRes)) {
    pushTotal += 1; add(r.line_target_room_id, storeOf(r.line_target_room_id, ""), "push", "Gmail予約通知", "予約メール")
  }
  for (const r of dataOf(resvTodayRes)) {
    pushTotal += 1; add(r.room_id, storeOf(r.room_id, r.store_partition_key), "push", "本日の予約配信", "daily")
  }
  for (const r of dataOf(domeRes)) {
    pushTotal += 1; add(r.room_id, storeOf(r.room_id, r.store_partition_key), "push", "東京ドーム週次配信", "weekly")
  }
  for (const r of dataOf(receiptRes)) {
    pushTotal += 1; add(r.room_id, storeOf(r.room_id, ""), "push", "レシートレポート", String(r.report_kind ?? "").trim() || "report")
  }

  const bySourceContext: PushUsageItem[] = Array.from(srcCounter.entries())
    .map(([k, count]) => { const [source, context] = k.split("\t"); return { source: source || "unknown", context: context || "unknown", count } })
    .sort((a, b) => (b.count - a.count) || a.source.localeCompare(b.source))
  const byStoreArr: PushByStore[] = Array.from(byStore.entries())
    .map(([store_key, v]) => ({ store_key, push: v.push, reply: v.reply, total: v.push + v.reply }))
    .sort((a, b) => b.total - a.total)
  const byRoomArr: PushByRoom[] = Array.from(byRoom.entries())
    .map(([room_id, v]) => ({ room_id, room_name: roomToName.get(room_id) ?? "", store_key: v.store, push: v.push, reply: v.reply, total: v.push + v.reply }))
    .sort((a, b) => b.total - a.total)

  return {
    month_jst: bounds.monthLabel,
    total_push_rows: pushTotal,       // LINE PUSH（定期・ジョブ＝枠を消費）
    webhook_push_rows: replyTotal,    // WEBHOOK PUSH（メッセージ受信による返信）
    summary_push_rows: pushTotal,     // 後方互換（合計push）
    webhook_reply_rows: replyTotal,
    webhook_success_rows: pushTotal + replyTotal,
    free_quota_limit: 200,
    free_quota_remaining: Math.max(0, 200 - pushTotal),
    by_source_context: bySourceContext,
    by_store: byStoreArr,
    by_room: byRoomArr,
  }
}

async function fetchLineUserPermissions(
  supabase: ReturnType<typeof createClient>,
  url: URL,
) {
  const limit = clampInt(url.searchParams.get("limit"), USER_PERMISSION_LIST_DEFAULT_LIMIT, 1, USER_PERMISSION_LIST_MAX_LIMIT)
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1000000)
  const q = String(url.searchParams.get("q") ?? "").trim()

  let query = supabase
    .from("line_user_permissions")
    .select("line_user_id, display_name, is_active, can_message_search, can_library_search, can_calendar_create, can_calendar_update, can_calendar_view, can_media_access, excluded_message_search_room_ids, assigned_store, assigned_job_title, registration_source_store, updated_at", { count: "exact" })
    .limit(USER_PERMISSION_SORT_FETCH_CAP)

  if (q) {
    const escaped = q.replaceAll("%", "\\%").replaceAll("_", "\\_")
    query = query.or(`line_user_id.ilike.%${escaped}%,display_name.ilike.%${escaped}%`)
  }

  const { data, error, count } = await query
  if (error) {
    throw { status: 500, message: `Failed to fetch user permissions: ${error.message}` } satisfies AppError
  }

  const rows = Array.isArray(data) ? data : []
  const sorted = sortLineUserPermissionsForAdminDisplay(rows)
  const paged = sorted.slice(offset, offset + limit)
  const safeTotal = Number.isFinite(Number(count)) ? Number(count) : sorted.length
  const nextOffset = offset + paged.length
  return {
    items: paged,
    total: safeTotal,
    limit,
    offset,
    has_more: nextOffset < safeTotal,
    next_offset: nextOffset < safeTotal ? nextOffset : null,
    generated_at: new Date().toISOString(),
  }
}

async function backfillLineUserPermissionsFromMessages(
  supabase: ReturnType<typeof createClient>,
) {
  const pageSize = 1000
  const userIds = new Set<string>()
  const latestRoomIdByUserId = new Map<string, string>()
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from("line_messages")
      .select("user_id, room_id, id")
      .not("user_id", "is", null)
      .neq("user_id", "")
      .order("id", { ascending: false })
      .range(offset, offset + pageSize - 1)
    if (error) {
      throw { status: 500, message: `Failed to scan line_messages users: ${error.message}` } satisfies AppError
    }
    const rows = Array.isArray(data) ? data : []
    if (rows.length === 0) break
    for (const row of rows) {
      const userId = String((row as { user_id?: unknown })?.user_id ?? "").trim()
      if (!userId) continue
      userIds.add(userId)
      if (!latestRoomIdByUserId.has(userId)) {
        const roomId = String((row as { room_id?: unknown })?.room_id ?? "").trim()
        if (roomId) latestRoomIdByUserId.set(userId, roomId)
      }
    }
    if (rows.length < pageSize) break
    offset += pageSize
  }

  // Include users that already exist in permission table (for display-name recovery).
  offset = 0
  while (true) {
    const { data, error } = await supabase
      .from("line_user_permissions")
      .select("line_user_id")
      .range(offset, offset + pageSize - 1)
    if (error) {
      throw { status: 500, message: `Failed to scan line_user_permissions users: ${error.message}` } satisfies AppError
    }
    const rows = Array.isArray(data) ? data : []
    if (rows.length === 0) break
    for (const row of rows) {
      const lineUserId = String((row as { line_user_id?: unknown })?.line_user_id ?? "").trim()
      if (lineUserId) userIds.add(lineUserId)
    }
    if (rows.length < pageSize) break
    offset += pageSize
  }

  const allUserIds = Array.from(userIds)
  if (allUserIds.length === 0) {
    return {
      scanned_user_ids: 0,
      inserted: 0,
      already_existing: 0,
      display_name_updated: 0,
    }
  }

  const existingNameByUserId = new Map<string, string | null>()
  for (let i = 0; i < allUserIds.length; i += pageSize) {
    const chunk = allUserIds.slice(i, i + pageSize)
    const { data: existingRows, error: existingError } = await supabase
      .from("line_user_permissions")
      .select("line_user_id, display_name")
      .in("line_user_id", chunk)
    if (existingError) {
      throw { status: 500, message: `Failed to inspect existing user permissions: ${existingError.message}` } satisfies AppError
    }
    for (const row of existingRows ?? []) {
      const lineUserId = String((row as { line_user_id?: unknown })?.line_user_id ?? "").trim()
      if (!lineUserId) continue
      const displayName = String((row as { display_name?: unknown })?.display_name ?? "").trim()
      existingNameByUserId.set(lineUserId, displayName || null)
    }
  }

  const existingSet = new Set(Array.from(existingNameByUserId.keys()))
  const lineAccessToken = String(Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "").trim()
  const idsNeedingDisplayName = allUserIds.filter((lineUserId) => {
    const displayName = existingNameByUserId.get(lineUserId)
    return !displayName
  })
  const fetchedDisplayNameByUserId = lineAccessToken
    ? await fetchLineDisplayNamesByUserIds(idsNeedingDisplayName, latestRoomIdByUserId, lineAccessToken)
    : new Map<string, string>()

  const now = new Date().toISOString()
  const inserts = allUserIds
    .filter((id) => !existingSet.has(id))
    .map((lineUserId) => ({
      line_user_id: lineUserId,
      display_name: fetchedDisplayNameByUserId.get(lineUserId) ?? null,
      is_active: true,
      can_message_search: true,
      can_library_search: true,
      can_calendar_create: true,
      can_calendar_update: true,
      can_calendar_view: true,
      can_media_access: true,
      assigned_store: null,
      assigned_job_title: null,
      updated_at: now,
    }))

  if (inserts.length > 0) {
    const { error: insertError } = await supabase
      .from("line_user_permissions")
      .insert(inserts, { defaultToNull: false, ignoreDuplicates: true })
    if (insertError) {
      throw { status: 500, message: `Failed to backfill user permissions: ${insertError.message}` } satisfies AppError
    }
  }

  let displayNameUpdated = 0
  const existingNeedDisplayNameIds = allUserIds.filter((lineUserId) => {
    if (!existingSet.has(lineUserId)) return false
    const currentName = existingNameByUserId.get(lineUserId)
    return !currentName && !!fetchedDisplayNameByUserId.get(lineUserId)
  })
  for (const lineUserId of existingNeedDisplayNameIds) {
    const displayName = fetchedDisplayNameByUserId.get(lineUserId)
    if (!displayName) continue
    const { error: updateError } = await supabase
      .from("line_user_permissions")
      .update({
        display_name: displayName,
        updated_at: new Date().toISOString(),
      })
      .eq("line_user_id", lineUserId)
    if (updateError) {
      throw { status: 500, message: `Failed to update display_name for ${lineUserId}: ${updateError.message}` } satisfies AppError
    }
    displayNameUpdated += 1
  }

  return {
    scanned_user_ids: allUserIds.length,
    inserted: inserts.length,
    already_existing: allUserIds.length - inserts.length,
    display_name_updated: displayNameUpdated,
  }
}

async function fetchLineDisplayNamesByUserIds(
  lineUserIds: string[],
  latestRoomIdByUserId: Map<string, string>,
  lineAccessToken: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const lineUserId of lineUserIds) {
    const userId = String(lineUserId ?? "").trim()
    if (!userId) continue
    const roomId = String(latestRoomIdByUserId.get(userId) ?? "").trim()
    const displayName = await fetchLineDisplayNameByUserId(userId, roomId, lineAccessToken)
    if (displayName) {
      result.set(userId, displayName)
    }
  }
  return result
}

async function fetchLineDisplayNameByUserId(
  lineUserId: string,
  roomId: string,
  lineAccessToken: string,
): Promise<string | null> {
  if (roomId.startsWith("C")) {
    const byGroupMember = await fetchLineDisplayNameByUrl(
      `https://api.line.me/v2/bot/group/${encodeURIComponent(roomId)}/member/${encodeURIComponent(lineUserId)}`,
      lineAccessToken,
    )
    if (byGroupMember) return byGroupMember
  } else if (roomId.startsWith("R")) {
    const byRoomMember = await fetchLineDisplayNameByUrl(
      `https://api.line.me/v2/bot/room/${encodeURIComponent(roomId)}/member/${encodeURIComponent(lineUserId)}`,
      lineAccessToken,
    )
    if (byRoomMember) return byRoomMember
  }

  return await fetchLineDisplayNameByUrl(
    `https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`,
    lineAccessToken,
  )
}

async function fetchLineDisplayNameByUrl(
  url: string,
  lineAccessToken: string,
): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${lineAccessToken}`,
      },
    })
    if (!response.ok) {
      return null
    }
    const body = await response.json()
    const displayName = String(body?.displayName ?? "").trim()
    return displayName || null
  } catch {
    return null
  }
}

async function fetchLineChatMemberIdsPaginated(
  roomId: string,
  lineAccessToken: string,
): Promise<string[]> {
  const rid = String(roomId ?? "").trim()
  if (!rid) {
    throw { status: 400, message: "room_id is required." } satisfies AppError
  }
  let baseUrl: string
  if (rid.startsWith("C")) {
    baseUrl = `https://api.line.me/v2/bot/group/${encodeURIComponent(rid)}/members/ids`
  } else if (rid.startsWith("R")) {
    baseUrl = `https://api.line.me/v2/bot/room/${encodeURIComponent(rid)}/members/ids`
  } else {
    throw {
      status: 400,
      message: "room_id must be a LINE group (C...) or multi-person chat room (R...).",
    } satisfies AppError
  }

  const all: string[] = []
  let start: string | undefined
  for (let page = 0; page < 500; page++) {
    const url = start ? `${baseUrl}?start=${encodeURIComponent(start)}` : baseUrl
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${lineAccessToken}`,
      },
    })
    const errorText = await response.text()
    if (!response.ok) {
      const detail = errorText.trim().slice(0, 400)
      if (response.status === 403) {
        let lineApiMessage = ""
        try {
          const j = JSON.parse(errorText) as { message?: unknown }
          if (typeof j?.message === "string") lineApiMessage = j.message.trim()
        } catch {
          // ignore
        }
        throw {
          status: 403,
          message: [
            "LINE の「グループ／トークのメンバー ID 一覧（members/ids）」は、このチャネルでは利用できません（403）。",
            "公式ドキュメント上、この API は認証済みアカウントまたはプレミアムアカウントの LINE 公式アカウントに限定されています。未認証の通常アカウントではメンバー同期は実行できません。",
            "代替: メンバーがトークでメッセージを送るたびに Webhook で userId が取得できるため、従来どおり「既存ユーザー取込」や運用でユーザー権限に反映できます。",
            "参考: https://developers.line.biz/en/docs/messaging-api/getting-user-ids/",
            lineApiMessage ? `（LINE API: ${lineApiMessage}）` : (detail ? `（応答: ${detail.slice(0, 240)}）` : ""),
          ].filter((s) => s.length > 0).join("\n"),
        } satisfies AppError
      }
      throw {
        status: response.status === 404 ? 404 : 502,
        message: `LINE members/ids failed (${response.status}): ${detail || response.statusText}`,
      } satisfies AppError
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(errorText)
    } catch {
      throw { status: 502, message: "LINE members/ids returned invalid JSON." } satisfies AppError
    }
    const body = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
    const idsRaw = body.memberIds
    const ids = Array.isArray(idsRaw) ? idsRaw : []
    for (const id of ids) {
      const u = String(id ?? "").trim()
      if (u) all.push(u)
    }
    const next = body.next
    if (typeof next === "string" && next.length > 0) {
      start = next
      continue
    }
    break
  }
  return Array.from(new Set(all))
}

async function syncLineUserPermissionsFromChatMembers(
  supabase: ReturnType<typeof createClient>,
  roomId: string,
): Promise<{
  room_id: string
  chat_kind: "group" | "room"
  member_ids: number
  inserted: number
  updated: number
  display_name_missing: number
  errors: string[]
}> {
  const normalizedRoomId = String(roomId ?? "").trim()
  const lineAccessToken = String(Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "").trim()
  if (!lineAccessToken) {
    throw { status: 500, message: "LINE_CHANNEL_ACCESS_TOKEN is not set." } satisfies AppError
  }

  const memberIds = await fetchLineChatMemberIdsPaginated(normalizedRoomId, lineAccessToken)
  const chatKind: "group" | "room" = normalizedRoomId.startsWith("C") ? "group" : "room"
  let inserted = 0
  let updated = 0
  let displayNameMissing = 0
  const errors: string[] = []
  const now = new Date().toISOString()

  for (const lineUserId of memberIds) {
    const displayName = await fetchLineDisplayNameByUserId(lineUserId, normalizedRoomId, lineAccessToken)
    if (!displayName) {
      displayNameMissing += 1
    }

    const { data: existing, error: selErr } = await supabase
      .from("line_user_permissions")
      .select("line_user_id")
      .eq("line_user_id", lineUserId)
      .maybeSingle()

    if (selErr) {
      errors.push(`${lineUserId}: ${selErr.message}`)
      continue
    }

    if (existing?.line_user_id) {
      const patch: Record<string, unknown> = { updated_at: now }
      if (displayName) {
        patch.display_name = displayName
      }
      const { error: upErr } = await supabase
        .from("line_user_permissions")
        .update(patch)
        .eq("line_user_id", lineUserId)
      if (upErr) {
        errors.push(`${lineUserId}: ${upErr.message}`)
        continue
      }
      updated += 1
    } else {
      const { error: insErr } = await supabase
        .from("line_user_permissions")
        .insert({
          line_user_id: lineUserId,
          display_name: displayName,
          is_active: false,
          can_message_search: false,
          can_library_search: false,
          can_calendar_create: false,
          can_calendar_update: false,
          can_calendar_view: false,
          can_media_access: false,
          excluded_message_search_room_ids: [],
          assigned_store: null,
          assigned_job_title: null,
          updated_at: now,
        })
      if (insErr) {
        errors.push(`${lineUserId}: ${insErr.message}`)
        continue
      }
      inserted += 1
    }
  }

  return {
    room_id: normalizedRoomId,
    chat_kind: chatKind,
    member_ids: memberIds.length,
    inserted,
    updated,
    display_name_missing: displayNameMissing,
    errors,
  }
}

/**
 * 設定済みの LINE チャネルアクセストークンを全て収集する。
 * ユーザー/グループは店舗Bot・承認Botなど別チャネルを友だち追加していることがあり、
 * 単一トークンだと /profile・/summary が 404 になる。全トークンで順に試すために使う。
 * env: LINE_CHANNEL_ACCESS_TOKEN（全体）＋ LINE_CHANNEL_ACCESS_TOKEN__{店舗キー}
 */
function collectAllLineChannelTokens(): string[] {
  const env = Deno.env.toObject()
  const tokens: string[] = []
  const seen = new Set<string>()
  const globalToken = String(env["LINE_CHANNEL_ACCESS_TOKEN"] ?? "").trim()
  if (globalToken) {
    seen.add(globalToken)
    tokens.push(globalToken)
  }
  for (const [key, value] of Object.entries(env)) {
    if (!/^LINE_CHANNEL_ACCESS_TOKEN__.+/.test(key)) continue
    const token = String(value ?? "").trim()
    if (token && !seen.has(token)) {
      seen.add(token)
      tokens.push(token)
    }
  }
  return tokens
}

async function refreshRoomNamesFromLine(
  supabase: ReturnType<typeof createClient>,
  roomId: string | null,
) {
  const lineAccessTokens = collectAllLineChannelTokens()
  if (lineAccessTokens.length === 0) {
    throw { status: 500, message: "LINE_CHANNEL_ACCESS_TOKEN is not set." } satisfies AppError
  }

  const roomIds = new Set<string>()
  if (roomId) {
    roomIds.add(roomId)
  } else {
    const { data, error } = await supabase.rpc("get_room_overview")
    if (error) {
      throw { status: 500, message: `Failed to fetch room overview for name refresh: ${error.message}` } satisfies AppError
    }
    const rows = Array.isArray(data) ? data : []
    for (const row of rows) {
      const id = String((row as { room_id?: unknown })?.room_id ?? "").trim()
      if (id) roomIds.add(id)
    }
  }

  let refreshed = 0
  let attempted = 0
  let notFound = 0
  const now = new Date().toISOString()
  for (const id of roomIds) {
    attempted += 1
    // 友だち追加先のチャネルが店舗ごとに異なるため、全トークンで順に試す
    let name: string | null = null
    for (const token of lineAccessTokens) {
      name = await fetchLineConversationNameByRoomId(id, token)
      if (name) break
    }
    if (!name) {
      notFound += 1
      continue
    }

    const { error: settingsError } = await supabase
      .from("room_summary_settings")
      .update({
        room_name: name,
        updated_at: now,
      })
      .eq("room_id", id)
    if (settingsError) {
      throw { status: 500, message: `Failed to refresh room name in settings (${id}): ${settingsError.message}` } satisfies AppError
    }

    const { error: cacheError } = await supabase
      .from("line_room_names")
      .upsert({
        room_id: id,
        room_name: name,
        updated_at: now,
      }, { onConflict: "room_id" })
    if (cacheError) {
      throw { status: 500, message: `Failed to refresh room name in cache (${id}): ${cacheError.message}` } satisfies AppError
    }

    refreshed += 1
  }

  return {
    attempted,
    refreshed,
    not_found: notFound,
    generated_at: now,
  }
}

async function fetchLineConversationNameByRoomId(
  roomId: string,
  lineAccessToken: string,
): Promise<string | null> {
  const normalizedRoomId = String(roomId ?? "").trim()
  if (!normalizedRoomId) return null

  if (normalizedRoomId.startsWith("C")) {
    return await fetchLineConversationNameByUrl(
      `https://api.line.me/v2/bot/group/${encodeURIComponent(normalizedRoomId)}/summary`,
      lineAccessToken,
      "groupName",
    )
  }
  if (normalizedRoomId.startsWith("R")) {
    return await fetchLineConversationNameByUrl(
      `https://api.line.me/v2/bot/room/${encodeURIComponent(normalizedRoomId)}/summary`,
      lineAccessToken,
      "roomName",
    )
  }
  if (normalizedRoomId.startsWith("U")) {
    return await fetchLineConversationNameByUrl(
      `https://api.line.me/v2/bot/profile/${encodeURIComponent(normalizedRoomId)}`,
      lineAccessToken,
      "displayName",
    )
  }
  return null
}

async function fetchLineConversationNameByUrl(
  url: string,
  lineAccessToken: string,
  key: "groupName" | "roomName" | "displayName",
): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${lineAccessToken}`,
      },
    })
    if (!response.ok) {
      return null
    }
    const body = await response.json()
    const value = String(body?.[key] ?? "").trim()
    return value || null
  } catch {
    return null
  }
}

type ReceiptSheetsPilotLinkState = {
  configured: boolean
  spreadsheet_id: string | null
  spreadsheet_url: string | null
  store_partition_key: string | null
  store_display_name: string | null
  suggested_google_user: string | null
  access_note: string
}

async function fetchReceiptSheetsPilotLinkState(): Promise<ReceiptSheetsPilotLinkState> {
  const spreadsheetId = String(Deno.env.get("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID") ?? "").trim()
  const suggestedGoogleUser = String(Deno.env.get("RECEIPT_SHEETS_PILOT_SUGGESTED_GOOGLE_USER") ?? "").trim() || null
  const accessNote =
    "Google スプレッドシート連携は **全店舗** 対応です。" +
    "スプレッドシート内の `{店舗キー}_月間予算` / `{店舗キー}_過去売上` / `{店舗キー}_日次売上` タブごとに同期されます。" +
    "シートはブラウザにログイン中の Google アカウントで開きます。編集にはシートの共有（編集者）が必要です。"

  if (!spreadsheetId) {
    return {
      configured: false,
      spreadsheet_id: null,
      spreadsheet_url: null,
      store_partition_key: null,
      store_display_name: null,
      suggested_google_user: null,
      access_note: "サーバーに RECEIPT_SHEETS_PILOT_SPREADSHEET_ID が未設定のため、リンクを出せません。",
    }
  }

  let spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`
  if (suggestedGoogleUser) {
    spreadsheetUrl += `?authuser=${encodeURIComponent(suggestedGoogleUser)}`
  }

  return {
    configured: true,
    spreadsheet_id: spreadsheetId,
    spreadsheet_url: spreadsheetUrl,
    store_partition_key: null,
    store_display_name: "全店舗",
    suggested_google_user: suggestedGoogleUser,
    access_note: accessNote,
  }
}

async function fetchGmailLinkedAccountState(): Promise<GmailLinkedAccountState> {
  const checkedAt = new Date().toISOString()
  const clientId = String(Deno.env.get("GMAIL_CLIENT_ID") ?? "").trim()
  const clientSecret = String(Deno.env.get("GMAIL_CLIENT_SECRET") ?? "").trim()
  const refreshToken = String(Deno.env.get("GMAIL_REFRESH_TOKEN") ?? "").trim()

  const hasAnyCredential = !!clientId || !!clientSecret || !!refreshToken
  const enabled = parseBooleanEnv(Deno.env.get("GMAIL_ALERT_ENABLED"), hasAnyCredential)
  const configured = !!clientId && !!clientSecret && !!refreshToken

  if (!enabled) {
    return {
      enabled: false,
      configured,
      email_address: null,
      history_id: null,
      checked_at: checkedAt,
      error: null,
    }
  }

  if (!configured) {
    const missing: string[] = []
    if (!clientId) missing.push("GMAIL_CLIENT_ID")
    if (!clientSecret) missing.push("GMAIL_CLIENT_SECRET")
    if (!refreshToken) missing.push("GMAIL_REFRESH_TOKEN")
    return {
      enabled: true,
      configured: false,
      email_address: null,
      history_id: null,
      checked_at: checkedAt,
      error: `Missing Gmail secrets: ${missing.join(", ")}`,
    }
  }

  const tokenState = await fetchGmailAccessTokenByRefreshToken(clientId, clientSecret, refreshToken)
  if (!tokenState.ok) {
    return {
      enabled: true,
      configured: true,
      email_address: null,
      history_id: null,
      checked_at: checkedAt,
      error: tokenState.error,
    }
  }

  const profileState = await fetchGmailProfile(tokenState.accessToken)
  if (!profileState.ok) {
    return {
      enabled: true,
      configured: true,
      email_address: null,
      history_id: null,
      checked_at: checkedAt,
      error: profileState.error,
    }
  }

  return {
    enabled: true,
    configured: true,
    email_address: profileState.emailAddress,
    history_id: profileState.historyId,
    checked_at: checkedAt,
    error: null,
  }
}

async function fetchGmailAccessTokenByRefreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  try {
    const body = new URLSearchParams()
    body.set("client_id", clientId)
    body.set("client_secret", clientSecret)
    body.set("refresh_token", refreshToken)
    body.set("grant_type", "refresh_token")

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
    const text = await response.text()
    if (!response.ok) {
      return {
        ok: false,
        error: `Gmail token取得エラー (${response.status}): ${extractGoogleApiErrorMessage(text)}`,
      }
    }

    const data = parseJsonObjectSafe(text)
    const accessToken = typeof data?.access_token === "string" ? data.access_token.trim() : ""
    if (!accessToken) {
      return { ok: false, error: "Gmail token取得エラー: access_token が空です。" }
    }
    return { ok: true, accessToken }
  } catch (error) {
    return {
      ok: false,
      error: `Gmail token取得エラー: ${sanitizeSingleLine(error instanceof Error ? error.message : String(error))}`,
    }
  }
}

async function fetchGmailProfile(
  accessToken: string,
): Promise<{ ok: true; emailAddress: string | null; historyId: string | null } | { ok: false; error: string }> {
  try {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    })
    const text = await response.text()
    if (!response.ok) {
      return {
        ok: false,
        error: `Gmail profile取得エラー (${response.status}): ${extractGoogleApiErrorMessage(text)}`,
      }
    }

    const data = parseJsonObjectSafe(text)
    const emailAddress = typeof data?.emailAddress === "string" ? data.emailAddress.trim() : ""
    const historyId = data?.historyId == null ? "" : String(data.historyId).trim()
    return {
      ok: true,
      emailAddress: emailAddress || null,
      historyId: historyId || null,
    }
  } catch (error) {
    return {
      ok: false,
      error: `Gmail profile取得エラー: ${sanitizeSingleLine(error instanceof Error ? error.message : String(error))}`,
    }
  }
}

function extractGoogleApiErrorMessage(responseText: string): string {
  const raw = String(responseText ?? "").trim()
  if (!raw) return "unknown error"
  const parsed = parseJsonObjectSafe(raw)
  const nestedMessage = parsed?.error?.message
  if (typeof nestedMessage === "string" && nestedMessage.trim()) {
    return sanitizeSingleLine(nestedMessage)
  }
  const description = parsed?.error_description
  if (typeof description === "string" && description.trim()) {
    return sanitizeSingleLine(description)
  }
  return sanitizeSingleLine(raw)
}

function parseJsonObjectSafe(value: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function sanitizeSingleLine(value: string): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
}

async function fetchMediaState(
  supabase: ReturnType<typeof createClient>,
  url: URL,
) {
  const limit = clampInt(url.searchParams.get("limit"), MEDIA_LIST_DEFAULT_LIMIT, 1, MEDIA_LIST_MAX_LIMIT)
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1000000)
  const roomId = String(url.searchParams.get("room_id") ?? "").trim()
  const mediaType = normalizeMediaType(url.searchParams.get("media_type"))
  const storePartitionKeyRaw = String(url.searchParams.get("store_partition_key") ?? "").trim()
  const storePartitionKey = /^[A-Za-z0-9_]{1,120}$/.test(storePartitionKeyRaw) ? storePartitionKeyRaw : ""

  let query = supabase
    .from("line_message_media")
    .select(
      "id, message_id, line_message_id, room_id, user_id, sender_display_name, media_type, storage_bucket, storage_path, original_file_name, mime_type, file_size_bytes, content_preview, created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (storePartitionKey) {
    query = query.eq("store_partition_key", storePartitionKey)
  }
  if (roomId) {
    query = query.eq("room_id", roomId)
  }
  if (mediaType) {
    query = query.eq("media_type", mediaType)
  }

  const [listRes, filteredUsageRes, allUsageRes, mediaUploadMaxMb, storeMediaCounts] = await Promise.all([
    query,
    storePartitionKey
      ? fetchStoreMediaUsage(supabase, storePartitionKey, mediaType)
      : fetchLineMediaUsageStats(supabase, roomId || null, mediaType),
    fetchLineMediaUsageStats(supabase, null, null),
    fetchMediaUploadMaxMb(supabase),
    fetchMediaCountByStore(supabase),
  ])

  const { data, error, count } = listRes
  if (error) {
    throw { status: 500, message: `Failed to fetch media list: ${error.message}` } satisfies AppError
  }
  if (!filteredUsageRes.ok) {
    throw { status: 500, message: filteredUsageRes.message } satisfies AppError
  }
  if (!allUsageRes.ok) {
    throw { status: 500, message: allUsageRes.message } satisfies AppError
  }

  const rows = Array.isArray(data) ? data.map((item) => normalizeMediaListRow(item)).filter((item): item is MediaListRow => item !== null) : []
  const roomNameMap = await fetchRoomNameMapForIds(supabase, rows.map((row) => row.room_id))
  const mediaContextMap = await fetchMediaContextMap(supabase, rows)
  // 既存行（保存時に名前未取得）向け: sender_display_name が空のものだけ user_id から補完。
  const senderNameMap = await fetchSenderNameMapForUserIds(
    supabase,
    rows.filter((row) => !row.sender_display_name && row.user_id).map((row) => String(row.user_id)),
  )
  const items = await Promise.all(rows.map(async (row) => {
    const signedUrl = await createSignedMediaUrl(supabase, row.storage_bucket, row.storage_path)
    const downloadUrl = await createSignedMediaDownloadUrl(
      supabase,
      row.storage_bucket,
      row.storage_path,
      row.original_file_name ?? `${row.line_message_id}`,
    )
    const context = mediaContextMap.get(row.id) ?? null
    return {
      ...row,
      sender_display_name: row.sender_display_name
        ?? (row.user_id ? senderNameMap.get(String(row.user_id)) ?? null : null),
      room_name: roomNameMap.get(row.room_id) ?? row.room_name ?? null,
      context_before_text: context?.before_text ?? null,
      context_before_at: context?.before_at ?? null,
      context_after_text: context?.after_text ?? null,
      context_after_at: context?.after_at ?? null,
      signed_url: signedUrl,
      download_url: downloadUrl ?? signedUrl,
      line_message_tag: formatLineMediaTag(row.line_message_id),
    }
  }))
  const safeTotal = Number.isFinite(Number(count)) ? Number(count) : items.length
  const nextOffset = offset + items.length
  return {
    items,
    total: safeTotal,
    store_media_counts: storeMediaCounts,
    total_file_bytes: filteredUsageRes.stats.total_bytes,
    total_file_count: filteredUsageRes.stats.total_files,
    all_file_bytes: allUsageRes.stats.total_bytes,
    all_file_count: allUsageRes.stats.total_files,
    media_storage_cap_bytes: MEDIA_STORAGE_CAP_BYTES,
    media_storage_usage_ratio: MEDIA_STORAGE_CAP_BYTES > 0
      ? Math.min(1, allUsageRes.stats.total_bytes / MEDIA_STORAGE_CAP_BYTES)
      : 0,
    media_upload_max_mb: mediaUploadMaxMb,
    limit,
    offset,
    has_more: nextOffset < safeTotal,
    next_offset: nextOffset < safeTotal ? nextOffset : null,
    generated_at: new Date().toISOString(),
  }
}

async function fetchDocumentState(
  supabase: ReturnType<typeof createClient>,
  url: URL,
) {
  const limit = clampInt(url.searchParams.get("limit"), DOCUMENT_LIST_DEFAULT_LIMIT, 1, DOCUMENT_LIST_MAX_LIMIT)
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1000000)
  const roomId = String(url.searchParams.get("room_id") ?? "").trim()

  let query = supabase
    .from("line_search_documents")
    .select(
      "id, room_id, room_name, storage_bucket, storage_path, original_file_name, mime_type, file_size_bytes, extracted_text, source, created_at, updated_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (roomId) {
    query = query.eq("room_id", roomId)
  }

  const [listRes, filteredUsageRes, allUsageRes] = await Promise.all([
    query,
    fetchLineDocumentUsageStats(supabase, roomId || null),
    fetchLineDocumentUsageStats(supabase, null),
  ])
  const { data, error, count } = listRes
  if (error) {
    throw { status: 500, message: `Failed to fetch document list: ${error.message}` } satisfies AppError
  }
  if (!filteredUsageRes.ok) {
    throw { status: 500, message: filteredUsageRes.message } satisfies AppError
  }
  if (!allUsageRes.ok) {
    throw { status: 500, message: allUsageRes.message } satisfies AppError
  }

  const rows = Array.isArray(data)
    ? data.map((item) => normalizeDocumentListRow(item)).filter((item): item is DocumentListRow => item !== null)
    : []
  const roomNameMap = await fetchRoomNameMapForIds(
    supabase,
    rows.map((row) => row.room_id || "").filter((value) => value.length > 0),
  )
  const items = await Promise.all(rows.map(async (row) => {
    const signedUrl = await createSignedMediaDownloadUrl(
      supabase,
      row.storage_bucket,
      row.storage_path,
      row.original_file_name,
    )
    const normalizedRoomId = row.room_id || null
    const latestRoomName = normalizedRoomId ? (roomNameMap.get(normalizedRoomId) ?? "") : ""
    const normalizedRoomName = latestRoomName
      || (row.room_name ? String(row.room_name) : (normalizedRoomId || null))
    const snippet = buildDocumentSnippet(row.extracted_text, DOCUMENT_PREVIEW_MAX_CHARS)
    return {
      ...row,
      room_id: normalizedRoomId,
      room_name: normalizedRoomName,
      snippet,
      signed_url: signedUrl,
      has_extracted_text: row.extracted_text.length > 0,
      extracted_char_count: row.extracted_text.length,
    }
  }))
  const permissionSummaries = await fetchDocumentPermissionSummaries(supabase, rows.map((row) => row.id))

  const safeTotal = Number.isFinite(Number(count)) ? Number(count) : items.length
  const nextOffset = offset + items.length
  return {
    items: items.map((item) => {
      const summary = permissionSummaries.get(item.id)
      return {
        ...item,
        permission_mode: summary?.mode ?? "public",
        allowed_user_count: summary?.allowed_user_count ?? 0,
      }
    }),
    total: safeTotal,
    total_file_bytes: filteredUsageRes.stats.total_bytes,
    total_file_count: filteredUsageRes.stats.total_files,
    all_file_bytes: allUsageRes.stats.total_bytes,
    all_file_count: allUsageRes.stats.total_files,
    limit,
    offset,
    has_more: nextOffset < safeTotal,
    next_offset: nextOffset < safeTotal ? nextOffset : null,
    generated_at: new Date().toISOString(),
  }
}

async function fetchReservationCalendarState(
  supabase: ReturnType<typeof createClient>,
  url: URL,
) {
  const targetMonth = normalizeCalendarMonthParam(url.searchParams.get("month"))
  const sourceFilter = normalizeReservationSourceFilter(url.searchParams.get("source"))
  const storeScope = normalizeReservationStoreScope(url.searchParams.get("store_key") ?? url.searchParams.get("store"))
  // 非表示（ソフト削除）の行は既定で除外。include_hidden=1 のときだけ含める（確認・復元用）。
  const includeHidden = url.searchParams.get("include_hidden") === "1"
  const range = buildJstMonthRange(targetMonth)
  const baseSources: Array<"tabelog" | "ikyu"> = sourceFilter === "all"
    ? ["tabelog", "ikyu"]
    : (sourceFilter === "tabelog" || sourceFilter === "ikyu" ? [sourceFilter] : [])
  const includeManual = sourceFilter === "all" || sourceFilter === "manual"
  const items: Array<Record<string, unknown>> = []
  const sourceCounts: Record<string, number> = {
    tabelog: 0,
    ikyu: 0,
    manual: 0,
  }

  for (const source of baseSources) {
    const { eventTable, summaryTable } = getReservationSourceTables(source)

    const [eventsRes, summariesRes] = await Promise.all([
      supabase
        .from(eventTable)
        .select(RESERVATION_EVENT_SELECT_COLUMNS)
        .gte("visit_at", range.startIso)
        .lt("visit_at", range.endIso)
        .order("visit_at", { ascending: true })
        .limit(2000),
      supabase
        .from(summaryTable)
        .select("customer_name, customer_phone, visit_count, last_visit_at")
        .limit(5000),
    ])

    if (eventsRes.error) {
      throw { status: 500, message: `Failed to fetch ${source} reservation events: ${eventsRes.error.message}` } satisfies AppError
    }
    if (summariesRes.error) {
      throw { status: 500, message: `Failed to fetch ${source} reservation summaries: ${summariesRes.error.message}` } satisfies AppError
    }

    const summaryByCustomer = await buildReservationEffectiveSummaryLookup(
      supabase,
      eventTable,
      eventsRes.data,
      summariesRes.data,
    )

    for (const row of eventsRes.data ?? []) {
      const record = row as Record<string, unknown>
      if (!includeHidden && record.manual_hidden === true) continue
      const item = buildReservationCalendarItem(source, record, summaryByCustomer)
      if (!item) continue
      if (!reservationCalendarItemMatchesStoreScope(item, storeScope)) continue
      items.push(item)
      sourceCounts[source] += 1
    }
  }

  // 手入力（新規）予約: gmail_message_id もサマリも持たないため別途読み込む。
  if (includeManual) {
    const { data: manualRows, error: manualErr } = await supabase
      .from("manual_reservation_visit_events")
      .select(MANUAL_RESERVATION_SELECT_COLUMNS)
      .gte("visit_at", range.startIso)
      .lt("visit_at", range.endIso)
      .order("visit_at", { ascending: true })
      .limit(2000)
    if (manualErr) {
      throw { status: 500, message: `Failed to fetch manual reservation events: ${manualErr.message}` } satisfies AppError
    }
    for (const row of manualRows ?? []) {
      const record = row as Record<string, unknown>
      if (!includeHidden && record.manual_hidden === true) continue
      const item = buildReservationCalendarItem("manual", record, null)
      if (!item) continue
      if (!reservationCalendarItemMatchesStoreScope(item, storeScope)) continue
      items.push(item)
      sourceCounts.manual += 1
    }
  }

  items.sort((a, b) => String(a.visit_at ?? "").localeCompare(String(b.visit_at ?? "")))

  return {
    month: targetMonth,
    month_start_iso: range.startIso,
    month_end_iso: range.endIso,
    source_filter: sourceFilter,
    include_hidden: includeHidden,
    total: items.length,
    source_counts: sourceCounts,
    items,
    generated_at: new Date().toISOString(),
  }
}

async function fetchReservationSearchState(
  supabase: ReturnType<typeof createClient>,
  url: URL,
) {
  const query = normalizeReservationSearchQuery(url.searchParams.get("q"))
  if (!query) {
    throw { status: 400, message: "q is required." } satisfies AppError
  }

  const sourceFilter = normalizeReservationSourceFilter(url.searchParams.get("source"))
  const storeScope = normalizeReservationStoreScope(url.searchParams.get("store_key") ?? url.searchParams.get("store"))
  const limit = clampInt(
    url.searchParams.get("limit"),
    RESERVATION_SEARCH_DEFAULT_LIMIT,
    1,
    RESERVATION_SEARCH_MAX_LIMIT,
  )
  const includeHidden = url.searchParams.get("include_hidden") === "1"
  const baseSources: Array<"tabelog" | "ikyu"> = sourceFilter === "all"
    ? ["tabelog", "ikyu"]
    : (sourceFilter === "tabelog" || sourceFilter === "ikyu" ? [sourceFilter] : [])
  const includeManual = sourceFilter === "all" || sourceFilter === "manual"
  const sourceFetchLimit = Math.min(
    RESERVATION_SEARCH_SOURCE_FETCH_CAP,
    Math.max(limit, Math.ceil(limit * 2)),
  )
  const searchPatterns = buildReservationNameSearchPatterns(query)
  const escapedPatterns = searchPatterns
    .map((pattern) => escapeLikePattern(pattern))
    .filter((pattern) => pattern.length > 0)
  // 氏名 or 詳細(JSON文字列)に対する ilike OR フィルタ（tabelog/ikyu/手入力で共通利用）。
  const orFilter = (() => {
    if (escapedPatterns.length === 0) return ""
    const filters: string[] = []
    for (const pattern of escapedPatterns) {
      filters.push(`customer_name.ilike.%${pattern}%`)
      filters.push(`reservation_detail.ilike.%${pattern}%`)
    }
    return filters.join(",")
  })()

  const items: Array<Record<string, unknown>> = []
  const sourceCounts: Record<string, number> = {
    tabelog: 0,
    ikyu: 0,
    manual: 0,
  }
  const sourceLimitReached: Record<string, boolean> = {
    tabelog: false,
    ikyu: false,
    manual: false,
  }

  for (const source of baseSources) {
    const { eventTable, summaryTable } = getReservationSourceTables(source)

    let eventsQuery = supabase
      .from(eventTable)
      .select(RESERVATION_EVENT_SELECT_COLUMNS)
      .order("visit_at", { ascending: false })
      .limit(sourceFetchLimit)
    if (orFilter) eventsQuery = eventsQuery.or(orFilter)

    const [{ data, error }, summariesRes] = await Promise.all([
      eventsQuery,
      supabase
        .from(summaryTable)
        .select("customer_name, customer_phone, visit_count, last_visit_at")
        .limit(5000),
    ])

    if (error) {
      throw { status: 500, message: `Failed to search ${source} reservations: ${error.message}` } satisfies AppError
    }
    if (summariesRes.error) {
      throw { status: 500, message: `Failed to fetch ${source} reservation summaries: ${summariesRes.error.message}` } satisfies AppError
    }

    const eventRows = Array.isArray(data) ? data : []
    const summaryByCustomer = await buildReservationEffectiveSummaryLookup(
      supabase,
      eventTable,
      eventRows,
      summariesRes.data,
    )
    if (eventRows.length >= sourceFetchLimit) {
      sourceLimitReached[source] = true
    }

    for (const row of eventRows) {
      const record = row as Record<string, unknown>
      if (!includeHidden && record.manual_hidden === true) continue
      const item = buildReservationCalendarItem(source, record, summaryByCustomer)
      if (!item) continue
      if (!reservationCalendarItemMatchesStoreScope(item, storeScope)) continue
      if (!matchesReservationSearchItem(item, query)) continue
      items.push(item)
      sourceCounts[source] += 1
    }
  }

  if (includeManual) {
    let manualQuery = supabase
      .from("manual_reservation_visit_events")
      .select(MANUAL_RESERVATION_SELECT_COLUMNS)
      .order("visit_at", { ascending: false })
      .limit(sourceFetchLimit)
    if (orFilter) manualQuery = manualQuery.or(orFilter)
    const { data: manualRows, error: manualErr } = await manualQuery
    if (manualErr) {
      throw { status: 500, message: `Failed to search manual reservations: ${manualErr.message}` } satisfies AppError
    }
    const manualList = Array.isArray(manualRows) ? manualRows : []
    if (manualList.length >= sourceFetchLimit) sourceLimitReached.manual = true
    for (const row of manualList) {
      const record = row as Record<string, unknown>
      if (!includeHidden && record.manual_hidden === true) continue
      const item = buildReservationCalendarItem("manual", record, null)
      if (!item) continue
      if (!reservationCalendarItemMatchesStoreScope(item, storeScope)) continue
      if (!matchesReservationSearchItem(item, query)) continue
      items.push(item)
      sourceCounts.manual += 1
    }
  }

  items.sort((a, b) => String(b.visit_at ?? "").localeCompare(String(a.visit_at ?? "")))
  const truncated = items.length > limit ||
    sourceLimitReached.tabelog || sourceLimitReached.ikyu || sourceLimitReached.manual

  return {
    query,
    source_filter: sourceFilter,
    include_hidden: includeHidden,
    limit,
    total: items.length,
    truncated,
    source_counts: sourceCounts,
    items: items.slice(0, limit),
    generated_at: new Date().toISOString(),
  }
}

// 手入力（新規）予約を作成。reservation_detail はフロントが組み立てたJSON文字列をそのまま保存する。
async function createManualReservationEvent(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  enforcedStoreScope?: string | null,
) {
  const visitAtIso = normalizeReservationVisitAtIso(body.visit_at)
  if (!visitAtIso) {
    throw { status: 400, message: "visit_at is required (ISO datetime)." } satisfies AppError
  }
  const enforcedStoreKey = normalizeReservationStoreScope(enforcedStoreScope)
  const insertRow = {
    customer_name: toSafeString(body.customer_name) || null,
    customer_phone: toSafeString(body.customer_phone) || null,
    visit_at: visitAtIso,
    reservation_type: toSafeString(body.reservation_type) || null,
    reservation_detail: toSafeString(body.reservation_detail) || null,
    manual_store_key: enforcedStoreKey || toSafeString(body.manual_store_key) || null,
  }
  const { data, error } = await supabase
    .from("manual_reservation_visit_events")
    .insert(insertRow)
    .select("id")
    .single()
  if (error) {
    throw { status: 500, message: `Failed to create reservation: ${error.message}` } satisfies AppError
  }
  return { ok: true, source: "manual", id: (data as { id?: number } | null)?.id ?? null }
}

// 既存/手入力の予約を編集・非表示(ソフト削除)・復元。body に含まれたフィールドだけを更新する。
async function updateReservationEvent(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  enforcedStoreScope?: string | null,
) {
  const source = toSafeString(body.source)
  const table = reservationEventTableForSource(source)
  if (!table) {
    throw { status: 400, message: "source must be one of tabelog|ikyu|manual." } satisfies AppError
  }
  const id = Number(body.id)
  if (!Number.isInteger(id) || id <= 0) {
    throw { status: 400, message: "id is required." } satisfies AppError
  }
  const enforcedStoreKey = normalizeReservationStoreScope(enforcedStoreScope)
  if (enforcedStoreKey) {
    const record = await fetchReservationEventRecordForScopeCheck(supabase, table, id)
    assertReservationEventMatchesStoreScope(source, record, enforcedStoreKey)
  }
  const isManualTable = table === "manual_reservation_visit_events"
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)

  const patch: Record<string, unknown> = {}
  if (has("customer_name")) patch.customer_name = toSafeString(body.customer_name) || null
  if (has("customer_phone")) patch.customer_phone = toSafeString(body.customer_phone) || null
  if (has("visit_at")) {
    const iso = normalizeReservationVisitAtIso(body.visit_at)
    if (!iso) throw { status: 400, message: "visit_at is invalid." } satisfies AppError
    patch.visit_at = iso
  }
  if (has("reservation_type")) patch.reservation_type = toSafeString(body.reservation_type) || null
  if (has("reservation_detail")) patch.reservation_detail = toSafeString(body.reservation_detail) || null
  if (has("manual_store_key")) {
    patch.manual_store_key = enforcedStoreKey || toSafeString(body.manual_store_key) || null
  } else if (enforcedStoreKey && isManualTable) {
    patch.manual_store_key = enforcedStoreKey
  }
  if (has("manual_hidden")) {
    const hidden = body.manual_hidden === true || body.manual_hidden === "true"
    patch.manual_hidden = hidden
    if (hidden) {
      const reason = toSafeString(body.manual_hidden_reason).toLowerCase()
      patch.manual_hidden_reason = RESERVATION_MANUAL_HIDDEN_REASONS.has(reason) ? reason : "cancel"
    } else {
      patch.manual_hidden_reason = null
    }
  }

  if (Object.keys(patch).length === 0) {
    throw { status: 400, message: "No fields to update." } satisfies AppError
  }
  // 監査用タイムスタンプ。手入力表は updated_at、既存表は manual_edited_at に記録する。
  if (isManualTable) patch.updated_at = new Date().toISOString()
  else patch.manual_edited_at = new Date().toISOString()

  const { error } = await supabase.from(table).update(patch).eq("id", id)
  if (error) {
    throw { status: 500, message: `Failed to update reservation: ${error.message}` } satisfies AppError
  }
  return { ok: true, source, id }
}

// 氏名/電話のサジェスト: 入力語で3つの予約表を横断検索し、顧客（氏名+電話）単位に集約して返す。
// 検索語は URL ではなく POST ボディで受け取り、ログ/URL に PII を残さない。
async function suggestReservationCustomers(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  enforcedStoreScope?: string | null,
) {
  const q = toSafeString(body.q).trim()
  const field = toSafeString(body.field).toLowerCase() === "phone" ? "phone" : "name"
  const limit = clampInt(String(body.limit ?? ""), 8, 1, 20)
  const enforcedStoreKey = normalizeReservationStoreScope(enforcedStoreScope)
  if (q.length < 1) return { ok: true, field, suggestions: [] as Array<Record<string, unknown>> }

  const col = field === "phone" ? "customer_phone" : "customer_name"
  const pat = escapeLikePattern(q)
  const tables: Array<{ t: string; source: string }> = [
    { t: "tabelog_reservation_visit_events", source: "tabelog" },
    { t: "ikyu_reservation_visit_events", source: "ikyu" },
    { t: "manual_reservation_visit_events", source: "manual" },
  ]
  const byKey = new Map<string, Record<string, unknown>>()
  for (const { t, source } of tables) {
    const { data, error } = await supabase
      .from(t)
      .select("customer_name, customer_phone, visit_at, manual_store_key, reservation_detail")
      .ilike(col, `%${pat}%`)
      .order("visit_at", { ascending: false })
      .limit(60)
    if (error) {
      console.error(`customer-suggest query failed (${t}):`, error.message)
      continue
    }
    for (const row of (Array.isArray(data) ? data : [])) {
      if (!isRecord(row)) continue
      if (enforcedStoreKey && !reservationEventRecordMatchesStoreScope(source, row, enforcedStoreKey)) continue
      const name = toSafeString(row.customer_name)
      const phone = toSafeString(row.customer_phone)
      if (!name && !phone) continue
      const key = `${name}__${phone}`
      const visitAt = toSafeString(row.visit_at)
      const existing = byKey.get(key)
      if (existing) {
        existing.count = Number(existing.count ?? 0) + 1
        if (visitAt && visitAt > toSafeString(existing.last_visit_at)) existing.last_visit_at = visitAt
        continue
      }
      const parsed = parseReservationCalendarDetail(toSafeString(row.reservation_detail))
      byKey.set(key, {
        customer_name: name,
        customer_phone: phone,
        last_visit_at: visitAt || null,
        manual_store_key: toSafeString(row.manual_store_key) || null,
        store_name: normalizeCalendarText(parsed?.storeName, 90),
        source,
        count: 1,
      })
    }
  }
  const suggestions = [...byKey.values()]
    .sort((a, b) => String(b.last_visit_at ?? "").localeCompare(String(a.last_visit_at ?? "")))
    .slice(0, limit)
  return { ok: true, field, suggestions }
}

// 予約の完全削除（ハードデリート）。非表示(ソフト削除)と違い行を物理削除する。
// 取込予約(tabelog/ikyu)は reservation_customer_visit_history にも複製があるため、
// 「履歴も残さない」ため gmail_message_id を辿って履歴行も併せて削除する。
async function deleteReservationEvent(
  supabase: ReturnType<typeof createClient>,
  url: URL,
  enforcedStoreScope?: string | null,
) {
  const source = toSafeString(url.searchParams.get("source"))
  const table = reservationEventTableForSource(source)
  if (!table) {
    throw { status: 400, message: "source must be one of tabelog|ikyu|manual." } satisfies AppError
  }
  const id = Number(url.searchParams.get("id"))
  if (!Number.isInteger(id) || id <= 0) {
    throw { status: 400, message: "id is required." } satisfies AppError
  }
  const enforcedStoreKey = normalizeReservationStoreScope(enforcedStoreScope)

  const selectColumns = table === "manual_reservation_visit_events"
    ? "customer_name, customer_phone, reservation_detail, manual_store_key, created_at, visit_at"
    : "gmail_message_id, customer_name, customer_phone, reservation_detail, manual_store_key, created_at, visit_at"
  const { data: row } = await supabase.from(table).select(selectColumns).eq("id", id).maybeSingle()
  if (enforcedStoreKey) {
    assertReservationEventMatchesStoreScope(source, row, enforcedStoreKey)
  }
  const gmid = toSafeString((row as { gmail_message_id?: string } | null)?.gmail_message_id)
  const customerName = toSafeString((row as { customer_name?: string } | null)?.customer_name)
  const customerPhone = toSafeString((row as { customer_phone?: string } | null)?.customer_phone)

  if (table === "manual_reservation_visit_events") {
    const { error: histErr } = await supabase
      .from("reservation_customer_visit_history")
      .delete()
      .eq("partner", "manual")
      .eq("gmail_message_id", `manual:${id}`)
    if (histErr) console.error("Failed to delete manual reservation visit history:", histErr.message)
  } else if (gmid) {
    const { error: histErr } = await supabase
      .from("reservation_customer_visit_history")
      .delete()
      .eq("partner", source)
      .eq("gmail_message_id", gmid)
    if (histErr) console.error("Failed to delete reservation visit history:", histErr.message)
  }

  const { error } = await supabase.from(table).delete().eq("id", id)
  if (error) {
    throw { status: 500, message: `Failed to delete reservation: ${error.message}` } satisfies AppError
  }
  await rebuildReservationSummaryForCustomer(supabase, source, customerName, customerPhone)
  return { ok: true, source, id, deleted: true }
}

// ── 小口現金（出金/経費）台帳 ──
const PETTY_CASH_CATEGORIES = ["消耗品費", "食材・仕入", "雑費", "衛生用品", "修繕費", "その他"] as const

// 勘定科目（品目ごと）。3科目固定。未知キーは「未分類」フォールバック（通常は出ない）。
const PETTY_ACCT_KEYS = new Set(["shokuzai", "shomohin", "alcohol"])
const PETTY_ACCT_NAMES: Record<string, string> = { shokuzai: "食材", shomohin: "消耗品", alcohol: "アルコール" }
type PettyItem = { n: string; p: number; acct: string; rate: number }
type PettyTaxMode = "ex" | "in"

// items 配列を正規化（[{n,p,acct,rate}]）。各品目: 税抜価格 p(int≥0)、acct∈3科目、rate∈{8,10}。
// 空行（名前も価格も無い）は除去。1件も無ければ null（＝従来の単一フィールド経路にフォールバック）。
function normalizePettyItems(raw: unknown): PettyItem[] | null {
  if (!Array.isArray(raw)) return null
  const items: PettyItem[] = []
  for (const el of raw) {
    if (!el || typeof el !== "object") continue
    const o = el as Record<string, unknown>
    const n = toSafeString(o.n ?? (o as { name?: unknown }).name).trim()
    const pNum = Math.floor(Number(o.p ?? (o as { price?: unknown }).price))
    const p = Number.isFinite(pNum) && pNum > 0 ? pNum : 0
    let acct = toSafeString(o.acct).trim().toLowerCase()
    if (!PETTY_ACCT_KEYS.has(acct)) acct = "shokuzai"
    let rate = Math.floor(Number(o.rate))
    if (rate !== 8 && rate !== 10) rate = acct === "shokuzai" ? 8 : 10
    if (!n && p <= 0) continue
    items.push({ n: n || "(品目)", p, acct, rate })
    if (items.length >= 60) break
  }
  return items.length ? items : null
}

// items から 本体(Σp)・税・出金額(本体+税) を導出。
// 消費税は「税率ごとに税抜小計をまとめてから 1円未満切り捨て(floor)」で算出（税率別に1回・端数切り捨て）。
function pettyTotalsFromItems(items: PettyItem[]): { base: number; tax: number; amount: number } {
  let base = 0
  let base8 = 0
  let base10 = 0
  for (const it of items) {
    base += it.p
    if (it.rate === 8) base8 += it.p
    else base10 += it.p
  }
  const tax = Math.floor((base8 * 8) / 100) + Math.floor((base10 * 10) / 100)
  return { base, tax, amount: base + tax }
}

function normalizePettyTaxMode(raw: unknown): PettyTaxMode {
  return String(raw ?? "").trim().toLowerCase() === "in" ? "in" : "ex"
}

// 検索/旧表示用の品目テキスト（複数は「・名 ¥価格」改行、1件はそのまま）。
function pettyItemText(items: PettyItem[]): string {
  const lines = items.map((it) => `${it.n}${it.p > 0 ? " ¥" + it.p.toLocaleString("ja-JP") : ""}`.trim()).filter(Boolean)
  if (!lines.length) return ""
  return lines.length > 1 ? lines.map((s) => "・" + s).join("\n") : lines[0]
}

// 旧 category 列向け（科目名の重複排除を「・」連結。例: 食材・消耗品）。
function pettyCategoryLabel(items: PettyItem[]): string {
  const names = [...new Set(items.map((it) => PETTY_ACCT_NAMES[it.acct] ?? "未分類"))]
  return names.join("・")
}

// 一覧（店舗・月で絞り込み）＋ 月合計・勘定科目別合計を返す。
async function fetchPettyCashState(
  supabase: ReturnType<typeof createClient>,
  url: URL,
) {
  const storeKey = toSafeString(url.searchParams.get("store")).trim()
  const month = toSafeString(url.searchParams.get("month")).trim() // "YYYY-MM"（任意）
  const monthValid = /^\d{4}-\d{2}$/.test(month)

  let query = supabase
    .from("petty_cash_entries")
    .select("id, store_partition_key, spent_on, item, category, amount_yen, tax_yen, tax_mode, items, handler, source, note, line_message_id, created_at")
    .eq("hidden", false)
    .order("spent_on", { ascending: false })
    .order("id", { ascending: false })
    .limit(3000)
  if (storeKey) query = query.eq("store_partition_key", storeKey)
  if (monthValid) {
    const [y, m] = month.split("-").map((n) => Number(n))
    const start = `${month}-01`
    const endY = m === 12 ? y + 1 : y
    const endM = m === 12 ? 1 : m + 1
    const end = `${endY}-${String(endM).padStart(2, "0")}-01`
    query = query.gte("spent_on", start).lt("spent_on", end)
  }

  const { data, error } = await query
  if (error) {
    throw { status: 500, message: `Failed to load petty cash: ${error.message}` } satisfies AppError
  }
  const rows = Array.isArray(data) ? data : []

  let total = 0
  let taxTotal = 0
  const byCategory = new Map<string, number>()
  for (const r of rows) {
    const amt = Math.max(0, Math.floor(Number((r as { amount_yen?: unknown }).amount_yen ?? 0)))
    const tax = Math.max(0, Math.floor(Number((r as { tax_yen?: unknown }).tax_yen ?? 0)))
    total += amt
    taxTotal += tax
    const cat = toSafeString((r as { category?: unknown }).category) || "未分類"
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + amt)
  }

  return {
    ok: true,
    store_key: storeKey || null,
    month: monthValid ? month : null,
    categories: PETTY_CASH_CATEGORIES,
    entries: rows,
    total_yen: total,
    tax_total_yen: taxTotal,
    base_total_yen: Math.max(0, total - taxTotal),
    by_category: [...byCategory.entries()]
      .map(([category, amount_yen]) => ({ category, amount_yen }))
      .sort((a, b) => b.amount_yen - a.amount_yen),
    count: rows.length,
  }
}

// 出金(レシート画像由来)に紐づく元レシート画像の署名URLを返す。
// line_message_id でメディア(line_message_media)を引く。店舗スコープ付きセッションは
// 対象 entry が自店舗のものでなければ 404（他店のレシートを開けない）。
async function fetchPettyCashReceiptMedia(
  supabase: ReturnType<typeof createClient>,
  url: URL,
  enforcedStoreKey?: string | null,
) {
  const id = Number(url.searchParams.get("id"))
  if (!Number.isInteger(id) || id <= 0) {
    throw { status: 400, message: "id is required." } satisfies AppError
  }
  let entryQuery = supabase
    .from("petty_cash_entries")
    .select("id, store_partition_key, line_message_id, source")
    .eq("id", id)
  if (enforcedStoreKey) entryQuery = entryQuery.eq("store_partition_key", enforcedStoreKey)
  const { data: entry, error: entryErr } = await entryQuery.maybeSingle()
  if (entryErr) {
    throw { status: 500, message: `Failed to load entry: ${entryErr.message}` } satisfies AppError
  }
  if (!entry) {
    throw { status: 404, message: "対象の出金が見つかりません。" } satisfies AppError
  }
  const lineMessageId = toSafeString((entry as { line_message_id?: unknown }).line_message_id)
  if (!lineMessageId) {
    throw { status: 404, message: "この出金にはレシート画像が紐づいていません（手入力など）。" } satisfies AppError
  }
  // line_message_id は LINE メッセージ単位で一意。entry は上で店舗確認済みなので店舗安全。
  const { data: media, error: mediaErr } = await supabase
    .from("line_message_media")
    .select("media_type, storage_bucket, storage_path, original_file_name, created_at")
    .eq("line_message_id", lineMessageId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (mediaErr) {
    throw { status: 500, message: `Failed to load receipt media: ${mediaErr.message}` } satisfies AppError
  }
  if (!media) {
    throw { status: 404, message: "レシート画像が保存されていません（保存前/削除済みの可能性）。" } satisfies AppError
  }
  const signedUrl = await createSignedMediaUrl(
    supabase,
    toSafeString((media as { storage_bucket?: unknown }).storage_bucket) || "line-media",
    toSafeString((media as { storage_path?: unknown }).storage_path),
  )
  if (!signedUrl) {
    throw { status: 502, message: "レシート画像のURL生成に失敗しました。" } satisfies AppError
  }
  return {
    ok: true,
    id,
    line_message_id: lineMessageId,
    media_type: toSafeString((media as { media_type?: unknown }).media_type) || "image",
    original_file_name: toSafeString((media as { original_file_name?: unknown }).original_file_name) || null,
    created_at: (media as { created_at?: unknown }).created_at ?? null,
    signed_url: signedUrl,
  }
}

// 追加（手入力）。
async function createPettyCashEntry(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
) {
  const storeKey = toSafeString(body.store_partition_key).trim()
  if (!storeKey) {
    throw { status: 400, message: "store_partition_key is required." } satisfies AppError
  }
  const spentOn = toSafeString(body.spent_on).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) {
    throw { status: 400, message: "spent_on must be YYYY-MM-DD." } satisfies AppError
  }
  // 新方式: items（品目ごとの勘定科目・税率）があれば、本体/税/出金額はサーバ側で導出して保存（パリティ保証）。
  const items = normalizePettyItems(body.items)
  const taxMode = normalizePettyTaxMode(body.tax_mode)
  let insertRow: Record<string, unknown>
  if (items) {
    const t = pettyTotalsFromItems(items)
    if (t.amount <= 0) {
      throw { status: 400, message: "items must total a positive amount." } satisfies AppError
    }
    insertRow = {
      store_partition_key: storeKey,
      spent_on: spentOn,
      item: pettyItemText(items),
      category: pettyCategoryLabel(items),
      amount_yen: t.amount,
      tax_yen: t.tax,
      tax_mode: taxMode,
      items,
      handler: toSafeString(body.handler) || null,
      note: toSafeString(body.note) || null,
      source: "manual",
    }
  } else {
    // 旧方式（単一フィールド）。LINE取込や後方互換のためフォールバックとして残す。
    const amount = Math.floor(Number(body.amount_yen))
    if (!Number.isFinite(amount) || amount < 0) {
      throw { status: 400, message: "amount_yen must be a non-negative number." } satisfies AppError
    }
    const taxParsed = (body.tax_yen == null || body.tax_yen === "") ? 0 : Math.floor(Number(body.tax_yen))
    const tax = Number.isFinite(taxParsed) ? Math.max(0, taxParsed) : 0
    if (tax > amount) {
      throw { status: 400, message: "tax_yen must not exceed amount_yen (out-of-pocket total)." } satisfies AppError
    }
    insertRow = {
      store_partition_key: storeKey,
      spent_on: spentOn,
      item: toSafeString(body.item) || null,
      category: toSafeString(body.category) || null,
      amount_yen: amount,
      tax_yen: tax,
      tax_mode: taxMode,
      handler: toSafeString(body.handler) || null,
      note: toSafeString(body.note) || null,
      source: "manual",
    }
  }
  const { data, error } = await supabase
    .from("petty_cash_entries")
    .insert(insertRow)
    .select("id")
    .single()
  if (error) {
    throw { status: 500, message: `Failed to create petty cash entry: ${error.message}` } satisfies AppError
  }
  return { ok: true, id: (data as { id?: number } | null)?.id ?? null }
}

function normalizePettyCashReceiptImageMime(fileType: string, fileName: string): string | null {
  const type = String(fileType || "").split(";")[0].trim().toLowerCase()
  if (type === "image/jpeg" || type === "image/jpg") return "image/jpeg"
  if (type === "image/png") return "image/png"
  const ext = extractFileExt(fileName).toLowerCase()
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
  if (ext === "png") return "image/png"
  return null
}

function receiptImageStorageExt(mimeType: string): string {
  return mimeType === "image/png" ? "png" : "jpg"
}

async function recordPettyCashWebAiUsage(
  supabase: ReturnType<typeof createClient>,
  storeKey: string,
  lineMessageId: string,
  usage: LineImageVisionUsage | null | undefined,
): Promise<void> {
  if (!usage) return
  try {
    const { error } = await supabase.from("ai_usage_events").insert({
      store_partition_key: storeKey,
      provider: "groq",
      model: GROQ_RECEIPT_MODEL,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      thinking_tokens: usage.thinkingTokens,
      total_tokens: usage.totalTokens,
      line_message_id: lineMessageId,
    })
    if (error) console.error("petty cash web ai_usage_events insert failed:", error.message)
  } catch (e) {
    console.error("petty cash web ai_usage_events insert threw:", e instanceof Error ? e.message : String(e))
  }
}

async function uploadPettyCashWebReceiptImage(
  supabase: ReturnType<typeof createClient>,
  params: {
    storeKey: string
    lineMessageId: string
    fileName: string
    mimeType: string
    bytes: Uint8Array
  },
): Promise<{ storagePath: string }> {
  const storePath = sanitizeStoragePathSegment(params.storeKey)
  const idPath = sanitizeStoragePathSegment(params.lineMessageId)
  const storagePath = `web-petty-cash/${storePath}/${idPath}.${receiptImageStorageExt(params.mimeType)}`
  const uploaded = await supabase.storage.from(PETTY_CASH_RECEIPT_IMAGE_BUCKET).upload(storagePath, params.bytes, {
    contentType: params.mimeType,
    upsert: true,
  })
  if (uploaded?.error) {
    throw { status: 500, message: `レシート画像の保存に失敗しました: ${uploaded.error.message}` } satisfies AppError
  }
  const inserted = await supabase.from("line_message_media").insert({
    message_id: null,
    line_message_id: params.lineMessageId,
    room_id: `web_upload:${params.storeKey}`,
    user_id: null,
    sender_display_name: "Webアップロード",
    media_type: "image",
    store_partition_key: params.storeKey,
    storage_bucket: PETTY_CASH_RECEIPT_IMAGE_BUCKET,
    storage_path: storagePath,
    original_file_name: params.fileName,
    mime_type: params.mimeType,
    file_size_bytes: params.bytes.byteLength,
    content_preview: null,
    created_at: new Date().toISOString(),
  })
  if (inserted?.error) {
    try { await supabase.storage.from(PETTY_CASH_RECEIPT_IMAGE_BUCKET).remove([storagePath]) } catch (_) { /* ignore */ }
    throw { status: 500, message: `レシート画像情報の保存に失敗しました: ${inserted.error.message}` } satisfies AppError
  }
  return { storagePath }
}

// Web画面からアップロードされたレシート画像を、LINEの小口現金解析と同じロジックで解析して登録する。
async function createPettyCashEntryFromReceiptImage(
  supabase: ReturnType<typeof createClient>,
  req: Request,
  enforcedStoreKey?: string | null,
) {
  const contentLength = Number(req.headers.get("content-length") ?? "")
  if (Number.isFinite(contentLength) && contentLength > PETTY_CASH_RECEIPT_IMAGE_MAX_BYTES + 1024 * 1024) {
    throw { status: 400, message: "画像が大きすぎます。3MB以下のJPEG/PNGにしてアップロードしてください。" } satisfies AppError
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    throw { status: 400, message: "Upload request must be multipart/form-data." } satisfies AppError
  }

  const rawStoreKey = toSafeString(formData.get("store_partition_key") ?? formData.get("store") ?? formData.get("store_key"))
  if (enforcedStoreKey && rawStoreKey && rawStoreKey.toLowerCase() !== enforcedStoreKey.toLowerCase()) {
    throw { status: 403, message: "他店舗のデータには登録できません。" } satisfies AppError
  }
  const storeKey = (enforcedStoreKey || rawStoreKey).trim()
  if (!storeKey) {
    throw { status: 400, message: "store_partition_key is required." } satisfies AppError
  }

  const fileValue = formData.get("image") ?? formData.get("file")
  if (!(fileValue instanceof File)) {
    throw { status: 400, message: "image file is required." } satisfies AppError
  }
  if (!Number.isFinite(fileValue.size) || fileValue.size <= 0) {
    throw { status: 400, message: "image file must not be empty." } satisfies AppError
  }
  if (fileValue.size > PETTY_CASH_RECEIPT_IMAGE_MAX_BYTES) {
    throw { status: 400, message: "画像が大きすぎます。3MB以下のJPEG/PNGにしてアップロードしてください。" } satisfies AppError
  }

  const originalFileName = sanitizeUploadFileName(
    toSafeString(formData.get("original_file_name")) || fileValue.name || "receipt.jpg",
  )
  const mimeType = normalizePettyCashReceiptImageMime(fileValue.type || "", originalFileName)
  if (!mimeType) {
    throw { status: 400, message: "JPEGまたはPNG画像だけアップロードできます。" } satisfies AppError
  }

  const groqApiKey = String(Deno.env.get("GROQ_API_KEY") ?? "").trim()
  if (!groqApiKey) {
    throw { status: 500, message: "GROQ_API_KEY is missing." } satisfies AppError
  }

  const bytes = new Uint8Array(await fileValue.arrayBuffer())
  const webMessageId = `web-petty-cash:${crypto.randomUUID()}`
  const analyzed = await analyzeExpenseReceiptWithGroqScout(
    bytes,
    mimeType,
    originalFileName,
    groqApiKey,
    EXPENSE_RECEIPT_PROMPT_ADDITION,
  )
  await recordPettyCashWebAiUsage(supabase, storeKey, webMessageId, analyzed.usage)
  if (analyzed.failure) {
    throw { status: 422, message: `レシート画像を解析できませんでした: ${analyzed.failure.message}` } satisfies AppError
  }
  const expense = extractExpenseFromReceipt(analyzed.analysis?.receipt ?? null)
  if (!expense) {
    throw { status: 422, message: "レシートの金額を読み取れませんでした。画像を撮り直すか手入力してください。" } satisfies AppError
  }

  let storagePath: string | null = null
  try {
    const media = await uploadPettyCashWebReceiptImage(supabase, {
      storeKey,
      lineMessageId: webMessageId,
      fileName: originalFileName,
      mimeType,
      bytes,
    })
    storagePath = media.storagePath

    const items = normalizePettyItems(expense.items) ?? null
    const { data, error } = await supabase
      .from("petty_cash_entries")
      .insert({
        store_partition_key: storeKey,
        spent_on: expense.spentOn,
        item: items ? pettyItemText(items) : expense.item,
        category: items ? pettyCategoryLabel(items) : null,
        amount_yen: expense.amount,
        tax_yen: Math.min(expense.amount, Math.max(0, expense.tax)),
        tax_mode: expense.taxMode,
        items,
        handler: toSafeString(formData.get("handler")) || null,
        note: expense.supplier ? `仕入先: ${expense.supplier}` : null,
        source: "web_image",
        line_message_id: webMessageId,
      })
      .select("id, store_partition_key, spent_on, item, category, amount_yen, tax_yen, tax_mode, items, handler, source, note, line_message_id, created_at")
      .single()
    if (error) {
      throw { status: 500, message: `Failed to create petty cash entry: ${error.message}` } satisfies AppError
    }
    return {
      ok: true,
      id: (data as { id?: number } | null)?.id ?? null,
      entry: data,
      receipt: {
        summary: analyzed.analysis?.summary ?? "",
        supplier: expense.supplier,
        spent_on: expense.spentOn,
        amount_yen: expense.amount,
        tax_yen: expense.tax,
      },
    }
  } catch (e) {
    if (storagePath) {
      try { await supabase.storage.from(PETTY_CASH_RECEIPT_IMAGE_BUCKET).remove([storagePath]) } catch (_) { /* ignore */ }
      try { await supabase.from("line_message_media").delete().eq("line_message_id", webMessageId) } catch (_) { /* ignore */ }
    }
    throw e
  }
}

// 既存の小口現金行を編集（body に含めたフィールドだけ更新）。
async function updatePettyCashEntry(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  enforcedStoreKey?: string | null,
) {
  const id = Number(body.id)
  if (!Number.isInteger(id) || id <= 0) {
    throw { status: 400, message: "id is required." } satisfies AppError
  }
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)
  const patch: Record<string, unknown> = {}
  if (has("spent_on")) {
    const s = toSafeString(body.spent_on).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      throw { status: 400, message: "spent_on must be YYYY-MM-DD." } satisfies AppError
    }
    patch.spent_on = s
  }
  if (has("handler")) patch.handler = toSafeString(body.handler) || null
  if (has("note")) patch.note = toSafeString(body.note) || null
  if (has("tax_mode")) patch.tax_mode = normalizePettyTaxMode(body.tax_mode)
  // 新方式: items を指定したら 本体/税/品目テキスト/科目ラベル をサーバ側で再導出（item/category/amount/tax は items が優先）。
  if (has("items")) {
    const items = normalizePettyItems(body.items)
    if (!items) {
      throw { status: 400, message: "items must contain at least one valid line item." } satisfies AppError
    }
    const t = pettyTotalsFromItems(items)
    if (t.amount <= 0) {
      throw { status: 400, message: "items must total a positive amount." } satisfies AppError
    }
    patch.items = items
    patch.amount_yen = t.amount
    patch.tax_yen = t.tax
    patch.item = pettyItemText(items)
    patch.category = pettyCategoryLabel(items)
  } else {
    // 旧方式（単一フィールド）。
    if (has("item")) patch.item = toSafeString(body.item) || null
    if (has("category")) patch.category = toSafeString(body.category) || null
    let nextAmount: number | null = null
    let nextTax: number | null = null
    if (has("amount_yen")) {
      const a = Math.floor(Number(body.amount_yen))
      if (!Number.isFinite(a) || a < 0) {
        throw { status: 400, message: "amount_yen must be a non-negative number." } satisfies AppError
      }
      patch.amount_yen = a
      nextAmount = a
    }
    if (has("tax_yen")) {
      const t = Math.floor(Number(body.tax_yen))
      if (!Number.isFinite(t) || t < 0) {
        throw { status: 400, message: "tax_yen must be a non-negative number." } satisfies AppError
      }
      patch.tax_yen = t
      nextTax = t
    }
    if (nextAmount != null && nextTax != null && nextTax > nextAmount) {
      throw { status: 400, message: "tax_yen must not exceed amount_yen." } satisfies AppError
    }
  }
  if (Object.keys(patch).length === 0) {
    throw { status: 400, message: "No fields to update." } satisfies AppError
  }
  patch.updated_at = new Date().toISOString()
  let upd = supabase.from("petty_cash_entries").update(patch).eq("id", id)
  // 店舗スコープ付きセッションは自店舗の行だけ編集可（他店舗idを指定しても0件更新→403）。
  if (enforcedStoreKey) upd = upd.eq("store_partition_key", enforcedStoreKey)
  const { data: updated, error } = await upd.select("id")
  if (error) {
    throw { status: 500, message: `Failed to update petty cash entry: ${error.message}` } satisfies AppError
  }
  if (enforcedStoreKey && (!Array.isArray(updated) || updated.length === 0)) {
    throw { status: 403, message: "他店舗のデータは編集できません。" } satisfies AppError
  }
  return { ok: true, id }
}

// 論理削除（hidden=true）。
async function deletePettyCashEntry(
  supabase: ReturnType<typeof createClient>,
  url: URL,
  enforcedStoreKey?: string | null,
) {
  const id = Number(url.searchParams.get("id"))
  if (!Number.isInteger(id) || id <= 0) {
    throw { status: 400, message: "id is required." } satisfies AppError
  }
  let del = supabase
    .from("petty_cash_entries")
    .update({ hidden: true, updated_at: new Date().toISOString() })
    .eq("id", id)
  // 店舗スコープ付きセッションは自店舗の行だけ削除可（他店舗idを指定しても0件→403）。
  if (enforcedStoreKey) del = del.eq("store_partition_key", enforcedStoreKey)
  const { data: deleted, error } = await del.select("id")
  if (error) {
    throw { status: 500, message: `Failed to delete petty cash entry: ${error.message}` } satisfies AppError
  }
  if (enforcedStoreKey && (!Array.isArray(deleted) || deleted.length === 0)) {
    throw { status: 403, message: "他店舗のデータは削除できません。" } satisfies AppError
  }
  return { ok: true, id, deleted: true }
}

function normalizeBudgetStoreKey(raw: string): string {
  const s = String(raw ?? "").trim().toLowerCase()
  return s || "__all__"
}

type ReceiptStoreOption = {
  store_key: string
  store_name: string
}


function parsePositiveWeight(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

type SalesBudgetRow = {
  budget_yen: number
  mon_weight: number
  tue_weight: number
  wed_weight: number
  thu_weight: number
  fri_weight: number
  sat_weight: number
  sun_weight: number
  store_closed_dates: string[]
}

async function fetchStoreClosedDatesFromTable(
  supabase: ReturnType<typeof createClient>,
  store_partition_key: string,
  month: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("line_sales_month_store_closed_days")
    .select("closed_on")
    .eq("store_partition_key", store_partition_key)
    .eq("target_month", month)

  if (error) {
    throw { status: 500, message: `Failed to fetch store closed days: ${error.message}` } satisfies AppError
  }
  const allowed = new Set(enumerateMonthDates(month))
  const out: string[] = []
  for (const row of Array.isArray(data) ? data : []) {
    const r = row as { closed_on?: unknown }
    const s = String(r.closed_on ?? "").trim().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue
    if (!allowed.has(s)) continue
    out.push(s)
  }
  return [...new Set(out)].sort()
}

async function replaceStoreClosedDatesInTable(
  supabase: ReturnType<typeof createClient>,
  store_partition_key: string,
  month: string,
  dates: string[],
) {
  const { error: delErr } = await supabase
    .from("line_sales_month_store_closed_days")
    .delete()
    .eq("store_partition_key", store_partition_key)
    .eq("target_month", month)
  if (delErr) {
    throw { status: 500, message: `Failed to clear store closed days: ${delErr.message}` } satisfies AppError
  }
  if (dates.length === 0) return
  const rows = dates.map((closed_on) => ({
    store_partition_key,
    target_month: month,
    closed_on,
  }))
  const { error: insErr } = await supabase.from("line_sales_month_store_closed_days").insert(rows)
  if (insErr) {
    throw { status: 500, message: `Failed to save store closed days: ${insErr.message}` } satisfies AppError
  }
}

async function fetchSalesBudgetRow(
  supabase: ReturnType<typeof createClient>,
  storeKeyQueryParam: string,
  month: string,
): Promise<SalesBudgetRow | null> {
  const store_partition_key = normalizeBudgetStoreKey(storeKeyQueryParam)
  const { data, error } = await supabase
    .from("line_sales_month_budgets")
    .select("budget_yen, mon_weight, tue_weight, wed_weight, thu_weight, fri_weight, sat_weight, sun_weight, store_closed_dates")
    .eq("store_partition_key", store_partition_key)
    .eq("target_month", month)
    .maybeSingle()

  if (error) {
    throw { status: 500, message: `Failed to fetch sales budget: ${error.message}` } satisfies AppError
  }
  if (!data) return null
  const row = data as {
    budget_yen?: unknown
    mon_weight?: unknown
    tue_weight?: unknown
    wed_weight?: unknown
    thu_weight?: unknown
    fri_weight?: unknown
    sat_weight?: unknown
    sun_weight?: unknown
    store_closed_dates?: unknown
  }
  const budgetYen = toNonNegativeInteger(row.budget_yen)
  if (budgetYen <= 0) return null
  const fromTable = await fetchStoreClosedDatesFromTable(supabase, store_partition_key, month)
  const store_closed_dates = mergeStoreClosedDateLists(fromTable, row.store_closed_dates, month)
  return {
    budget_yen: budgetYen,
    mon_weight: parsePositiveWeight(row.mon_weight, 1),
    tue_weight: parsePositiveWeight(row.tue_weight, 1),
    wed_weight: parsePositiveWeight(row.wed_weight, 1),
    thu_weight: parsePositiveWeight(row.thu_weight, 1),
    fri_weight: parsePositiveWeight(row.fri_weight, 1),
    sat_weight: parsePositiveWeight(row.sat_weight, 1.5),
    sun_weight: parsePositiveWeight(row.sun_weight, 2),
    store_closed_dates,
  }
}

async function upsertReceiptSalesBudget(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
) {
  const store_partition_key = normalizeBudgetStoreKey(toSafeString(body.store_key))
  const month = normalizeCalendarMonthParam(toSafeString(body.month))
  const rawBudget = body.budget_yen

  const clearAndReturn = async () => {
    const { error: delClosedErr } = await supabase
      .from("line_sales_month_store_closed_days")
      .delete()
      .eq("store_partition_key", store_partition_key)
      .eq("target_month", month)
    if (delClosedErr) {
      throw { status: 500, message: `Failed to clear store closed days: ${delClosedErr.message}` } satisfies AppError
    }
    const { error } = await supabase
      .from("line_sales_month_budgets")
      .delete()
      .eq("store_partition_key", store_partition_key)
      .eq("target_month", month)
    if (error) {
      throw { status: 500, message: `Failed to clear sales budget: ${error.message}` } satisfies AppError
    }
    return {
      month_budget_yen: null as number | null,
      mon_weight: null as number | null,
      tue_weight: null as number | null,
      wed_weight: null as number | null,
      thu_weight: null as number | null,
      fri_weight: null as number | null,
      sat_weight: null as number | null,
      sun_weight: null as number | null,
      store_closed_dates: null as string[] | null,
      store_partition_key,
      month,
    }
  }

  if (rawBudget === null || rawBudget === undefined || rawBudget === "") {
    return await clearAndReturn()
  }

  const budgetYen = toNonNegativeInteger(rawBudget)
  if (budgetYen <= 0) {
    return await clearAndReturn()
  }

  const monW = parsePositiveWeight(body.mon_weight, 1)
  const tueW = parsePositiveWeight(body.tue_weight, 1)
  const wedW = parsePositiveWeight(body.wed_weight, 1)
  const thuW = parsePositiveWeight(body.thu_weight, 1)
  const friW = parsePositiveWeight(body.fri_weight, 1)
  const satW = parsePositiveWeight(body.sat_weight, 1.5)
  const sunW = parsePositiveWeight(body.sun_weight, 2)
  const closedDates = parseStoreClosedDatesForMonth(body.store_closed_dates, month)

  const updatedAt = new Date().toISOString()
  const { data, error } = await supabase
    .from("line_sales_month_budgets")
    .upsert(
      {
        store_partition_key,
        target_month: month,
        budget_yen: budgetYen,
        mon_weight: monW,
        tue_weight: tueW,
        wed_weight: wedW,
        thu_weight: thuW,
        fri_weight: friW,
        sat_weight: satW,
        sun_weight: sunW,
        store_closed_dates: closedDates,
        updated_at: updatedAt,
      },
      { onConflict: "store_partition_key,target_month" },
    )
    .select("budget_yen, mon_weight, tue_weight, wed_weight, thu_weight, fri_weight, sat_weight, sun_weight, store_closed_dates")
    .maybeSingle()

  if (error) {
    throw { status: 500, message: `Failed to save sales budget: ${error.message}` } satisfies AppError
  }

  await replaceStoreClosedDatesInTable(supabase, store_partition_key, month, closedDates)

  let row = data as {
    budget_yen?: unknown
    mon_weight?: unknown
    tue_weight?: unknown
    wed_weight?: unknown
    thu_weight?: unknown
    fri_weight?: unknown
    sat_weight?: unknown
    sun_weight?: unknown
    store_closed_dates?: unknown
  } | null
  let parsedClosed = await fetchStoreClosedDatesFromTable(supabase, store_partition_key, month)
  if (parsedClosed.length === 0) {
    parsedClosed = parseStoreClosedDatesForMonth(row?.store_closed_dates, month)
  }
  if (parsedClosed.length === 0 && closedDates.length > 0) {
    parsedClosed = [...closedDates]
  }
  const out = row != null ? toNonNegativeInteger(row.budget_yen) : budgetYen
  return {
    month_budget_yen: out > 0 ? out : null,
    mon_weight: parsePositiveWeight(row?.mon_weight, monW),
    tue_weight: parsePositiveWeight(row?.tue_weight, tueW),
    wed_weight: parsePositiveWeight(row?.wed_weight, wedW),
    thu_weight: parsePositiveWeight(row?.thu_weight, thuW),
    fri_weight: parsePositiveWeight(row?.fri_weight, friW),
    sat_weight: parsePositiveWeight(row?.sat_weight, satW),
    sun_weight: parsePositiveWeight(row?.sun_weight, sunW),
    store_closed_dates: parsedClosed,
    store_partition_key,
    month,
  }
}

function parseCompareYearQueryParam(raw: string | null, displayMonth: string): number {
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed >= 1900 && parsed <= 2100) {
    return Math.floor(parsed)
  }
  const parts = displayMonth.split("-")
  const y = Number(parts[0])
  if (Number.isFinite(y)) return y - 1
  return new Date().getUTCFullYear() - 1
}

function comparisonSalesMonth(displayMonth: string, compareYear: number): string {
  const mm = displayMonth.slice(5, 7)
  return `${compareYear}-${mm}`
}

async function fetchManualMonthGross(
  supabase: ReturnType<typeof createClient>,
  storeKeyQueryParam: string,
  salesMonth: string,
): Promise<number | null> {
  const store_partition_key = normalizeBudgetStoreKey(storeKeyQueryParam)
  const sm = normalizeCalendarMonthParam(salesMonth)
  const record = await fetchManualMonthSales(supabase, store_partition_key, sm)
  return record?.gross_sales_yen ?? null
}

async function fetchManualMonthsForYearState(
  supabase: ReturnType<typeof createClient>,
  url: URL,
) {
  const store_partition_key = normalizeBudgetStoreKey(toSafeString(url.searchParams.get("store_key")))
  const year = Number(url.searchParams.get("year"))
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw { status: 400, message: "year must be an integer 1900-2100." } satisfies AppError
  }
  const start = `${year}-01`
  const endExclusive = `${year + 1}-01`
  const { data, error } = await supabase
    .from("line_sales_manual_month_gross")
    .select("sales_month, gross_sales_yen, net_sales_yen, tax_amount_yen, party_count, guest_count, operating_days_count")
    .eq("store_partition_key", store_partition_key)
    .gte("sales_month", start)
    .lt("sales_month", endExclusive)

  if (error) {
    throw { status: 500, message: `Failed to list manual month gross: ${error.message}` } satisfies AppError
  }

  const months: Record<string, {
    gross_sales_yen: number
    net_sales_yen: number | null
    tax_amount_yen: number | null
    party_count: number | null
    guest_count: number | null
    operating_days_count: number | null
  }> = {}
  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const sm = toSafeString(r.sales_month)
    if (!/^\d{4}-\d{2}$/.test(sm)) continue
    const gross = toNonNegativeInteger(r.gross_sales_yen)
    const netRaw = r.net_sales_yen
    const taxRaw = r.tax_amount_yen
    const partyRaw = r.party_count
    const guestRaw = r.guest_count
    const party = partyRaw === null || partyRaw === undefined || partyRaw === ""
      ? null
      : toNonNegativeInteger(partyRaw)
    const guest = guestRaw === null || guestRaw === undefined || guestRaw === ""
      ? null
      : toNonNegativeInteger(guestRaw)
    const opRaw = r.operating_days_count
    const operating_days_count = opRaw === null || opRaw === undefined || opRaw === ""
      ? null
      : toNonNegativeInteger(opRaw)
    months[sm] = {
      gross_sales_yen: gross,
      net_sales_yen: netRaw === null || netRaw === undefined || netRaw === "" ? null : toNonNegativeInteger(netRaw),
      tax_amount_yen: taxRaw === null || taxRaw === undefined || taxRaw === "" ? null : toNonNegativeInteger(taxRaw),
      party_count: party,
      guest_count: guest,
      operating_days_count: operating_days_count != null && operating_days_count > 0 ? operating_days_count : null,
    }
  }

  return {
    year,
    store_partition_key,
    months,
    generated_at: new Date().toISOString(),
  }
}

async function upsertManualMonthEntries(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
) {
  const store_partition_key = normalizeBudgetStoreKey(toSafeString(body.store_key))
  const entriesRaw = body.entries
  if (!Array.isArray(entriesRaw)) {
    throw { status: 400, message: "entries must be an array." } satisfies AppError
  }

  const upsertPayload: Array<{
    sales_month: string
    gross_sales_yen: number | null
    party_count?: number | null
    guest_count?: number | null
    operating_days_count?: number | null
    net_sales_yen?: number | null
    tax_amount_yen?: number | null
  }> = []
  let applied = 0

  for (const entry of entriesRaw) {
    if (!isRecord(entry)) continue
    const sales_month = normalizeCalendarMonthParam(toSafeString(entry.sales_month))
    const raw = entry.gross_sales_yen

    if (raw === null || raw === undefined || raw === "") {
      upsertPayload.push({ sales_month, gross_sales_yen: null })
    } else {
      const yenVal = toNonNegativeInteger(raw)
      const partyRaw = entry.party_count
      const guestRaw = entry.guest_count
      const party = partyRaw === null || partyRaw === undefined || partyRaw === ""
        ? null
        : toNonNegativeInteger(partyRaw)
      const guest = guestRaw === null || guestRaw === undefined || guestRaw === ""
        ? null
        : toNonNegativeInteger(guestRaw)
      const opRaw = entry.operating_days_count
      const netRaw = entry.net_sales_yen
      const taxRaw = entry.tax_amount_yen
      const operatingDays = opRaw === null || opRaw === undefined || opRaw === ""
        ? null
        : toNonNegativeInteger(opRaw)
      const net = netRaw === null || netRaw === undefined || netRaw === ""
        ? null
        : toNonNegativeInteger(netRaw)
      const tax = taxRaw === null || taxRaw === undefined || taxRaw === ""
        ? null
        : toNonNegativeInteger(taxRaw)
      upsertPayload.push({
        sales_month,
        gross_sales_yen: yenVal,
        net_sales_yen: net,
        tax_amount_yen: tax,
        party_count: party,
        guest_count: guest,
        operating_days_count: operatingDays != null && operatingDays > 0 ? operatingDays : null,
      })
    }
    applied += 1
  }

  try {
    await upsertManualMonthSalesEntries(supabase, store_partition_key, upsertPayload)
  } catch (e) {
    throw {
      status: 500,
      message: `Failed to save manual month sales: ${String(e)}`,
    } satisfies AppError
  }

  return {
    ok: true as const,
    store_partition_key,
    applied,
    generated_at: new Date().toISOString(),
  }
}

/** 日次売上の手入力上書き（売上分析の日次表からのインライン編集）。各フィールドは
 *  - キー無し: 変更しない / null|"": その列の上書き解除 / 数値: 上書き。3列とも空になればその日の手入力を削除。 */
// 先頭が ZIP シグネチャ(PK\x03\x04)なら xlsx、それ以外は CSV とみなす。
// 月次日別売上管理表（Excel/CSV）を解析して entries を返す（解析のみ）。実処理は _shared/daily_sales_import.ts。
async function parseManualDaySalesImport(req: Request) {
  let formData: FormData
  try {
    formData = await req.formData()
  } catch (_e) {
    throw { status: 400, message: "multipart/form-data でファイルを送信してください。" } satisfies AppError
  }
  const fileValue = formData.get("file")
  if (!(fileValue instanceof File)) {
    throw { status: 400, message: "file フィールドにファイルがありません。" } satisfies AppError
  }
  const bytes = new Uint8Array(await fileValue.arrayBuffer())
  const parsed = parseMonthlyDailySalesWorkbook(bytes, fileValue.name)
  if (!parsed.recognized) {
    throw { status: 400, message: parsed.error || "月次日別売上管理表として読み取れませんでした。" } satisfies AppError
  }
  return {
    ok: true,
    file_name: fileValue.name,
    import_mode: parsed.import_mode,
    store_name: parsed.store_name,
    store_key: parsed.store_key,
    period: parsed.period,
    manual_month_entry: parsed.manual_month_entry,
    entries: parsed.entries,
    covered_dates: parsed.covered_dates,
    day_count: parsed.day_count,
    total_gross_yen: parsed.total_gross_yen,
    skipped_zero_count: parsed.skipped_zero_count,
    warnings: parsed.warnings,
  }
}

// 解析した日次売上を「画像解析レシートと同等」に登録（上書き）。実処理は _shared/daily_sales_import.ts。
async function importDailyReceiptsCommit(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
) {
  const key = toSafeString(body.store_key).trim().toLowerCase()
  if (!key || key === "__all__") {
    throw { status: 400, message: "store_key（店舗）を指定してください。" } satisfies AppError
  }
  const entriesRaw = body.entries
  const importMode = toSafeString(body.import_mode).trim()
  if (importMode === "manual_month") {
    const raw = isRecord(body.manual_month_entry) ? body.manual_month_entry : null
    if (!raw) throw { status: 400, message: "manual_month_entry is required." } satisfies AppError
    const salesMonth = toSafeString(raw.sales_month).trim().slice(0, 7)
    const gross = toNonNegativeInteger(raw.gross_sales_yen)
    if (!/^\d{4}-\d{2}$/.test(salesMonth) || gross == null || gross <= 0) {
      throw { status: 400, message: "manual_month_entry is invalid." } satisfies AppError
    }
    const entry: ManualMonthImportEntry = {
      sales_month: salesMonth,
      gross_sales_yen: gross,
      tax_amount_yen: raw.tax_amount_yen == null || raw.tax_amount_yen === "" ? null : toNonNegativeInteger(raw.tax_amount_yen),
      net_sales_yen: raw.net_sales_yen == null || raw.net_sales_yen === "" ? null : toNonNegativeInteger(raw.net_sales_yen),
      party_count: raw.party_count == null || raw.party_count === "" ? null : toNonNegativeInteger(raw.party_count),
      guest_count: raw.guest_count == null || raw.guest_count === "" ? null : toNonNegativeInteger(raw.guest_count),
      operating_days_count: raw.operating_days_count == null || raw.operating_days_count === "" ? null : toNonNegativeInteger(raw.operating_days_count),
    }
    const coveredDates = (Array.isArray(body.covered_dates) ? body.covered_dates : [])
      .map((d) => toSafeString(d).trim().slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d.slice(0, 7) === salesMonth)
    if (body.confirm_overwrite !== true) {
      const resolved = await resolveReceiptTableForStore(supabase, key)
      if (resolved) {
        const existing = await countExistingReceiptsForDates(supabase, resolved.receiptTable, coveredDates)
        if (existing > 0) {
          return {
            ok: false,
            needs_confirm: true,
            existing_count: existing,
            store_key: key,
            day_count: 0,
            message: `対象月には既に ${existing} 件の日別データがあります。取込むと削除され、月合計として上書きされます。`,
          }
        }
      }
    }
    return await importManualMonthSalesOverwrite(supabase, key, entry, coveredDates)
  }
  if (!Array.isArray(entriesRaw)) {
    throw { status: 400, message: "entries must be an array." } satisfies AppError
  }
  const entries: DailySalesImportEntry[] = []
  for (const e of entriesRaw) {
    if (!isRecord(e)) continue
    const sales_date = toSafeString(e.sales_date).trim().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sales_date)) continue
    const gross = toNonNegativeInteger(e.gross_sales_yen)
    if (gross == null || gross <= 0) continue
    entries.push({
      sales_date,
      gross_sales_yen: gross,
      party_count: (e.party_count == null || e.party_count === "") ? null : toNonNegativeInteger(e.party_count),
      guest_count: (e.guest_count == null || e.guest_count === "") ? null : toNonNegativeInteger(e.guest_count),
    })
  }
  // ファイルに載っていた全日付（0=休業の日も含む）。期間まるごと置換のため、この全日付の既存をクリアする。
  const coveredDates = (Array.isArray(body.covered_dates) ? body.covered_dates : [])
    .map((d) => toSafeString(d).trim().slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  // 上書き確認ゲート: 対象日に既存データがあり、confirm_overwrite 未指定なら削除せず確認を求める（誤上書き防止）。
  // フロントは needs_confirm を受けてユーザーに確認し、confirm_overwrite:true で再送する。
  if (body.confirm_overwrite !== true) {
    const resolved = await resolveReceiptTableForStore(supabase, key)
    if (resolved) {
      const clearDates = [...new Set([...coveredDates, ...entries.map((e) => e.sales_date)])]
      const existing = await countExistingReceiptsForDates(supabase, resolved.receiptTable, clearDates)
      if (existing > 0) {
        return {
          ok: false,
          needs_confirm: true,
          existing_count: existing,
          store_key: key,
          day_count: entries.length,
          message: `対象期間には既に ${existing} 件のデータがあります。取込むと削除され、今回の内容で上書きされます。`,
        }
      }
    }
  }
  return await importDailyReceiptsOverwrite(supabase, key, entries, coveredDates)
}

// 日別予算の直接入力（手動上書き）を保存。body: { store_key, entries:[{sales_date, budget_yen|null}] }
// budget_yen が null/空 の日は上書き解除（その日は自動按分へ戻る）。
async function upsertDailyBudgetEntries(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
) {
  const store_partition_key = normalizeBudgetStoreKey(toSafeString(body.store_key))
  const entriesRaw = body.entries
  if (!Array.isArray(entriesRaw)) {
    throw { status: 400, message: "entries must be an array." } satisfies AppError
  }
  const payload: Array<{ sales_date: string; budget_yen: number | null }> = []
  for (const entry of entriesRaw) {
    if (!isRecord(entry)) continue
    const sales_date = toSafeString(entry.sales_date).trim().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sales_date)) continue
    const raw = entry.budget_yen
    const budget_yen = (raw === null || raw === undefined || raw === "") ? null : toNonNegativeInteger(raw)
    payload.push({ sales_date, budget_yen })
  }
  let applied = 0
  try {
    applied = await upsertManualDayBudgetEntries(supabase, store_partition_key, payload)
  } catch (e) {
    throw { status: 500, message: e instanceof Error ? e.message : String(e) } satisfies AppError
  }
  return { ok: true, applied, store_key: store_partition_key }
}

async function upsertManualDayEntries(
  supabase: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
) {
  const store_partition_key = normalizeBudgetStoreKey(toSafeString(body.store_key))
  const entriesRaw = body.entries
  if (!Array.isArray(entriesRaw)) {
    throw { status: 400, message: "entries must be an array." } satisfies AppError
  }

  const resolveField = (entry: Record<string, unknown>, prop: string):
    number | null | undefined => {
    if (!(prop in entry)) return undefined
    const raw = entry[prop]
    if (raw === null || raw === undefined || raw === "") return null
    return toNonNegativeInteger(raw)
  }

  const upsertPayload: Array<{
    sales_date: string
    gross_sales_yen?: number | null
    party_count?: number | null
    guest_count?: number | null
  }> = []

  for (const entry of entriesRaw) {
    if (!isRecord(entry)) continue
    const sales_date = toSafeString(entry.sales_date).trim().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sales_date)) continue
    upsertPayload.push({
      sales_date,
      gross_sales_yen: resolveField(entry, "gross_sales_yen"),
      party_count: resolveField(entry, "party_count"),
      guest_count: resolveField(entry, "guest_count"),
    })
  }

  let applied = 0
  try {
    applied = await upsertManualDaySalesEntries(supabase, store_partition_key, upsertPayload)
  } catch (e) {
    throw {
      status: 500,
      message: `Failed to save manual day sales: ${String(e)}`,
    } satisfies AppError
  }

  return {
    ok: true as const,
    store_partition_key,
    applied,
    generated_at: new Date().toISOString(),
  }
}



function resolveReceiptEntryDateKeyForMonth(
  receiptDateValue: unknown,
  month: string,
): string | null {
  const receiptDate = toSafeString(receiptDateValue)
  if (/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(receiptDate) && receiptDate.startsWith(`${month}-`)) {
    return receiptDate
  }
  return null
}

function toJstDateKeyFromIso(value: unknown): string | null {
  const iso = toSafeString(value)
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  const day = parts.find((part) => part.type === "day")?.value
  if (!year || !month || !day) return null
  return `${year}-${month}-${day}`
}

function buildJstDateKeysForMonth(month: string): string[] {
  const matched = month.match(/^(\d{4})-(\d{2})$/)
  if (!matched) return []
  const year = Number(matched[1])
  const monthNum = Number(matched[2])
  if (!Number.isInteger(year) || !Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) return []
  const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate()
  const keys: string[] = []
  for (let day = 1; day <= lastDay; day += 1) {
    keys.push(`${String(year).padStart(4, "0")}-${String(monthNum).padStart(2, "0")}-${String(day).padStart(2, "0")}`)
  }
  return keys
}

function roundToScale(value: number, scale = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** Math.max(0, Math.floor(scale))
  return Math.round(value * factor) / factor
}

function getReservationSourceTables(
  source: "tabelog" | "ikyu",
): { eventTable: "tabelog_reservation_visit_events" | "ikyu_reservation_visit_events"; summaryTable: "tabelog_reservation_visit_summaries" | "ikyu_reservation_visit_summaries" } {
  if (source === "tabelog") {
    return {
      eventTable: "tabelog_reservation_visit_events",
      summaryTable: "tabelog_reservation_visit_summaries",
    }
  }
  return {
    eventTable: "ikyu_reservation_visit_events",
    summaryTable: "ikyu_reservation_visit_summaries",
  }
}

function getReservationSummarySource(
  source: string,
): "tabelog" | "ikyu" | "manual" | null {
  if (source === "tabelog" || source === "ikyu" || source === "manual") return source
  return null
}

async function rebuildReservationSummaryForCustomer(
  supabase: ReturnType<typeof createClient>,
  source: string,
  customerName: string | null,
  customerPhone: string | null,
) {
  const partner = getReservationSummarySource(source)
  const name = toSafeString(customerName)
  const phone = toSafeString(customerPhone)
  if (!partner || !name || !phone) return
  const { error } = await supabase.rpc("rebuild_partner_reservation_summary", {
    p_partner: partner,
    p_customer_name: name,
    p_customer_phone: phone,
  })
  if (error) {
    console.error(`Failed to rebuild ${partner} reservation summary for ${name}/${phone}:`, error.message)
  }
}

function buildReservationSummaryLookup(rows: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  const list = Array.isArray(rows) ? rows : []
  for (const row of list) {
    if (!isRecord(row)) continue
    const name = toSafeString(row.customer_name)
    const phone = toSafeString(row.customer_phone)
    if (!name || !phone) continue
    map.set(`${name}__${phone}`, row)
  }
  return map
}

function extractReservationNoFromReservationRow(row: Record<string, unknown>): string | null {
  const reservationDetail = toSafeString(row.reservation_detail)
  if (!reservationDetail) return null
  const parsedDetail = parseReservationCalendarDetail(reservationDetail)
  const reservationNo = toSafeString(parsedDetail?.reservationNo)
  return reservationNo || null
}

function buildReservationCountDedupeKey(
  name: string,
  phone: string,
  row: Record<string, unknown>,
): string | null {
  const reservationNo = extractReservationNoFromReservationRow(row)
  if (!reservationNo) return null
  return `${name}__${phone}__${isReservationCancellationRow(row) ? "cancel" : "active"}__${reservationNo}`
}

async function buildReservationEffectiveSummaryLookup(
  supabase: ReturnType<typeof createClient>,
  eventTable: "tabelog_reservation_visit_events" | "ikyu_reservation_visit_events",
  seedRows: unknown,
  fallbackRows: unknown,
): Promise<Map<string, Record<string, unknown>>> {
  const fallbackMap = buildReservationSummaryLookup(fallbackRows)
  const seedList = Array.isArray(seedRows) ? seedRows : []
  const names = new Set<string>()
  const phones = new Set<string>()

  for (const row of seedList) {
    if (!isRecord(row)) continue
    const name = toSafeString(row.customer_name)
    const phone = toSafeString(row.customer_phone)
    if (!name || !phone) continue
    names.add(name)
    phones.add(phone)
  }

  if (names.size === 0 || phones.size === 0) {
    return fallbackMap
  }

  const { data, error } = await supabase
    .from(eventTable)
    .select("customer_name, customer_phone, visit_at, created_at, reservation_type, reservation_detail")
    .in("customer_name", [...names])
    .in("customer_phone", [...phones])
    .order("visit_at", { ascending: false })
    .limit(RESERVATION_CUSTOMER_HISTORY_FETCH_CAP)

  if (error) {
    console.error(`Failed to fetch reservation customer history from ${eventTable}:`, error.message)
    return fallbackMap
  }

  const map = new Map<string, Record<string, unknown>>()
  const seenReservationKeys = new Set<string>()
  const rows = Array.isArray(data) ? data : []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const name = toSafeString(row.customer_name)
    const phone = toSafeString(row.customer_phone)
    if (!name || !phone) continue
    const dedupeKey = buildReservationCountDedupeKey(name, phone, row)
    if (dedupeKey && seenReservationKeys.has(dedupeKey)) continue
    if (dedupeKey) seenReservationKeys.add(dedupeKey)
    const key = `${name}__${phone}`
    const prev = map.get(key)
    const isCancellation = isReservationCancellationRow(row)
    const delta = isCancellation ? -1 : 1
    const nextCount = Math.max(0, toNonNegativeInteger(prev?.visit_count) + delta)
    const candidateLastVisitAt = isCancellation
      ? null
      : (toSafeString(row.visit_at) || toSafeString(row.created_at) || null)
    const prevLastVisitAt = toSafeString(prev?.last_visit_at) || null
    const lastVisitAt = chooseLaterIso(prevLastVisitAt, candidateLastVisitAt)
    map.set(key, {
      customer_name: name,
      customer_phone: phone,
      visit_count: nextCount,
      last_visit_at: lastVisitAt,
    })
  }

  for (const [key, row] of fallbackMap.entries()) {
    if (!map.has(key)) map.set(key, row)
  }
  return map
}

function isReservationCancellationRow(row: Record<string, unknown>): boolean {
  const reservationType = toSafeString(row.reservation_type)
  const reservationDetail = toSafeString(row.reservation_detail)
  const parsedDetail = parseReservationCalendarDetail(reservationDetail)
  if (RESERVATION_CANCELLATION_RE.test(reservationType)) return true
  if (parsedDetail && reservationParsedDetailLooksCancelled(parsedDetail)) return true
  return RESERVATION_CANCELLATION_RE.test(reservationDetail)
}

function reservationParsedDetailLooksCancelled(detail: Record<string, unknown>): boolean {
  const candidateKeys = [
    "status",
    "reservationStatus",
    "action",
    "eventType",
    "mailType",
    "subject",
    "title",
    "summary",
    "note",
  ]
  for (const key of candidateKeys) {
    if (RESERVATION_CANCELLATION_RE.test(toSafeString(detail[key]))) return true
  }
  return false
}

function chooseLaterIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  const aMs = Date.parse(a)
  const bMs = Date.parse(b)
  if (!Number.isFinite(aMs)) return b
  if (!Number.isFinite(bMs)) return a
  return bMs > aMs ? b : a
}

function buildReservationCalendarItem(
  source: "tabelog" | "ikyu" | "manual",
  event: Record<string, unknown>,
  summaryByCustomer: Map<string, Record<string, unknown>> | null,
): Record<string, unknown> | null {
  const name = String(event.customer_name ?? "").trim()
  const phone = String(event.customer_phone ?? "").trim()
  const visitAt = toSafeString(event.visit_at)
  const createdAt = toSafeString(event.created_at)
  if (!visitAt && !createdAt) return null

  const defaultSourceLabel = source === "tabelog"
    ? "食べログ"
    : source === "ikyu"
    ? "一休.comレストラン"
    : "手入力"
  const visitAtValue = visitAt || createdAt
  const createdAtValue = createdAt || visitAt
  const reservationType = toSafeString(event.reservation_type) || "unknown"
  const reservationDetail = toSafeString(event.reservation_detail)
  const parsedDetail = parseReservationCalendarDetail(reservationDetail)
  const routeLabel = normalizeCalendarText(
    parsedDetail?.route ??
      parsedDetail?.reservationSite ??
      defaultSourceLabel,
    80,
  ) ?? defaultSourceLabel
  const customerNameLabel = normalizeCalendarText(parsedDetail?.customerName, 80) ?? (name || null)
  const planLabel = normalizeCalendarText(parsedDetail?.plan, 220) ??
    (parsedDetail ? null : normalizeCalendarText(reservationDetail, 220))
  const partySizeLabel = normalizeCalendarPartySize(parsedDetail?.partySize)
  const allergyLabel = normalizeCalendarAllergy(parsedDetail?.allergy)
  const visitTimeLabel = buildCalendarVisitTimeLabel(parsedDetail?.visitDateTime, visitAtValue)
  const visitMonth = buildCalendarVisitMonthLabel(visitAtValue)
  const storeNameLabel = normalizeCalendarText(parsedDetail?.storeName, 90)
  const summary = summaryByCustomer?.get(`${name}__${phone}`)
  const visitCount = Number(summary?.visit_count ?? 0)

  return {
    source,
    id: Number(event.id ?? 0),
    gmail_message_id: toSafeString(event.gmail_message_id),
    customer_name: name,
    customer_phone: phone,
    visit_at: visitAtValue,
    visit_month: visitMonth,
    created_at: createdAtValue,
    visit_count: Number.isFinite(visitCount) && visitCount > 0 ? Math.floor(visitCount) : 0,
    last_visit_at: toSafeString(summary?.last_visit_at),
    reservation_type: reservationType,
    reservation_detail: reservationDetail,
    route_label: routeLabel,
    customer_name_label: customerNameLabel,
    visit_time_label: visitTimeLabel,
    plan_label: planLabel,
    party_size_label: partySizeLabel,
    allergy_label: allergyLabel,
    store_name: storeNameLabel,
    is_manual: source === "manual",
    manual_hidden: event.manual_hidden === true,
    manual_hidden_reason: toSafeString(event.manual_hidden_reason) || null,
    manual_store_key: toSafeString(event.manual_store_key) || null,
    manual_edited_at: toSafeString(event.manual_edited_at) || toSafeString(event.updated_at) || null,
  }
}

function normalizeReservationStoreScope(value: unknown): string | null {
  const raw = String(value ?? "").trim()
  return raw ? raw.toLowerCase() : null
}

function resolveReservationCalendarItemStoreKey(item: Record<string, unknown>): string | null {
  const manualStoreKey = String(item.manual_store_key ?? "").trim()
  if (manualStoreKey) return manualStoreKey.toLowerCase()
  const storeName = String(item.store_name ?? "").trim()
  if (!storeName) return null
  const resolved = resolveReceiptNamePartitionKey(storeName)
  return resolved ? String(resolved).trim().toLowerCase() : null
}

function reservationCalendarItemMatchesStoreScope(
  item: Record<string, unknown>,
  storeScope: string | null,
): boolean {
  if (!storeScope) return true
  return resolveReservationCalendarItemStoreKey(item) === storeScope
}

function reservationEventRecordMatchesStoreScope(
  source: "tabelog" | "ikyu" | "manual",
  record: unknown,
  storeScope: string | null,
): boolean {
  if (!storeScope || !isRecord(record)) return true
  const item = buildReservationCalendarItem(source, record, null)
  if (!item) return false
  return reservationCalendarItemMatchesStoreScope(item, storeScope)
}

async function fetchReservationEventRecordForScopeCheck(
  supabase: ReturnType<typeof createClient>,
  table: string,
  id: number,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from(table)
    .select("id, reservation_detail, manual_store_key, created_at, visit_at")
    .eq("id", id)
    .maybeSingle()
  if (error) {
    throw { status: 500, message: `Failed to verify reservation scope: ${error.message}` } satisfies AppError
  }
  if (!isRecord(data)) {
    throw { status: 404, message: "対象の予約が見つかりません。" } satisfies AppError
  }
  return data
}

function assertReservationEventMatchesStoreScope(
  source: string,
  record: unknown,
  storeScope: string | null,
) {
  const normalizedScope = normalizeReservationStoreScope(storeScope)
  const normalizedSource = source === "tabelog" || source === "ikyu" || source === "manual"
    ? source
    : null
  if (!normalizedScope || !normalizedSource) return
  if (!reservationEventRecordMatchesStoreScope(normalizedSource, record, normalizedScope)) {
    throw { status: 403, message: "他店舗の予約は編集できません。" } satisfies AppError
  }
}

function parseReservationCalendarDetail(detail: string): Record<string, unknown> | null {
  const text = String(detail ?? "").trim()
  if (!text || !text.startsWith("{")) return null
  try {
    const parsed = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeCalendarText(value: unknown, maxLength = 160): string | null {
  const normalized = toSafeString(value)
  if (!normalized) return null
  if (normalized === "不明" || normalized === "なし") return null
  if (normalized.length > maxLength) return `${normalized.slice(0, maxLength)}...`
  return normalized
}

function normalizeCalendarPartySize(value: unknown): string | null {
  const text = normalizeCalendarText(value, 40)
  if (!text) return null
  const numberHit = text.match(/([0-9０-９]+)/)
  if (!numberHit) return text
  const digits = numberHit[1].replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  return `${digits}名`
}

function normalizeCalendarAllergy(value: unknown): string | null {
  const text = normalizeCalendarText(value, 120)
  if (!text) return null
  if (/^(なし|無|無し|ありません|特になし|該当なし|なしです|不要|記載なし)$/i.test(text)) return null
  return text
}

function buildCalendarVisitTimeLabel(visitDateTime: unknown, visitAtIso: string): string | null {
  const rawVisitDateTime = toSafeString(visitDateTime)
  if (rawVisitDateTime) {
    const hit = rawVisitDateTime.match(/([0-2]?\d):([0-5]\d)/)
    if (hit) return `${String(Number(hit[1])).padStart(2, "0")}:${hit[2]}`
  }

  const fallback = toSafeString(visitAtIso)
  if (!fallback) return null
  const date = new Date(fallback)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date)
  const hour = parts.find((part) => part.type === "hour")?.value
  const minute = parts.find((part) => part.type === "minute")?.value
  if (!hour || !minute) return null
  return `${hour}:${minute}`
}

function buildCalendarVisitMonthLabel(visitAtIso: string): string | null {
  const iso = toSafeString(visitAtIso)
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date)
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  if (!year || !month) return null
  return `${year}-${month}`
}

function normalizeReservationSearchQuery(value: string | null): string {
  const query = toSafeString(value).replace(/\u3000/g, " ").replace(/\s+/g, " ").trim()
  return query
}

function buildReservationNameSearchPatterns(query: string): string[] {
  const compact = query.replace(/\s+/g, "").replace(/様/g, "").trim()
  const noHonorific = query.replace(/様/g, "").trim()
  return [...new Set([
    query,
    noHonorific,
    compact,
  ].map((value) => value.trim()).filter((value) => value.length > 0))]
}

function normalizeReservationNameSearchKey(value: unknown): string {
  const raw = toSafeString(value)
  if (!raw) return ""
  return raw
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, "")
    .replace(/様/g, "")
    .trim()
    .toLowerCase()
}

function matchesReservationSearchItem(item: Record<string, unknown>, query: string): boolean {
  const queryKey = normalizeReservationNameSearchKey(query)
  if (!queryKey) return true
  const candidates = [
    item.customer_name,
    item.customer_name_label,
    item.reservation_detail,
  ]
  return candidates.some((candidate) => {
    const candidateKey = normalizeReservationNameSearchKey(candidate)
    return candidateKey.includes(queryKey)
  })
}

function escapeLikePattern(value: string): string {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")
}

function normalizeCalendarMonthParam(value: string | null): string {
  const src = String(value ?? "").trim()
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(src)) return src
  // 2026-5 のような 1 桁月や trim 漏れで「現在月」に落ちると、店舗休日が対象月と不一致で全除外される
  const loose = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(src)
  if (loose) {
    const y = Number(loose[1])
    const moRaw = Number(loose[2])
    if (Number.isFinite(y) && y >= 1900 && y <= 2100 && Number.isFinite(moRaw)) {
      const mo = Math.min(12, Math.max(1, Math.floor(moRaw)))
      return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}`
    }
  }
  const now = new Date()
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  })
  const parts = formatter.formatToParts(now)
  const year = parts.find((part) => part.type === "year")?.value ?? String(now.getUTCFullYear())
  const month = parts.find((part) => part.type === "month")?.value ?? "01"
  return `${year}-${month}`
}

function normalizeReservationSourceFilter(value: string | null): "all" | "tabelog" | "ikyu" | "manual" {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (normalized === "tabelog") return "tabelog"
  if (normalized === "ikyu") return "ikyu"
  if (normalized === "manual") return "manual"
  return "all"
}

// 予約イベントのソース → 物理テーブル名（手入力含む）。
function reservationEventTableForSource(source: string): string | null {
  if (source === "tabelog") return "tabelog_reservation_visit_events"
  if (source === "ikyu") return "ikyu_reservation_visit_events"
  if (source === "manual") return "manual_reservation_visit_events"
  return null
}

// 既存イベント表（tabelog/ikyu）が手動編集用に追加した列を含めた SELECT 列。
const RESERVATION_EVENT_SELECT_COLUMNS =
  "id, gmail_message_id, customer_name, customer_phone, visit_at, created_at, reservation_type, reservation_detail, manual_hidden, manual_hidden_reason, manual_store_key, manual_edited_at"

// 手入力予約表の SELECT 列（gmail_message_id を持たない）。
const MANUAL_RESERVATION_SELECT_COLUMNS =
  "id, customer_name, customer_phone, visit_at, created_at, reservation_type, reservation_detail, manual_hidden, manual_hidden_reason, manual_store_key, updated_at"

const RESERVATION_MANUAL_HIDDEN_REASONS = new Set(["cancel", "mistake", "other"])

// 来店日時の入力（"2026-06-04T18:30" 等）を ISO 文字列へ正規化。妥当でなければ null。
function normalizeReservationVisitAtIso(value: unknown): string | null {
  const raw = String(value ?? "").trim()
  if (!raw) return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function buildJstMonthRange(month: string): { startIso: string; endIso: string } {
  const matched = month.match(/^(\d{4})-(\d{2})$/)
  if (!matched) {
    const fallbackStart = new Date()
    const fallbackEnd = new Date(fallbackStart.getTime() + 31 * 24 * 60 * 60 * 1000)
    return {
      startIso: fallbackStart.toISOString(),
      endIso: fallbackEnd.toISOString(),
    }
  }
  const year = Number(matched[1])
  const monthNumber = Number(matched[2])
  const startUtc = Date.UTC(year, monthNumber - 1, 1, -9, 0, 0)
  const endUtc = Date.UTC(year, monthNumber, 1, -9, 0, 0)
  return {
    startIso: new Date(startUtc).toISOString(),
    endIso: new Date(endUtc).toISOString(),
  }
}

async function fetchLineDocumentUsageStats(
  supabase: ReturnType<typeof createClient>,
  roomId: string | null,
): Promise<{ ok: true; stats: MediaUsageStats } | { ok: false; message: string }> {
  const { data, error } = await supabase.rpc("get_line_document_usage_stats", {
    filter_room_id: roomId,
  })
  if (error) {
    return { ok: false, message: `Failed to fetch document usage stats: ${error.message}` }
  }
  const row = Array.isArray(data) ? data[0] : null
  const totalFiles = toNonNegativeInteger((row as any)?.total_files)
  const totalBytes = toNonNegativeInteger((row as any)?.total_bytes)
  return {
    ok: true,
    stats: {
      total_files: totalFiles,
      total_bytes: totalBytes,
    },
  }
}

function normalizeDocumentListRow(value: unknown): DocumentListRow | null {
  if (!isRecord(value)) return null
  const idNum = Number(value.id)
  if (!Number.isFinite(idNum) || idNum <= 0) return null

  const storageBucket = toSafeString(value.storage_bucket)
  const storagePath = toSafeString(value.storage_path)
  const originalFileName = toSafeString(value.original_file_name)
  if (!storageBucket || !storagePath || !originalFileName) return null

  const mimeType = normalizeDocumentMimeType(String(value.mime_type ?? ""), originalFileName)
  if (!mimeType) return null

  return {
    id: Math.floor(idNum),
    room_id: value.room_id == null ? null : toSafeString(value.room_id) || null,
    room_name: value.room_name == null ? null : String(value.room_name),
    storage_bucket: storageBucket,
    storage_path: storagePath,
    original_file_name: originalFileName,
    mime_type: mimeType,
    file_size_bytes: toNonNegativeInteger(value.file_size_bytes),
    extracted_text: normalizeExtractedText(String(value.extracted_text ?? "")),
    source: toSafeString(value.source) || "manual_upload",
    created_at: String(value.created_at ?? ""),
    updated_at: String(value.updated_at ?? ""),
  }
}

async function uploadDocumentFile(
  req: Request,
  supabase: ReturnType<typeof createClient>,
) {
  const contentLength = Number(req.headers.get("content-length") ?? "")
  if (Number.isFinite(contentLength) && contentLength > DOCUMENT_UPLOAD_MAX_BYTES + 1024 * 1024) {
    throw { status: 400, message: "payload is too large." } satisfies AppError
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    throw {
      status: 400,
      message: "Upload request must be multipart/form-data.",
    } satisfies AppError
  }

  const fileValue = formData.get("file")
  if (!(fileValue instanceof File)) {
    throw { status: 400, message: "file is required." } satisfies AppError
  }
  if (!Number.isFinite(fileValue.size) || fileValue.size <= 0) {
    throw { status: 400, message: "file must not be empty." } satisfies AppError
  }
  if (fileValue.size >= DOCUMENT_UPLOAD_MAX_BYTES) {
    throw {
      status: 400,
      message: `file must be smaller than ${Math.floor(DOCUMENT_UPLOAD_MAX_BYTES / (1024 * 1024))}MB.`,
    } satisfies AppError
  }

  const roomIdRaw = toSafeString(formData.get("room_id"))
  const roomId = roomIdRaw || null
  let roomName = toSafeString(formData.get("room_name")) || null

  const originalFileName = sanitizeUploadFileName(fileValue.name || "document")
  const mimeType = normalizeDocumentMimeType(fileValue.type || "", originalFileName)
  if (!mimeType) {
    throw { status: 400, message: "Only TXT/PDF/DOCX/XLSX files can be uploaded." } satisfies AppError
  }

  const buffer = await fileValue.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const validationError = await validateDocumentPayloadSafety(bytes, mimeType)
  if (validationError) {
    throw { status: 400, message: validationError } satisfies AppError
  }
  const fallbackExtractedText = mimeType === "text/plain"
    ? tryDecodeText(bytes)
    : mimeType === "application/pdf"
      ? await extractPdfText(bytes)
      : mimeType === DOCX_MIME_TYPE
        ? await extractDocxText(bytes)
        : mimeType === XLSX_MIME_TYPE
          ? await extractXlsxText(bytes)
      : ""
  const extractedText = normalizeExtractedText(fallbackExtractedText)
  const nowIso = new Date().toISOString()
  const storagePath = buildDocumentStoragePath(roomId, originalFileName)

  const uploadRes = await supabase
    .storage
    .from(LINE_DOCUMENT_BUCKET)
    .upload(storagePath, bytes, {
      contentType: mimeType,
      upsert: false,
    })
  if (uploadRes.error) {
    throw { status: 500, message: `Failed to upload document: ${uploadRes.error.message}` } satisfies AppError
  }

  if (roomId && !roomName) {
    const { data: roomRow } = await supabase
      .from("room_summary_settings")
      .select("room_name")
      .eq("room_id", roomId)
      .maybeSingle()
    roomName = toSafeString(roomRow?.room_name) || null
  }

  const insertPayload = {
    room_id: roomId,
    room_name: roomName,
    storage_bucket: LINE_DOCUMENT_BUCKET,
    storage_path: storagePath,
    original_file_name: originalFileName,
    mime_type: mimeType,
    file_size_bytes: bytes.byteLength,
    extracted_text: extractedText,
    source: "manual_upload",
    created_at: nowIso,
    updated_at: nowIso,
  }
  const { data: inserted, error: insertError } = await supabase
    .from("line_search_documents")
    .insert(insertPayload)
    .select("id, room_id, room_name, storage_bucket, storage_path, original_file_name, mime_type, file_size_bytes, extracted_text, source, created_at, updated_at")
    .single()

  if (insertError) {
    await supabase.storage.from(LINE_DOCUMENT_BUCKET).remove([storagePath])
    throw { status: 500, message: `Failed to save document metadata: ${insertError.message}` } satisfies AppError
  }

  const normalized = normalizeDocumentListRow(inserted)
  if (!normalized) {
    await supabase.storage.from(LINE_DOCUMENT_BUCKET).remove([storagePath])
    throw { status: 500, message: "Saved document row is invalid." } satisfies AppError
  }

  const signedUrl = await createSignedMediaDownloadUrl(
    supabase,
    normalized.storage_bucket,
    normalized.storage_path,
    normalized.original_file_name,
  )
  return {
    ...normalized,
    snippet: buildDocumentSnippet(normalized.extracted_text, DOCUMENT_PREVIEW_MAX_CHARS),
    signed_url: signedUrl,
    has_extracted_text: normalized.extracted_text.length > 0,
    extracted_char_count: normalized.extracted_text.length,
  }
}

function normalizeDocumentMimeType(rawMimeType: string, fileName: string): DocumentMimeType | null {
  const normalizedMimeType = String(rawMimeType ?? "").split(";")[0].trim().toLowerCase()
  if (normalizedMimeType === "text/plain") return "text/plain"
  if (normalizedMimeType === "application/pdf") return "application/pdf"
  if (normalizedMimeType === DOCX_MIME_TYPE) return DOCX_MIME_TYPE
  if (normalizedMimeType === XLSX_MIME_TYPE) return XLSX_MIME_TYPE

  const ext = extractFileExt(fileName)
  if (ext === "txt" || ext === "log" || ext === "md" || ext === "csv") {
    return "text/plain"
  }
  if (ext === "pdf") return "application/pdf"
  if (ext === "docx") return DOCX_MIME_TYPE
  if (ext === "xlsx") return XLSX_MIME_TYPE
  return null
}

function parseDocumentPermissionPath(path: string): number | null {
  const match = path.match(/^\/documents\/(\d+)\/permissions$/)
  if (!match || !match[1]) return null
  const documentId = Number(match[1])
  if (!Number.isInteger(documentId) || documentId <= 0) return null
  return documentId
}

async function ensureDocumentExists(
  supabase: ReturnType<typeof createClient>,
  documentId: number,
): Promise<void> {
  const { data, error } = await supabase
    .from("line_search_documents")
    .select("id")
    .eq("id", documentId)
    .maybeSingle()
  if (error) {
    throw { status: 500, message: `Failed to fetch document row: ${error.message}` } satisfies AppError
  }
  if (!data?.id) {
    throw { status: 404, message: "Document not found." } satisfies AppError
  }
}

async function fetchDocumentPermissionStateById(
  supabase: ReturnType<typeof createClient>,
  documentId: number,
): Promise<DocumentViewerPermissionState> {
  await ensureDocumentExists(supabase, documentId)
  const { data, error } = await supabase
    .from("line_search_document_viewers")
    .select("line_user_id")
    .eq("document_id", documentId)
    .order("line_user_id", { ascending: true })
  if (error) {
    throw { status: 500, message: `Failed to fetch document permissions: ${error.message}` } satisfies AppError
  }
  const ids = Array.isArray(data)
    ? data.map((row) => toSafeString(row?.line_user_id)).filter((value) => value.length > 0)
    : []
  return {
    document_id: documentId,
    mode: ids.length > 0 ? "restricted" : "public",
    allowed_user_ids: ids,
  }
}

function normalizeDocumentPermissionUserIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    const normalized = String(value ?? "").trim()
    if (!normalized || normalized.length > 191) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= 300) break
  }
  return out
}

async function updateDocumentPermissionStateById(
  supabase: ReturnType<typeof createClient>,
  documentId: number,
  body: Record<string, unknown>,
): Promise<DocumentViewerPermissionState> {
  await ensureDocumentExists(supabase, documentId)

  const modeRaw = String(body.mode ?? "").trim().toLowerCase()
  const requestedIds = normalizeDocumentPermissionUserIds(body.line_user_ids)
  const shouldRestrict = modeRaw === "restricted" || (modeRaw !== "public" && requestedIds.length > 0)
  if (shouldRestrict && requestedIds.length === 0) {
    throw { status: 400, message: "restricted mode requires line_user_ids." } satisfies AppError
  }

  const { error: deleteError } = await supabase
    .from("line_search_document_viewers")
    .delete()
    .eq("document_id", documentId)
  if (deleteError) {
    throw { status: 500, message: `Failed to clear existing document permissions: ${deleteError.message}` } satisfies AppError
  }

  if (shouldRestrict) {
    const rows = requestedIds.map((lineUserId) => ({
      document_id: documentId,
      line_user_id: lineUserId,
    }))
    const { error: insertError } = await supabase
      .from("line_search_document_viewers")
      .insert(rows)
    if (insertError) {
      throw { status: 500, message: `Failed to save document permissions: ${insertError.message}` } satisfies AppError
    }
  }

  return await fetchDocumentPermissionStateById(supabase, documentId)
}

async function fetchDocumentPermissionSummaries(
  supabase: ReturnType<typeof createClient>,
  documentIds: number[],
): Promise<Map<number, { mode: "public" | "restricted"; allowed_user_count: number }>> {
  const out = new Map<number, { mode: "public" | "restricted"; allowed_user_count: number }>()
  const ids = Array.from(new Set(documentIds.filter((value) => Number.isInteger(value) && value > 0)))
  if (ids.length === 0) return out

  const { data, error } = await supabase
    .from("line_search_document_viewers")
    .select("document_id, line_user_id")
    .in("document_id", ids)
  if (error) {
    console.error("Failed to fetch document permission summaries:", error.message)
    return out
  }

  const counts = new Map<number, number>()
  for (const row of Array.isArray(data) ? data : []) {
    const documentId = Number((row as any)?.document_id)
    if (!Number.isInteger(documentId) || documentId <= 0) continue
    counts.set(documentId, (counts.get(documentId) || 0) + 1)
  }
  for (const documentId of ids) {
    const count = counts.get(documentId) || 0
    out.set(documentId, {
      mode: count > 0 ? "restricted" : "public",
      allowed_user_count: count,
    })
  }
  return out
}

function sanitizeUploadFileName(value: string): string {
  const safe = String(value ?? "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
  if (!safe) return "document.txt"
  return safe.length <= 180 ? safe : safe.slice(0, 180).trimEnd()
}

function extractFileExt(fileName: string): string {
  const safe = sanitizeUploadFileName(fileName)
  const idx = safe.lastIndexOf(".")
  if (idx < 0 || idx === safe.length - 1) return ""
  return safe
    .slice(idx + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

function buildDocumentStoragePath(roomId: string | null, originalFileName: string): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, "0")
  const d = String(now.getUTCDate()).padStart(2, "0")
  const roomSegment = sanitizeStoragePathSegment(roomId || "shared")
  const ext = extractFileExt(originalFileName) || "bin"
  const baseName = sanitizeStoragePathSegment(originalFileName.replace(/\.[^.]+$/, "") || "document")
  const docId = crypto.randomUUID()
  return `${y}/${m}/${d}/${roomSegment}/${docId}-${baseName}.${ext}`
}

function sanitizeStoragePathSegment(value: string): string {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
  if (!cleaned) return "unknown"
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned
}

async function loadPdfJsModule(): Promise<PdfJsModule | null> {
  if (!cachedPdfJsModulePromise) {
    cachedPdfJsModulePromise = import(PDFJS_MODULE_URL)
      .then((mod) => {
        if (isRecord(mod) && typeof mod.getDocument === "function") {
          return mod as unknown as PdfJsModule
        }
        console.error("pdfjs module is invalid: getDocument is missing.")
        return null
      })
      .catch((error) => {
        console.error("Failed to load pdfjs module:", error)
        return null
      })
  }
  return await cachedPdfJsModulePromise
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await loadPdfJsModule()
  if (!pdfjs) return ""

  let loadingTask: PdfJsLoadingTask | null = null
  let pdfDocument: PdfJsDocument | null = null
  try {
    loadingTask = pdfjs.getDocument({
      data: bytes,
      disableWorker: true,
      useSystemFonts: false,
      isEvalSupported: false,
      stopAtErrors: false,
    })
    pdfDocument = await loadingTask.promise

    const numPages = Number(pdfDocument.numPages || 0)
    if (!Number.isFinite(numPages) || numPages <= 0) return ""

    const pagesToRead = Math.min(numPages, DOCUMENT_PDF_EXTRACT_MAX_PAGES)
    const chunks: string[] = []
    let extractedChars = 0

    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber += 1) {
      let page: PdfJsPage | null = null
      try {
        page = await pdfDocument.getPage(pageNumber)
        const textContent = await page.getTextContent()
        const rawItems = Array.isArray(textContent?.items) ? textContent.items : []
        const pageText = rawItems
          .map((item) => {
            if (!isRecord(item)) return ""
            const strValue = (item as PdfJsTextItem).str
            return typeof strValue === "string" ? strValue : ""
          })
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
        if (!pageText) continue

        const remaining = DOCUMENT_EXTRACT_MAX_CHARS - extractedChars
        if (remaining <= 0) break
        const clipped = pageText.length > remaining
          ? pageText.slice(0, remaining)
          : pageText
        chunks.push(clipped)
        extractedChars += clipped.length + 1
        if (extractedChars >= DOCUMENT_EXTRACT_MAX_CHARS) break
      } catch (pageError) {
        console.error(`Failed to extract PDF page text (${pageNumber}):`, pageError)
      } finally {
        try {
          page?.cleanup?.()
        } catch {
          // no-op
        }
      }
    }

    return normalizeExtractedText(chunks.join("\n"))
  } catch (error) {
    console.error("Failed to extract PDF text:", error)
    return ""
  } finally {
    try {
      pdfDocument?.cleanup?.()
    } catch {
      // no-op
    }
    try {
      await pdfDocument?.destroy?.()
    } catch {
      // no-op
    }
    try {
      await loadingTask?.destroy?.()
    } catch {
      // no-op
    }
  }
}

async function loadOfficeZip(bytes: Uint8Array): Promise<JSZip | null> {
  try {
    return await JSZip.loadAsync(bytes, {
      checkCRC32: false,
      createFolders: false,
    })
  } catch (error) {
    console.error("Failed to load office archive:", error)
    return null
  }
}

async function validateDocumentPayloadSafety(
  bytes: Uint8Array,
  mimeType: DocumentMimeType,
): Promise<string | null> {
  if (mimeType === "application/pdf" && !hasPdfMagicHeader(bytes)) {
    return "Invalid PDF payload."
  }
  if (mimeType === DOCX_MIME_TYPE || mimeType === XLSX_MIME_TYPE) {
    if (!hasZipMagicHeader(bytes)) {
      return "Office file must be a valid ZIP container."
    }
    const inspection = await inspectOfficeArchiveSafety(bytes, mimeType)
    if (!inspection.ok) return inspection.message
    return null
  }
  if (mimeType === "text/plain" && looksLikeBinaryTextPayload(bytes)) {
    return "Text file appears to contain binary data."
  }
  return null
}

function hasPdfMagicHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false
  return bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d
}

function hasZipMagicHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false
  const marker = bytes[2] * 256 + bytes[3]
  return marker === 0x0304 || marker === 0x0506 || marker === 0x0708
}

function looksLikeBinaryTextPayload(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  const sampleSize = Math.min(bytes.length, 4096)
  let binaryCount = 0
  for (let i = 0; i < sampleSize; i += 1) {
    const value = bytes[i]
    const isAllowedControl = value === 9 || value === 10 || value === 13
    const isTextByte = value >= 32 && value <= 126
    const isMultiByteLead = value >= 0x80
    if (!isAllowedControl && !isTextByte && !isMultiByteLead) {
      binaryCount += 1
    }
  }
  return (binaryCount / sampleSize) > DOCUMENT_TEXT_BINARY_RATIO_MAX
}

async function inspectOfficeArchiveSafety(
  bytes: Uint8Array,
  mimeType: DocumentMimeType,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes, {
      checkCRC32: false,
      createFolders: false,
    })
  } catch {
    return { ok: false, message: "Failed to parse Office archive." }
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  if (entries.length === 0) {
    return { ok: false, message: "Office archive has no files." }
  }
  if (entries.length > DOCUMENT_ARCHIVE_MAX_ENTRIES) {
    return { ok: false, message: "Office archive has too many entries." }
  }

  let totalUncompressed = 0
  let totalCompressed = 0
  for (const entry of entries) {
    const entryName = String(entry.name || "")
    if (!entryName || entryName.startsWith("/") || entryName.includes("../") || entryName.includes("..\\")) {
      return { ok: false, message: "Office archive contains unsafe entry paths." }
    }
    const uncompressedSize = Number((entry as any)?._data?.uncompressedSize ?? 0)
    const compressedSize = Number((entry as any)?._data?.compressedSize ?? 0)
    if (Number.isFinite(uncompressedSize) && uncompressedSize > DOCUMENT_ARCHIVE_SINGLE_ENTRY_MAX_BYTES) {
      return { ok: false, message: "Office archive entry exceeds allowed size." }
    }
    if (Number.isFinite(uncompressedSize) && uncompressedSize > 0) {
      totalUncompressed += uncompressedSize
      if (totalUncompressed > DOCUMENT_ARCHIVE_TOTAL_UNCOMPRESSED_MAX_BYTES) {
        return { ok: false, message: "Office archive exceeds uncompressed size limit." }
      }
    }
    if (Number.isFinite(compressedSize) && compressedSize > 0) {
      totalCompressed += compressedSize
    }
  }

  if (totalCompressed > 0) {
    const compressionRatio = totalUncompressed / totalCompressed
    if (compressionRatio > DOCUMENT_ARCHIVE_MAX_COMPRESSION_RATIO) {
      return { ok: false, message: "Office archive compression ratio is too high." }
    }
  }

  const hasContentTypes = !!zip.file("[Content_Types].xml")
  if (!hasContentTypes) {
    return { ok: false, message: "Office archive is missing required metadata." }
  }
  if (mimeType === DOCX_MIME_TYPE && !zip.file("word/document.xml")) {
    return { ok: false, message: "DOCX payload is missing word/document.xml." }
  }
  if (mimeType === XLSX_MIME_TYPE && !zip.file("xl/workbook.xml")) {
    return { ok: false, message: "XLSX payload is missing xl/workbook.xml." }
  }
  return { ok: true }
}

// プライベート/ループバック/リンクローカルでない（＝意味のある公開）IPか。
function isPublicIp(ip: string): boolean {
  if (!ip || ip === "unknown") return false
  if (/^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip) || /^0\./.test(ip)) return false
  if (ip === "::1" || /^fe80:/i.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip)) return false
  return true
}

// レート制限のキーに使うクライアントIP。攻撃者が自由に詐称してキーを変えられないよう、
// 「詐称できない情報源」を優先する。
function extractClientIp(headers: Headers, info?: { remoteAddr?: { hostname?: string } }): string {
  // 1) プラットフォームが付与する実接続元（クライアントが詐称不可）。公開IPのときのみ採用。
  const remote = String(info?.remoteAddr?.hostname ?? "").trim()
  if (isPublicIp(remote)) return remote
  // 2) Cloudflare が付与する真のクライアントIP（クライアント送信の同名ヘッダは上書き＝詐称不可）。
  const cf = String(headers.get("cf-connecting-ip") ?? "").trim()
  if (cf) return cf
  // 3) プラットフォーム設定の x-real-ip。
  const xreal = String(headers.get("x-real-ip") ?? "").trim()
  if (xreal) return xreal
  // 4) x-forwarded-for は「クライアント, …, 直前プロキシ」の順で、先頭はクライアントが詐称可能。
  //    プラットフォームが最後に付与する「末尾」を使う（旧実装は先頭を採用＝回数制限を回避できた）。
  const xff = String(headers.get("x-forwarded-for") ?? "").trim()
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }
  return "unknown"
}

function resolveAdminRateLimit(method: string, path: string): { maxRequests: number; windowMs: number } {
  // 資格情報を提示する認証エンドポイントは総当たりの標的。既定(180/分)より厳しくする。
  if (method === "POST" && (path === "/auth/link-login" || path === "/auth/session" || path === "/auth/room-config-login" || path === "/auth/verify")) {
    return {
      maxRequests: 20,
      windowMs: ADMIN_RATE_LIMIT_DEFAULT_WINDOW_MS,
    }
  }
  if (method === "POST" && (path === "/documents" || path === "/petty-cash/receipt-image")) {
    return {
      maxRequests: ADMIN_RATE_LIMIT_UPLOAD_MAX_REQUESTS,
      windowMs: ADMIN_RATE_LIMIT_UPLOAD_WINDOW_MS,
    }
  }
  return {
    maxRequests: ADMIN_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
    windowMs: ADMIN_RATE_LIMIT_DEFAULT_WINDOW_MS,
  }
}

async function consumeRateLimitFromDb(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  maxRequests: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const windowSeconds = Math.max(1, Math.floor(windowMs / 1000))
  try {
    const { data, error } = await supabase.rpc("consume_security_rate_limit", {
      rate_bucket: bucket,
      window_seconds: windowSeconds,
      max_hits: maxRequests,
    })
    if (error) {
      console.error("Rate limit RPC failed (admin-api):", error.message)
      return { allowed: true, retryAfterMs: windowMs }
    }
    const row = Array.isArray(data) ? data[0] : null
    const allowed = row?.allowed !== false
    const retryAfterSeconds = Number(row?.retry_after_seconds ?? windowSeconds)
    const retryAfterMs = Math.max(1000, retryAfterSeconds * 1000)
    return { allowed, retryAfterMs }
  } catch (error) {
    console.error("Unexpected rate limit error (admin-api):", error)
    return { allowed: true, retryAfterMs: windowMs }
  }
}

function getOfficeXmlEntries(
  zip: JSZip,
  predicate: (entryName: string) => boolean,
): OfficeZipEntry[] {
  const items = Object.values(zip.files)
    .filter((entry) => !entry.dir && predicate(entry.name))
    .slice(0, DOCUMENT_ARCHIVE_MAX_XML_ENTRIES) as unknown as OfficeZipEntry[]
  return items
}

async function readOfficeXmlEntry(entry: OfficeZipEntry): Promise<string> {
  try {
    const uncompressedSize = Number((entry as any)?._data?.uncompressedSize ?? 0)
    if (Number.isFinite(uncompressedSize) && uncompressedSize > DOCUMENT_ARCHIVE_ENTRY_MAX_BYTES) {
      console.error(`Skipped oversized office xml entry: ${entry.name}`)
      return ""
    }
    const raw = await entry.async("string")
    if (!raw) return ""
    if (raw.length > DOCUMENT_ARCHIVE_ENTRY_MAX_BYTES) {
      return raw.slice(0, DOCUMENT_ARCHIVE_ENTRY_MAX_BYTES)
    }
    return raw
  } catch (error) {
    console.error(`Failed to read office xml entry (${entry.name}):`, error)
    return ""
  }
}

function parseXmlDocument(xml: string): Document | null {
  if (!xml) return null
  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml")
    const parserErrors = doc.getElementsByTagName("parsererror")
    if (parserErrors && parserErrors.length > 0) return null
    return doc
  } catch {
    return null
  }
}

function appendChunkWithinLimit(chunks: string[], chunk: string, remainingChars: number): number {
  if (!Number.isFinite(remainingChars) || remainingChars <= 0) return 0
  const text = String(chunk ?? "")
  if (!text || !/\S/.test(text)) return remainingChars
  const clipped = text.length > remainingChars
    ? text.slice(0, remainingChars)
    : text
  chunks.push(clipped)
  return remainingChars - clipped.length - 1
}

function compareWordXmlEntry(a: string, b: string): number {
  const rank = (entryName: string): number => {
    if (entryName === "word/document.xml") return 0
    if (entryName.startsWith("word/header")) return 1
    if (entryName.startsWith("word/footer")) return 2
    if (entryName.startsWith("word/footnotes")) return 3
    if (entryName.startsWith("word/endnotes")) return 4
    return 9
  }
  const diff = rank(a) - rank(b)
  return diff !== 0 ? diff : a.localeCompare(b)
}

function appendWordXmlNodeText(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.nodeValue
    if (value) out.push(value)
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return

  const el = node as Element
  const local = String(el.localName || "").toLowerCase()
  if (local === "t") {
    const text = el.textContent || ""
    if (text) out.push(text)
    return
  }
  if (local === "tab") {
    out.push("\t")
    return
  }
  if (local === "br" || local === "cr") {
    out.push("\n")
    return
  }

  const children = Array.from(el.childNodes)
  for (const child of children) {
    appendWordXmlNodeText(child, out)
  }
  if (local === "p" || local === "tr") {
    out.push("\n")
  } else if (local === "tc") {
    out.push("\t")
  }
}

function extractWordXmlText(xml: string): string {
  const doc = parseXmlDocument(xml)
  if (!doc || !doc.documentElement) return ""
  const out: string[] = []
  appendWordXmlNodeText(doc.documentElement, out)
  return out.join("")
}

async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const zip = await loadOfficeZip(bytes)
  if (!zip) return ""

  const entries = getOfficeXmlEntries(zip, (entryName) =>
    entryName.startsWith("word/")
      && entryName.endsWith(".xml")
      && !entryName.includes("/_rels/"),
  ).sort((a, b) => compareWordXmlEntry(a.name, b.name))

  const chunks: string[] = []
  let remainingChars = DOCUMENT_EXTRACT_MAX_CHARS
  for (const entry of entries) {
    if (remainingChars <= 0) break
    const xml = await readOfficeXmlEntry(entry)
    if (!xml) continue
    const text = extractWordXmlText(xml)
    if (!text) continue
    remainingChars = appendChunkWithinLimit(chunks, text, remainingChars)
  }
  return normalizeExtractedText(chunks.join("\n"))
}

function collectTextNodes(root: Element, localName: string): string[] {
  const nodes = getSheetElementsLive(root, localName)
  const out: string[] = []
  const isUnderPhonetic = (el: Element | null): boolean => {
    let cur: Node | null = el
    while (cur) {
      const maybeEl = cur as Element
      if (String(maybeEl.localName || "").toLowerCase() === "rph") return true
      cur = cur.parentNode
    }
    return false
  }
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes.item(i)
    if (node && isUnderPhonetic(node)) continue
    const value = node?.textContent ?? ""
    if (value) out.push(value)
  }
  return out
}

function parseXlsxSharedStrings(xml: string): string[] {
  const doc = parseXmlDocument(xml)
  if (!doc || !doc.documentElement) return []
  const siNodes = getSheetElementsLive(doc, "si")
  const out: string[] = []
  for (let i = 0; i < siNodes.length; i += 1) {
    const si = siNodes.item(i)
    if (!si) {
      out.push("")
      continue
    }
    const joined = collectTextNodes(si, "t").join("")
    out.push(joined)
  }
  return out
}

function getDirectChildElementsByLocalName(root: Element, localName: string): Element[] {
  const out: Element[] = []
  const nodes = root.childNodes
  for (let i = 0; i < nodes.length; i += 1) {
    const child = nodes.item(i)
    if (!child) continue
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = child as Element
    if ((el.localName || "").toLowerCase() === localName) {
      out.push(el)
    }
  }
  return out
}

function getFirstSpreadsheetDescendant(root: Element, localName: string): Element | null {
  const byNs = root.getElementsByTagNameNS(OFFICE_SPREADSHEETML_NS, localName)
  if (byNs.length > 0) return byNs.item(0)
  const byStar = root.getElementsByTagNameNS("*", localName)
  if (byStar.length > 0) return byStar.item(0)
  const byTag = root.getElementsByTagName(localName)
  return byTag.length > 0 ? byTag.item(0) : null
}

function columnNameToIndex(columnName: string): number | null {
  const normalized = String(columnName || "").trim().toUpperCase()
  if (!normalized || !/^[A-Z]+$/.test(normalized)) return null
  let value = 0
  for (let i = 0; i < normalized.length; i += 1) {
    value = value * 26 + (normalized.charCodeAt(i) - 64)
  }
  return value - 1
}

function getColumnIndexFromCellRef(cellRef: string): number | null {
  const match = String(cellRef || "").toUpperCase().match(/^([A-Z]+)\d+$/)
  if (!match) return null
  return columnNameToIndex(match[1])
}

function extractXlsxCellText(cell: Element, sharedStrings: string[]): string {
  const cellType = String(cell.getAttribute("t") || "").trim().toLowerCase()
  const valueEl = getFirstSpreadsheetDescendant(cell, "v")
  const rawValue = String(valueEl?.textContent ?? "").trim()

  if (cellType === "s") {
    const idx = Number(rawValue)
    if (Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length) {
      return String(sharedStrings[idx] || "")
    }
    return ""
  }
  if (cellType === "inlineStr") {
    const inlineEl = getFirstSpreadsheetDescendant(cell, "is")
    if (!inlineEl) return ""
    return collectTextNodes(inlineEl, "t").join("")
  }
  if (cellType === "b") {
    if (rawValue === "1") return "TRUE"
    if (rawValue === "0") return "FALSE"
  }
  if (rawValue) return rawValue
  const formulaEl = getFirstSpreadsheetDescendant(cell, "f")
  const formula = String(formulaEl?.textContent ?? "").trim()
  return formula ? `=${formula}` : ""
}

function extractXlsxSheetText(xml: string, sharedStrings: string[]): string {
  const doc = parseXmlDocument(xml)
  if (!doc || !doc.documentElement) return ""

  const rowNodes = getSheetElementsLive(doc, "row")
  const lines: string[] = []
  for (let i = 0; i < rowNodes.length; i += 1) {
    const row = rowNodes.item(i)
    if (!row) continue
    const cellNodes = getDirectChildElementsByLocalName(row, "c")
    if (cellNodes.length === 0) continue

    const cols: string[] = []
    let nextCol = 0
    for (const cell of cellNodes) {
      const ref = String(cell.getAttribute("r") || "")
      const indexedCol = getColumnIndexFromCellRef(ref)
      const col = indexedCol == null ? nextCol : indexedCol
      while (nextCol < col) {
        cols.push("")
        nextCol += 1
      }
      const text = extractXlsxCellText(cell, sharedStrings)
      cols.push(text)
      nextCol = col + 1
    }

    while (cols.length > 0 && !String(cols[cols.length - 1] || "").trim()) {
      cols.pop()
    }
    if (cols.length === 0) continue
    lines.push(cols.join("\t"))
  }
  return lines.join("\n")
}

function compareXlsxWorksheetEntry(a: string, b: string): number {
  const parse = (name: string): number => {
    const match = name.match(/sheet(\d+)\.xml$/)
    if (!match) return Number.POSITIVE_INFINITY
    return Number(match[1])
  }
  const diff = parse(a) - parse(b)
  return Number.isFinite(diff) && diff !== 0 ? diff : a.localeCompare(b)
}

function decodeXmlEntities(value: string): string {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
}

function stripXmlTags(value: string): string {
  return decodeXmlEntities(String(value ?? "").replace(/<[^>]+>/g, ""))
}

function parseXlsxSharedStringsByRegex(xml: string): string[] {
  const out: string[] = []
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/gi
  let siMatch: RegExpExecArray | null
  while ((siMatch = siRe.exec(xml)) !== null) {
    const siBody = String(siMatch[1] ?? "")
      .replace(/<rPh\b[\s\S]*?<\/rPh>/gi, "")
      .replace(/<phoneticPr\b[^>]*\/?>/gi, "")
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/gi
    let tMatch: RegExpExecArray | null
    const pieces: string[] = []
    while ((tMatch = tRe.exec(siBody)) !== null) {
      pieces.push(stripXmlTags(String(tMatch[1] ?? "")))
    }
    out.push(pieces.join(""))
  }
  return out
}

function parseXlsxSheetTextByRegex(xml: string, sharedStrings: string[]): string {
  const lines: string[] = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi
  let rowMatch: RegExpExecArray | null

  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const rowBody = String(rowMatch[1] ?? "")
    const cols: string[] = []
    let nextCol = 0
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/gi
    let cellMatch: RegExpExecArray | null

    while ((cellMatch = cellRe.exec(rowBody)) !== null) {
      const attr = String(cellMatch[1] ?? "")
      const body = String(cellMatch[2] ?? "")
      const refMatch = /\br="([A-Z]+\d+)"/i.exec(attr)
      const idx = refMatch ? getColumnIndexFromCellRef(refMatch[1]) : null
      const col = idx == null ? nextCol : idx
      while (nextCol < col) {
        cols.push("")
        nextCol += 1
      }

      const typeMatch = /\bt="([^"]+)"/i.exec(attr)
      const cellType = String(typeMatch?.[1] ?? "").trim().toLowerCase()
      let text = ""
      if (cellType === "s") {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)
        const sharedIdx = Number(String(vMatch?.[1] ?? "").trim())
        if (Number.isInteger(sharedIdx) && sharedIdx >= 0 && sharedIdx < sharedStrings.length) {
          text = String(sharedStrings[sharedIdx] ?? "")
        }
      } else if (cellType === "inlineStr") {
        const cleanBody = body
          .replace(/<rPh\b[\s\S]*?<\/rPh>/gi, "")
          .replace(/<phoneticPr\b[^>]*\/?>/gi, "")
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/gi
        let tMatch: RegExpExecArray | null
        const pieces: string[] = []
        while ((tMatch = tRe.exec(cleanBody)) !== null) {
          pieces.push(stripXmlTags(String(tMatch[1] ?? "")))
        }
        text = pieces.join("")
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)
        const rawValue = stripXmlTags(String(vMatch?.[1] ?? "")).trim()
        if (rawValue) {
          text = rawValue
        } else {
          const fMatch = /<f\b[^>]*>([\s\S]*?)<\/f>/i.exec(body)
          const formula = stripXmlTags(String(fMatch?.[1] ?? "")).trim()
          if (formula) text = `=${formula}`
        }
      }
      cols.push(text)
      nextCol = col + 1
    }

    while (cols.length > 0 && !String(cols[cols.length - 1] ?? "").trim()) cols.pop()
    if (cols.length > 0) lines.push(cols.join("\t"))
  }
  return lines.join("\n")
}

async function extractXlsxText(bytes: Uint8Array): Promise<string> {
  const zip = await loadOfficeZip(bytes)
  if (!zip) return ""

  const sharedEntry = zip.file("xl/sharedStrings.xml") as unknown as OfficeZipEntry | null
  const sharedStrings = sharedEntry
    ? parseXlsxSharedStrings(await readOfficeXmlEntry(sharedEntry))
    : []

  const worksheetEntries = getOfficeXmlEntries(zip, (entryName) =>
    entryName.startsWith("xl/worksheets/")
      && entryName.endsWith(".xml")
      && !entryName.includes("/_rels/"),
  ).sort((a, b) => compareXlsxWorksheetEntry(a.name, b.name))

  const chunks: string[] = []
  let remainingChars = DOCUMENT_EXTRACT_MAX_CHARS
  for (const entry of worksheetEntries) {
    if (remainingChars <= 0) break
    const xml = await readOfficeXmlEntry(entry)
    if (!xml) continue
    const text = extractXlsxSheetText(xml, sharedStrings)
    if (!text) continue
    remainingChars = appendChunkWithinLimit(chunks, text, remainingChars)
  }
  const domText = normalizeExtractedText(chunks.join("\n"))
  if (domText) return domText

  const sharedXml = sharedEntry ? await readOfficeXmlEntry(sharedEntry) : ""
  const sharedByRegex = sharedXml ? parseXlsxSharedStringsByRegex(sharedXml) : []
  const regexChunks: string[] = []
  let remainingRegexChars = DOCUMENT_EXTRACT_MAX_CHARS
  for (const entry of worksheetEntries) {
    if (remainingRegexChars <= 0) break
    const xml = await readOfficeXmlEntry(entry)
    if (!xml) continue
    const text = parseXlsxSheetTextByRegex(xml, sharedByRegex)
    if (!text) continue
    remainingRegexChars = appendChunkWithinLimit(regexChunks, text, remainingRegexChars)
  }
  return normalizeExtractedText(regexChunks.join("\n"))
}

function tryDecodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  } catch {
    return ""
  }
}

function normalizeExtractedText(value: string): string {
  const normalized = String(value ?? "")
    .replace(/\u0000/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim()
  if (!normalized) return ""
  if (normalized.length <= DOCUMENT_EXTRACT_MAX_CHARS) return normalized
  return normalized.slice(0, DOCUMENT_EXTRACT_MAX_CHARS).trimEnd()
}

function buildDocumentSnippet(text: string, maxChars: number): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
  if (!normalized) return ""
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars).trimEnd()}…`
}

async function fetchMediaUploadMaxMb(
  supabase: ReturnType<typeof createClient>,
): Promise<number> {
  try {
    const { data, error } = await supabase
      .from("summary_settings")
      .select("media_upload_max_mb")
      .eq("id", 1)
      .maybeSingle()
    if (error) {
      console.error("Failed to fetch media_upload_max_mb:", error.message)
      return DEFAULT_MEDIA_UPLOAD_MAX_MB
    }
    return normalizeMediaUploadMaxMb(data?.media_upload_max_mb)
  } catch (error) {
    console.error("Unexpected error while fetching media_upload_max_mb:", error)
    return DEFAULT_MEDIA_UPLOAD_MAX_MB
  }
}

/** 店舗単位のメディア使用量（store_partition_key で集計）。RPCは room/type のみ対応のため直接集計する。 */
async function fetchStoreMediaUsage(
  supabase: ReturnType<typeof createClient>,
  storePartitionKey: string,
  mediaType: MediaType | null,
): Promise<{ ok: true; stats: MediaUsageStats } | { ok: false; message: string }> {
  let query = supabase
    .from("line_message_media")
    .select("file_size_bytes")
    .eq("store_partition_key", storePartitionKey)
    .limit(10000)
  if (mediaType) {
    query = query.eq("media_type", mediaType)
  }
  const { data, error } = await query
  if (error) {
    return { ok: false, message: `Failed to fetch store media usage: ${error.message}` }
  }
  const rows = Array.isArray(data) ? data : []
  let totalBytes = 0
  for (const r of rows) totalBytes += toNonNegativeInteger((r as { file_size_bytes?: unknown }).file_size_bytes)
  return { ok: true, stats: { total_files: rows.length, total_bytes: totalBytes } }
}

async function fetchLineMediaUsageStats(
  supabase: ReturnType<typeof createClient>,
  roomId: string | null,
  mediaType: MediaType | null,
): Promise<{ ok: true; stats: MediaUsageStats } | { ok: false; message: string }> {
  const { data, error } = await supabase.rpc("get_line_media_usage_stats", {
    filter_room_id: roomId,
    filter_media_type: mediaType,
  })
  if (error) {
    return { ok: false, message: `Failed to fetch media usage stats: ${error.message}` }
  }

  const row = Array.isArray(data) ? data[0] : null
  const totalFiles = toNonNegativeInteger((row as any)?.total_files)
  const totalBytes = toNonNegativeInteger((row as any)?.total_bytes)
  return {
    ok: true,
    stats: {
      total_files: totalFiles,
      total_bytes: totalBytes,
    },
  }
}

function normalizeMediaType(value: string | null): MediaType | null {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (normalized === "image" || normalized === "video" || normalized === "audio" || normalized === "file") {
    return normalized
  }
  return null
}

function normalizeMediaListRow(value: unknown): MediaListRow | null {
  if (!isRecord(value)) return null
  const idNum = Number(value.id)
  if (!Number.isFinite(idNum) || idNum <= 0) return null
  const mediaType = normalizeMediaType(String(value.media_type ?? ""))
  if (!mediaType) return null

  const messageId = toSafeString(value.message_id)
  const lineMessageId = toSafeString(value.line_message_id)
  const roomId = toSafeString(value.room_id)
  const storageBucket = toSafeString(value.storage_bucket)
  const storagePath = toSafeString(value.storage_path)
  // message_id は Webhook 保存メディア（メッセージ行と紐付かない）では null。
  // line_message_id とストレージ情報が揃っていれば表示対象とする。
  if (!lineMessageId || !roomId || !storageBucket || !storagePath) return null

  return {
    id: Math.floor(idNum),
    message_id: messageId || null,
    line_message_id: lineMessageId,
    room_id: roomId,
    room_name: value.room_name == null ? null : String(value.room_name),
    user_id: value.user_id == null ? null : String(value.user_id),
    sender_display_name: value.sender_display_name == null || String(value.sender_display_name).trim() === ""
      ? null
      : String(value.sender_display_name).trim(),
    media_type: mediaType,
    storage_bucket: storageBucket,
    storage_path: storagePath,
    original_file_name: value.original_file_name == null ? null : String(value.original_file_name),
    mime_type: value.mime_type == null ? null : String(value.mime_type),
    file_size_bytes: toNonNegativeInteger(value.file_size_bytes),
    content_preview: value.content_preview == null || value.content_preview === ""
      ? null
      : String(value.content_preview),
    created_at: String(value.created_at ?? ""),
  }
}

async function fetchRoomNameMapForIds(
  supabase: ReturnType<typeof createClient>,
  roomIds: string[],
): Promise<Map<string, string>> {
  const normalizedIds = Array.from(
    new Set(
      roomIds
        .map((value) => String(value ?? "").trim())
        .filter((value) => value.length > 0),
    ),
  )
  if (normalizedIds.length === 0) return new Map<string, string>()

  const { data, error } = await supabase
    .from("room_summary_settings")
    .select("room_id, room_name")
    .in("room_id", normalizedIds)

  if (error) {
    console.error("Failed to fetch room names for media list:", error.message)
    return new Map<string, string>()
  }

  const map = new Map<string, string>()
  for (const row of Array.isArray(data) ? data : []) {
    const id = toSafeString((row as any)?.room_id)
    const name = toSafeString((row as any)?.room_name)
    if (!id || !name) continue
    map.set(id, name)
  }
  return map
}

// 投稿者名の補完: 保存時に sender_display_name が未取得（null）でも、user_id が
// line_user_permissions に登録済みなら、その display_name を表示用に補う。
// 店舗ごとの保存メディア件数（全種別・絞り込みに依存しない総数）。
// メディア閲覧の店舗セレクタに「店名 (件数)」を表示するために使う。
async function fetchMediaCountByStore(
  supabase: ReturnType<typeof createClient>,
): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from("line_message_media")
    .select("store_partition_key")
    .limit(100000)
  if (error) {
    console.error("Failed to fetch media counts by store:", error.message)
    return {}
  }
  const counts: Record<string, number> = {}
  for (const row of Array.isArray(data) ? data : []) {
    const key = String((row as { store_partition_key?: unknown })?.store_partition_key ?? "").trim()
    if (!key) continue
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

async function fetchSenderNameMapForUserIds(
  supabase: ReturnType<typeof createClient>,
  userIds: string[],
): Promise<Map<string, string>> {
  const normalizedIds = Array.from(
    new Set(
      userIds
        .map((value) => String(value ?? "").trim())
        .filter((value) => value.length > 0),
    ),
  )
  if (normalizedIds.length === 0) return new Map<string, string>()

  const { data, error } = await supabase
    .from("line_user_permissions")
    .select("line_user_id, display_name")
    .in("line_user_id", normalizedIds)

  if (error) {
    console.error("Failed to fetch sender names for media list:", error.message)
    return new Map<string, string>()
  }

  const map = new Map<string, string>()
  for (const row of Array.isArray(data) ? data : []) {
    const id = toSafeString((row as any)?.line_user_id)
    const name = toSafeString((row as any)?.display_name)
    if (!id || !name) continue
    map.set(id, name)
  }
  return map
}

async function fetchMediaContextMap(
  supabase: ReturnType<typeof createClient>,
  rows: MediaListRow[],
): Promise<Map<number, MediaMessageContext>> {
  const contextMap = new Map<number, MediaMessageContext>()
  if (rows.length === 0) return contextMap

  const anchorMessageIds = Array.from(
    new Set(rows.map((row) => row.message_id).filter((id): id is string => typeof id === "string" && id.length > 0)),
  )
  const anchorMap = new Map<string, { room_id: string; created_at: string }>()
  if (anchorMessageIds.length > 0) {
    const { data: anchorRows, error: anchorError } = await supabase
      .from("line_messages")
      .select("id, room_id, created_at")
      .in("id", anchorMessageIds)
    if (anchorError) {
      console.error("Failed to fetch anchor line_messages for media context:", anchorError.message)
    } else {
      for (const row of Array.isArray(anchorRows) ? anchorRows : []) {
        const id = toSafeString((row as any)?.id)
        const roomId = toSafeString((row as any)?.room_id)
        const createdAt = toSafeString((row as any)?.created_at)
        if (!id || !roomId || !createdAt) continue
        anchorMap.set(id, { room_id: roomId, created_at: createdAt })
      }
    }
  }

  const contextEntries = await Promise.all(rows.map(async (row) => {
    const anchor = row.message_id ? anchorMap.get(row.message_id) : undefined
    const roomId = anchor?.room_id || row.room_id
    const createdAt = anchor?.created_at || row.created_at
    if (!roomId || !createdAt) {
      return {
        mediaId: row.id,
        context: {
          before_text: null,
          before_at: null,
          after_text: null,
          after_at: null,
        } satisfies MediaMessageContext,
      }
    }

    const [beforeRes, afterRes] = await Promise.all([
      supabase
        .from("line_messages")
        .select("content, created_at")
        .eq("room_id", roomId)
        .lt("created_at", createdAt)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("line_messages")
        .select("content, created_at")
        .eq("room_id", roomId)
        .gt("created_at", createdAt)
        .order("created_at", { ascending: true })
        .limit(8),
    ])

    if (beforeRes.error) {
      console.error(`Failed to fetch before-context for media ${row.id}:`, beforeRes.error.message)
    }
    if (afterRes.error) {
      console.error(`Failed to fetch after-context for media ${row.id}:`, afterRes.error.message)
    }

    const before = pickMediaContextCandidate(beforeRes.data)
    const after = pickMediaContextCandidate(afterRes.data)
    return {
      mediaId: row.id,
      context: {
        before_text: before?.text ?? null,
        before_at: before?.created_at ?? null,
        after_text: after?.text ?? null,
        after_at: after?.created_at ?? null,
      } satisfies MediaMessageContext,
    }
  }))

  for (const entry of contextEntries) {
    contextMap.set(entry.mediaId, entry.context)
  }
  return contextMap
}

function pickMediaContextCandidate(
  rows: unknown,
): { text: string; created_at: string | null } | null {
  const list = Array.isArray(rows) ? rows : []
  for (const row of list) {
    const rawText = typeof (row as any)?.content === "string" ? String((row as any).content) : ""
    const text = normalizeMediaContextText(rawText)
    if (!text) continue
    const createdAt = toSafeString((row as any)?.created_at) || null
    return { text, created_at: createdAt }
  }
  return null
}

function normalizeMediaContextText(raw: string): string {
  if (!raw) return ""
  const withoutMetaLines = raw
    .split(/\r?\n/)
    .map((line) => String(line ?? "").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isInternalLineMessageMetaLine(line))
    .join(" ")
    .replace(/\[\[MEDIA:[^\]]+\]\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!withoutMetaLines) return ""
  return truncateForContext(withoutMetaLines, 120)
}

function isInternalLineMessageMetaLine(line: string): boolean {
  return /^(LINE room_id:|LINE user_id:|source:\s*line-webhook)/i.test(line)
}

function truncateForContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}…`
}

async function createSignedMediaUrl(
  supabase: ReturnType<typeof createClient>,
  storageBucket: string,
  storagePath: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .storage
      .from(storageBucket)
      .createSignedUrl(storagePath, MEDIA_SIGNED_URL_EXPIRES_SEC)
    if (error) {
      console.error(`Failed to create signed URL for ${storageBucket}/${storagePath}:`, error.message)
      return null
    }
    const signedUrl = typeof data?.signedUrl === "string" ? data.signedUrl.trim() : ""
    return signedUrl || null
  } catch (error) {
    console.error(`Unexpected error while signing media URL for ${storageBucket}/${storagePath}:`, error)
    return null
  }
}

async function createSignedMediaDownloadUrl(
  supabase: ReturnType<typeof createClient>,
  storageBucket: string,
  storagePath: string,
  fileName: string,
): Promise<string | null> {
  const safeName = sanitizeDownloadFileName(fileName)
  const downloadOption: string | boolean = safeName || true
  try {
    const { data, error } = await supabase
      .storage
      .from(storageBucket)
      .createSignedUrl(storagePath, MEDIA_SIGNED_URL_EXPIRES_SEC, {
        download: downloadOption,
      } as any)
    if (error) {
      console.error(`Failed to create signed download URL for ${storageBucket}/${storagePath}:`, error.message)
      return null
    }
    const signedUrl = typeof data?.signedUrl === "string" ? data.signedUrl.trim() : ""
    return signedUrl || null
  } catch (error) {
    console.error(`Unexpected error while signing media download URL for ${storageBucket}/${storagePath}:`, error)
    return null
  }
}

function sanitizeDownloadFileName(value: string): string {
  const sanitized = String(value ?? "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
  if (!sanitized) return ""
  if (sanitized.length <= 120) return sanitized
  return sanitized.slice(0, 120).trimEnd()
}

function formatLineMediaTag(lineMessageId: string): string {
  return `[[MEDIA:${lineMessageId}]]`
}

async function deleteMediaItemById(
  supabase: ReturnType<typeof createClient>,
  mediaId: number,
): Promise<{ media_id: number; room_id: string; line_message_id: string; storage_deleted: boolean }> {
  const { data: row, error: fetchError } = await supabase
    .from("line_message_media")
    .select("id, room_id, line_message_id, storage_bucket, storage_path")
    .eq("id", mediaId)
    .maybeSingle()
  if (fetchError) {
    throw { status: 500, message: `Failed to fetch media row: ${fetchError.message}` } satisfies AppError
  }
  if (!row) {
    throw { status: 404, message: "Media not found." } satisfies AppError
  }

  const storageBucket = toSafeString(row.storage_bucket)
  const storagePath = toSafeString(row.storage_path)
  let storageDeleted = false
  if (storageBucket && storagePath) {
    const { data: removed, error: removeError } = await supabase
      .storage
      .from(storageBucket)
      .remove([storagePath])
    if (removeError) {
      throw { status: 500, message: `Failed to delete storage object: ${removeError.message}` } satisfies AppError
    }
    storageDeleted = Array.isArray(removed) && removed.length > 0
  }

  const { error: deleteError } = await supabase
    .from("line_message_media")
    .delete()
    .eq("id", mediaId)
  if (deleteError) {
    throw { status: 500, message: `Failed to delete media metadata: ${deleteError.message}` } satisfies AppError
  }

  return {
    media_id: mediaId,
    room_id: String(row.room_id ?? ""),
    line_message_id: String(row.line_message_id ?? ""),
    storage_deleted: storageDeleted,
  }
}

async function deleteDocumentById(
  supabase: ReturnType<typeof createClient>,
  documentId: number,
): Promise<{ document_id: number; room_id: string | null; storage_deleted: boolean }> {
  const { data: row, error: fetchError } = await supabase
    .from("line_search_documents")
    .select("id, room_id, storage_bucket, storage_path")
    .eq("id", documentId)
    .maybeSingle()
  if (fetchError) {
    throw { status: 500, message: `Failed to fetch document row: ${fetchError.message}` } satisfies AppError
  }
  if (!row) {
    throw { status: 404, message: "Document not found." } satisfies AppError
  }

  const storageBucket = toSafeString(row.storage_bucket)
  const storagePath = toSafeString(row.storage_path)
  let storageDeleted = false
  if (storageBucket && storagePath) {
    const { data: removed, error: removeError } = await supabase
      .storage
      .from(storageBucket)
      .remove([storagePath])
    if (removeError) {
      throw { status: 500, message: `Failed to delete storage object: ${removeError.message}` } satisfies AppError
    }
    storageDeleted = Array.isArray(removed) && removed.length > 0
  }

  const { error: deleteError } = await supabase
    .from("line_search_documents")
    .delete()
    .eq("id", documentId)
  if (deleteError) {
    throw { status: 500, message: `Failed to delete document metadata: ${deleteError.message}` } satisfies AppError
  }

  return {
    document_id: documentId,
    room_id: row.room_id == null ? null : String(row.room_id),
    storage_deleted: storageDeleted,
  }
}

async function unregisterRoomFromAdmin(
  supabase: ReturnType<typeof createClient>,
  roomId: string,
  adminSurface: string,
): Promise<
  | {
    ok: true
    admin_surface: string
    unregistered: { room_settings: number; line_room_names: number; dismissed: number; webhook_unlinked: number }
    retained: { messages: number }
  }
  | { ok: false; message: string }
> {
  const surface = adminSurface === ADMIN_SURFACE_LINE_REPORT
    ? ADMIN_SURFACE_LINE_REPORT
    : ADMIN_SURFACE_LEGACY

  const { count: messageCount, error: messageCountError } = await supabase
    .from("line_messages")
    .select("id", { count: "exact", head: true })
    .eq("room_id", roomId)
  if (messageCountError) {
    return { ok: false, message: `Failed to count room messages: ${messageCountError.message}` }
  }

  const { data: roomSettingsRow, error: roomSettingsCountError } = await supabase
    .from("room_summary_settings")
    .select("room_id, receipt_report_store_partition_key")
    .eq("room_id", roomId)
    .maybeSingle()
  if (roomSettingsCountError) {
    return { ok: false, message: `Failed to inspect room settings: ${roomSettingsCountError.message}` }
  }

  const { data: lineRoomNamesRow, error: lineRoomNamesInspectError } = await supabase
    .from("line_room_names")
    .select("room_id")
    .eq("room_id", roomId)
    .maybeSingle()
  if (lineRoomNamesInspectError) {
    return { ok: false, message: `Failed to inspect line_room_names: ${lineRoomNamesInspectError.message}` }
  }

  const now = new Date().toISOString()
  const { error: dismissError } = await supabase
    .from("line_room_dismissed")
    .upsert({
      room_id: roomId,
      admin_surface: surface,
      dismissed_at: now,
    }, { onConflict: "room_id,admin_surface" })
  if (dismissError) {
    return { ok: false, message: `Failed to dismiss room: ${dismissError.message}` }
  }

  let webhookUnlinked = 0
  if (surface === ADMIN_SURFACE_LINE_REPORT) {
    if (roomSettingsRow?.room_id && roomSettingsRow.receipt_report_store_partition_key) {
      const { error: unlinkError } = await supabase
        .from("room_summary_settings")
        .update({
          receipt_report_store_partition_key: null,
          updated_at: now,
        })
        .eq("room_id", roomId)
      if (unlinkError) {
        return { ok: false, message: `Failed to unlink room webhook assignment: ${unlinkError.message}` }
      }
      webhookUnlinked = 1
    }
    return {
      ok: true,
      admin_surface: surface,
      unregistered: {
        room_settings: 0,
        line_room_names: 0,
        dismissed: 1,
        webhook_unlinked: webhookUnlinked,
      },
      retained: {
        messages: messageCount ?? 0,
      },
    }
  }

  const { error: roomSettingsDeleteError } = await supabase
    .from("room_summary_settings")
    .delete()
    .eq("room_id", roomId)
  if (roomSettingsDeleteError) {
    return { ok: false, message: `Failed to delete room settings: ${roomSettingsDeleteError.message}` }
  }

  const { error: lineRoomNamesDeleteError } = await supabase
    .from("line_room_names")
    .delete()
    .eq("room_id", roomId)
  if (lineRoomNamesDeleteError) {
    return { ok: false, message: `Failed to delete line_room_names: ${lineRoomNamesDeleteError.message}` }
  }

  return {
    ok: true,
    admin_surface: surface,
    unregistered: {
      room_settings: roomSettingsRow ? 1 : 0,
      line_room_names: lineRoomNamesRow ? 1 : 0,
      dismissed: 1,
      webhook_unlinked: 0,
    },
    retained: {
      messages: messageCount ?? 0,
    },
  }
}

async function removeRoomMediaObjects(
  supabase: ReturnType<typeof createClient>,
  roomId: string,
): Promise<{ ok: true; deletedFiles: number; deletedMetadataRows: number } | { ok: false; message: string }> {
  const { data: mediaRows, error: mediaError } = await supabase
    .from("line_message_media")
    .select("id, storage_bucket, storage_path")
    .eq("room_id", roomId)

  if (mediaError) {
    return { ok: false, message: `Failed to fetch room media metadata: ${mediaError.message}` }
  }

  const rows = Array.isArray(mediaRows)
    ? mediaRows
        .map((item) => ({
          id: Number(item?.id),
          storage_bucket: toSafeString(item?.storage_bucket),
          storage_path: toSafeString(item?.storage_path),
        }))
        .filter((item) => Number.isFinite(item.id) && item.id > 0 && item.storage_bucket && item.storage_path)
    : []

  if (rows.length === 0) {
    return { ok: true, deletedFiles: 0, deletedMetadataRows: 0 }
  }

  const bucketMap = new Map<string, string[]>()
  for (const row of rows) {
    const list = bucketMap.get(row.storage_bucket) ?? []
    list.push(row.storage_path)
    bucketMap.set(row.storage_bucket, list)
  }

  let deletedFiles = 0
  for (const [bucket, paths] of bucketMap.entries()) {
    const chunks = chunkArray(paths, 100)
    for (const chunk of chunks) {
      const { data: removed, error: removeError } = await supabase
        .storage
        .from(bucket)
        .remove(chunk)
      if (removeError) {
        return { ok: false, message: `Failed to delete storage files in bucket ${bucket}: ${removeError.message}` }
      }
      deletedFiles += Array.isArray(removed) ? removed.length : 0
    }
  }

  const { count: deletedMetadataRows, error: deleteMetaError } = await supabase
    .from("line_message_media")
    .delete({ count: "exact" })
    .eq("room_id", roomId)
  if (deleteMetaError) {
    return { ok: false, message: `Failed to delete media metadata: ${deleteMetaError.message}` }
  }

  return { ok: true, deletedFiles, deletedMetadataRows: deletedMetadataRows ?? 0 }
}

async function removeRoomDocuments(
  supabase: ReturnType<typeof createClient>,
  roomId: string,
): Promise<{ ok: true; deletedFiles: number; deletedMetadataRows: number } | { ok: false; message: string }> {
  const { data: rowsRaw, error: fetchError } = await supabase
    .from("line_search_documents")
    .select("id, storage_bucket, storage_path")
    .eq("room_id", roomId)
  if (fetchError) {
    return { ok: false, message: `Failed to fetch room documents: ${fetchError.message}` }
  }

  const rows = Array.isArray(rowsRaw)
    ? rowsRaw
        .map((item) => ({
          id: Number(item?.id),
          storage_bucket: toSafeString(item?.storage_bucket),
          storage_path: toSafeString(item?.storage_path),
        }))
        .filter((item) => Number.isFinite(item.id) && item.id > 0 && item.storage_bucket && item.storage_path)
    : []

  if (rows.length === 0) {
    return { ok: true, deletedFiles: 0, deletedMetadataRows: 0 }
  }

  const bucketMap = new Map<string, string[]>()
  for (const row of rows) {
    const list = bucketMap.get(row.storage_bucket) ?? []
    list.push(row.storage_path)
    bucketMap.set(row.storage_bucket, list)
  }

  let deletedFiles = 0
  for (const [bucket, paths] of bucketMap.entries()) {
    const chunks = chunkArray(paths, 100)
    for (const chunk of chunks) {
      const { data: removed, error: removeError } = await supabase
        .storage
        .from(bucket)
        .remove(chunk)
      if (removeError) {
        return { ok: false, message: `Failed to delete document files in bucket ${bucket}: ${removeError.message}` }
      }
      deletedFiles += Array.isArray(removed) ? removed.length : 0
    }
  }

  const { count: deletedMetadataRows, error: deleteMetaError } = await supabase
    .from("line_search_documents")
    .delete({ count: "exact" })
    .eq("room_id", roomId)
  if (deleteMetaError) {
    return { ok: false, message: `Failed to delete document metadata: ${deleteMetaError.message}` }
  }
  return { ok: true, deletedFiles, deletedMetadataRows: deletedMetadataRows ?? 0 }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items]
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

async function fetchStorageUsageState(
  supabase: ReturnType<typeof createClient>,
): Promise<{ stats: StorageUsageStats | null; error: string | null }> {
  const { data, error } = await supabase.rpc("get_storage_usage_stats")
  if (error) {
    return { stats: null, error: `容量取得エラー: ${error.message}` }
  }
  return { stats: normalizeStorageUsageStats(data), error: null }
}

function normalizeStorageUsageStats(value: unknown): StorageUsageStats | null {
  if (!isRecord(value)) return null

  const managedTablesRaw = Array.isArray(value.managed_tables) ? value.managed_tables : []
  const managedTables = managedTablesRaw
    .map((item) => normalizeStorageUsageTableStat(item))
    .filter((item): item is StorageUsageTableStat => item !== null)
    .sort((a, b) => b.size_bytes - a.size_bytes)

  return {
    database_size_bytes: toNonNegativeInteger(value.database_size_bytes),
    database_size_pretty: toSafeString(value.database_size_pretty) || "0 bytes",
    managed_tables_total_bytes: toNonNegativeInteger(value.managed_tables_total_bytes),
    managed_tables_total_pretty: toSafeString(value.managed_tables_total_pretty) || "0 bytes",
    managed_tables: managedTables,
  }
}

function normalizeStorageUsageTableStat(value: unknown): StorageUsageTableStat | null {
  if (!isRecord(value)) return null
  const tableName = toSafeString(value.table_name)
  if (!tableName) return null
  return {
    table_name: tableName,
    size_bytes: toNonNegativeInteger(value.size_bytes),
    size_pretty: toSafeString(value.size_pretty) || "0 bytes",
  }
}

function isActionableDeliveryLogStatus(status: unknown, details?: unknown): boolean {
  const normalized = String(status ?? "").trim().toLowerCase()
  if (!normalized) return true
  if (isForceRunLogDetails(details)) return true
  return !nonActionableDeliveryLogStatuses.has(normalized)
}

const nonActionableDeliveryLogStatuses = new Set([
  "no_messages",
  "not_scheduled",
  "no_room_summary",
  "overall_schedule_skip",
])

function isForceRunLogDetails(details: unknown): boolean {
  if (!isRecord(details)) return false
  return details.force_run === true
}

async function waitForNewLog(
  supabase: ReturnType<typeof createClient>,
  previousId: number,
): Promise<{ id: number; run_at: string; status: string; reason: string | null } | null> {
  const maxAttempts = 20
  const intervalMs = 1000
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }

    const { data, error } = await supabase
      .from("summary_delivery_logs")
      .select("id, run_at, status, reason")
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      continue
    }
    if (data && data.id > previousId) {
      return data
    }
  }
  return null
}

async function fetchGlobalSettings(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("summary_settings")
    .select("id, delivery_hours, is_enabled, message_cleanup_timing, last_delivery_summary_mode, message_retention_days, calendar_tomorrow_reminder_enabled, calendar_tomorrow_reminder_hours, calendar_tomorrow_reminder_only_if_events, calendar_tomorrow_reminder_max_items, media_upload_max_mb, updated_at")
    .eq("id", 1)
    .maybeSingle()

  if (error) {
    throw { status: 500, message: `Failed to fetch global settings: ${error.message}` } satisfies AppError
  }

  if (data) {
    return data
  }

  const fallback = {
    id: 1,
    delivery_hours: [12, 17, 23],
    is_enabled: true,
    message_cleanup_timing: "after_each_delivery" as MessageCleanupTiming,
    last_delivery_summary_mode: "independent" as LastDeliverySummaryMode,
    message_retention_days: 365 as MessageRetentionDays,
    calendar_tomorrow_reminder_enabled: true,
    calendar_tomorrow_reminder_hours: [19],
    calendar_tomorrow_reminder_only_if_events: false,
    calendar_tomorrow_reminder_max_items: 20,
    media_upload_max_mb: DEFAULT_MEDIA_UPLOAD_MAX_MB,
    updated_at: new Date().toISOString(),
  }

  const { data: inserted, error: insertError } = await supabase
    .from("summary_settings")
    .upsert(fallback, { onConflict: "id" })
    .select("id, delivery_hours, is_enabled, message_cleanup_timing, last_delivery_summary_mode, message_retention_days, calendar_tomorrow_reminder_enabled, calendar_tomorrow_reminder_hours, calendar_tomorrow_reminder_only_if_events, calendar_tomorrow_reminder_max_items, media_upload_max_mb, updated_at")
    .single()

  if (insertError) {
    throw { status: 500, message: `Failed to initialize global settings: ${insertError.message}` } satisfies AppError
  }

  return inserted
}

function buildGlobalSettingsPayload(body: unknown): {
  delivery_hours: number[]
  is_enabled: boolean
  message_cleanup_timing: MessageCleanupTiming
  last_delivery_summary_mode: LastDeliverySummaryMode
  message_retention_days: MessageRetentionDays
  calendar_tomorrow_reminder_enabled: boolean
  calendar_tomorrow_reminder_hours: number[]
  calendar_tomorrow_reminder_only_if_events: boolean
  calendar_tomorrow_reminder_max_items: number
  media_upload_max_mb: number | null
} {
  if (!isRecord(body)) {
    throw { status: 400, message: "Invalid JSON body." } satisfies AppError
  }

  const isEnabled = body.is_enabled
  if (typeof isEnabled !== "boolean") {
    throw { status: 400, message: "is_enabled must be boolean." } satisfies AppError
  }

  const deliveryHours = normalizeHours(body.delivery_hours, false)
  if (deliveryHours.length === 0) {
    throw { status: 400, message: "delivery_hours must include at least one hour." } satisfies AppError
  }

  const messageCleanupTiming = normalizeMessageCleanupTiming(body.message_cleanup_timing)
  const lastDeliverySummaryMode = normalizeLastDeliverySummaryMode(body.last_delivery_summary_mode)
  if (lastDeliverySummaryMode === "daily_rollup" && messageCleanupTiming !== "end_of_day") {
    throw {
      status: 400,
      message: "last_delivery_summary_mode=daily_rollup requires message_cleanup_timing=end_of_day.",
    } satisfies AppError
  }
  const messageRetentionDays = normalizeMessageRetentionDays(body.message_retention_days)
  const mediaUploadMaxMb = body.media_upload_max_mb == null || body.media_upload_max_mb === ""
    ? null
    : normalizeMediaUploadMaxMb(body.media_upload_max_mb)

  const reminderEnabled = body.calendar_tomorrow_reminder_enabled
  if (typeof reminderEnabled !== "boolean") {
    throw { status: 400, message: "calendar_tomorrow_reminder_enabled must be boolean." } satisfies AppError
  }

  const reminderHours = normalizeHours(body.calendar_tomorrow_reminder_hours, false)
  if (reminderHours.length === 0) {
    throw { status: 400, message: "calendar_tomorrow_reminder_hours must include at least one hour." } satisfies AppError
  }

  const onlyIfEvents = body.calendar_tomorrow_reminder_only_if_events
  if (typeof onlyIfEvents !== "boolean") {
    throw { status: 400, message: "calendar_tomorrow_reminder_only_if_events must be boolean." } satisfies AppError
  }

  const maxItems = Number(body.calendar_tomorrow_reminder_max_items)
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50) {
    throw { status: 400, message: "calendar_tomorrow_reminder_max_items must be an integer between 1 and 50." } satisfies AppError
  }

  return {
    is_enabled: isEnabled,
    delivery_hours: deliveryHours,
    message_cleanup_timing: messageCleanupTiming,
    last_delivery_summary_mode: lastDeliverySummaryMode,
    message_retention_days: messageRetentionDays,
    calendar_tomorrow_reminder_enabled: reminderEnabled,
    calendar_tomorrow_reminder_hours: reminderHours,
    calendar_tomorrow_reminder_only_if_events: onlyIfEvents,
    calendar_tomorrow_reminder_max_items: maxItems,
    media_upload_max_mb: mediaUploadMaxMb,
  }
}

function buildRoomSettingsPayload(body: unknown): {
  room_id: string
  room_name: string | null
  is_enabled: boolean
  bot_reply_enabled: boolean
  bot_reply_hard_mute_enabled: boolean
  send_room_summary: boolean
  receive_overall_summary_enabled: boolean
  calendar_tomorrow_reminder_enabled: boolean
  calendar_ai_auto_create_enabled: boolean
  calendar_silent_auto_register_enabled: boolean
  calendar_low_confidence_confirm_reply_enabled: boolean
  calendar_registration_reply_enabled: boolean
  message_search_enabled: boolean
  message_search_library_enabled: boolean
  media_file_access_enabled: boolean
  image_analysis_reply_enabled: boolean
  receipt_reply_executive_detail_enabled: boolean
  receipt_correction_reply_enabled: boolean
  non_receipt_image_reply_enabled: boolean
  gmail_reservation_alert_enabled: boolean
  today_reservation_alert_enabled: boolean
  today_reservation_alert_hour: number | null
  today_reservation_alert_minute: number | null
  receipt_midreport_enabled: boolean
  receipt_monthend_report_enabled: boolean
  media_save_enabled: boolean
  review_alert_enabled?: boolean
  budget_entry_enabled?: boolean
  petty_receipt_analysis_enabled?: boolean
  receipt_sales_registration_enabled?: boolean
  receipt_schedule_override: boolean
  receipt_midreport_day: number | null
  receipt_midreport_hour: number | null
  receipt_midreport_minute: number | null
  receipt_monthend_day: number | null
  receipt_monthend_hour: number | null
  receipt_monthend_minute: number | null
  receipt_report_store_partition_key: string | null
  room_sort_order: number | null
  delivery_hours: number[] | null
  message_cleanup_timing: MessageCleanupTiming | null
  last_delivery_summary_mode: LastDeliverySummaryMode | null
} {
  if (!isRecord(body)) {
    throw { status: 400, message: "Invalid JSON body." } satisfies AppError
  }

  const roomIdRaw = String(body.room_id ?? "").trim()
  if (!roomIdRaw) {
    throw { status: 400, message: "room_id is required." } satisfies AppError
  }

  const isEnabled = body.is_enabled
  if (typeof isEnabled !== "boolean") {
    throw { status: 400, message: "is_enabled must be boolean." } satisfies AppError
  }

  const botReplyEnabledRaw = body.bot_reply_enabled
  if (botReplyEnabledRaw != null && typeof botReplyEnabledRaw !== "boolean") {
    throw { status: 400, message: "bot_reply_enabled must be boolean when provided." } satisfies AppError
  }
  const botReplyEnabled = botReplyEnabledRaw === true

  const botReplyHardMuteEnabledRaw = body.bot_reply_hard_mute_enabled
  if (botReplyHardMuteEnabledRaw != null && typeof botReplyHardMuteEnabledRaw !== "boolean") {
    throw { status: 400, message: "bot_reply_hard_mute_enabled must be boolean when provided." } satisfies AppError
  }
  const botReplyHardMuteEnabled = botReplyHardMuteEnabledRaw === true

  const sendRoomSummary = body.send_room_summary
  if (typeof sendRoomSummary !== "boolean") {
    throw { status: 400, message: "send_room_summary must be boolean." } satisfies AppError
  }

  const receiveOverallRaw = body.receive_overall_summary_enabled
  if (receiveOverallRaw != null && typeof receiveOverallRaw !== "boolean") {
    throw { status: 400, message: "receive_overall_summary_enabled must be boolean when provided." } satisfies AppError
  }
  let receiveOverallSummaryEnabled = receiveOverallRaw === true
  let sendRoomSummaryFinal = sendRoomSummary
  if (receiveOverallSummaryEnabled) {
    sendRoomSummaryFinal = false
  }
  if (sendRoomSummaryFinal) {
    receiveOverallSummaryEnabled = false
  }

  const roomTomorrowReminderEnabledRaw = body.calendar_tomorrow_reminder_enabled
  if (roomTomorrowReminderEnabledRaw != null && typeof roomTomorrowReminderEnabledRaw !== "boolean") {
    throw { status: 400, message: "calendar_tomorrow_reminder_enabled must be boolean when provided." } satisfies AppError
  }
  const roomTomorrowReminderEnabled = roomTomorrowReminderEnabledRaw === true

  const roomAiAutoCreateEnabledRaw = body.calendar_ai_auto_create_enabled
  if (roomAiAutoCreateEnabledRaw != null && typeof roomAiAutoCreateEnabledRaw !== "boolean") {
    throw { status: 400, message: "calendar_ai_auto_create_enabled must be boolean when provided." } satisfies AppError
  }
  const roomAiAutoCreateEnabled = roomAiAutoCreateEnabledRaw !== false

  const roomSilentAutoRegisterEnabledRaw = body.calendar_silent_auto_register_enabled
  if (roomSilentAutoRegisterEnabledRaw != null && typeof roomSilentAutoRegisterEnabledRaw !== "boolean") {
    throw { status: 400, message: "calendar_silent_auto_register_enabled must be boolean when provided." } satisfies AppError
  }
  const roomSilentAutoRegisterEnabled = roomSilentAutoRegisterEnabledRaw !== false

  const roomLowConfidenceConfirmRaw = body.calendar_low_confidence_confirm_reply_enabled
  if (roomLowConfidenceConfirmRaw != null && typeof roomLowConfidenceConfirmRaw !== "boolean") {
    throw { status: 400, message: "calendar_low_confidence_confirm_reply_enabled must be boolean when provided." } satisfies AppError
  }
  const roomLowConfidenceConfirmReplyEnabled = roomLowConfidenceConfirmRaw === true

  const roomRegistrationReplyRaw = body.calendar_registration_reply_enabled
  if (roomRegistrationReplyRaw != null && typeof roomRegistrationReplyRaw !== "boolean") {
    throw { status: 400, message: "calendar_registration_reply_enabled must be boolean when provided." } satisfies AppError
  }
  const roomRegistrationReplyEnabled = roomRegistrationReplyRaw === true

  const messageSearchEnabledRaw = body.message_search_enabled
  if (messageSearchEnabledRaw != null && typeof messageSearchEnabledRaw !== "boolean") {
    throw { status: 400, message: "message_search_enabled must be boolean when provided." } satisfies AppError
  }
  const messageSearchEnabled = messageSearchEnabledRaw !== false

  const messageSearchLibraryEnabledRaw = body.message_search_library_enabled
  if (messageSearchLibraryEnabledRaw != null && typeof messageSearchLibraryEnabledRaw !== "boolean") {
    throw { status: 400, message: "message_search_library_enabled must be boolean when provided." } satisfies AppError
  }
  const messageSearchLibraryEnabled = messageSearchLibraryEnabledRaw !== false

  const mediaFileAccessEnabledRaw = body.media_file_access_enabled
  if (mediaFileAccessEnabledRaw != null && typeof mediaFileAccessEnabledRaw !== "boolean") {
    throw { status: 400, message: "media_file_access_enabled must be boolean when provided." } satisfies AppError
  }
  const mediaFileAccessEnabled = mediaFileAccessEnabledRaw !== false

  const imageAnalysisReplyEnabledRaw = body.image_analysis_reply_enabled
  if (imageAnalysisReplyEnabledRaw != null && typeof imageAnalysisReplyEnabledRaw !== "boolean") {
    throw { status: 400, message: "image_analysis_reply_enabled must be boolean when provided." } satisfies AppError
  }
  const imageAnalysisReplyEnabled = imageAnalysisReplyEnabledRaw !== false

  const receiptReplyExecutiveDetailEnabledRaw = body.receipt_reply_executive_detail_enabled
  if (receiptReplyExecutiveDetailEnabledRaw != null && typeof receiptReplyExecutiveDetailEnabledRaw !== "boolean") {
    throw { status: 400, message: "receipt_reply_executive_detail_enabled must be boolean when provided." } satisfies AppError
  }
  const receiptReplyExecutiveDetailEnabled = receiptReplyExecutiveDetailEnabledRaw !== false

  const receiptCorrectionReplyEnabledRaw = body.receipt_correction_reply_enabled
  if (receiptCorrectionReplyEnabledRaw != null && typeof receiptCorrectionReplyEnabledRaw !== "boolean") {
    throw { status: 400, message: "receipt_correction_reply_enabled must be boolean when provided." } satisfies AppError
  }
  const receiptCorrectionReplyEnabled = receiptCorrectionReplyEnabledRaw === true

  const nonReceiptImageReplyEnabledRaw = body.non_receipt_image_reply_enabled
  if (nonReceiptImageReplyEnabledRaw != null && typeof nonReceiptImageReplyEnabledRaw !== "boolean") {
    throw { status: 400, message: "non_receipt_image_reply_enabled must be boolean when provided." } satisfies AppError
  }
  const nonReceiptImageReplyEnabled = nonReceiptImageReplyEnabledRaw !== false

  const gmailReservationAlertEnabledRaw = body.gmail_reservation_alert_enabled
  if (gmailReservationAlertEnabledRaw != null && typeof gmailReservationAlertEnabledRaw !== "boolean") {
    throw { status: 400, message: "gmail_reservation_alert_enabled must be boolean when provided." } satisfies AppError
  }
  const gmailReservationAlertEnabled = gmailReservationAlertEnabledRaw === true

  const todayReservationAlertEnabledRaw = body.today_reservation_alert_enabled
  if (todayReservationAlertEnabledRaw != null && typeof todayReservationAlertEnabledRaw !== "boolean") {
    throw { status: 400, message: "today_reservation_alert_enabled must be boolean when provided." } satisfies AppError
  }
  const todayReservationAlertEnabled = todayReservationAlertEnabledRaw === true

  const receiptMidreportEnabledRaw = body.receipt_midreport_enabled
  if (receiptMidreportEnabledRaw != null && typeof receiptMidreportEnabledRaw !== "boolean") {
    throw { status: 400, message: "receipt_midreport_enabled must be boolean when provided." } satisfies AppError
  }
  const receiptMidreportEnabled = receiptMidreportEnabledRaw !== false

  const receiptMonthendReportEnabledRaw = body.receipt_monthend_report_enabled
  if (receiptMonthendReportEnabledRaw != null && typeof receiptMonthendReportEnabledRaw !== "boolean") {
    throw { status: 400, message: "receipt_monthend_report_enabled must be boolean when provided." } satisfies AppError
  }
  const receiptMonthendReportEnabled = receiptMonthendReportEnabledRaw !== false

  const mediaSaveEnabledRaw = body.media_save_enabled
  if (mediaSaveEnabledRaw != null && typeof mediaSaveEnabledRaw !== "boolean") {
    throw { status: 400, message: "media_save_enabled must be boolean when provided." } satisfies AppError
  }
  const mediaSaveEnabled = mediaSaveEnabledRaw !== false

  // 口コミ新着通知（review-alert-cron宛て、既定OFF）。未指定なら undefined＝upsertに含めず既存値を保持。
  const reviewAlertEnabledRaw = body.review_alert_enabled
  if (reviewAlertEnabledRaw != null && typeof reviewAlertEnabledRaw !== "boolean") {
    throw { status: 400, message: "review_alert_enabled must be boolean when provided." } satisfies AppError
  }
  const reviewAlertEnabled = reviewAlertEnabledRaw != null ? reviewAlertEnabledRaw === true : undefined

  const budgetEntryEnabledRaw = body.budget_entry_enabled
  if (budgetEntryEnabledRaw != null && typeof budgetEntryEnabledRaw !== "boolean") {
    throw { status: 400, message: "budget_entry_enabled must be boolean when provided." } satisfies AppError
  }
  // 未指定なら undefined＝upsertに含めず既存値を保持（予算を送らない保存経路でfalseに戻さない）。
  const budgetEntryEnabled = budgetEntryEnabledRaw != null ? budgetEntryEnabledRaw === true : undefined

  // 小口（経費）レシート解析の許可（既定ON）。未指定なら undefined＝既存値を保持。
  const pettyReceiptAnalysisEnabledRaw = body.petty_receipt_analysis_enabled
  if (pettyReceiptAnalysisEnabledRaw != null && typeof pettyReceiptAnalysisEnabledRaw !== "boolean") {
    throw { status: 400, message: "petty_receipt_analysis_enabled must be boolean when provided." } satisfies AppError
  }
  const pettyReceiptAnalysisEnabled = pettyReceiptAnalysisEnabledRaw != null ? pettyReceiptAnalysisEnabledRaw === true : undefined

  // 売上(精算)のDB登録ゲート（既定ON）。未指定なら undefined＝upsertに含めず既存値を保持。
  const receiptSalesRegistrationEnabledRaw = body.receipt_sales_registration_enabled
  if (receiptSalesRegistrationEnabledRaw != null && typeof receiptSalesRegistrationEnabledRaw !== "boolean") {
    throw { status: 400, message: "receipt_sales_registration_enabled must be boolean when provided." } satisfies AppError
  }
  const receiptSalesRegistrationEnabled = receiptSalesRegistrationEnabledRaw != null ? receiptSalesRegistrationEnabledRaw === true : undefined

  const receiptScheduleOverrideRaw = body.receipt_schedule_override
  if (receiptScheduleOverrideRaw != null && typeof receiptScheduleOverrideRaw !== "boolean") {
    throw { status: 400, message: "receipt_schedule_override must be boolean when provided." } satisfies AppError
  }
  const receiptScheduleOverride = receiptScheduleOverrideRaw === true

  const parseScheduleInt = (value: unknown, label: string, min: number, max: number): number | null => {
    if (value == null || value === "") return null
    const n = Number(value)
    if (!Number.isInteger(n) || n < min || n > max) {
      throw { status: 400, message: `${label} must be an integer between ${min} and ${max} or null.` } satisfies AppError
    }
    return n
  }
  const receiptMidreportDay = parseScheduleInt(body.receipt_midreport_day, "receipt_midreport_day", 1, 28)
  const receiptMidreportHour = parseScheduleInt(body.receipt_midreport_hour, "receipt_midreport_hour", 0, 23)
  const receiptMidreportMinute = parseScheduleInt(body.receipt_midreport_minute, "receipt_midreport_minute", 0, 59)
  const receiptMonthendDay = parseScheduleInt(body.receipt_monthend_day, "receipt_monthend_day", 1, 28)
  const receiptMonthendHour = parseScheduleInt(body.receipt_monthend_hour, "receipt_monthend_hour", 0, 23)
  const receiptMonthendMinute = parseScheduleInt(body.receipt_monthend_minute, "receipt_monthend_minute", 0, 59)
  const todayReservationAlertHour = parseScheduleInt(body.today_reservation_alert_hour, "today_reservation_alert_hour", 0, 23)
  const todayReservationAlertMinute = parseScheduleInt(body.today_reservation_alert_minute, "today_reservation_alert_minute", 0, 59)

  let receiptReportStorePartitionKey: string | null = null
  if (body.receipt_report_store_partition_key != null) {
    const rawKey = typeof body.receipt_report_store_partition_key === "string"
      ? body.receipt_report_store_partition_key.trim().toLowerCase()
      : ""
    if (rawKey) {
      if (!/^[a-z0-9]{2,120}$/.test(rawKey) || rawKey === RECEIPT_STORE_PARTITION_UNKNOWN) {
        throw {
          status: 400,
          message: "receipt_report_store_partition_key is invalid.",
        } satisfies AppError
      }
      receiptReportStorePartitionKey = rawKey
    }
  }

  const roomNameRaw = typeof body.room_name === "string" ? body.room_name.trim() : ""
  const roomSortOrderRaw = body.room_sort_order
  let roomSortOrder: number | null = null
  if (roomSortOrderRaw != null && roomSortOrderRaw !== "") {
    const num = Number(roomSortOrderRaw)
    if (!Number.isInteger(num) || num < 0 || num > 1000000) {
      throw { status: 400, message: "room_sort_order must be an integer between 0 and 1000000 or null." } satisfies AppError
    }
    roomSortOrder = num
  }
  const deliveryHours = body.delivery_hours == null ? null : normalizeHours(body.delivery_hours, false)
  if (Array.isArray(deliveryHours) && deliveryHours.length === 0) {
    throw { status: 400, message: "delivery_hours must contain at least one hour or null." } satisfies AppError
  }

  const roomCleanupTiming = normalizeOptionalMessageCleanupTiming(body.message_cleanup_timing)
  const roomSummaryMode = normalizeOptionalLastDeliverySummaryMode(body.last_delivery_summary_mode)
  if (roomSummaryMode === "daily_rollup" && roomCleanupTiming === "after_each_delivery") {
    throw {
      status: 400,
      message: "last_delivery_summary_mode=daily_rollup requires message_cleanup_timing=end_of_day or null (inherit).",
    } satisfies AppError
  }

  return {
    room_id: roomIdRaw,
    room_name: roomNameRaw || null,
    is_enabled: isEnabled,
    bot_reply_enabled: botReplyEnabled,
    bot_reply_hard_mute_enabled: botReplyHardMuteEnabled,
    send_room_summary: sendRoomSummaryFinal,
    receive_overall_summary_enabled: receiveOverallSummaryEnabled,
    calendar_tomorrow_reminder_enabled: roomTomorrowReminderEnabled,
    calendar_ai_auto_create_enabled: roomAiAutoCreateEnabled,
    calendar_silent_auto_register_enabled: roomSilentAutoRegisterEnabled,
    calendar_low_confidence_confirm_reply_enabled: roomLowConfidenceConfirmReplyEnabled,
    calendar_registration_reply_enabled: roomRegistrationReplyEnabled,
    message_search_enabled: messageSearchEnabled,
    message_search_library_enabled: messageSearchLibraryEnabled,
    media_file_access_enabled: mediaFileAccessEnabled,
    image_analysis_reply_enabled: imageAnalysisReplyEnabled,
    receipt_reply_executive_detail_enabled: receiptReplyExecutiveDetailEnabled,
    receipt_correction_reply_enabled: receiptCorrectionReplyEnabled,
    non_receipt_image_reply_enabled: nonReceiptImageReplyEnabled,
    gmail_reservation_alert_enabled: gmailReservationAlertEnabled,
    today_reservation_alert_enabled: todayReservationAlertEnabled,
    today_reservation_alert_hour: todayReservationAlertHour,
    today_reservation_alert_minute: todayReservationAlertMinute,
    receipt_midreport_enabled: receiptMidreportEnabled,
    receipt_monthend_report_enabled: receiptMonthendReportEnabled,
    media_save_enabled: mediaSaveEnabled,
    review_alert_enabled: reviewAlertEnabled,
    budget_entry_enabled: budgetEntryEnabled,
    petty_receipt_analysis_enabled: pettyReceiptAnalysisEnabled,
    receipt_sales_registration_enabled: receiptSalesRegistrationEnabled,
    receipt_schedule_override: receiptScheduleOverride,
    receipt_midreport_day: receiptMidreportDay,
    receipt_midreport_hour: receiptMidreportHour,
    receipt_midreport_minute: receiptMidreportMinute,
    receipt_monthend_day: receiptMonthendDay,
    receipt_monthend_hour: receiptMonthendHour,
    receipt_monthend_minute: receiptMonthendMinute,
    receipt_report_store_partition_key: receiptReportStorePartitionKey,
    room_sort_order: roomSortOrder,
    delivery_hours: deliveryHours,
    message_cleanup_timing: roomCleanupTiming,
    last_delivery_summary_mode: roomSummaryMode,
  }
}

function buildLineUserPermissionPayload(body: unknown): LineUserPermissionRow {
  if (!isRecord(body)) {
    throw { status: 400, message: "Invalid JSON body." } satisfies AppError
  }
  const lineUserId = String(body.line_user_id ?? "").trim()
  if (!lineUserId) {
    throw { status: 400, message: "line_user_id is required." } satisfies AppError
  }
  const ensureBoolean = (value: unknown, key: string, fallback: boolean): boolean => {
    if (value == null) return fallback
    if (typeof value !== "boolean") {
      throw { status: 400, message: `${key} must be boolean when provided.` } satisfies AppError
    }
    return value
  }
  const displayNameRaw = typeof body.display_name === "string" ? body.display_name.trim() : ""
  let assignedStore: string | null = null
  if (body.assigned_store != null) {
    const raw = typeof body.assigned_store === "string" ? body.assigned_store.trim() : ""
    if (raw) {
      if (!isMarugoGroupStoreLabel(raw)) {
        throw { status: 400, message: "assigned_store must be one of the predefined store labels." } satisfies AppError
      }
      assignedStore = raw
    }
  }
  let assignedJobTitle: string | null = null
  if (body.assigned_job_title != null) {
    const raw = typeof body.assigned_job_title === "string" ? body.assigned_job_title.trim() : ""
    if (raw) {
      if (!isJobTitleLabel(raw)) {
        throw { status: 400, message: "assigned_job_title must be one of the predefined job titles." } satisfies AppError
      }
      assignedJobTitle = raw
    }
  }
  const excludedRoomIdsRaw = body.excluded_message_search_room_ids
  let excludedRoomIds: string[] = []
  if (excludedRoomIdsRaw != null) {
    if (!Array.isArray(excludedRoomIdsRaw)) {
      throw { status: 400, message: "excluded_message_search_room_ids must be string[] when provided." } satisfies AppError
    }
    excludedRoomIds = Array.from(new Set(excludedRoomIdsRaw
      .map((v) => String(v ?? "").trim())
      .filter((v) => v.length > 0)))
  }
  const canCalendarView = ensureBoolean(body.can_calendar_view, "can_calendar_view", true)
  let canCalendarCreate = ensureBoolean(body.can_calendar_create, "can_calendar_create", true)
  let canCalendarUpdate = ensureBoolean(body.can_calendar_update, "can_calendar_update", true)
  if (!canCalendarView) {
    canCalendarCreate = false
    canCalendarUpdate = false
  }
  return {
    line_user_id: lineUserId,
    display_name: displayNameRaw || null,
    is_active: ensureBoolean(body.is_active, "is_active", true),
    can_message_search: ensureBoolean(body.can_message_search, "can_message_search", true),
    can_library_search: ensureBoolean(body.can_library_search, "can_library_search", true),
    can_calendar_create: canCalendarCreate,
    can_calendar_update: canCalendarUpdate,
    can_calendar_view: canCalendarView,
    can_media_access: ensureBoolean(body.can_media_access, "can_media_access", true),
    excluded_message_search_room_ids: excludedRoomIds,
    assigned_store: assignedStore,
    assigned_job_title: assignedJobTitle,
    updated_at: new Date().toISOString(),
  }
}

function normalizeHours(value: unknown, allowNull: boolean): number[] | null {
  if (value == null) {
    return allowNull ? null : []
  }

  if (!Array.isArray(value)) {
    throw { status: 400, message: "delivery_hours must be an array of integers 0-23." } satisfies AppError
  }

  const hours: number[] = []
  for (const item of value) {
    const num = Number(item)
    if (!Number.isInteger(num) || num < 0 || num > 23) {
      throw { status: 400, message: "delivery_hours must be an array of integers 0-23." } satisfies AppError
    }
    if (!hours.includes(num)) {
      hours.push(num)
    }
  }
  hours.sort((a, b) => a - b)
  return hours
}

function normalizeMessageCleanupTiming(value: unknown): MessageCleanupTiming {
  if (value == null) return "after_each_delivery"
  if (value === "after_each_delivery" || value === "end_of_day") return value
  throw {
    status: 400,
    message: "message_cleanup_timing must be either after_each_delivery or end_of_day.",
  } satisfies AppError
}

function normalizeLastDeliverySummaryMode(value: unknown): LastDeliverySummaryMode {
  if (value == null) return "independent"
  if (value === "independent" || value === "daily_rollup") return value
  throw {
    status: 400,
    message: "last_delivery_summary_mode must be either independent or daily_rollup.",
  } satisfies AppError
}

function normalizeMessageRetentionDays(value: unknown): MessageRetentionDays {
  if (value == null || value === "") return 365
  const days = Number(value)
  if (days === 0 || days === 60 || days === 120 || days === 180 || days === 365 || days === 730 || days === 1095) {
    return days
  }
  throw {
    status: 400,
    message: "message_retention_days must be one of 0, 60, 120, 180, 365, 730, or 1095.",
  } satisfies AppError
}

function normalizeMediaUploadMaxMb(value: unknown): number {
  if (value == null || value === "") return DEFAULT_MEDIA_UPLOAD_MAX_MB
  const mb = Number(value)
  if (!Number.isInteger(mb) || mb < 1 || mb > MAX_MEDIA_UPLOAD_MAX_MB) {
    throw {
      status: 400,
      message: `media_upload_max_mb must be an integer between 1 and ${MAX_MEDIA_UPLOAD_MAX_MB}.`,
    } satisfies AppError
  }
  return mb
}

function normalizeOptionalMessageCleanupTiming(value: unknown): MessageCleanupTiming | null {
  if (value == null || value === "") return null
  return normalizeMessageCleanupTiming(value)
}

function normalizeOptionalLastDeliverySummaryMode(value: unknown): LastDeliverySummaryMode | null {
  if (value == null || value === "") return null
  return normalizeLastDeliverySummaryMode(value)
}

function secureEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  if (aBytes.length !== bBytes.length) return false

  let result = 0
  for (let i = 0; i < aBytes.length; i += 1) {
    result |= aBytes[i] ^ bBytes[i]
  }
  return result === 0
}

async function parseJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw { status: 400, message: "Request body must be valid JSON." } satisfies AppError
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toSafeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function toNonNegativeInteger(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.floor(parsed)
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return fallback
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false
  return fallback
}

function normalizePath(pathname: string): string {
  const stripped = pathname
    .replace(/^\/functions\/v1\/admin-api/, "")
    .replace(/^\/admin-api/, "")
  return stripped || "/"
}

// レシート画像解析に Gemini を使う店舗（line-webhook と同一）。他店は Groq。
const AI_USAGE_GEMINI_STORE_KEYS = new Set<string>(["sauvage", "sushikoruri"])
const AI_USAGE_GEMINI_MODEL = "gemini-3.1-pro-preview"
// レシート画像解析に Claude(Haiku) を使う店舗（line-webhook の CLAUDE_RECEIPT_STORE_KEYS と同一）。
// ＋経費（小口）の再解析も Claude を使うため、claude バケットには「claudia2の売上解析」と「全店の経費解析」のトークンが入る。
const AI_USAGE_CLAUDE_STORE_KEYS = new Set<string>(["claudia2"])
const AI_USAGE_CLAUDE_MODEL = "claude-haiku-4-5"
const AI_USAGE_GROQ_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
const AI_USAGE_OPENAI_MODEL = "gpt-5.5"
const AI_USAGE_GROK_MODEL = "grok-3-mini"

type AiUsageStoreRow = {
  store_partition_key: string
  display_name: string
  image_count: number
  receipt_count: number
}

type AiUsageProviderBucket = {
  provider: "gemini" | "groq" | "claude" | "openai" | "grok"
  model: string
  store_count: number
  image_count: number
  receipt_count: number
  // 実測トークン（ai_usage_events 由来。記録開始以降のみ）。
  event_count: number
  input_tokens: number
  output_tokens: number
  thinking_tokens: number
  total_tokens: number
  stores: AiUsageStoreRow[]
}

// AI使用料（概算）: 店舗別の画像解析回数を Groq / Gemini に振り分けて合計を返す（ルーム単位ではなく合計）。
async function fetchAiUsageCostState(
  supabase: ReturnType<typeof createClient>,
  url: URL,
): Promise<Record<string, unknown>> {
  const fromParam = String(url.searchParams.get("from") ?? "").trim()
  const toParam = String(url.searchParams.get("to") ?? "").trim()
  const p_from = fromParam || null
  const p_to = toParam || null

  const { data, error } = await supabase.rpc("ai_usage_image_counts", { p_from, p_to })
  if (error) {
    throw { status: 500, message: `ai_usage_image_counts failed: ${error.message}` } satisfies AppError
  }
  const rows = Array.isArray(data) ? data : []

  const gemini: AiUsageProviderBucket = {
    provider: "gemini",
    model: AI_USAGE_GEMINI_MODEL,
    store_count: 0,
    image_count: 0,
    receipt_count: 0,
    event_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    total_tokens: 0,
    stores: [],
  }
  const groq: AiUsageProviderBucket = {
    provider: "groq",
    model: AI_USAGE_GROQ_MODEL,
    store_count: 0,
    image_count: 0,
    receipt_count: 0,
    event_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    total_tokens: 0,
    stores: [],
  }
  const claude: AiUsageProviderBucket = {
    provider: "claude",
    model: AI_USAGE_CLAUDE_MODEL,
    store_count: 0,
    image_count: 0,
    receipt_count: 0,
    event_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    total_tokens: 0,
    stores: [],
  }
  const openai: AiUsageProviderBucket = {
    provider: "openai",
    model: AI_USAGE_OPENAI_MODEL,
    store_count: 0,
    image_count: 0,
    receipt_count: 0,
    event_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    total_tokens: 0,
    stores: [],
  }
  const grok: AiUsageProviderBucket = {
    provider: "grok",
    model: AI_USAGE_GROK_MODEL,
    store_count: 0,
    image_count: 0,
    receipt_count: 0,
    event_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    total_tokens: 0,
    stores: [],
  }

  for (const raw of rows) {
    const r = raw as Record<string, unknown>
    const key = String(r.store_partition_key ?? "").trim()
    if (!key) continue
    const row: AiUsageStoreRow = {
      store_partition_key: key,
      display_name: String(r.display_name ?? key),
      image_count: Number(r.image_count ?? 0) || 0,
      receipt_count: Number(r.receipt_count ?? 0) || 0,
    }
    const bucket = AI_USAGE_GEMINI_STORE_KEYS.has(key)
      ? gemini
      : AI_USAGE_CLAUDE_STORE_KEYS.has(key)
      ? claude
      : groq
    bucket.stores.push(row)
    bucket.store_count += 1
    bucket.image_count += row.image_count
    bucket.receipt_count += row.receipt_count
  }
  gemini.stores.sort((a, b) => b.image_count - a.image_count)
  groq.stores.sort((a, b) => b.image_count - a.image_count)
  claude.stores.sort((a, b) => b.image_count - a.image_count)

  // 実測トークン（ai_usage_events）をプロバイダ別に合算してバケットに足し込む。
  // provider は「実際に応答したプロバイダ」なので、Gemini採用店の Groq フォールバック分は groq 側に入る。
  const { data: tokenData, error: tokenError } = await supabase.rpc("ai_usage_token_totals", { p_from, p_to })
  if (tokenError) {
    throw { status: 500, message: `ai_usage_token_totals failed: ${tokenError.message}` } satisfies AppError
  }
  for (const raw of (Array.isArray(tokenData) ? tokenData : [])) {
    const r = raw as Record<string, unknown>
    const provider = String(r.provider ?? "").trim()
    const bucket = provider === "gemini"
      ? gemini
      : provider === "groq"
      ? groq
      : provider === "claude"
      ? claude
      : provider === "openai"
      ? openai
      : provider === "grok" || provider === "xai"
      ? grok
      : null
    if (!bucket) continue
    bucket.event_count += Number(r.event_count ?? 0) || 0
    bucket.input_tokens += Number(r.input_tokens ?? 0) || 0
    bucket.output_tokens += Number(r.output_tokens ?? 0) || 0
    bucket.thinking_tokens += Number(r.thinking_tokens ?? 0) || 0
    bucket.total_tokens += Number(r.total_tokens ?? 0) || 0
  }

  // モデル別の実測トークン（provider×model 粒度）。AI使用料をモデル別の公式単価で正確に計算するため。
  const { data: modelData, error: modelError } = await supabase.rpc("ai_usage_model_totals", { p_from, p_to })
  if (modelError) {
    throw { status: 500, message: `ai_usage_model_totals failed: ${modelError.message}` } satisfies AppError
  }
  const models = (Array.isArray(modelData) ? modelData : []).map((raw) => {
    const r = raw as Record<string, unknown>
    return {
      provider: String(r.provider ?? ""),
      model: String(r.model ?? "(unknown)"),
      event_count: Number(r.event_count ?? 0) || 0,
      input_tokens: Number(r.input_tokens ?? 0) || 0,
      output_tokens: Number(r.output_tokens ?? 0) || 0,
      thinking_tokens: Number(r.thinking_tokens ?? 0) || 0,
      total_tokens: Number(r.total_tokens ?? 0) || 0,
    }
  })

  // MARUGO S のフードコート分析(Q&A・テナント表画像抽出・東京ドーム抽出)だけを surface='foodcourt' で抽出。
  // 同じ marugoS でもレシート解析(surface=null)とは混ぜず、別表示できるようにする。
  const FOODCOURT_STORE_KEY = "marugoS"
  let foodcourtModels: Array<Record<string, unknown>> = []
  const { data: fcData, error: fcError } = await supabase.rpc("ai_usage_surface_model_totals", {
    p_from, p_to, p_store: FOODCOURT_STORE_KEY, p_surface: "foodcourt",
  })
  if (fcError) {
    console.error("ai_usage_surface_model_totals failed:", fcError.message)
  } else {
    foodcourtModels = (Array.isArray(fcData) ? fcData : []).map((raw) => {
      const r = raw as Record<string, unknown>
      return {
        provider: String(r.provider ?? ""),
        model: String(r.model ?? "(unknown)"),
        event_count: Number(r.event_count ?? 0) || 0,
        input_tokens: Number(r.input_tokens ?? 0) || 0,
        output_tokens: Number(r.output_tokens ?? 0) || 0,
        thinking_tokens: Number(r.thinking_tokens ?? 0) || 0,
        total_tokens: Number(r.total_tokens ?? 0) || 0,
      }
    })
  }

  // 時系列データ（日次）
  let dailyTotals: Array<Record<string, unknown>> = []
  const { data: dailyData, error: dailyError } = await supabase.rpc("ai_usage_time_series", {
    p_from, p_to, p_by: "day"
  })
  if (dailyError) {
    console.error("ai_usage_time_series daily failed:", dailyError.message)
  } else {
    dailyTotals = (Array.isArray(dailyData) ? dailyData : []).map((raw) => {
      const r = raw as Record<string, unknown>
      return {
        period_date: String(r.period_date ?? ""),
        provider: String(r.provider ?? ""),
        model: String(r.model ?? "(unknown)"),
        event_count: Number(r.event_count ?? 0) || 0,
        input_tokens: Number(r.input_tokens ?? 0) || 0,
        output_tokens: Number(r.output_tokens ?? 0) || 0,
        thinking_tokens: Number(r.thinking_tokens ?? 0) || 0,
        total_tokens: Number(r.total_tokens ?? 0) || 0,
      }
    })
  }

  // 時系列データ（月次）: 月次は全体の推移が見たいため p_from, p_to は null (全期間)で取得
  let monthlyTotals: Array<Record<string, unknown>> = []
  const { data: monthlyData, error: monthlyError } = await supabase.rpc("ai_usage_time_series", {
    p_from: null, p_to: null, p_by: "month"
  })
  if (monthlyError) {
    console.error("ai_usage_time_series monthly failed:", monthlyError.message)
  } else {
    monthlyTotals = (Array.isArray(monthlyData) ? monthlyData : []).map((raw) => {
      const r = raw as Record<string, unknown>
      return {
        period_date: String(r.period_date ?? ""),
        provider: String(r.provider ?? ""),
        model: String(r.model ?? "(unknown)"),
        event_count: Number(r.event_count ?? 0) || 0,
        input_tokens: Number(r.input_tokens ?? 0) || 0,
        output_tokens: Number(r.output_tokens ?? 0) || 0,
        thinking_tokens: Number(r.thinking_tokens ?? 0) || 0,
        total_tokens: Number(r.total_tokens ?? 0) || 0,
      }
    })
  }

  return {
    period: { from: p_from, to: p_to },
    gemini,
    groq,
    claude,
    openai,
    grok,
    models,
    foodcourt: { store: FOODCOURT_STORE_KEY, models: foodcourtModels },
    daily_totals: dailyTotals,
    monthly_totals: monthlyTotals,
    generated_at: new Date().toISOString(),
  }
}

function asAppError(error: unknown): AppError {
  if (isRecord(error) && typeof error.status === "number" && typeof error.message === "string") {
    return { status: error.status, message: error.message }
  }
  return { status: 500, message: error instanceof Error ? error.message : "Internal Server Error" }
}

async function invokeReceiptMidreportCronTestSend(opts: {
  supabaseUrl: string
  serviceRoleKey: string
  testKey: string
  roomId: string
  reportKind: "mid_month" | "month_end"
  year?: number
  month?: number
  storePartitionKey?: string
}): Promise<{ status: number; payload: unknown }> {
  const base = opts.supabaseUrl.replace(/\/+$/, "")
  const url = new URL(`${base}/functions/v1/receipt-midreport-cron`)
  url.searchParams.set("test_receipt_report", "1")
  url.searchParams.set("room_id", opts.roomId)
  url.searchParams.set("report_kind", opts.reportKind)
  if (opts.year != null) url.searchParams.set("year", String(opts.year))
  if (opts.month != null) url.searchParams.set("month", String(opts.month))
  if (opts.storePartitionKey) url.searchParams.set("store_partition_key", opts.storePartitionKey)

  // Edge ゲートウェイは verify_jwt=false でも「Authorization に無効なJWTを載せた」リクエストを関数到達前に 401 で弾く。
  // service_role を Bearer に載せると環境（新APIキー方式への移行後など service_role/anon が非JWTになると）に
  // よっては無効JWT扱いで 401(deployment_id=null) になり、テスト経路に到達しない。本番ログ＋pg_net 再現で、
  // (a) 無認証 (b) apikey のみ のいずれも関数に到達（403=鍵未指定）することを確認済み。
  // テスト経路の認可は X-Receipt-Midreport-Test-Key（admin-api と cron で同一シークレット）で行うため、
  // Authorization は付けない。apikey は anon があれば付与（無くても匿名通過するので必須ではない）。
  const anonKey = (Deno.env.get("SUPABASE_ANON_KEY") ?? "").trim()

  const headers: Record<string, string> = {
    "X-Receipt-Midreport-Test-Key": opts.testKey,
  }
  if (anonKey) headers["apikey"] = anonKey

  const res = await fetch(url.toString(), {
    method: "GET",
    headers,
  })
  const text = await res.text()
  let payload: unknown
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = { ok: false, error: "Invalid JSON from receipt-midreport-cron", raw: text.slice(0, 500) }
  }
  return { status: res.status, payload }
}

function resolveAdminSurface(req: Request, url: URL): string {
  const header = String(req.headers.get("x-admin-surface") ?? "").trim().toLowerCase()
  if (header === ADMIN_SURFACE_LINE_REPORT) return ADMIN_SURFACE_LINE_REPORT
  const query = String(url.searchParams.get("admin_surface") ?? "").trim().toLowerCase()
  if (query === ADMIN_SURFACE_LINE_REPORT) return ADMIN_SURFACE_LINE_REPORT
  return ADMIN_SURFACE_LEGACY
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  })
}
