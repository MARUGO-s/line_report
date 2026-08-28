import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { writeGasSyncConfigToSpreadsheet } from "../_shared/receipt_sheets_gas_config.ts"
import { clearBistrocavacavaSheetDataRowsAndPushFromDb } from "../_shared/bistrocavacava_sheet_push.ts"
import {
  clearSpreadsheetTabsExceptStores,
  clearStoreSheetBudgetTabsAndPushFromDb,
} from "../_shared/clear_store_sheet_budget_tabs.ts"
import {
  appendReceiptSheetsBackgroundSyncSummaryLog,
  runReceiptSheetsPilotSync,
  runReceiptSheetsPilotSyncChainedStep,
  runReceiptSheetsPilotSyncForStore,
  runReceiptSheetsPilotSyncViaGas,
  type ReceiptSheetsGasPullInput,
  type ReceiptSheetsSyncDirection,
} from "../_shared/receipt_sheets_pilot_sync.ts"
import {
  listReceiptSheetsStores,
  resolveReceiptSheetsStoreDisplayName,
  resolveReceiptSheetsStoreKey,
} from "../_shared/receipt_sheets_store_catalog.ts"
import { isInternalCronAuthorized } from "../_shared/internal_cron_auth.ts"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-receipt-sheets-sync-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    })
  }

  let body: Record<string, unknown> = {}
  if (req.method === "POST") {
    try {
      body = await req.json() as Record<string, unknown>
    } catch {
      body = {}
    }
  }

  if (body?.get_gas_config === true) {
    const canRead = await isAuthorized(req)
    if (!canRead) {
      return json({ ok: false, error: "Forbidden." }, 403)
    }
    const syncSecret = String(Deno.env.get("RECEIPT_SHEETS_SYNC_SECRET") ?? "").trim()
    if (!syncSecret) {
      return json({ ok: false, error: "RECEIPT_SHEETS_SYNC_SECRET is not set on hocbn." }, 500)
    }
    const saEmail = String(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL") ?? "").trim()
    const saProject = saEmail.includes("@")
      ? saEmail.split("@")[1].replace(".iam.gserviceaccount.com", "")
      : ""
    const sheetsApiUrl = saProject
      ? `https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=${saProject}`
      : "https://console.cloud.google.com/apis/library/sheets.googleapis.com"

    return json({
      ok: true,
      supabase_receipt_sheets_sync_url:
        "https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/receipt-sheets-sync-cron",
      receipt_sheets_sync_secret: syncSecret,
      spreadsheet_id: String(Deno.env.get("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID") ?? "").trim(),
      google_service_account_email: saEmail,
      google_cloud_project_for_sa: saProject,
      gas_config_tab: "設定",
      gas_url_cell: "B2",
      gas_secret_cell: "B3",
      sheets_api_enable_url: sheetsApiUrl,
    }, 200)
  }

  if (body?.write_gas_config === true) {
    const canWrite = await isAuthorized(req)
    if (!canWrite) {
      return json({
        ok: false,
        error: "Forbidden. Use service role Bearer or x-receipt-sheets-sync-key / RECEIPT_SHEETS_SYNC_SECRET.",
      }, 403)
    }
    try {
      const spreadsheetId = String(Deno.env.get("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID") ?? "").trim()
      const result = await writeGasSyncConfigToSpreadsheet(spreadsheetId)
      return json({ ok: true, ...result }, 200)
    } catch (e) {
      console.error("write_gas_config failed:", e)
      return json({ ok: false, error: String(e) }, 500)
    }
  }

  if (body?.clear_sheets_except_stores === true) {
    const canRun = await isAuthorized(req)
    if (!canRun) {
      return json({ ok: false, error: "Forbidden." }, 403)
    }
    const spreadsheetId = String(Deno.env.get("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID") ?? "").trim()
    if (!spreadsheetId) {
      return json({ ok: false, error: "RECEIPT_SHEETS_PILOT_SPREADSHEET_ID is not set." }, 500)
    }
    const keepRaw = body?.keep_store_partition_keys
    const keepKeys = Array.isArray(keepRaw)
      ? keepRaw.map((k) => String(k ?? "").trim()).filter(Boolean)
      : []
    if (keepKeys.length === 0) {
      return json({ ok: false, error: "keep_store_partition_keys array is required." }, 400)
    }
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
      let registryKeys: string[] = []
      if (supabaseUrl && serviceRoleKey) {
        const sb = createClient(supabaseUrl, serviceRoleKey)
        const { data } = await sb.from("store_webhook_tables").select("store_partition_key")
        registryKeys = (data ?? [])
          .map((row) => String((row as { store_partition_key?: unknown }).store_partition_key ?? "").trim())
          .filter(Boolean)
      }
      const result = await clearSpreadsheetTabsExceptStores(
        spreadsheetId,
        keepKeys,
        registryKeys,
      )
      return json(result, 200)
    } catch (e) {
      console.error("clear_sheets_except_stores failed:", e)
      return json({ ok: false, error: String(e) }, 500)
    }
  }

  if (body?.clear_store_budget_tabs === true) {
    const canRun = await isAuthorized(req)
    if (!canRun) {
      return json({ ok: false, error: "Forbidden." }, 403)
    }
    const storeKey = String(body?.store_partition_key ?? "").trim()
    if (!storeKey) {
      return json({ ok: false, error: "store_partition_key is required." }, 400)
    }
    const spreadsheetId = String(Deno.env.get("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID") ?? "").trim()
    if (!spreadsheetId) {
      return json({ ok: false, error: "RECEIPT_SHEETS_PILOT_SPREADSHEET_ID is not set." }, 500)
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ ok: false, error: "Supabase env is missing." }, 500)
    }
    const sb = createClient(supabaseUrl, serviceRoleKey)
    try {
      const skipPush = body?.skip_push === true
      const result = await clearStoreSheetBudgetTabsAndPushFromDb(sb, spreadsheetId, storeKey, { skipPush })
      return json({ ok: true, ...result }, 200)
    } catch (e) {
      console.error("clear_store_budget_tabs failed:", e)
      return json({ ok: false, error: String(e), store_partition_key: storeKey }, 500)
    }
  }

  if (body?.bistrocavacava_cleanup_and_push === true) {
    const canRun = await isAuthorized(req)
    if (!canRun) {
      return json({ ok: false, error: "Forbidden." }, 403)
    }
    const spreadsheetId = String(Deno.env.get("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID") ?? "").trim()
    if (!spreadsheetId) {
      return json({ ok: false, error: "RECEIPT_SHEETS_PILOT_SPREADSHEET_ID is not set." }, 500)
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ ok: false, error: "Supabase env is missing." }, 500)
    }
    const sb = createClient(supabaseUrl, serviceRoleKey)
    try {
      const result = await clearBistrocavacavaSheetDataRowsAndPushFromDb(sb, spreadsheetId)
      return json({ ok: true, ...result }, 200)
    } catch (e) {
      console.error("bistrocavacava_cleanup_and_push failed:", e)
      return json({ ok: false, error: String(e) }, 500)
    }
  }

  if (!(await isAuthorized(req))) {
    return json({ ok: false, error: "Unauthorized." }, 401)
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Supabase env is missing." }, 500)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const url = new URL(req.url)
  let direction: ReceiptSheetsSyncDirection = "both"
  let viaGas = url.searchParams.get("via_gas") === "1"
  const gasPull: Partial<ReceiptSheetsGasPullInput> = {}

  const raw = String(body?.direction ?? "").trim().toLowerCase()
  if (raw === "pull" || raw === "push" || raw === "both") {
    direction = raw
  }
  if (body?.via_gas === true) viaGas = true
  if (typeof body?.store_partition_key === "string" && body.store_partition_key.trim()) {
    gasPull.store_partition_key = body.store_partition_key.trim()
  }
  if (typeof body?.store_display_name === "string" && body.store_display_name.trim()) {
    gasPull.store_display_name = body.store_display_name.trim()
  }
  if (Array.isArray(body?.monthly_budget_rows)) {
    gasPull.monthly_budget_rows = body.monthly_budget_rows as ReceiptSheetsGasPullInput["monthly_budget_rows"]
  }
  if (Array.isArray(body?.past_sales_rows)) {
    gasPull.past_sales_rows = body.past_sales_rows as ReceiptSheetsGasPullInput["past_sales_rows"]
  }

  if (url.searchParams.get("direction") === "pull" || url.searchParams.get("direction") === "push") {
    direction = url.searchParams.get("direction") as ReceiptSheetsSyncDirection
  }

  if (viaGas) {
    try {
      const result = await runReceiptSheetsPilotSyncViaGas(supabase, direction, gasPull)
      return json(result, 200)
    } catch (e) {
      console.error("receipt-sheets-sync-cron (via_gas) failed:", e)
      return json({ ok: false, error: String(e), via_gas: true }, 500)
    }
  }

  const spreadsheetId = String(Deno.env.get("RECEIPT_SHEETS_PILOT_SPREADSHEET_ID") ?? "").trim()
  if (!spreadsheetId) {
    return json({
      ok: true,
      skipped: true,
      reason: "receipt_sheets_pilot_not_configured",
      hint: "Set RECEIPT_SHEETS_PILOT_SPREADSHEET_ID (and share the sheet with the service account).",
    }, 200)
  }

  // 過去売上シートのデータソース診断（store_webhook_tables キーと手入力データを確認）
  if (body?.past_sales_diagnostic === true) {
    const storeKey = String(body?.store_key ?? "marugosecond").trim()
    const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")

    // store_webhook_tables の全キー一覧（大文字小文字を確認）
    const { data: allStores } = await sb.from("store_webhook_tables")
      .select("store_partition_key, receipt_table").order("store_partition_key")

    // 指定店舗の receipt_table
    const { data: reg } = await sb.from("store_webhook_tables")
      .select("receipt_table").eq("store_partition_key", storeKey).maybeSingle()
    const receiptTable = (reg as Record<string, unknown> | null)?.receipt_table as string | null

    // ★ line_sales_manual_month_gross に存在するすべての store_partition_key を取得
    const { data: manualAllKeys } = await sb.from("line_sales_manual_month_gross")
      .select("store_partition_key")
    const distinctManualKeys = [...new Set(
      (manualAllKeys ?? []).map((r: Record<string, unknown>) => String(r.store_partition_key ?? ""))
    )].sort()

    // 手入力データの月一覧（指定店舗）
    const { data: manualRows } = await sb.from("line_sales_manual_month_gross")
      .select("sales_month, gross_sales_yen").eq("store_partition_key", storeKey)
      .order("sales_month")

    // レシート集計（receipt_table が取れた場合）
    let receiptMonthSample: unknown[] = []
    if (receiptTable) {
      const { data: rRows } = await sb.from(receiptTable)
        .select("receipt_date, gross_sales_yen")
        .not("receipt_date", "is", null).not("gross_sales_yen", "is", null)
        .gte("receipt_date", "2025-01-01").order("receipt_date").limit(5)
      receiptMonthSample = rRows ?? []
    }

    return json({
      ok: true,
      queried_store_key: storeKey,
      receipt_table_found: receiptTable,
      all_store_keys_in_webhook_tables: (allStores ?? []).map((s: Record<string, unknown>) => s.store_partition_key),
      // ★ これが空でない → キーの不一致が原因
      all_store_keys_in_manual_month_gross: distinctManualKeys,
      manual_months_count: (manualRows ?? []).length,
      manual_months_range: {
        first: (manualRows as Array<Record<string, unknown>> | null)?.[0]?.sales_month ?? null,
        last: (manualRows as Array<Record<string, unknown>> | null)?.at(-1)?.sales_month ?? null,
      },
      receipt_2025_sample: receiptMonthSample,
    }, 200)
  }

  // 一時診断エンドポイント: 各テーブルの件数を確認する（問題解決後に削除予定）
  if (body?.db_diagnostic === true) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    const sb = createClient(supabaseUrl, serviceRoleKey)

    // store_webhook_tables の一覧
    const { data: stores } = await sb.from("store_webhook_tables")
      .select("store_partition_key, receipt_table").order("store_partition_key")

    // 各レシートテーブルの件数・日付範囲
    const receiptCounts: Record<string, unknown> = {}
    for (const s of (stores ?? []) as Array<{ store_partition_key: string; receipt_table: string }>) {
      const { count } = await sb.from(s.receipt_table)
        .select("*", { count: "exact", head: true })
      const { data: minMax } = await sb.from(s.receipt_table)
        .select("receipt_date").not("receipt_date", "is", null)
        .order("receipt_date", { ascending: true }).limit(1)
      const { data: maxRow } = await sb.from(s.receipt_table)
        .select("receipt_date").not("receipt_date", "is", null)
        .order("receipt_date", { ascending: false }).limit(1)
      receiptCounts[s.store_partition_key] = {
        table: s.receipt_table,
        total_rows: count,
        earliest: (minMax as Array<Record<string, unknown>>)?.[0]?.receipt_date ?? null,
        latest: (maxRow as Array<Record<string, unknown>>)?.[0]?.receipt_date ?? null,
      }
    }

    // line_sales_manual_month_gross の件数
    const { count: manualCount } = await sb.from("line_sales_manual_month_gross")
      .select("*", { count: "exact", head: true })
    const { data: manualRange } = await sb.from("line_sales_manual_month_gross")
      .select("sales_month").order("sales_month", { ascending: true }).limit(1)
    const { data: manualRangeMax } = await sb.from("line_sales_manual_month_gross")
      .select("sales_month").order("sales_month", { ascending: false }).limit(1)

    return json({
      ok: true,
      manual_month_gross: {
        total_rows: manualCount,
        earliest: (manualRange as Array<Record<string, unknown>>)?.[0]?.sales_month ?? null,
        latest: (manualRangeMax as Array<Record<string, unknown>>)?.[0]?.sales_month ?? null,
      },
      receipt_tables: receiptCounts,
    }, 200)
  }

  if (body?.get_sync_status === true) {
    const { data } = await supabase
      .from("receipt_sheets_sync_status")
      .select("last_completed_at, direction, updated_at, failed, error_message")
      .eq("id", 1)
      .maybeSingle()
    return json({ ok: true, ...(data ?? {}) }, 200)
  }

  if (body?.sync_one_store === true) {
    const storeKeyRaw = String(body?.store_partition_key ?? "").trim()
    const canonical = resolveReceiptSheetsStoreKey(storeKeyRaw)
    if (!canonical) {
      return json({ ok: false, error: "Unknown store_partition_key." }, 400)
    }
    const displayName = resolveReceiptSheetsStoreDisplayName(canonical)
    if (!displayName) {
      return json({ ok: false, error: "Unknown store display name." }, 400)
    }
    const oneDirection: ReceiptSheetsSyncDirection =
      raw === "pull" || raw === "push" || raw === "both" ? direction : "push"
    const preferSheetOnContentDiff = body?.prefer_sheet_on_content_diff === true
    try {
      const result = await runReceiptSheetsPilotSyncForStore(
        supabase,
        {
          spreadsheetId,
          storePartitionKey: canonical,
          storeDisplayName: displayName,
          skipSyncLog: false,
          preferSheetOnContentDiff,
        },
        oneDirection,
      )
      return json({ ok: true, sync_one_store: true, ...result }, 200)
    } catch (e) {
      console.error("sync_one_store failed:", e)
      return json({ ok: false, sync_one_store: true, error: String(e), store_partition_key: canonical }, 500)
    }
  }

  const preferSheetOnContentDiff = body?.prefer_sheet_on_content_diff === true

  if (body?.background_sync_continue === true) {
    const offset = Math.max(0, parseInt(String(body?.offset ?? "0"), 10) || 0)
    const startedAt = String(body?.started_at ?? new Date().toISOString()).trim()
    const failedRaw = body?.failed_stores
    const failedStores = Array.isArray(failedRaw)
      ? failedRaw.map((k) => String(k ?? "").trim()).filter(Boolean)
      : []
    try {
      await runReceiptSheetsPilotSyncChainedStep(
        supabase,
        direction,
        offset,
        startedAt,
        failedStores,
        preferSheetOnContentDiff,
      )
      return json({
        ok: true,
        background_continue: true,
        offset,
        store_count: listReceiptSheetsStores().length,
      }, 200)
    } catch (e) {
      console.error("background_sync_continue failed:", e)
      return json({
        ok: false,
        background_continue: true,
        offset,
        error: String(e),
      }, 500)
    }
  }

  if (body?.background_sync === true) {
    const storeCount = listReceiptSheetsStores().length
    try {
      await appendReceiptSheetsBackgroundSyncSummaryLog(spreadsheetId, direction, {
        failed: false,
        storeCount,
        pullSummary: "受付",
        memo: "background_sync 受付（2店舗ずつ並列で順次処理を開始）。完了行が続けば成功。通常5〜12分。",
      })
    } catch (e) {
      console.error("background_sync accept log failed:", e)
      return json({
        ok: false,
        error: `同期ログへの書き込みに失敗しました。サービスアカウントのシート共有を確認してください: ${String(e)}`,
        spreadsheet_id: spreadsheetId,
      }, 500)
    }

    const startedAt = new Date().toISOString()
    const syncPromise = runReceiptSheetsPilotSyncChainedStep(
      supabase,
      direction,
      0,
      startedAt,
      [],
      preferSheetOnContentDiff,
    ).catch((e) => {
      console.error("background receipt-sheets-sync chained failed:", e)
    })
    EdgeRuntime.waitUntil(syncPromise)
    return json({
      ok: true,
      background: true,
      direction,
      spreadsheet_id: spreadsheetId,
      store_count: storeCount,
      message:
        "全店舗同期を開始しました（2店舗ずつ並列）。同期ログに「受付」行が出ていれば接続OK。サイドバーで進捗を確認し、通常5〜12分で完了します。",
    }, 202)
  }

  try {
    const result = await runReceiptSheetsPilotSync(supabase, direction)
    return json(result, 200)
  } catch (e) {
    console.error("receipt-sheets-sync-cron failed:", e)
    return json({
      ok: false,
      error: String(e),
      spreadsheet_id: spreadsheetId,
    }, 500)
  }
})

