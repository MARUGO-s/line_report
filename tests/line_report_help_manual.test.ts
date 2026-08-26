import {
  buildLineReportHelpIndex,
  isLineReportHelpQuestion,
  LINE_REPORT_HELP_CATEGORIES,
  LINE_REPORT_HELP_SECTION_SOURCES,
  LINE_REPORT_HELP_SECTIONS,
  lineReportHelpSourcesForCode,
  selectLineReportHelpSections,
  wantsLineReportImplementationDetails,
} from "../supabase/functions/_shared/line_report_help_manual.ts"
import {
  buildMtalkHelpReference,
  isMtalkHelpQuestion,
} from "../supabase/functions/_shared/mtalk_help_manual.ts"
import { buildCasualSystemPrompt } from "../supabase/functions/_shared/mtalk_casual_chat.ts"
import { buildLineReportHelpDocument } from "../scripts/generate-line-report-help-manual.ts"

function assertEquals(actual: unknown, expected: unknown, label = ""): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`assertEquals failed ${label}\nactual: ${a}\nexpected: ${e}`)
}

Deno.test("統合資料は区分・項目ID・索引コードが重複せず全項目が分類される", () => {
  assertEquals(LINE_REPORT_HELP_CATEGORIES.length, 12, "major category count")
  assertEquals(LINE_REPORT_HELP_SECTIONS.length, 45, "indexed section count")
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

Deno.test("全項目が実装根拠を持ち、参照先がリポジトリ内に存在する", async () => {
  const sectionCodes = new Set(LINE_REPORT_HELP_SECTIONS.map((section) => section.code))
  assertEquals(
    Object.keys(LINE_REPORT_HELP_SECTION_SOURCES).sort(),
    [...sectionCodes].sort(),
    "source-map codes match sections",
  )
  for (const section of LINE_REPORT_HELP_SECTIONS) {
    const sources = lineReportHelpSourcesForCode(section.code)
    if (!sources.length) throw new Error(`${section.code} に実装根拠がありません`)
    for (const source of sources) {
      try {
        await Deno.stat(new URL(`../${source}`, import.meta.url))
      } catch {
        throw new Error(`${section.code} の実装根拠が存在しません: ${source}`)
      }
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
  assertEquals(actual, await buildLineReportHelpDocument())
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
    ["売上の日次セルを手入力で直すコードは？", "manual-sales-sheets-prompts"],
    ["メディア画面へPDF文書をアップロードして閲覧許可を付けたい", "media-document-library"],
    ["LINE Report電子ジャーナルとJournal Reportは何が違う？", "pos-journal-vs-journal-report"],
    ["フードコートの来客予測はどう学習する？", "foodcourt-forecast-evolution"],
    ["フードコート日報の動員数はどこへ反映される？", "foodcourt-daily-weekly"],
    ["フードコートのRAGと蒸留は本当に自動学習ですか？", "foodcourt-learning-assets"],
    ["東京ドーム週次配信と日本戦PVアラートの違いは？", "foodcourt-events-alerts"],
    ["自店舗のGoogle口コミを更新したい", "store-reviews"],
    ["周辺競合の口コミと競合圧力について教えて", "competitor-reviews"],
    ["AI使用料とシステムマップは誰が見られる？", "ai-usage-system-map"],
    ["M-talk管理の監査ログから権限を復元できますか？", "mtalk-admin-audit"],
    ["Botは普通のトーク画面から削除できますか？", "mtalk-admin-audit"],
    ["Journal AIにまだ入っていないデータは何ですか？", "known-coverage-limits"],
    ["過去に生成したAI分析文を次の回答の事実にしますか？", "known-coverage-limits"],
    ["Journalの天気と気温は通常AIチャットに入っていますか？", "known-coverage-limits"],
    ["東京ドームと小ホールを同じイベント係数で扱いますか？", "foodcourt-forecast-evolution"],
    ["LINEのグループに店舗Botを2体入れられますか？", "admin-console-approvals"],
    ["GrokやPerplexityは数字を聞いただけでも毎回検索しますか？", "journal-ai-analysis"],
    ["Edge Functionsとadmin-apiの役割をコード構成から教えて", "edge-functions-api"],
    ["cloudflare-workerやsrc/server.jsは今の本番ですか？", "auxiliary-legacy-code"],
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
      "Journalの資料に書いた金額を確定売上として使いますか",
      "フードコートの週次報告はどこですか",
      "自店舗口コミと競合口コミの違いは？",
      "システムマップでは何が見られますか",
      "メディア画面の文書閲覧許可について",
      "Journal AIで未統合のデータを教えて",
      "admin-apiの実装はどこですか",
      "OCRブリッジと現在のレシート解析の違いは？",
    ]
  ) {
    assertEquals(isLineReportHelpQuestion(question), true, question)
    assertEquals(isMtalkHelpQuestion(question), true, `integrated: ${question}`)
  }
})

Deno.test("否定形・分離語・類似機能の質問でも正しい項目を選び、統合資料を注入する", () => {
  const cases = [
    ["Botは普通のトーク画面から削除できますか？", "ADM-03"],
    ["過去に生成したAI分析文を次の回答の事実にしますか？", "SEC-03"],
    ["Journalの天気と気温は通常AIチャットに入っていますか？", "SEC-03"],
    ["東京ドームと小ホールを同じイベント係数で扱いますか？", "FCT-03"],
    ["LINEのグループに店舗Botを2体入れられますか？", "ADM-01"],
    ["GrokやPerplexityは数字を聞いただけでも毎回検索しますか？", "JAI-01"],
    ["Journalの資料に書いた金額を確定売上として使いますか？", "KNW-01"],
  ] as const

  for (const [question, expectedCode] of cases) {
    const selectedCodes = selectLineReportHelpSections(question, 6)
      .map((entry) => entry.section.code)
    if (!selectedCodes.includes(expectedCode)) {
      throw new Error(
        `${question}\nexpected: ${expectedCode}\nactual: ${selectedCodes.join(", ")}`,
      )
    }
    const reference = buildMtalkHelpReference(question)
    if (!reference || reference.endsWith("…")) {
      throw new Error(`${question}: 統合資料が未注入または途中切れです`)
    }
  }
})

Deno.test("過去の売上登録は一括取込へ、当日の売上登録はレシートへ振り分ける", () => {
  // 「過去の売上登録方法」でレシート画像（当日1日分）の手順を答えてしまう誤りの回帰防止。
  for (
    const question of [
      "過去の売上登録方法",
      "過去の売上をまとめて登録したい",
      "先月の売上を後から登録するには？",
      "過去分の売上を一括取込したい",
    ]
  ) {
    const selected = selectLineReportHelpSections(question, 4)
    const codes = selected.map((entry) => entry.section.code)
    if (!codes.includes("SAL-07")) {
      throw new Error(`${question}\nexpected SAL-07\nactual: ${codes.join(", ")}`)
    }
    const past = selected.find((entry) => entry.section.code === "SAL-07")
    const receipt = selected.find((entry) => entry.section.code === "SAL-02")
    if (receipt && past && receipt.score >= past.score) {
      throw new Error(
        `${question}: SAL-02(${receipt.score}) が SAL-07(${past.score}) 以上です`,
      )
    }
  }

  // 当日の売上登録は従来どおりレシート解析（SAL-02）が最上位であること。
  const todaySelected = selectLineReportHelpSections("売上登録のやり方", 4)
  if (todaySelected[0]?.section.code !== "SAL-02") {
    throw new Error(
      `売上登録のやり方: expected SAL-02 first, actual ${
        todaySelected.map((entry) => entry.section.code).join(", ")
      }`,
    )
  }

  // AIへ渡す参照に、正しい経路と「レシートではない」根拠が両方入ること。
  const reference = buildMtalkHelpReference("過去の売上登録方法")
  for (
    const expected of [
      "SAL-07",
      "過去の日次売上を一括取込",
      "月次日別売上管理表",
      "レシート画像はその日1日分の登録専用です",
      "M-talkのトークへExcelを送っても一括取込は行われません",
    ]
  ) {
    if (!reference.includes(expected)) {
      throw new Error(`過去の売上登録方法: 参照資料に ${expected} がありません`)
    }
  }
})

Deno.test("統合参照は区分索引と質問に関連する詳細を含み、通常例では途中切れしない", () => {
  const cases = [
    ["予算登録と売上照会の違い", ["M-talk / Journal Report 区分索引", "SAL-04", "必ず最初に「予算登録」"]],
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

Deno.test("全45項目をタイトルで検索でき、参照資料が途中で切れない", () => {
  for (const section of LINE_REPORT_HELP_SECTIONS) {
    const question = `${section.title}について教えて`
    const selected = selectLineReportHelpSections(question, 4)
    if (!selected.some((entry) => entry.section.code === section.code)) {
      throw new Error(`${section.code} をタイトルから検索できません`)
    }
    const reference = buildMtalkHelpReference(question)
    if (reference.endsWith("…")) {
      throw new Error(`${section.code} の参照資料が途中で切れました: ${reference.length}文字`)
    }
    if (!reference.includes(`【${section.code} ${section.title}】`)) {
      throw new Error(`${section.code} の詳細が統合参照へ入りませんでした`)
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

Deno.test("コード・APIの質問だけ実装根拠を添え、通常の使い方回答は簡潔に保つ", () => {
  const implementationQuestion = "予算登録の実装コードとAPIはどこですか？"
  assertEquals(wantsLineReportImplementationDetails(implementationQuestion), true)
  const implementationReference = buildMtalkHelpReference(implementationQuestion)
  if (
    !implementationReference.includes("実装根拠:") ||
    !implementationReference.includes("budget_entry_flow.ts")
  ) {
    throw new Error("実装質問へソースコードの根拠が入りませんでした")
  }

  const usageReference = buildMtalkHelpReference("予算登録のやり方を教えて")
  if (usageReference.includes("実装根拠:")) {
    throw new Error("通常の使い方回答へ不要なソース一覧が入りました")
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
