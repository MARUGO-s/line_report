import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1"
import { normalizeLineImageAnalysisResult } from "../supabase/functions/_shared/receipt_parse.ts"
import { RECEIPT_VISION_SYSTEM_PROMPT_BASE } from "../supabase/functions/_shared/receipt_prompt.ts"
import {
  buildMtalkMenuKnowledgeCard,
  normalizeMtalkMenuKnowledgeAnalysis,
  parseMtalkMenuKnowledgeCommand,
} from "../supabase/functions/_shared/mtalk_menu_knowledge.ts"

Deno.test("single image vision response preserves structured menu names and prices", () => {
  const result = normalizeLineImageAnalysisResult({
    kind: "menu",
    summary: "ワインメニュー",
    receipt: null,
    menu: {
      title: "MARUGO S WINE LIST",
      summary: "グラス・デキャンタ・ボトルのワイン一覧",
      menu_items: [{
        section: "RED",
        name: "Gilles Charlot Pinot Noir",
        price: "Glass 950円 / Decanter 4,500円 / Bottle 6,000円",
        description: "Pinot Noir",
      }],
      body_text: "RED\nGilles Charlot Pinot Noir\nGlass 950 / Decanter 4500 / Bottle 6000",
      extraction_notes: "",
      tags: ["ワイン", "赤ワイン"],
    },
  })
  assert(result?.menu)
  assertEquals(result.receipt, null)
  assertEquals(result.menu.menuItems.length, 1)
  assertEquals(result.menu.menuItems[0].price, "Glass 950円 / Decanter 4,500円 / Bottle 6,000円")
  assertMatch(RECEIPT_VISION_SYSTEM_PROMPT_BASE, /receipt\|reservation\|menu\|general/)
  assertMatch(RECEIPT_VISION_SYSTEM_PROMPT_BASE, /全商品を menu\.menu_items/)
})

Deno.test("M-talk menu confirmation card is pending-only and becomes immutable after decision", () => {
  const analysis = normalizeMtalkMenuKnowledgeAnalysis({
    title: "ドリンクメニュー",
    category: "メニュー",
    summary: "ドリンク一覧",
    body_text: "コーヒー 600円",
    tags: ["ドリンク"],
    menu_items: [{ section: "COFFEE", name: "コーヒー", price: "600円", description: "Hot/Iced" }],
  })
  assert(analysis)
  const draftId = "11111111-1111-4111-8111-111111111111"
  const pending = buildMtalkMenuKnowledgeCard({ draftId, analysis })
  assertEquals(pending.actions?.length, 2)
  assertEquals(pending.header?.eyebrow, "AIメニュー解析")
  assertEquals(pending.header?.title, "ドリンクメニュー")
  assertMatch(JSON.stringify(pending.sections), /価格：600円 ／ Hot\/Iced/)
  assertEquals(parseMtalkMenuKnowledgeCommand(pending.actions?.[0]?.command), {
    decision: "register",
    draftId,
  })
  const registered = buildMtalkMenuKnowledgeCard({ draftId, analysis, status: "registered", documentId: 52 })
  assertEquals(registered.actions?.length, 0)
  assertMatch(registered.header?.subtitle || "", /資料ID 52/)
})

Deno.test("non-menu analysis cannot create a menu registration draft", () => {
  assertEquals(normalizeMtalkMenuKnowledgeAnalysis({
    title: "店内写真",
    category: "その他",
    body_text: "客席",
  }), null)
})
