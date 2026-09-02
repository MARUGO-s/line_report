export type KnowledgeMenuItem = {
  section: string;
  name: string;
  price: string;
  description: string;
};

export type KnowledgeMenuQuality = {
  menu_item_count: number;
  priced_item_count: number;
  unpriced_item_count: number;
  body_price_count: number;
  needs_review: boolean;
  warnings: string[];
};

function text(value: unknown, max = 1000): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const MENU_PRICE_LABEL_RE = /(?:glass|グラス|decanter|デキャンタ|bottle|ボトル|regular|large|small|hot|iced|cup|杯|本)(?:\s|:|：|$)/i;
const MENU_NON_PRICE_UNIT_RE = /^\s*(?:ml|cl|cc|oz|l|%|年|度|名|個|枚|本|杯)(?:\b|$)/i;

/**
 * Geminiが価格フィールドへ `Glass 950 / Bottle 6000` のように通貨記号なしで
 * 返した場合だけ、裸の金額を円表記へ正規化する。50ml・375ml・年号は価格にしない。
 * 文字起こし本文には適用せず、構造化済みの price フィールドだけが対象。
 */
export function normalizeKnowledgeMenuPrice(value: unknown): string {
  const source = text(value, 240);
  if (!source) return "";
  const segments = source.split(/(\s*(?:\/|／|\||｜)\s*)/);
  return segments.map((segment, index) => {
    if (index % 2 === 1 || !segment.trim()) return segment;
    const candidates = Array.from(segment.matchAll(/\d[\d,]*/g));
    if (candidates.length === 0) return segment;
    const hasPriceLabel = MENU_PRICE_LABEL_RE.test(segment);
    return segment.replace(/\d[\d,]*/g, (digits, offset, whole) => {
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + digits.length);
      if (/[¥￥\\]\s*$/.test(before) || /^\s*円/.test(after)) return digits;
      if (MENU_NON_PRICE_UNIT_RE.test(after)) return digits;
      const numeric = Number(String(digits).replace(/,/g, ""));
      if (!Number.isFinite(numeric)) return digits;
      if (candidates.length > 1 && numeric >= 1900 && numeric <= 2099) return digits;
      if (!hasPriceLabel && candidates.length !== 1) return digits;
      return `${numeric.toLocaleString("ja-JP")}円`;
    });
  }).join("");
}

export function normalizeKnowledgeMenuItems(
  value: unknown,
): KnowledgeMenuItem[] {
  if (!Array.isArray(value)) return [];
  const items: KnowledgeMenuItem[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 300)) {
    const row = asRecord(raw);
    if (!row) continue;
    const name = text(row.name ?? row.item_name ?? row.menu_name, 240);
    if (!name) continue;
    const rawPrice = row.price ?? row.price_text ?? row.amount ?? row.prices;
    const price = Array.isArray(rawPrice)
      ? rawPrice.map((item) => normalizeKnowledgeMenuPrice(item)).filter(Boolean).join(" / ")
      : typeof rawPrice === "number"
      ? `${rawPrice.toLocaleString("ja-JP")}円`
      : normalizeKnowledgeMenuPrice(rawPrice);
    const item = {
      section: text(row.section ?? row.group ?? row.category, 160),
      name,
      price,
      description: text(
        row.description ?? row.note ?? row.options ?? row.variant,
        800,
      ),
    };
    const key = `${item.section}\u0000${item.name}\u0000${item.price}`
      .toLocaleLowerCase("ja-JP");
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

export function countKnowledgePriceMentions(value: unknown): number {
  const source = String(value ?? "");
  const matches = source.match(/(?:[¥￥\\]\s*\d[\d,]*|\d[\d,]*\s*円)/g) ?? [];
  if (matches.length > 0) {
    return new Set(matches.map((match) => match.replace(/\s+/g, ""))).size;
  }
  const labeled = source.match(/(?:Glass|グラス|Decanter|デキャンタ|Bottle|ボトル)\s*[:：]?\s*\d[\d,]*(?![\d,])(?!\s*(?:ml|cl|cc|oz|l)\b)/gi) ?? [];
  return new Set(labeled.map((match) => match.replace(/\s+/g, "").toLowerCase())).size;
}

function safeLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function buildStructuredKnowledgeMenuBody(
  items: KnowledgeMenuItem[],
  transcription: unknown,
  extractionNotes: unknown,
): string {
  const parts: string[] = [];
  if (items.length > 0) {
    parts.push("【メニュー一覧（画像・資料から抽出）】");
    for (const item of items) {
      const prefix = item.section ? `[${safeLine(item.section)}] ` : "";
      const price = item.price
        ? ` — ${safeLine(item.price)}`
        : " — 価格判読不可";
      const description = item.description
        ? `（${safeLine(item.description)}）`
        : "";
      parts.push(`- ${prefix}${safeLine(item.name)}${price}${description}`);
    }
  }
  const body = String(transcription ?? "").trim();
  if (body) parts.push(`【画像・資料内の文字起こし】\n${body}`);
  const notes = String(extractionNotes ?? "").trim();
  if (notes) parts.push(`【抽出上の注意】\n${notes}`);
  return parts.join("\n\n").slice(0, 60000);
}

export function assessKnowledgeMenuQuality(args: {
  category: unknown;
  menuItems: KnowledgeMenuItem[];
  bodyText: unknown;
  requireStructuredItems?: boolean;
}): KnowledgeMenuQuality {
  const category = text(args.category, 80);
  const items = Array.isArray(args.menuItems) ? args.menuItems : [];
  const priced =
    items.filter((item) => countKnowledgePriceMentions(item.price) > 0).length;
  const unpriced = Math.max(0, items.length - priced);
  const bodyPrices = countKnowledgePriceMentions(args.bodyText);
  const warnings: string[] = [];
  if (category === "メニュー") {
    if (items.length === 0 && args.requireStructuredItems) {
      warnings.push("メニュー名の構造化一覧を抽出できませんでした。");
    }
    if (priced === 0 && bodyPrices === 0) {
      warnings.push("価格付きのメニュー項目を抽出できませんでした。");
    } else if (unpriced > 0) {
      warnings.push(`メニュー${unpriced}件の価格が未抽出または判読不可です。`);
    }
  }
  return {
    menu_item_count: items.length,
    priced_item_count: priced,
    unpriced_item_count: unpriced,
    body_price_count: bodyPrices,
    needs_review: warnings.length > 0,
    warnings,
  };
}

export function scoreKnowledgeMenuExtraction(
  quality: KnowledgeMenuQuality,
): number {
  return quality.priced_item_count * 30 + quality.menu_item_count * 3 -
    quality.unpriced_item_count * 15 + Math.min(quality.body_price_count, 20);
}
