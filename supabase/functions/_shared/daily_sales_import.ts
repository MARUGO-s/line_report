// 月次日別売上管理表（Excel .xlsx / CSV）の解析と、「画像解析レシートと同等」での日次売上登録を行う共通モジュール。
// admin-api（管理画面のドラッグ&ドロップ取込）と line-webhook（LINEへのファイルアップロード取込）の両方から使う。
import * as XLSX from "https://esm.sh/xlsx@0.18.5"
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"
import { upsertManualMonthSalesEntries } from "./manual_month_sales.ts"

export type DailySalesImportEntry = {
  sales_date: string
  gross_sales_yen: number
  party_count: number | null
  guest_count: number | null
}

export type ManualMonthImportEntry = {
  sales_month: string
  gross_sales_yen: number
  tax_amount_yen: number | null
  net_sales_yen: number | null
  party_count: number | null
  guest_count: number | null
  operating_days_count: number | null
}

export type DailySalesParseResult = {
  recognized: boolean // 「総売上」列＋日付が取れ、日次売上ファイルと判定できたか
  import_mode: "daily" | "manual_month"
  store_name: string | null
  store_key: string | null // 新テンプレ C3 の店舗キー（あれば登録時の照合に最優先で使う）
  period: string | null
  manual_month_entry: ManualMonthImportEntry | null
  entries: DailySalesImportEntry[]
  covered_dates: string[] // ファイルに日付行として載っている全日付（総売上0=休業の日も含む）。期間まるごと置換に使う。
  day_count: number
  total_gross_yen: number
  skipped_zero_count: number
  warnings: string[]
  error: string | null
}

// 先頭が ZIP シグネチャ(PK\x03\x04)なら xlsx、それ以外は CSV とみなす。
function importLooksLikeCsv(buf: Uint8Array): boolean {
  return !(buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b)
}

// 引用符対応の最小 CSV パーサ（"171,200" のようなカンマ入り数値も扱える）。
function parseImportCsvCells(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let inQuotes = false
  const s = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++ } else inQuotes = false
      } else cell += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ",") {
      row.push(cell); cell = ""
    } else if (ch === "\n") {
      row.push(cell); rows.push(row); row = []; cell = ""
    } else {
      cell += ch
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

// 日付セル（Date / "YYYY/MM/DD" / "YYYY-MM-DD" 等）→ "YYYY-MM-DD"。解釈不可なら null。
function parseImportDateCell(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // Excelの日付は「JSTの日付」として入る（テンプレ）。SheetJSはUTC基準のDateを返すため、
    // UTC抽出だと1日ズレる（例: JST 2025-06-01 → Date は 2025-05-31T15:00Z）。Asia/Tokyo で日付を取る。
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value)
    const pick = (t: string) => parts.find((x) => x.type === t)?.value ?? ""
    const y = pick("year"), m = pick("month"), d = pick("day")
    if (y && m && d) return `${y}-${m}-${d}`
    return null
  }
  const m = String(value).trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/)
  if (!m) return null
  return `${m[1]}-${String(Number(m[2])).padStart(2, "0")}-${String(Number(m[3])).padStart(2, "0")}`
}

function enumerateImportMonthDates(salesMonth: string): string[] {
  const m = String(salesMonth ?? "").trim().match(/^(\d{4})-(\d{2})$/)
  if (!m) return []
  const year = Number(m[1])
  const month = Number(m[2])
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return []
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return Array.from({ length: days }, (_, i) => `${m[1]}-${m[2]}-${String(i + 1).padStart(2, "0")}`)
}

// 数値セル（数値 / "171,200" / "¥171,200" 等）→ 整数。解釈不可なら null。
function parseImportNumber(value: unknown): number | null {
  if (value == null || value === "") return null
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null
  const s = String(value).replace(/[,，¥￥\s]/g, "").trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n) : null
}

