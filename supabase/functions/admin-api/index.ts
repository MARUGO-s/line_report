import "jsr:@supabase/functions-js/edge-runtime.d.ts"
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
import {
  fetchManualMonthSales,
  fetchManualMonthSalesMapForStore,
  upsertManualMonthSalesEntries,
} from "../_shared/manual_month_sales.ts"
import {
  RECEIPT_STORE_PARTITION_UNKNOWN,
  toReceiptStorePartitionKey,
} from "../_shared/receipt_report_aggregate.ts"
import {
  fetchAnalyticsMonthly as fetchStoreAnalyticsMonthly,
  fetchManualMonthsForYearState as fetchStoreManualMonthsForYearState,
  fetchReceiptSalesState as fetchStoreReceiptSalesState,
  fetchReceiptStoreOptions as fetchStorePartitionReceiptOptions,
  fetchReceiptWebhookStatus,
  upsertManualMonthEntries as upsertStoreManualMonthEntries,
  upsertReceiptSalesBudget as upsertStoreReceiptSalesBudget,
  updateStoreReceiptPhones,
} from "../_shared/admin_receipt_sales.ts"
import { isReceiptRoomAutoLinkEnabled } from "../_shared/auto_link_room.ts"
import {
  authenticateAdminDashboardSessionToken,
  exchangeAdminDashboardLoginLinkToken,
  issueAdminDashboardSessionToken,
  revokeAdminDashboardSessionToken,
  revokeAllAdminDashboardAuthTokens,
} from "../_shared/admin_dashboard_link_auth.ts"
import { fetchWeatherDailyState } from "../_shared/weather_daily.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import JSZip from "https://esm.sh/jszip@3.10.1"

