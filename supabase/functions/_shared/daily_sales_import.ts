// 月次日別売上管理表（Excel .xlsx / CSV）の解析と、「画像解析レシートと同等」での日次売上登録を行う共通モジュール。
// admin-api（管理画面のドラッグ&ドロップ取込）と line-webhook（LINEへのファイルアップロード取込）の両方から使う。
import * as XLSX from "https://esm.sh/xlsx@0.18.5"
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.0"

export type DailySalesImportEntry = {
  sales_date: string
  gross_sales_yen: number
  party_count: number | null
  guest_count: number | null
}

export type DailySalesParseResult = {
  recognized: boolean // 「総売上」列＋日付が取れ、日次売上ファイルと判定できたか
  store_name: string | null
  period: string | null
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
    const y = value.getUTCFullYear(), m = value.getUTCMonth() + 1, d = value.getUTCDate()
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  }
  const m = String(value).trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/)
  if (!m) return null
  return `${m[1]}-${String(Number(m[2])).padStart(2, "0")}-${String(Number(m[3])).padStart(2, "0")}`
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
    store_name: null,
    period: null,
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
    let period: string | null = null
    let headerRowIdx = -1
    let dateCol = 0, grossCol = -1, guestCol = -1, partyCol = -1
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] ?? []
      for (let c = 0; c < row.length; c++) {
        const v = String(row[c] ?? "").trim()
        if (!v) continue
        if (v.includes("対象店舗")) storeName = (v.split(/[：:]/)[1] ?? "").trim() || storeName
        else if (v.includes("対象期間")) period = (v.split(/[：:]/)[1] ?? "").trim() || period
        if (v === "総売上") { grossCol = c; headerRowIdx = r }
        else if (v === "客数") guestCol = c
        else if (v === "組数") partyCol = c
        else if (v === "日付") dateCol = c
      }
    }
    if (grossCol < 0) {
      return fail("「総売上」列が見つかりませんでした（月次日別売上管理表ではないようです）。", { store_name: storeName, period })
    }

    const collected: DailySalesImportEntry[] = []
    const coveredDateSet = new Set<string>() // 総売上0(休業)の日も含め、日付行として認識できた全日付
    let skippedZero = 0
    const startIdx = headerRowIdx >= 0 ? headerRowIdx + 1 : 0
    for (let r = startIdx; r < rows.length; r++) {
      const row = rows[r] ?? []
      const iso = parseImportDateCell(row[dateCol])
      if (!iso) continue // 合計行・空行などはスキップ
      coveredDateSet.add(iso) // 0の日も「対象日」に含める（期間まるごと置換のため）
      const gross = parseImportNumber(row[grossCol])
      if (gross == null || gross <= 0) { skippedZero++; continue } // 休業日(総売上0)はスキップ
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
    if (entries.length === 0) warnings.push("総売上が1円以上の日が見つかりませんでした。")

    return {
      recognized: entries.length > 0,
      store_name: storeName,
      period,
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
