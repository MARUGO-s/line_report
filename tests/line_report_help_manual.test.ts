import {
  buildLineReportHelpIndex,
  isLineReportHelpQuestion,
  LINE_REPORT_HELP_CATEGORIES,
  LINE_REPORT_HELP_SECTIONS,
  renderLineReportHelpManualMarkdown,
  selectLineReportHelpSections,
} from "../supabase/functions/_shared/line_report_help_manual.ts"
import {
  buildMtalkHelpReference,
  isMtalkHelpQuestion,
} from "../supabase/functions/_shared/mtalk_help_manual.ts"
import { buildCasualSystemPrompt } from "../supabase/functions/_shared/mtalk_casual_chat.ts"

function assertEquals(actual: unknown, expected: unknown, label = ""): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`assertEquals failed ${label}\nactual: ${a}\nexpected: ${e}`)
}

Deno.test("統合資料は区分・項目ID・索引コードが重複せず全項目が分類される", () => {
  assertEquals(LINE_REPORT_HELP_CATEGORIES.length, 11, "major category count")
  assertEquals(LINE_REPORT_HELP_SECTIONS.length, 32, "indexed section count")
  const categoryIds = LINE_REPORT_HELP_CATEGORIES.map((category) => category.id)
  const sectionIds = LINE_REPORT_HELP_SECTIONS.map((section) => section.id)
  const sectionCodes = LINE_REPORT_HELP_SECTIONS.map((section) => section.code)
  assertEquals(new Set(categoryIds).size, categoryIds.length, "category id unique")
  assertEquals(new Set(sectionIds).size, sectionIds.length, "section id unique")
  assertEquals(new Set(sectionCodes).size, sectionCodes.length, "section code unique")

  for (const category of LINE_REPORT_HELP_CATEGORIES) {
    const sections = LINE_REPORT_HELP_SECTIONS.filter((section) => section.categoryId === category.id)
    if (!sections.length) throw new Error(`区分 ${category.id} に項目がありません`)
  }
  for (const section of LINE_REPORT_HELP_SECTIONS) {
    if (!LINE_REPORT_HELP_CATEGORIES.some((category) => category.id === section.categoryId)) {
      throw new Error(`項目 ${section.code} の区分 ${section.categoryId} が存在しません`)
    }
    if (!section.summary.trim() || !section.content.trim() || section.keywords.length < 3) {
      throw new Error(`項目 ${section.code} の概要・本文・キーワードが不足しています`)
    }
  }
})

Deno.test("区分索引は全カテゴリと全項目コードを含む", () => {
  const index = buildLineReportHelpIndex()
  for (const category of LINE_REPORT_HELP_CATEGORIES) {
    if (!index.includes(`【${category.code} ${category.title}】`)) {
      throw new Error(`索引に区分 ${category.code} がありません`)
    }
  }
  for (const section of LINE_REPORT_HELP_SECTIONS) {
    if (!index.includes(`${section.code} ${section.title}`)) {
      throw new Error(`索引に項目 ${section.code} がありません`)
    }
  }
})

Deno.test("人間向け統合マニュアルは実行時資料から生成され、差分がない", async () => {
  const actual = await Deno.readTextFile(
    new URL("../docs/LINE-REPORT-JOURNAL-AI-MANUAL.md", import.meta.url),
  )
  assertEquals(actual, renderLineReportHelpManualMarkdown())
})

