import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  assessKnowledgeMenuQuality,
  buildStructuredKnowledgeMenuBody,
  countKnowledgePriceMentions,
  normalizeKnowledgeMenuItems,
  normalizeKnowledgeMenuPrice,
  scoreKnowledgeMenuExtraction,
} from "../supabase/functions/_shared/knowledge_menu_extract.ts";
import {
  buildKnowledgeCommonPromptBlock,
  buildStoreKnowledgeSpecializedPromptBlock,
  KNOWLEDGE_MENU_EXTRACTION_PROMPT_BLOCK,
} from "../supabase/functions/_shared/knowledge_menu_prompt.ts";

Deno.test("menu extraction normalizes item names, sections, prices and aliases", () => {
  const items = normalizeKnowledgeMenuItems([
    {
      section: "抹茶",
      name: "TOKYO抹茶白玉ラテ",
      price: ["900円", "1,000円"],
      note: "アイス黒蜜付き",
    },
    { group: "紅茶", item_name: "イングリッシュブレックファスト", amount: 700 },
    {
      category: "紅茶",
      menu_name: "イングリッシュブレックファスト",
      price_text: "700円",
    },
  ]);

  assertEquals(items, [
    {
      section: "抹茶",
      name: "TOKYO抹茶白玉ラテ",
      price: "900円 / 1,000円",
      description: "アイス黒蜜付き",
    },
    {
      section: "紅茶",
      name: "イングリッシュブレックファスト",
      price: "700円",
      description: "",
    },
  ]);
});

Deno.test("menu body keeps a RAG-readable item and price list before transcription", () => {
  const items = normalizeKnowledgeMenuItems([
    {
      section: "COFFEE Hot",
      name: "オーガニックコーヒー",
      price: "500円",
      description: "Regular",
    },
    { section: "ソフトドリンク", name: "パイナップルジュース", price: "600円" },
  ]);
  const body = buildStructuredKnowledgeMenuBody(
    items,
    "COFFEE / SOFT DRINK",
    "反射部分は一部判読不可",
  );

  assertMatch(body, /^【メニュー一覧（画像・資料から抽出）】/);
  assertMatch(body, /オーガニックコーヒー — 500円/);
  assertMatch(body, /パイナップルジュース — 600円/);
  assertMatch(body, /【画像・資料内の文字起こし】/);
  assertMatch(body, /【抽出上の注意】/);
});

Deno.test("summary-only menu extraction fails closed while priced menus pass", () => {
  const weak = assessKnowledgeMenuQuality({
    category: "メニュー",
    menuItems: [],
    bodyText: "抹茶ラテ、紅茶、コーヒーを取り揃えたドリンクメニューです。",
    requireStructuredItems: true,
  });
  assert(weak.needs_review);
  assertEquals(weak.menu_item_count, 0);
  assertEquals(weak.priced_item_count, 0);
  assertEquals(weak.warnings.length, 2);

  const items = normalizeKnowledgeMenuItems([
    {
      section: "ラッシー",
      name: "ギリシャヨーグルトのラッシー",
      price: "800円",
    },
    { section: "ジンジャーエール", name: "Sweet Ginger Ale", price: "600円" },
  ]);
  const strongBody = buildStructuredKnowledgeMenuBody(
    items,
    "ラッシー 800円 / ジンジャーエール 600円",
    "",
  );
  const strong = assessKnowledgeMenuQuality({
    category: "メニュー",
    menuItems: items,
    bodyText: strongBody,
    requireStructuredItems: true,
  });
  assertEquals(strong.needs_review, false);
  assertEquals(strong.priced_item_count, 2);
  assert(
    scoreKnowledgeMenuExtraction(strong) > scoreKnowledgeMenuExtraction(weak),
  );
});

Deno.test("price counter recognizes Japanese yen formats without treating plain numbers as prices", () => {
  assertEquals(
    countKnowledgePriceMentions("900円 / ￥1,000 / ¥750 / \\600 / 2026年9月"),
    4,
  );
  assertEquals(countKnowledgePriceMentions("抹茶、紅茶、コーヒー"), 0);
});

Deno.test("wine menu bare amounts become yen prices without converting serving volumes", () => {
  assertEquals(
    normalizeKnowledgeMenuPrice("Glass 950 / Decanter 4500 / Bottle 6000"),
    "Glass 950円 / Decanter 4,500円 / Bottle 6,000円",
  );
  assertEquals(
    normalizeKnowledgeMenuPrice("Glass 1300 (50ml) / Bottle 9000 (375ml)"),
    "Glass 1,300円 (50ml) / Bottle 9,000円 (375ml)",
  );
  assertEquals(countKnowledgePriceMentions("Glass 950 / Bottle 6000"), 2);
  assertEquals(countKnowledgePriceMentions("50ml / 375ml / 2022年"), 0);
  assertEquals(countKnowledgePriceMentions("Glass 50ml / Bottle 375ml"), 0);
});