// バイト列（xlsx/csv）を解析して日次売上 entries を返す。「総売上」列が取れなければ recognized=false（throw しない）。
// 採用は総売上。総売上が0以下の日（休業）はスキップ。同一日付は最後を採用。
export function parseMonthlyDailySalesWorkbook(bytes: Uint8Array, fileName: string): DailySalesParseResult {
  const fail = (error: string, extra: Partial<DailySalesParseResult> = {}): DailySalesParseResult => ({
    recognized: false,
    import_mode: "daily",
    store_name: null,
    store_key: null,
    period: null,
    manual_month_entry: null,
    entries: [],
    covered_dates: [],
    day_count: 0,
    total_gross_yen: 0,
    skipped_zero_count: 0,
    warnings: error ? [error] : [],
    error,
    ...extra,
  })
  try {
    if (!bytes || bytes.length === 0) return fail("空のファイルです。")
    if (bytes.length > 5 * 1024 * 1024) return fail("ファイルが大きすぎます（5MBまで）。")
    const name = String(fileName ?? "").toLowerCase()
    let rows: unknown[][]
    const isCsv = name.endsWith(".csv") ||
      (!name.endsWith(".xlsx") && !name.endsWith(".xls") && importLooksLikeCsv(bytes))
    if (isCsv) {
      rows = parseImportCsvCells(new TextDecoder("utf-8").decode(bytes)) as unknown[][]
    } else {
      const wb = XLSX.read(bytes, { type: "array", cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      if (!ws) return fail("シートが見つかりません。")
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][]
    }

    let storeName: string | null = null
    let storeKey: string | null = null
    let period: string | null = null
    let headerRowIdx = -1
    let dateCol = 0, grossCol = -1, taxCol = -1, guestCol = -1, partyCol = -1
    const looksLikeStoreKey = (s: string) => /^[a-z][a-z0-9_]{1,40}$/.test(s)
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] ?? []
      for (let c = 0; c < row.length; c++) {
        const v = String(row[c] ?? "").trim()
        if (!v) continue
        if (v.includes("対象店舗")) {
          // 店名: 同セルのコロン後ろ（旧形式）or 右隣セル（新テンプレ B3）
          const afterColon = (v.split(/[：:]/)[1] ?? "").trim()
          storeName = afterColon || String(row[c + 1] ?? "").trim() || storeName
          // 店舗キー: 右側の「英小文字始まりの英数字」セル（新テンプレ C3 = 例 marugosecond）
          for (let k = c + 1; k < row.length; k++) {
            const cand = String(row[k] ?? "").trim()
            if (looksLikeStoreKey(cand)) { storeKey = cand; break }
          }
        } else if (v.includes("対象期間")) {
          // 期間: コロン後ろ（旧）or 右隣セル（新 B2 = 例 202506）。YYYYMM6桁は YYYY-MM に整形。
          const afterColon = (v.split(/[：:]/)[1] ?? "").trim()
          const raw = afterColon || String(row[c + 1] ?? "").trim()
          period = /^\d{6}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}` : (raw || period)
        }
        // ヘッダ: 「総売上(税込）」など接尾辞付きにも対応するため部分一致。
        if (v.includes("総売上")) { grossCol = c; headerRowIdx = r }
        else if (v.includes("消費税")) taxCol = c
        else if (v.includes("客数")) guestCol = c
        else if (v.includes("組数")) partyCol = c
        else if (v.includes("日付")) dateCol = c
      }
    }
    if (grossCol < 0) {
      return fail("「総売上」列が見つかりませんでした（月次日別売上管理表ではないようです）。", { store_name: storeName, store_key: storeKey, period })
    }

    const collected: DailySalesImportEntry[] = []
    const coveredDateSet = new Set<string>() // 総売上0(休業)の日も含め、日付行として認識できた全日付
    let manualMonthEntry: ManualMonthImportEntry | null = null
    let positiveDailyGrossBeforeManualRow = 0
    let skippedZero = 0
    const startIdx = headerRowIdx >= 0 ? headerRowIdx + 1 : 0
    for (let r = startIdx; r < rows.length; r++) {
      const row = rows[r] ?? []
      const label = String(row[dateCol] ?? "").trim()
      if (label.includes("合計だけ入力")) {
        const gross = parseImportNumber(row[grossCol])
        if (gross != null && gross > 0 && period && /^\d{4}-\d{2}$/.test(period)) {
          const nextRows = rows.slice(r + 1, Math.min(rows.length, r + 4))
          const totalRow = nextRows.find((candidate) => {
            const totalLabel = String((candidate ?? [])[dateCol] ?? "").trim()
            return totalLabel === "合計" || totalLabel.includes("合計")
          }) ?? []
          const totalGross = parseImportNumber(totalRow[grossCol])
          const totalRowExists = totalRow.length > 0
          const computedTotalGross = positiveDailyGrossBeforeManualRow + gross
          // Excel/Numbersで再計算されていないファイルは、B38のキャッシュが古いことがある。
          // その場合でも、日別売上が空で「合計だけ入力」だけなら B38 は B37 と同額になるため月合計として扱う。
          if (totalRowExists && (totalGross === gross || (positiveDailyGrossBeforeManualRow === 0 && computedTotalGross === gross))) {
            const tax = taxCol >= 0 ? parseImportNumber(row[taxCol]) : null
            manualMonthEntry = {
              sales_month: period,
              gross_sales_yen: gross,
              tax_amount_yen: tax,
              net_sales_yen: tax != null ? Math.max(0, gross - tax) : null,
              party_count: partyCol >= 0 ? parseImportNumber(row[partyCol]) : null,
              guest_count: guestCol >= 0 ? parseImportNumber(row[guestCol]) : null,
              operating_days_count: coveredDateSet.size > 0 ? coveredDateSet.size : null,
            }
          }
        }
        continue
      }
      const iso = parseImportDateCell(row[dateCol])
      if (!iso) continue // 合計行・空行などはスキップ
      coveredDateSet.add(iso) // 0の日も「対象日」に含める（期間まるごと置換のため）
      const gross = parseImportNumber(row[grossCol])
      if (gross == null || gross <= 0) { skippedZero++; continue } // 休業日(総売上0)はスキップ
      positiveDailyGrossBeforeManualRow += gross
      collected.push({
        sales_date: iso,
        gross_sales_yen: gross,
        guest_count: guestCol >= 0 ? parseImportNumber(row[guestCol]) : null,
        party_count: partyCol >= 0 ? parseImportNumber(row[partyCol]) : null,
      })
    }

    const byDate = new Map<string, DailySalesImportEntry>()
    for (const e of collected) byDate.set(e.sales_date, e)
    const entries = [...byDate.values()].sort((a, b) => a.sales_date.localeCompare(b.sales_date))
    const totalGross = entries.reduce((s, e) => s + e.gross_sales_yen, 0)
    const coveredDates = [...coveredDateSet].sort((a, b) => a.localeCompare(b))

    const warnings: string[] = []
    if (!storeName) warnings.push("対象店舗が読み取れませんでした。")
    if (entries.length === 0 && !manualMonthEntry) warnings.push("総売上が1円以上の日が見つかりませんでした。")

    if (manualMonthEntry) {
      const manualCoveredDates = coveredDates.length > 0
        ? coveredDates
        : enumerateImportMonthDates(manualMonthEntry.sales_month)
      return {
        recognized: true,
        import_mode: "manual_month",
        store_name: storeName,
        store_key: storeKey,
        period,
        manual_month_entry: manualMonthEntry,
        entries: [],
        covered_dates: manualCoveredDates,
        day_count: 0,
        total_gross_yen: manualMonthEntry.gross_sales_yen,
        skipped_zero_count: skippedZero,
        warnings,
        error: null,
      }
    }

    return {
      recognized: entries.length > 0,
      import_mode: "daily",
      store_name: storeName,
      store_key: storeKey,
      period,
      manual_month_entry: null,
      entries,
      covered_dates: coveredDates,
      day_count: entries.length,
      total_gross_yen: totalGross,
      skipped_zero_count: skippedZero,
      warnings,
      error: entries.length === 0 ? "登録対象の日がありません。" : null,
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

export async function importManualMonthSalesOverwrite(
  supabase: SupabaseClient,
  storeKey: string,
  entry: ManualMonthImportEntry,
  coveredDates: string[] = [],
): Promise<{ ok: boolean; applied: number; cleared_dates: number; receipt_table: string; cleared_manual_day: number; store_partition_key: string; sales_month: string }> {
  const resolved = await resolveReceiptTableForStore(supabase, storeKey)
  if (!resolved) {
    throw { status: 400, message: "店舗が見つかりません（store_key）。" }
  }
  const key = String(storeKey ?? "").trim().toLowerCase()
  const salesMonth = String(entry.sales_month ?? "").trim().slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(salesMonth)) {
    throw { status: 400, message: "対象月が不正です。" }
  }
  const gross = parseImportNumber(entry.gross_sales_yen)
  if (gross == null || gross <= 0) {
    throw { status: 400, message: "月合計の総売上が不正です。" }
  }

  const isIsoDate = (d: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(d ?? "").trim().slice(0, 10))
  const sourceDates = coveredDates.length > 0 ? coveredDates : enumerateImportMonthDates(salesMonth)
  const clearDates = [...new Set(
    sourceDates
      .map((d) => String(d ?? "").trim().slice(0, 10))
      .filter((d) => isIsoDate(d) && d.slice(0, 7) === salesMonth),
  )]

  if (clearDates.length > 0) {
    const { error: delRcpErr } = await supabase.from(resolved.receiptTable).delete().in("receipt_date", clearDates)
    if (delRcpErr) {
      throw { status: 500, message: `既存レシートのクリアに失敗しました: ${delRcpErr.message}` }
    }
  }

  let clearedManualDay = 0
  if (clearDates.length > 0) {
    try {
      const { error: delErr, count } = await supabase
        .from("line_sales_manual_day")
        .delete({ count: "exact" })
        .eq("store_partition_key", key)
        .in("sales_date", clearDates)
      if (!delErr && typeof count === "number") clearedManualDay = count
    } catch (_e) {
      // 古い環境では line_sales_manual_day が無い可能性があるため、月次登録自体は継続する。
    }
  }

  await upsertManualMonthSalesEntries(supabase, key, [{
    sales_month: salesMonth,
    gross_sales_yen: gross,
    tax_amount_yen: entry.tax_amount_yen,
    net_sales_yen: entry.net_sales_yen,
    party_count: entry.party_count,
    guest_count: entry.guest_count,
    operating_days_count: entry.operating_days_count,
  }])

  return {
    ok: true,
    applied: 1,
    cleared_dates: clearDates.length,
    receipt_table: resolved.receiptTable,
    cleared_manual_day: clearedManualDay,
    store_partition_key: key,
    sales_month: salesMonth,
  }
}

// 「月別売上の手入力」画面から、対象月に実際に登録されている売上データ（Excel一括取込・画像解析レシート等の
// 日別レシート／日別手入力上書き／月合計手入力）をまとめて削除する＝その月を未登録の状態に戻す。
export async function clearDailyReceiptsForMonth(
  supabase: SupabaseClient,
  storeKey: string,
  salesMonth: string,
): Promise<{
  ok: boolean
  cleared_dates: number
  cleared_receipts: number
  cleared_manual_day: number
  receipt_table: string
  store_partition_key: string
  sales_month: string
}> {
  const resolved = await resolveReceiptTableForStore(supabase, storeKey)
  if (!resolved) {
    throw { status: 400, message: "店舗が見つかりません（store_key）。" }
  }
  const key = String(storeKey ?? "").trim().toLowerCase()
  const salesMonthNorm = String(salesMonth ?? "").trim().slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(salesMonthNorm)) {
    throw { status: 400, message: "対象月が不正です。" }
  }
  const clearDates = enumerateImportMonthDates(salesMonthNorm)
  if (clearDates.length === 0) {
    return {
      ok: true,
      cleared_dates: 0,
      cleared_receipts: 0,
      cleared_manual_day: 0,
      receipt_table: resolved.receiptTable,
      store_partition_key: key,
      sales_month: salesMonthNorm,
    }
  }

  const { error: delRcpErr, count: receiptCount } = await supabase
    .from(resolved.receiptTable)
    .delete({ count: "exact" })
    .in("receipt_date", clearDates)
  if (delRcpErr) {
    throw { status: 500, message: `レシートの削除に失敗しました: ${delRcpErr.message}` }
  }

  let clearedManualDay = 0
  try {
    const { error: delErr, count } = await supabase
      .from("line_sales_manual_day")
      .delete({ count: "exact" })
      .eq("store_partition_key", key)
      .in("sales_date", clearDates)
    if (!delErr && typeof count === "number") clearedManualDay = count
  } catch (_e) {
    // 古い環境では line_sales_manual_day が無い可能性があるため、削除自体は継続する。
  }

  // 月合計の手入力（あれば）も一緒に解除し、その月を完全に未登録状態へ戻す。
  await upsertManualMonthSalesEntries(supabase, key, [{
    sales_month: salesMonthNorm,
    gross_sales_yen: null,
  }])

  return {
    ok: true,
    cleared_dates: clearDates.length,
    cleared_receipts: typeof receiptCount === "number" ? receiptCount : 0,
    cleared_manual_day: clearedManualDay,
    receipt_table: resolved.receiptTable,
    store_partition_key: key,
    sales_month: salesMonthNorm,
  }
}

// 店舗キー → レシートテーブル名・表示名（store_webhook_tables から。存在確認も兼ねる）。
export async function resolveReceiptTableForStore(
  supabase: SupabaseClient,
  storeKey: string,
): Promise<{ receiptTable: string; storeDisplay: string } | null> {
  const key = String(storeKey ?? "").trim().toLowerCase()
  if (!key || key === "__all__") return null
  const { data, error } = await supabase
    .from("store_webhook_tables")
    .select("receipt_table, display_name")
    .eq("store_partition_key", key)
    .maybeSingle()
  if (error) return null
  const receiptTable = String((data as { receipt_table?: string } | null)?.receipt_table ?? "") || `line_receipt__${key}`
  const storeDisplay = String((data as { display_name?: string } | null)?.display_name ?? "") || key
  return { receiptTable, storeDisplay }
}

// 指定店舗のレシートテーブルに、対象日付のレシートが既に何件あるか（重複検出用）。
export async function countExistingReceiptsForDates(
  supabase: SupabaseClient,
  receiptTable: string,
  dates: string[],
): Promise<number> {
  const uniq = [...new Set(dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))]
  if (uniq.length === 0) return 0
  const { count, error } = await supabase
    .from(receiptTable)
    .select("id", { count: "exact", head: true })
    .in("receipt_date", uniq)
  if (error) return 0
  return typeof count === "number" ? count : 0
}

// 解析した日次売上を「画像解析レシートと同等」に登録（期間まるごと置換方式）。
// coveredDates（ファイルに載っていた全日付＝総売上0の休業日も含む）の既存レシートを delete してから、
// 売上のある日（entries）だけ合成レシートを insert する。これにより「0にした日＝売上なし」も正しく反映され、
// 以前のデータが残らない。ファイルに載っていない日は触らない。同じ日の手入力上書き(manual_day)も削除。
export async function importDailyReceiptsOverwrite(
  supabase: SupabaseClient,
  storeKey: string,
  entries: DailySalesImportEntry[],
  coveredDates: string[] = [],
): Promise<{ ok: boolean; applied: number; cleared_dates: number; receipt_table: string; cleared_manual_day: number; store_partition_key: string }> {
  const resolved = await resolveReceiptTableForStore(supabase, storeKey)
  if (!resolved) {
    throw { status: 400, message: "店舗が見つかりません（store_key）。" }
  }
  const key = String(storeKey ?? "").trim().toLowerCase()
  const { receiptTable, storeDisplay } = resolved
  const isIsoDate = (d: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(d ?? "").trim().slice(0, 10))

  const rows: Array<Record<string, unknown>> = []
  const dates: string[] = []
  for (const e of entries) {
    const salesDate = String(e?.sales_date ?? "").trim().slice(0, 10)
    if (!isIsoDate(salesDate)) continue
    const gross = parseImportNumber(e?.gross_sales_yen)
    if (gross == null || gross <= 0) continue
    const party = parseImportNumber(e?.party_count)
    const guest = parseImportNumber(e?.guest_count)
    rows.push({
      line_message_id: `xlsx-import:${key}:${salesDate}`,
      room_id: "xlsx-import",
      store_name: storeDisplay,
      receipt_date_text: salesDate,
      receipt_date: salesDate,
      gross_sales_yen: gross,
      party_count: party,
      guest_count: guest,
      summary_text: "Excel一括取込（総売上）",
      raw_payload: { source: "xlsx-import", sales_date: salesDate, gross_sales_yen: gross, party_count: party, guest_count: guest },
    })
    dates.push(salesDate)
  }

  // クリア対象 = ファイルに載っていた全日付(0含む) ∪ 登録する日。coveredDates 未指定なら entries の日のみ（後方互換）。
  const clearDates = [...new Set([
    ...coveredDates.map((d) => String(d ?? "").trim().slice(0, 10)).filter(isIsoDate),
    ...dates,
  ])]
  if (clearDates.length === 0) {
    return { ok: true, applied: 0, cleared_dates: 0, receipt_table: receiptTable, cleared_manual_day: 0, store_partition_key: key }
  }

  // 1) 対象日（0の日も含む）の既存レシートを全消し
  const { error: delRcpErr } = await supabase.from(receiptTable).delete().in("receipt_date", clearDates)
  if (delRcpErr) {
    throw { status: 500, message: `既存レシートのクリアに失敗しました: ${delRcpErr.message}` }
  }
  // 2) 売上のある日だけ登録（0の日は登録しない＝売上なし）
  if (rows.length > 0) {
    const { error: insErr } = await supabase.from(receiptTable).insert(rows)
    if (insErr) {
      throw { status: 500, message: `レシート登録に失敗しました: ${insErr.message}` }
    }
  }

  // 3) 同じ日の手入力上書き(manual_day)も対象日ぶんクリア
  let clearedManualDay = 0
  try {
    const { error: delErr, count } = await supabase
      .from("line_sales_manual_day")
      .delete({ count: "exact" })
      .eq("store_partition_key", key)
      .in("sales_date", clearDates)
    if (!delErr && typeof count === "number") clearedManualDay = count
  } catch (_e) { /* best-effort */ }

  return { ok: true, applied: rows.length, cleared_dates: clearDates.length, receipt_table: receiptTable, cleared_manual_day: clearedManualDay, store_partition_key: key }
}