Deno.test("代表的な質問を正しいLINE Report／Journal Report項目へ振り分ける", () => {
  const cases = [
    ["LINE ReportとJournal Reportの違いは？", "ecosystem-overview"],
    ["予算登録と6桁の売上照会は何が違う？", "budget-sales-query"],
    ["予約スクショで電話番号がないと予約回数はどうなる？", "reservation-flow"],
    ["画像をJournalの資料へ#メモで登録する方法", "journal-line-memo"],
    ["商品コード0023の2026年の売れ行きはどう調べる？", "journal-product-course"],
    ["Journal Reportで予測のMAPEを見る場所は？", "journal-reservations-forecast"],
    ["小口現金で内税と外税をどう使う？", "petty-cash"],
    ["フードコートの来客予測はどう学習する？", "foodcourt-forecast-evolution"],
    ["フードコート日報の動員数はどこへ反映される？", "foodcourt-daily-weekly"],
    ["自店舗のGoogle口コミを更新したい", "store-reviews"],
    ["周辺競合の口コミと競合圧力について教えて", "competitor-reviews"],
    ["AI使用料とシステムマップは誰が見られる？", "ai-usage-system-map"],
  ] as const

  for (const [question, expectedId] of cases) {
    const selected = selectLineReportHelpSections(question, 4)
    if (!selected.some((entry) => entry.section.id === expectedId)) {
      throw new Error(
        `${question}\nexpected: ${expectedId}\nactual: ${selected.map((entry) => entry.section.id).join(", ")}`,
      )
    }
  }
})

Deno.test("LINE Report／Journal Reportの質問は統合マニュアル対象になる", () => {
  for (
    const question of [
      "LINE Reportでは何ができますか",
      "Journal ReportへLZHを入れる方法",
      "売上レシートを修正したい",
      "AIチャットと標準AI分析の違いは？",
      "資料タブの数字は売上の正本ですか",
      "フードコートの週次報告はどこですか",
      "自店舗口コミと競合口コミの違いは？",
      "システムマップでは何が見られますか",
    ]
  ) {
    assertEquals(isLineReportHelpQuestion(question), true, question)
    assertEquals(isMtalkHelpQuestion(question), true, `integrated: ${question}`)
  }
})

Deno.test("統合参照は区分索引と質問に関連する詳細を含み、通常例では途中切れしない", () => {
  const cases = [
    ["予算登録と売上照会の違い", ["LINE Report / Journal Report 区分索引", "SAL-04", "必ず最初に「予算登録」"]],
    ["Journal Reportの商品コード下4桁について", ["JAI-03", "0023年と誤解", "別名履歴"]],
    ["LINEの予約スクショの仕組み", ["RSV-01", "氏名と電話", "予約回数"]],
    ["Journalの資料と#メモの違い", ["KNW-01", "KNW-02", "金額の正本にはしません"]],
  ] as const

  for (const [question, expectedParts] of cases) {
    const reference = buildMtalkHelpReference(question)
    if (reference.endsWith("…")) throw new Error(`${question}: 参照資料が途中で切れました`)
    for (const expected of expectedParts) {
      if (!reference.includes(expected)) {
        throw new Error(`${question}: 参照資料に ${expected} がありません`)
      }
    }
  }
})

Deno.test("回答指示は正確な根拠と簡潔さを両立し、索引をそのまま読み上げない", () => {
  const system = buildCasualSystemPrompt({
    storeName: "テスト店",
    question: "LINE ReportとJournal Reportの違いを教えて",
  })
  for (
    const required of [
      "統合マニュアルだけを正しい根拠",
      "最初に結論を1〜2文",
      "関係のない機能や索引全体を回答へ並べない",
      "入口・データの正本・用途の違いを明確に分けて",
      "マニュアルに書かれていない機能・場所・手順は推測で作らず",
    ]
  ) {
    if (!system.includes(required)) throw new Error(`回答指示に「${required}」がありません`)
  }
})

Deno.test("店舗の実数値は統合資料で推測せずJournal AIへ案内する", () => {
  const system = buildCasualSystemPrompt({
    storeName: "テスト店",
    question: "先月の客数と客単価を教えて",
  })
  if (
    !system.includes("店舗の実データに基づく具体的な数字には絶対に答えないでください") ||
    !system.includes("「ジャーナルに聞く」を開いて確認してください")
  ) {
    throw new Error("実数値を推測しない安全境界がありません")
  }
})
