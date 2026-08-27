/**
 * M-talk 店舗ルームの日次売上Excel取込。
 * 投入先はルームの店舗Botで決まり、ファイル記載の店舗と食い違うときは
 * 取り込まずに「一致しない」ことだけを返信する、という分岐を検証する。
 */
import {
  isDailySalesTemplateRequestText,
  isDailySalesWorkbookName,
  processMtalkDailySalesFile,
  replyDailySalesTemplateDownload,
} from "../supabase/functions/_shared/mtalk_daily_sales_import.ts"

function assertEquals(actual: unknown, expected: unknown, label = ""): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`assertEquals failed ${label}\nactual: ${a}\nexpected: ${e}`)
}

const templateBytes = await Deno.readFile(
  new URL("./fixtures/daily_sales_template.xlsx", import.meta.url),
)

type Inserted = { table: string; row: Record<string, unknown> }

/**
 * 取込に必要な最小限のSupabaseスタブ。
 * insert された行を記録して、返信内容と登録の有無を確認する。
 */
function makeStub(options: { existingCount?: number; bytes?: Uint8Array } = {}) {
  const inserted: Inserted[] = []
  const deleted: string[] = []
  const bytes = options.bytes ?? templateBytes

  const builder = (table: string) => {
    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      in: () => api,
      is: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: () => {
        if (table === "store_webhook_tables") {
          return Promise.resolve({
            data: { receipt_table: "line_receipt__bistrocavacava", display_name: "ビストロ サヴァサヴァ" },
            error: null,
          })
        }
        if (table === "chat_users") {
          return Promise.resolve({ data: { id: "bot", username: "店舗Bot" }, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
      single: () => Promise.resolve({ data: { id: 1 }, error: null }),
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, row })
        return {
          select: () => ({ single: () => Promise.resolve({ data: { id: 1 }, error: null }) }),
          then: (resolve: (v: unknown) => void) => resolve({ error: null }),
        }
      },
      update: () => api,
      delete: () => {
        deleted.push(table)
        return api
      },
    }
    // countExistingReceiptsForDates は select(..., {count}) の結果を await する。
    ;(api as { then?: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve({ count: options.existingCount ?? 0, error: null, data: [] })
    return api
  }

  const supabase = {
    from: (table: string) => builder(table),
    storage: {
      from: () => ({
        download: () =>
          Promise.resolve({
            data: { arrayBuffer: () => Promise.resolve(bytes.buffer), type: "application/vnd.ms-excel" },
            error: null,
          }),
      }),
    },
  }
  return { supabase, inserted, deleted }
}

function postedText(inserted: Inserted[]): string {
  return inserted
    .filter((row) => row.table === "chat_messages")
    .map((row) => String(row.row.content ?? ""))
    .join("\n---\n")
}

Deno.test("Excel/CSVだけを日次売上ファイルとして扱う", () => {
  for (const name of ["日別売上管理表.xlsx", "sales.XLSX", "a.xls", "b.csv"]) {
    assertEquals(isDailySalesWorkbookName(name), true, name)
  }
  for (const name of ["journal.lzh", "photo.jpg", "memo.pdf", ""]) {
    assertEquals(isDailySalesWorkbookName(name), false, name)
  }
})

Deno.test("配布テンプレートは見本店舗(marugo)のまま配られる", async () => {
  const { parseMonthlyDailySalesWorkbook } = await import(
    "../supabase/functions/_shared/daily_sales_import.ts"
  )
  const parsed = parseMonthlyDailySalesWorkbook(templateBytes, "日別売上管理表.xlsx")
  // C3の店舗キーが見本のまま入っている＝直し忘れると他店へ入りうる、という前提の確認。
  assertEquals(parsed.store_key, "marugo", "template store_key")
  assertEquals(parsed.store_name, "マルゴ", "template store_name")
})

Deno.test("ルームの店舗と一致しないファイルは取り込まず、一致しないことを返信する", async () => {
  const { supabase, inserted, deleted } = makeStub()
  // ファイルは marugo、ルームは bistrocavacava。
  const result = await processMtalkDailySalesFile(supabase, {
    groupId: 12,
    storeKey: "bistrocavacava",
    path: "files/x.xlsx",
    fileName: "日別売上管理表.xlsx",
    asUser: { id: "bot", username: "店舗Bot" },
  })

  assertEquals(result.handled, true, "handled")
  assertEquals(result.reason, "store_mismatch", "reason")

  const text = postedText(inserted)
  for (const expected of ["一致しない", "マルゴ", "marugo", "bistrocavacava"]) {
    if (!text.includes(expected)) {
      throw new Error(`不一致の返信に ${expected} がありません:\n${text}`)
    }
  }
  // 売上テーブルへは一切書かない。
  if (deleted.some((t) => t.startsWith("line_receipt__"))) {
    throw new Error("店舗不一致なのに既存レシートを削除しています")
  }
  if (inserted.some((row) => row.table.startsWith("line_receipt__"))) {
    throw new Error("店舗不一致なのに売上を登録しています")
  }
  if (inserted.some((row) => row.table === "pending_daily_sales_imports")) {
    throw new Error("店舗不一致は確認待ちにせず、その場で断ること")
  }
})

Deno.test("店舗が一致しても金額未入力なら登録せず、入力場所を案内する", async () => {
  const { supabase, inserted, deleted } = makeStub()
  // テンプレートの店舗キー(marugo)と同じルームなら店舗は一致するが、金額が空。
  const result = await processMtalkDailySalesFile(supabase, {
    groupId: 12,
    storeKey: "marugo",
    path: "files/x.xlsx",
    fileName: "日別売上管理表.xlsx",
    asUser: { id: "bot", username: "店舗Bot" },
  })

  assertEquals(result.handled, true, "handled")
  assertEquals(result.reason, "daily_sales_empty", "reason")
  const text = postedText(inserted)
  if (!text.includes("登録対象の売上がありません")) {
    throw new Error(`未入力の案内が返っていません:\n${text}`)
  }
  if (deleted.some((t) => t.startsWith("line_receipt__"))) {
    throw new Error("金額未入力なのに既存レシートを削除しています")
  }
})

Deno.test("テンプレートを求める発言を、LINE版と同じ言葉で判定する", () => {
  for (
    const text of [
      "日別売上管理表",
      "月次日別売上管理表",
      "売上管理表テンプレート",
      "excelテンプレート",
      "売上のフォーマットください",
      "日別のひな形ほしい",
    ]
  ) {
    assertEquals(isDailySalesTemplateRequestText(text), true, text)
  }
  for (
    const text of [
      "売上登録のやり方",
      "テンプレート",
      "フォーマット",
      "",
      "予算登録",
    ]
  ) {
    assertEquals(isDailySalesTemplateRequestText(text), false, text)
  }
})

Deno.test("M-talkの店舗ルームでテンプレートを求めると、ダウンロードリンク付きカードを返す", async () => {
  const { supabase, inserted } = makeStub()
  await replyDailySalesTemplateDownload(supabase, {
    groupId: 12,
    storeKey: "bistrocavacava",
    asUser: { id: "bot", username: "店舗Bot" },
  })
  const text = postedText(inserted)
  if (!text.includes("ダウンロード")) {
    throw new Error(`テンプレート案内にダウンロードURLがありません:\n${text}`)
  }
  if (!text.includes("line-webhook/bistrocavacava?download=daily_sales_management_xlsx")) {
    throw new Error(`URLがline-webhookの配布経路と一致しません:\n${text}`)
  }
  const card = inserted.find((row) => row.table === "chat_messages")?.row.payload as
    | { cards?: Array<{ action?: { url?: string } }> }
    | undefined
  const actionUrl = card?.cards?.[0]?.action?.url ?? ""
  if (!actionUrl.includes("download=daily_sales_management_xlsx")) {
    throw new Error(`カードのボタンURLにテンプレートキーがありません: ${actionUrl}`)
  }
})

Deno.test("日次売上ファイルでないExcelは取込対象にせず、添付として残す", async () => {
  // 売上管理表の体裁を持たないファイル（解析で店舗も期間も取れない）。
  const notSales = new TextEncoder().encode("col1,col2\n1,2\n")
  const { supabase, inserted } = makeStub({ bytes: notSales })
  const result = await processMtalkDailySalesFile(supabase, {
    groupId: 12,
    storeKey: "bistrocavacava",
    path: "files/x.csv",
    fileName: "memo.csv",
    asUser: { id: "bot", username: "店舗Bot" },
  })

  assertEquals(result.handled, false, "handled")
  assertEquals(result.reason, "not_daily_sales_file", "reason")
  assertEquals(postedText(inserted), "", "返信しない")
})