function bearerToken(req: Request): string {
  const authHeader = (req.headers.get("Authorization") ?? "").trim()
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : ""
}

/** service_role は値の完全一致だけを許可する。DBエラーから権限を推測しない。 */
function isServiceRoleAuthorized(req: Request): boolean {
  const bearer = bearerToken(req)
  if (!bearer) return false
  const sr = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim()
  return Boolean(sr && constantTimeEqual(bearer, sr))
}

// 定数時間比較（秘密トークン照合用・タイミング差で内容を漏らさない）
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ba = enc.encode(a)
  const bb = enc.encode(b)
  if (ba.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i]
  return diff === 0
}

async function isAuthorized(req: Request): Promise<boolean> {
  if (isServiceRoleAuthorized(req)) return true
  const syncSecret = (Deno.env.get("RECEIPT_SHEETS_SYNC_SECRET") ?? "").trim()
  const bearer = bearerToken(req)
  const headerKey = (req.headers.get("x-receipt-sheets-sync-key") ?? "").trim()
  if (syncSecret && (constantTimeEqual(bearer, syncSecret) || constantTimeEqual(headerKey, syncSecret))) return true

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim()
  const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim()
  if (!supabaseUrl || !serviceRoleKey) return false
  const supabase = createClient(supabaseUrl, serviceRoleKey)
  return await isInternalCronAuthorized(req, supabase)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  })
}