Deno.test("MARUGO S fourteen-cell wine list keeps every product and price group", () => {
  const rawPrices = [
    "Glass 1400 / Bottle 10000",
    "Glass 950 / Bottle 7000",
    "Glass 1100 / Decanter 5300 / Bottle 7500",
    "Glass 1200 / Decanter 5800 / Bottle 8000",
    "Glass 1000 / Decanter 4800 / Bottle 6800",
    "Glass 700 / Decanter 3300 / Bottle 4500",
    "Glass 600 / Decanter 2800 / Bottle 4000",
    "Glass 1500 / Decanter 7300 / Bottle 10000",
    "Glass 1200 / Decanter 5800 / Bottle 8000",
    "Glass 600 / Decanter 2800 / Bottle 4000",
    "Glass 800 / Decanter 3800 / Bottle 5000",
    "Glass 950 / Decanter 4500 / Bottle 6000",
    "Glass 1300 (50ml) / Bottle 9000 (375ml)",
    "Glass 1200 (50ml) / Bottle 11000 (500ml)",
  ];
  const items = normalizeKnowledgeMenuItems(rawPrices.map((price, index) => ({
    section: index < 4 ? "SPARKLING" : index < 8 ? "WHITE" : index < 12 ? "RED" : "DESSERT",
    name: `Wine ${index + 1}`,
    price,
    description: index >= 12 ? "容量表記あり" : "",
  })));
  const quality = assessKnowledgeMenuQuality({
    category: "メニュー",
    menuItems: items,
    bodyText: buildStructuredKnowledgeMenuBody(items, "", ""),
    requireStructuredItems: true,
  });
  assertEquals(items.length, 14);
  assertEquals(quality.priced_item_count, 14);
  assertEquals(quality.unpriced_item_count, 0);
  assertEquals(quality.needs_review, false);
  assertMatch(items[11].price, /Glass 950円 \/ Decanter 4,500円 \/ Bottle 6,000円/);
  assertMatch(items[12].price, /Glass 1,300円 \(50ml\) \/ Bottle 9,000円 \(375ml\)/);
});

Deno.test("menu quality requires price coverage for every extracted item", () => {
  const partialItems = normalizeKnowledgeMenuItems([
    { section: "RED", name: "Pinot Noir", price: "Glass 950 / Bottle 6000" },
    { section: "DESSERT", name: "Chenin Blanc", price: "判読不可" },
  ]);
  const partial = assessKnowledgeMenuQuality({
    category: "メニュー",
    menuItems: partialItems,
    bodyText: buildStructuredKnowledgeMenuBody(partialItems, "", ""),
    requireStructuredItems: true,
  });
  assertEquals(partial.priced_item_count, 1);
  assertEquals(partial.unpriced_item_count, 1);
  assert(partial.needs_review);
  assertMatch(partial.warnings.join(" "), /1件の価格が未抽出/);

  const completeItems = normalizeKnowledgeMenuItems([
    { section: "RED", name: "Pinot Noir", price: "Glass 950 / Bottle 6000" },
    { section: "DESSERT", name: "Chenin Blanc", price: "Glass 1300 (50ml) / Bottle 9000 (375ml)" },
  ]);
  const complete = assessKnowledgeMenuQuality({
    category: "メニュー",
    menuItems: completeItems,
    bodyText: buildStructuredKnowledgeMenuBody(completeItems, "", ""),
    requireStructuredItems: true,
  });
  assertEquals(complete.needs_review, false);
  assertEquals(complete.priced_item_count, 2);
  assert(scoreKnowledgeMenuExtraction(complete) > scoreKnowledgeMenuExtraction(partial));
});

Deno.test("non-menu documents are not blocked by menu quality rules", () => {
  const quality = assessKnowledgeMenuQuality({
    category: "マニュアル",
    menuItems: [],
    bodyText: "開店時の手順を確認する。",
    requireStructuredItems: true,
  });
  assertEquals(quality.needs_review, false);
  assertEquals(quality.warnings, []);
});

Deno.test("prompt blocks keep common menu rules global and MARUGO S rules store-scoped", () => {
  const common = buildKnowledgeCommonPromptBlock({
    sourceLabel: "画像",
    categoryHint: "メニュー",
    titleHint: "ワインリスト",
  });
  assertMatch(common, /全店共通・資料抽出規約/);
  assertMatch(KNOWLEDGE_MENU_EXTRACTION_PROMPT_BLOCK, /全店共通・メニュー専用規約/);
  assertMatch(KNOWLEDGE_MENU_EXTRACTION_PROMPT_BLOCK, /Glass 950円/);

  const marugos = buildStoreKnowledgeSpecializedPromptBlock("marugoS");
  assertMatch(marugos, /店舗専用・MARUGO S/);
  assertMatch(marugos, /東京ドームのフードコート店舗/);
  assertMatch(marugos, /Glass \/ Decanter \/ Bottle/);
  assertMatch(marugos, /別のMARUGO S資料や過去メニューの内容を混ぜない/);

  assertEquals(buildStoreKnowledgeSpecializedPromptBlock("bistrocavacava"), "");
  assertEquals(buildStoreKnowledgeSpecializedPromptBlock("marugo"), "");
});
