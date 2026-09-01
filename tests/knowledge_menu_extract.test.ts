import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  assessKnowledgeMenuQuality,
  buildStructuredKnowledgeMenuBody,
  countKnowledgePriceMentions,
  normalizeKnowledgeMenuItems,
  scoreKnowledgeMenuExtraction,
} from "../supabase/functions/_shared/knowledge_menu_extract.ts";

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