const ADMIN_SURFACE_LEGACY = "legacy"
const ADMIN_SURFACE_LINE_REPORT = "line_report"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token, x-admin-surface",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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
  message_id: string
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const path = normalizePath(url.pathname)
  const clientIp = extractClientIp(req.headers)

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

  if (req.method === "POST" && path === "/auth/link-login") {
    try {
      const body = await parseJson(req)
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

  if (req.method === "POST" && path === "/auth/session") {
    try {
      const body = await parseJson(req)
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

  try {
    if (req.method === "POST" && path === "/auth/logout") {
      const provided = req.headers.get("x-admin-token") ?? ""
      const revoked = await revokeAdminDashboardSessionToken(supabase, provided)
      return json({ success: true, revoked }, 200)
    }

    if (req.method === "GET" && path === "/state") {
      const adminSurface = resolveAdminSurface(req, url)
      const state = await fetchState(supabase, url, adminSurface)
      return json(state, 200)
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
      const body = await parseJson(req)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await updateStoreReceiptPhones(supabase, body)
      return json(result, 200)
    }

    if (req.method === "GET" && path === "/receipts/sales") {
      const receiptSalesState = await fetchStoreReceiptSalesState(supabase, url)
      return json(receiptSalesState, 200)
    }

    if (req.method === "PUT" && path === "/receipts/sales-budget") {
      const body = await parseJson(req)
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
      const body = await parseJson(req)
      if (!isRecord(body)) {
        throw { status: 400, message: "Invalid JSON body." } satisfies AppError
      }
      const result = await upsertStoreManualMonthEntries(supabase, body)
      return json(result, 200)
    }

    if (req.method === "GET" && path === "/analytics/monthly") {
      const result = await fetchStoreAnalyticsMonthly(supabase, url)
      return json(result, 200)
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
        const body = await parseJson(req)
        if (!isRecord(body)) {
          throw { status: 400, message: "Invalid JSON body." } satisfies AppError
        }
        const permissionState = await updateDocumentPermissionStateById(supabase, permissionPath, body)
        return json({ success: true, permissions: permissionState }, 200)
      }
    }

    if (req.method === "PUT" && path === "/settings/media-upload-limit") {
      const body = await parseJson(req)
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
      const body = await parseJson(req)
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
      const body = await parseJson(req)
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
      const body = await parseJson(req)
      const payload = buildRoomSettingsPayload(body)
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
          gmail_reservation_alert_enabled: payload.gmail_reservation_alert_enabled,
          receipt_midreport_enabled: payload.receipt_midreport_enabled,
          receipt_monthend_report_enabled: payload.receipt_monthend_report_enabled,
          receipt_report_store_partition_key: payload.receipt_report_store_partition_key,
          room_sort_order: payload.room_sort_order,
          delivery_hours: payload.delivery_hours,
          message_cleanup_timing: payload.message_cleanup_timing,
          last_delivery_summary_mode: payload.last_delivery_summary_mode,
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
      return json({ room_settings: data }, 200)
    }

    if (req.method === "PUT" && path === "/permissions/users") {
      const body = await parseJson(req)
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
        .select("line_user_id, display_name, is_active, can_message_search, can_library_search, can_calendar_create, can_calendar_update, can_calendar_view, can_media_access, excluded_message_search_room_ids, assigned_store, assigned_job_title, updated_at")
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
      const body = await parseJson(req).catch(() => ({}))
      const roomId = isRecord(body) ? String(body.room_id ?? "").trim() : ""
      const result = await refreshRoomNamesFromLine(supabase, roomId || null)
      return json({ success: true, refresh: result }, 200)
    }

    if (req.method === "POST" && path === "/rooms/sync-chat-members") {
      const body = await parseJson(req)
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
      const body = await parseJson(req)
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
      const body = await parseJson(req)
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
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const provided = req.headers.get("x-admin-token") ?? ""
  if (!provided) {
    return { ok: false, status: 401, message: "Unauthorized." }
  }

  if (await authenticateAdminDashboardSessionToken(supabase, provided)) {
    return { ok: true }
  }

  return authenticateRawAdminToken(provided, supabase, fallbackToken)
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
  const logsLimit = clampInt(url.searchParams.get("logs_limit"), 30, 10, 30)
  const logsFetchLimit = logsLimit * 8

  const globalSettings = await fetchGlobalSettings(supabase)
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
      supabase
        .from("line_webhook_delivery_logs")
        .select("id, created_at, jst_hour, status, reason, method, context, line_send_attempted, line_send_success, line_http_status, target_room_id, details")
        .order("id", { ascending: false })
        .limit(logsFetchLimit),
      fetchStorageUsageState(supabase),
      supabase
        .from("line_user_permissions")
        .select("line_user_id, display_name, is_active, can_message_search, can_library_search, can_calendar_create, can_calendar_update, can_calendar_view, can_media_access, excluded_message_search_room_ids, assigned_store, assigned_job_title, updated_at")
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

  return {
    global_settings: globalSettings,
    room_settings: roomSettingsRes.data ?? [],
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
}> {
  const bounds = getCurrentJstMonthUtcBounds()
  const [webhookPushRes, summaryRes, webhookSuccessRes] = await Promise.all([
    supabase
      .from("line_webhook_delivery_logs")
      .select("context")
      .eq("method", "push")
      .eq("line_send_success", true)
      .gte("created_at", bounds.startUtcIso)
      .lt("created_at", bounds.endUtcIso),
    supabase
      .from("summary_delivery_logs")
      .select("reason, details")
      .eq("line_send_attempted", true)
      .eq("line_send_success", true)
      .gte("run_at", bounds.startUtcIso)
      .lt("run_at", bounds.endUtcIso),
    supabase
      .from("line_webhook_delivery_logs")
      .select("method")
      .eq("line_send_success", true)
      .gte("created_at", bounds.startUtcIso)
      .lt("created_at", bounds.endUtcIso),
  ])
  if (webhookPushRes.error) {
    throw { status: 500, message: `Failed to fetch webhook push usage: ${webhookPushRes.error.message}` } satisfies AppError
  }
  if (summaryRes.error) {
    throw { status: 500, message: `Failed to fetch summary push usage: ${summaryRes.error.message}` } satisfies AppError
  }
  if (webhookSuccessRes.error) {
    throw { status: 500, message: `Failed to fetch webhook usage: ${webhookSuccessRes.error.message}` } satisfies AppError
  }
  const counter = new Map<string, number>()
  const webhookRows = Array.isArray(webhookPushRes.data) ? webhookPushRes.data : []
  const webhookSuccessRows = Array.isArray(webhookSuccessRes.data) ? webhookSuccessRes.data : []
  const summaryRows = Array.isArray(summaryRes.data) ? summaryRes.data : []
  for (const row of webhookRows) {
    const context = String((row as any)?.context ?? "").trim() || "unknown"
    const key = `line-webhook\t${context}`
    counter.set(key, (counter.get(key) ?? 0) + 1)
  }
  for (const row of summaryRows) {
    const details = ((row as any)?.details && typeof (row as any).details === "object") ? (row as any).details as Record<string, unknown> : {}
    const source = String(details.source ?? "summary_delivery_logs").trim() || "summary_delivery_logs"
    const contextRaw = String(details.context ?? "").trim() || String((row as any)?.reason ?? "").trim()
    const context = contextRaw || "unknown"
    const key = `${source}\t${context}`
    counter.set(key, (counter.get(key) ?? 0) + 1)
  }
  const bySourceContext: PushUsageItem[] = Array.from(counter.entries())
    .map(([k, count]) => {
      const [source, context] = k.split("\t")
      return { source: source || "unknown", context: context || "unknown", count }
    })
    .sort((a, b) => (b.count - a.count) || a.source.localeCompare(b.source) || a.context.localeCompare(b.context))

  return {
    month_jst: bounds.monthLabel,
    total_push_rows: webhookRows.length + summaryRows.length,
    webhook_push_rows: webhookRows.length,
    summary_push_rows: summaryRows.length,
    webhook_reply_rows: webhookSuccessRows.filter((row) => String((row as any)?.method ?? "").trim() === "reply").length,
    webhook_success_rows: webhookSuccessRows.length,
    free_quota_limit: 200,
    free_quota_remaining: Math.max(
      0,
      200 - webhookSuccessRows.filter((row) => String((row as any)?.method ?? "").trim() === "reply").length,
    ),
    by_source_context: bySourceContext,
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
    .select("line_user_id, display_name, is_active, can_message_search, can_library_search, can_calendar_create, can_calendar_update, can_calendar_view, can_media_access, excluded_message_search_room_ids, assigned_store, assigned_job_title, updated_at", { count: "exact" })
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

async function refreshRoomNamesFromLine(
  supabase: ReturnType<typeof createClient>,
  roomId: string | null,
) {
  const lineAccessToken = String(Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "").trim()
  if (!lineAccessToken) {
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
    const name = await fetchLineConversationNameByRoomId(id, lineAccessToken)
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

  let query = supabase
    .from("line_message_media")
    .select(
      "id, message_id, line_message_id, room_id, user_id, sender_display_name, media_type, storage_bucket, storage_path, original_file_name, mime_type, file_size_bytes, content_preview, created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (roomId) {
    query = query.eq("room_id", roomId)
  }
  if (mediaType) {
    query = query.eq("media_type", mediaType)
  }

  const [listRes, filteredUsageRes, allUsageRes, mediaUploadMaxMb] = await Promise.all([
    query,
    fetchLineMediaUsageStats(supabase, roomId || null, mediaType),
    fetchLineMediaUsageStats(supabase, null, null),
    fetchMediaUploadMaxMb(supabase),
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
  const range = buildJstMonthRange(targetMonth)
  const sources = sourceFilter === "all" ? ["tabelog", "ikyu"] as const : [sourceFilter] as const
  const items: Array<Record<string, unknown>> = []
  const sourceCounts: Record<string, number> = {
    tabelog: 0,
    ikyu: 0,
  }

  for (const source of sources) {
    const { eventTable, summaryTable } = getReservationSourceTables(source)

    const [eventsRes, summariesRes] = await Promise.all([
      supabase
        .from(eventTable)
        .select("id, gmail_message_id, customer_name, customer_phone, visit_at, created_at, reservation_type, reservation_detail")
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
      const item = buildReservationCalendarItem(
        source,
        row as Record<string, unknown>,
        summaryByCustomer,
      )
      if (!item) continue
      items.push(item)
      sourceCounts[source] += 1
    }
  }

  items.sort((a, b) => String(a.visit_at ?? "").localeCompare(String(b.visit_at ?? "")))

  return {
    month: targetMonth,
    month_start_iso: range.startIso,
    month_end_iso: range.endIso,
    source_filter: sourceFilter,
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
  const limit = clampInt(
    url.searchParams.get("limit"),
    RESERVATION_SEARCH_DEFAULT_LIMIT,
    1,
    RESERVATION_SEARCH_MAX_LIMIT,
  )
  const sources = sourceFilter === "all" ? ["tabelog", "ikyu"] as const : [sourceFilter] as const
  const sourceFetchLimit = Math.min(
    RESERVATION_SEARCH_SOURCE_FETCH_CAP,
    Math.max(limit, Math.ceil(limit * 2)),
  )
  const searchPatterns = buildReservationNameSearchPatterns(query)

  const items: Array<Record<string, unknown>> = []
  const sourceCounts: Record<string, number> = {
    tabelog: 0,
    ikyu: 0,
  }
  const sourceLimitReached: Record<string, boolean> = {
    tabelog: false,
    ikyu: false,
  }

  for (const source of sources) {
    const { eventTable, summaryTable } = getReservationSourceTables(source)

    let eventsQuery = supabase
      .from(eventTable)
      .select("id, gmail_message_id, customer_name, customer_phone, visit_at, created_at, reservation_type, reservation_detail")
      .order("visit_at", { ascending: false })
      .limit(sourceFetchLimit)

    const escapedPatterns = searchPatterns
      .map((pattern) => escapeLikePattern(pattern))
      .filter((pattern) => pattern.length > 0)

    if (escapedPatterns.length === 1) {
      const pattern = escapedPatterns[0]
      eventsQuery = eventsQuery.or(
        `customer_name.ilike.%${pattern}%,reservation_detail.ilike.%${pattern}%`,
      )
    } else if (escapedPatterns.length > 1) {
      const filters: string[] = []
      for (const pattern of escapedPatterns) {
        filters.push(`customer_name.ilike.%${pattern}%`)
        filters.push(`reservation_detail.ilike.%${pattern}%`)
      }
      eventsQuery = eventsQuery.or(filters.join(","))
    }

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
      const item = buildReservationCalendarItem(
        source,
        row as Record<string, unknown>,
        summaryByCustomer,
      )
      if (!item) continue
      if (!matchesReservationSearchItem(item, query)) continue
      items.push(item)
      sourceCounts[source] += 1
    }
  }

  items.sort((a, b) => String(b.visit_at ?? "").localeCompare(String(a.visit_at ?? "")))
  const truncated = items.length > limit || sourceLimitReached.tabelog || sourceLimitReached.ikyu

  return {
    query,
    source_filter: sourceFilter,
    limit,
    total: items.length,
    truncated,
    source_counts: sourceCounts,
    items: items.slice(0, limit),
    generated_at: new Date().toISOString(),
  }
}

function normalizeBudgetStoreKey(raw: string): string {
  const s = String(raw ?? "").trim().toLowerCase()
  return s || "__all__"
}

type ReceiptStoreOption = {
  store_key: string
  store_name: string
}

async function fetchReceiptStoreOptions(
  supabase: ReturnType<typeof createClient>,
): Promise<ReceiptStoreOption[]> {
  const byKey = new Map<string, string>()

  for (const label of MARUGO_GROUP_STORE_OPTIONS) {
    const key = toReceiptStorePartitionKey(label)
    if (key && key !== RECEIPT_STORE_PARTITION_UNKNOWN) {
      byKey.set(key, label)
    }
  }
  byKey.set("bistrocavacava", "BISTRO CAVA CAVA")

  const { data, error } = await supabase
    .from("line_receipt_entries")
    .select("store_partition_key, store_name")
    .neq("store_partition_key", RECEIPT_STORE_PARTITION_UNKNOWN)
    .order("store_name", { ascending: true })
    .limit(5000)

  if (error) {
    console.error("fetchReceiptStoreOptions failed:", error.message)
  } else {
    for (const row of Array.isArray(data) ? data : []) {
      const key = String((row as Record<string, unknown>).store_partition_key ?? "").trim().toLowerCase()
      if (!key || key === RECEIPT_STORE_PARTITION_UNKNOWN) continue
      const name = String((row as Record<string, unknown>).store_name ?? "").trim() || key
      if (!byKey.has(key) || (byKey.get(key) === key && name !== key)) {
        byKey.set(key, name)
      }
    }
  }

  return [...byKey.entries()]
    .map(([store_key, store_name]) => ({ store_key, store_name }))
    .sort((a, b) => a.store_name.localeCompare(b.store_name, "ja"))
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
    .select("sales_month, gross_sales_yen, party_count, guest_count, operating_days_count")
    .eq("store_partition_key", store_partition_key)
    .gte("sales_month", start)
    .lt("sales_month", endExclusive)

  if (error) {
    throw { status: 500, message: `Failed to list manual month gross: ${error.message}` } satisfies AppError
  }

  const months: Record<string, {
    gross_sales_yen: number
    party_count: number | null
    guest_count: number | null
    operating_days_count: number | null
  }> = {}
  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>
    const sm = toSafeString(r.sales_month)
    if (!/^\d{4}-\d{2}$/.test(sm)) continue
    const gross = toNonNegativeInteger(r.gross_sales_yen)
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
      party_count: party,
      guest_count: guest,
      operating_days_count: operating_days_count > 0 ? operating_days_count : null,
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
      const operatingDays = opRaw === null || opRaw === undefined || opRaw === ""
        ? null
        : toNonNegativeInteger(opRaw)
      upsertPayload.push({
        sales_month,
        gross_sales_yen: yenVal,
        party_count: party,
        guest_count: guest,
        operating_days_count: operatingDays > 0 ? operatingDays : null,
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

async function fetchReceiptSalesState(
  supabase: ReturnType<typeof createClient>,
  url: URL,
) {
  const month = normalizeCalendarMonthParam(url.searchParams.get("month"))
  const selectedStoreKeyRaw = toSafeString(url.searchParams.get("store_key"))
  const range = buildJstMonthRange(month)
  const dayKeys = buildJstDateKeysForMonth(month)
  const dayKeySet = new Set(dayKeys)

  let salesQuery = supabase
    .from("line_receipt_entries")
    .select(
      "store_partition_key, store_name, receipt_date, created_at, gross_sales_yen, net_sales_yen, tax_amount_yen, party_count, guest_count",
    )
    .gte("created_at", range.startIso)
    .lt("created_at", range.endIso)
    .order("created_at", { ascending: true })
    .limit(20000)

  // 店舗指定時は DB 側で絞る（全店スキャン回避）。インデックス (store_partition_key, created_at) を利用
  if (selectedStoreKeyRaw) {
    salesQuery = salesQuery.eq("store_partition_key", selectedStoreKeyRaw)
  }

  const { data, error } = await salesQuery

  if (error) {
    throw { status: 500, message: `Failed to fetch receipt sales data: ${error.message}` } satisfies AppError
  }

  type StoreTotal = {
    store_key: string
    store_name: string
    receipt_count: number
    total_gross_sales_yen: number
    total_net_sales_yen: number
    total_tax_amount_yen: number
    total_party_count: number
    total_guest_count: number
  }

  type DailyTotal = {
    date: string
    receipt_count: number
    gross_sales_yen: number
    net_sales_yen: number
    tax_amount_yen: number
    party_count: number
    guest_count: number
  }

  const rows = Array.isArray(data) ? data : []
  const storeTotals = new Map<string, StoreTotal>()
  const byStoreByDate = new Map<string, Map<string, DailyTotal>>()

  for (const row of rows) {
    const storeKey = toSafeString((row as Record<string, unknown>).store_partition_key) || "unknown_store"
    const storeNameRaw = toSafeString((row as Record<string, unknown>).store_name) || storeKey
    const dayKey = resolveReceiptEntryDateKeyForMonth(
      (row as Record<string, unknown>).receipt_date,
      month,
    )
    if (!dayKey || !dayKeySet.has(dayKey)) continue

    const grossSalesYen = toNonNegativeInteger((row as Record<string, unknown>).gross_sales_yen)
    const netSalesYen = toNonNegativeInteger((row as Record<string, unknown>).net_sales_yen)
    const taxAmountYen = toNonNegativeInteger((row as Record<string, unknown>).tax_amount_yen)
    const partyCount = toNonNegativeInteger((row as Record<string, unknown>).party_count)
    const guestCount = toNonNegativeInteger((row as Record<string, unknown>).guest_count)

    const existingStore = storeTotals.get(storeKey)
    if (!existingStore) {
      storeTotals.set(storeKey, {
        store_key: storeKey,
        store_name: storeNameRaw,
        receipt_count: 1,
        total_gross_sales_yen: grossSalesYen,
        total_net_sales_yen: netSalesYen,
        total_tax_amount_yen: taxAmountYen,
        total_party_count: partyCount,
        total_guest_count: guestCount,
      })
    } else {
      if (existingStore.store_name === existingStore.store_key && storeNameRaw !== storeKey) {
        existingStore.store_name = storeNameRaw
      }
      existingStore.receipt_count += 1
      existingStore.total_gross_sales_yen += grossSalesYen
      existingStore.total_net_sales_yen += netSalesYen
      existingStore.total_tax_amount_yen += taxAmountYen
      existingStore.total_party_count += partyCount
      existingStore.total_guest_count += guestCount
    }

    if (!byStoreByDate.has(storeKey)) {
      byStoreByDate.set(storeKey, new Map<string, DailyTotal>())
    }
    const dailyMap = byStoreByDate.get(storeKey)!
    const existingDaily = dailyMap.get(dayKey)
    if (!existingDaily) {
      dailyMap.set(dayKey, {
        date: dayKey,
        receipt_count: 1,
        gross_sales_yen: grossSalesYen,
        net_sales_yen: netSalesYen,
        tax_amount_yen: taxAmountYen,
        party_count: partyCount,
        guest_count: guestCount,
      })
    } else {
      existingDaily.receipt_count += 1
      existingDaily.gross_sales_yen += grossSalesYen
      existingDaily.net_sales_yen += netSalesYen
      existingDaily.tax_amount_yen += taxAmountYen
      existingDaily.party_count += partyCount
      existingDaily.guest_count += guestCount
    }
  }

  const collator = new Intl.Collator("ja-JP", { sensitivity: "base", usage: "sort" })
  const storeOptions = [...storeTotals.values()].sort((a, b) => {
    if (a.total_gross_sales_yen !== b.total_gross_sales_yen) {
      return b.total_gross_sales_yen - a.total_gross_sales_yen
    }
    const byName = collator.compare(a.store_name, b.store_name)
    if (byName !== 0) return byName
    return collator.compare(a.store_key, b.store_key)
  })

  // store_key 指定あり → そのまま使用（データなしでも空で返す）
  // store_key 指定なし → データのある最初の店舗をデフォルトに
  const selectedStoreKey = selectedStoreKeyRaw
    ? selectedStoreKeyRaw
    : (storeOptions[0]?.store_key ?? "")
  const selectedStore = selectedStoreKey ? storeTotals.get(selectedStoreKey) ?? null : null
  const selectedDailyMap = selectedStoreKey ? (byStoreByDate.get(selectedStoreKey) ?? new Map<string, DailyTotal>()) : new Map<
    string,
    DailyTotal
  >()

  const series = dayKeys.map((dateKey) => {
    const daily = selectedDailyMap.get(dateKey)
    const receiptCount = daily?.receipt_count ?? 0
    const grossSalesYen = daily?.gross_sales_yen ?? 0
    const netSalesYen = daily?.net_sales_yen ?? 0
    const taxAmountYen = daily?.tax_amount_yen ?? 0
    const partyCount = daily?.party_count ?? 0
    const guestCount = daily?.guest_count ?? 0
    return {
      date: dateKey,
      receipt_count: receiptCount,
      gross_sales_yen: grossSalesYen,
      net_sales_yen: netSalesYen,
      tax_amount_yen: taxAmountYen,
      party_count: partyCount,
      guest_count: guestCount,
      avg_gross_sales_yen: receiptCount > 0 ? Math.round(grossSalesYen / receiptCount) : null,
      avg_party_count: receiptCount > 0 ? roundToScale(partyCount / receiptCount, 2) : null,
      avg_guest_count: receiptCount > 0 ? roundToScale(guestCount / receiptCount, 2) : null,
      avg_unit_price_yen: guestCount > 0 ? Math.round(grossSalesYen / guestCount) : null,
    }
  })

  const monthStartDate = dayKeys.length > 0 ? dayKeys[0] : `${month}-01`
  const monthEndDate = dayKeys.length > 0 ? dayKeys[dayKeys.length - 1] : `${month}-01`

  // URL に store_key が無いときは、集計に使った既定店舗で予算を取得（__all__ との取り違え防止）
  const budgetRow = await fetchSalesBudgetRow(
    supabase,
    selectedStoreKeyRaw || selectedStoreKey || "",
    month,
  )
  const month_budget_yen = budgetRow?.budget_yen ?? null
  const budget_mon_weight = budgetRow?.mon_weight ?? null
  const budget_tue_weight = budgetRow?.tue_weight ?? null
  const budget_wed_weight = budgetRow?.wed_weight ?? null
  const budget_thu_weight = budgetRow?.thu_weight ?? null
  const budget_fri_weight = budgetRow?.fri_weight ?? null
  const budget_sat_weight = budgetRow?.sat_weight ?? null
  const budget_sun_weight = budgetRow?.sun_weight ?? null
  const store_closed_dates = budgetRow?.store_closed_dates ?? []

  const compareYear = parseCompareYearQueryParam(url.searchParams.get("compare_year"), month)
  const comparison_sales_month = comparisonSalesMonth(month, compareYear)
  const manualComparison = await fetchManualMonthSales(
    supabase,
    normalizeBudgetStoreKey(selectedStoreKeyRaw || selectedStoreKey || ""),
    comparison_sales_month,
  )
  const manual_comparison_gross_yen = manualComparison?.gross_sales_yen ?? null
  const manual_comparison_party_count = manualComparison?.party_count ?? null
  const manual_comparison_guest_count = manualComparison?.guest_count ?? null

  let daily_budget_yen_by_date: Record<string, number> | null = null
  if (
    budgetRow &&
    month_budget_yen != null &&
    month_budget_yen > 0
  ) {
    const weights: SalesBudgetAllocationWeights = {
      mon: budgetRow.mon_weight,
      tue: budgetRow.tue_weight,
      wed: budgetRow.wed_weight,
      thu: budgetRow.thu_weight,
      fri: budgetRow.fri_weight,
      sat: budgetRow.sat_weight,
      sun: budgetRow.sun_weight,
    }
    const storeClosedSet = new Set(store_closed_dates)
    const map = allocateDailyBudgetsForMonth(
      month,
      month_budget_yen,
      weights,
      storeClosedSet,
    )
    daily_budget_yen_by_date = Object.fromEntries(map)
  }

  return {
    month,
    month_budget_yen,
    budget_mon_weight,
    budget_tue_weight,
    budget_wed_weight,
    budget_thu_weight,
    budget_fri_weight,
    budget_sat_weight,
    budget_sun_weight,
    store_closed_dates,
    comparison_year: compareYear,
    comparison_sales_month,
    manual_comparison_gross_yen,
    manual_comparison_party_count,
    manual_comparison_guest_count,
    daily_budget_yen_by_date,
    month_start_iso: range.startIso,
    month_end_iso: range.endIso,
    month_start_date: monthStartDate,
    month_end_date: monthEndDate,
    selected_store_key: selectedStoreKey || null,
    selected_store_name: selectedStore?.store_name ?? null,
    store_options: storeOptions,
    totals: {
      receipt_count: selectedStore?.receipt_count ?? 0,
      total_gross_sales_yen: selectedStore?.total_gross_sales_yen ?? 0,
      total_net_sales_yen: selectedStore?.total_net_sales_yen ?? 0,
      total_tax_amount_yen: selectedStore?.total_tax_amount_yen ?? 0,
      total_party_count: selectedStore?.total_party_count ?? 0,
      total_guest_count: selectedStore?.total_guest_count ?? 0,
      avg_gross_sales_yen: selectedStore && selectedStore.receipt_count > 0
        ? Math.round(selectedStore.total_gross_sales_yen / selectedStore.receipt_count)
        : null,
      avg_party_count: selectedStore && selectedStore.receipt_count > 0
        ? roundToScale(selectedStore.total_party_count / selectedStore.receipt_count, 2)
        : null,
      avg_guest_count: selectedStore && selectedStore.receipt_count > 0
        ? roundToScale(selectedStore.total_guest_count / selectedStore.receipt_count, 2)
        : null,
      avg_unit_price_yen: selectedStore && selectedStore.total_guest_count > 0
        ? Math.round(selectedStore.total_gross_sales_yen / selectedStore.total_guest_count)
        : null,
    },
    series,
    available_store_count: storeOptions.length,
    source_row_count: rows.length,
    generated_at: new Date().toISOString(),
  }
}

async function fetchAnalyticsMonthly(
  supabase: ReturnType<typeof createClient>,
  url: URL,
) {
  const storeKeyRaw = toSafeString(url.searchParams.get("store_key"))
  const monthsRaw = Number(url.searchParams.get("months") ?? "12")
  const months = Number.isFinite(monthsRaw) && monthsRaw >= 1 ? Math.min(Math.floor(monthsRaw), 36) : 12

  const now = new Date()
  const jstParts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now)
  const currentYear = Number(jstParts.find((p) => p.type === "year")?.value ?? now.getUTCFullYear())
  const currentMonth = Number(jstParts.find((p) => p.type === "month")?.value ?? 1)

  const monthKeys: string[] = []
  for (let i = months - 1; i >= 0; i--) {
    const totalMonths = currentYear * 12 + (currentMonth - 1) - i
    const y = Math.floor(totalMonths / 12)
    const m = (totalMonths % 12) + 1
    monthKeys.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`)
  }

  const firstMonth = monthKeys[0]
  const lastMonth = monthKeys[monthKeys.length - 1]
  const startDateStr = `${firstMonth}-01`
  const lastMonthNum = Number(lastMonth.slice(5, 7))
  const lastMonthYear = Number(lastMonth.slice(0, 4))
  const nextYear = lastMonthNum === 12 ? lastMonthYear + 1 : lastMonthYear
  const nextMonth = lastMonthNum === 12 ? 1 : lastMonthNum + 1
  const endDateStr = `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`

  let query = supabase
    .from("line_receipt_entries")
    .select("store_partition_key, store_name, receipt_date, gross_sales_yen, net_sales_yen, party_count, guest_count")
    .gte("receipt_date", startDateStr)
    .lt("receipt_date", endDateStr)
    .limit(50000)

  if (storeKeyRaw) query = query.eq("store_partition_key", storeKeyRaw)

  const { data, error } = await query
  if (error) throw { status: 500, message: `Failed to fetch analytics monthly data: ${error.message}` } satisfies AppError

  type MonthlyRow = {
    month: string
    gross_sales_yen: number
    net_sales_yen: number
    party_count: number
    guest_count: number
    receipt_count: number
    avg_unit_price_yen: number | null
  }

  const monthMap = new Map<string, MonthlyRow>()
  for (const key of monthKeys) {
    monthMap.set(key, { month: key, gross_sales_yen: 0, net_sales_yen: 0, party_count: 0, guest_count: 0, receipt_count: 0, avg_unit_price_yen: null })
  }

  const storeSet = new Map<string, string>()

  for (const row of (Array.isArray(data) ? data : [])) {
    const r = row as Record<string, unknown>
    const dateStr = toSafeString(r.receipt_date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue
    const monthKey = dateStr.slice(0, 7)
    const bucket = monthMap.get(monthKey)
    if (!bucket) continue
    bucket.gross_sales_yen += toNonNegativeInteger(r.gross_sales_yen)
    bucket.net_sales_yen += toNonNegativeInteger(r.net_sales_yen)
    bucket.party_count += toNonNegativeInteger(r.party_count)
    bucket.guest_count += toNonNegativeInteger(r.guest_count)
    bucket.receipt_count += 1
    const sk = toSafeString(r.store_partition_key)
    if (sk && !storeSet.has(sk)) storeSet.set(sk, toSafeString(r.store_name) || sk)
  }

  if (storeKeyRaw) {
    const manualByMonth = await fetchManualMonthSalesMapForStore(supabase, storeKeyRaw, monthKeys)
    for (const [monthKey, manual] of manualByMonth.entries()) {
      const bucket = monthMap.get(monthKey)
      if (!bucket) continue
      bucket.gross_sales_yen = manual.gross_sales_yen
      if (manual.party_count != null) bucket.party_count = manual.party_count
      if (manual.guest_count != null) bucket.guest_count = manual.guest_count
    }
  }

  for (const bucket of monthMap.values()) {
    bucket.avg_unit_price_yen = bucket.guest_count > 0 ? Math.round(bucket.gross_sales_yen / bucket.guest_count) : null
  }

  return {
    months: monthKeys.length,
    store_key: storeKeyRaw || null,
    series: [...monthMap.values()],
    available_stores: [...storeSet.entries()].map(([k, v]) => ({ store_key: k, store_name: v })),
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
  const rows = Array.isArray(data) ? data : []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const name = toSafeString(row.customer_name)
    const phone = toSafeString(row.customer_phone)
    if (!name || !phone) continue
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
  source: "tabelog" | "ikyu",
  event: Record<string, unknown>,
  summaryByCustomer: Map<string, Record<string, unknown>> | null,
): Record<string, unknown> | null {
  const name = String(event.customer_name ?? "").trim()
  const phone = String(event.customer_phone ?? "").trim()
  const visitAt = toSafeString(event.visit_at)
  const createdAt = toSafeString(event.created_at)
  if (!visitAt && !createdAt) return null

  const visitAtValue = visitAt || createdAt
  const createdAtValue = createdAt || visitAt
  const reservationType = toSafeString(event.reservation_type) || "unknown"
  const reservationDetail = toSafeString(event.reservation_detail)
  const parsedDetail = parseReservationCalendarDetail(reservationDetail)
  const routeLabel = normalizeCalendarText(
    parsedDetail?.route ??
      parsedDetail?.reservationSite ??
      (source === "tabelog" ? "食べログ" : "一休.comレストラン"),
    80,
  ) ?? (source === "tabelog" ? "食べログ" : "一休.comレストラン")
  const customerNameLabel = normalizeCalendarText(parsedDetail?.customerName, 80) ?? (name || null)
  const planLabel = normalizeCalendarText(parsedDetail?.plan, 220) ??
    (parsedDetail ? null : normalizeCalendarText(reservationDetail, 220))
  const partySizeLabel = normalizeCalendarPartySize(parsedDetail?.partySize)
  const allergyLabel = normalizeCalendarAllergy(parsedDetail?.allergy)
  const visitTimeLabel = buildCalendarVisitTimeLabel(parsedDetail?.visitDateTime, visitAtValue)
  const visitMonth = buildCalendarVisitMonthLabel(visitAtValue)
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

function normalizeReservationSourceFilter(value: string | null): "all" | "tabelog" | "ikyu" {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (normalized === "tabelog") return "tabelog"
  if (normalized === "ikyu") return "ikyu"
  return "all"
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

function extractClientIp(headers: Headers): string {
  const candidates = [
    headers.get("cf-connecting-ip"),
    headers.get("x-real-ip"),
    headers.get("x-forwarded-for"),
  ]
  for (const raw of candidates) {
    const value = String(raw ?? "").trim()
    if (!value) continue
    const first = value.split(",")[0]?.trim()
    if (first) return first
  }
  return "unknown"
}

function resolveAdminRateLimit(method: string, path: string): { maxRequests: number; windowMs: number } {
  if (method === "POST" && path === "/auth/link-login") {
    return {
      maxRequests: 20,
      windowMs: ADMIN_RATE_LIMIT_DEFAULT_WINDOW_MS,
    }
  }
  if (method === "POST" && path === "/documents") {
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
  if (!messageId || !lineMessageId || !roomId || !storageBucket || !storagePath) return null

  return {
    id: Math.floor(idNum),
    message_id: messageId,
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

async function fetchMediaContextMap(
  supabase: ReturnType<typeof createClient>,
  rows: MediaListRow[],
): Promise<Map<number, MediaMessageContext>> {
  const contextMap = new Map<number, MediaMessageContext>()
  if (rows.length === 0) return contextMap

  const anchorMessageIds = Array.from(
    new Set(rows.map((row) => row.message_id).filter((id) => id.length > 0)),
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
    const anchor = anchorMap.get(row.message_id)
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
  gmail_reservation_alert_enabled: boolean
  receipt_midreport_enabled: boolean
  receipt_monthend_report_enabled: boolean
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

  const gmailReservationAlertEnabledRaw = body.gmail_reservation_alert_enabled
  if (gmailReservationAlertEnabledRaw != null && typeof gmailReservationAlertEnabledRaw !== "boolean") {
    throw { status: 400, message: "gmail_reservation_alert_enabled must be boolean when provided." } satisfies AppError
  }
  const gmailReservationAlertEnabled = gmailReservationAlertEnabledRaw === true

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
    gmail_reservation_alert_enabled: gmailReservationAlertEnabled,
    receipt_midreport_enabled: receiptMidreportEnabled,
    receipt_monthend_report_enabled: receiptMonthendReportEnabled,
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

  /** Edge の JWT 検証: `apikey` は anon、`Authorization` は service_role が推奨（両方 service で 401 になる環境がある） */
  const anonKey = (Deno.env.get("SUPABASE_ANON_KEY") ?? "").trim()

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${opts.serviceRoleKey}`,
      apikey: anonKey || opts.serviceRoleKey,
      "X-Receipt-Midreport-Test-Key": opts.testKey,
    },
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
