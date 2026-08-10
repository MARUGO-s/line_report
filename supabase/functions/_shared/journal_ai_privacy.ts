/**
 * Journal AI から外部LLMへ送る直前の個人情報最小化。
 * DB・管理画面の原本は変更せず、予約者の同一性は安定した仮名で保持する。
 */

type JsonRecord = Record<string, unknown>;

export type JournalAiPrivacyInput = {
  message?: unknown;
  chatHistory?: unknown;
  systemInstruction?: unknown;
  salesData?: unknown;
  clarificationContext?: unknown;
};

export type JournalAiPrivacyResult = {
  message: string;
  chatHistory: unknown;
  systemInstruction: string;
  salesData: unknown;
  clarificationContext: unknown;
  aliasCount: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A..Z, AA..AZ... の順で、明細件数が増えても衝突しない仮名を返す。 */
export function journalReservationAlias(index: number): string {
  let n = Math.max(0, Math.trunc(index));
  let suffix = "";
  do {
    suffix = String.fromCharCode(65 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `予約客${suffix}`;
}

function normalizeCandidateName(value: unknown): string {
  const name = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/(?:様|さん)$/u, "")
    .trim();
  // 1文字の名前は本文や商品名へ巻き込みやすく、仮名化の実益もないため対象外にする。
  if (!name || name.length < 2 || name.length > 80) return "";
  if (/^(?:氏名不明|予約客[A-Z]+|不明|null|undefined)$/i.test(name)) return "";
  return name;
}

function addName(names: string[], raw: unknown): void {
  const name = normalizeCandidateName(raw);
  if (name && !names.includes(name)) names.push(name);
}

function collectNamesFromText(text: string, names: string[]): void {
  // Journal画面が生成する予約明細:
  // - 2026-08-04 19:00 / 山田太郎 / リピート（3回） / 食べログ
  for (
    const match of text.matchAll(
      /^\s*-\s*\d{4}-\d{2}-\d{2}[^\n]*?\/\s*([^/\n]+?)\s*\//gmu,
    )
  ) {
    addName(names, match[1]);
  }

  // JSON文字列化された予約情報や、明示ラベル付きの自由入力も対象にする。
  for (
    const match of text.matchAll(
      /["']?(?:customer_name|customerName|予約者|予約名|氏名)["']?\s*[:：=]\s*["']?([^"',\n/}]{1,80})/gmu,
    )
  ) {
    addName(names, match[1]);
  }

  if (/予約|顧客|来店履歴|アレルギー/u.test(text)) {
    for (
      const match of text.matchAll(
        /((?:[一-龯々]{2,8}|[ぁ-んァ-ヶー]{2,16}|[A-Za-z][A-Za-z・･\s]{1,39}))(?:様|さん)/gu,
      )
    ) {
      addName(names, match[1]);
    }
  }
}

function collectNames(value: unknown, names: string[]): void {
  if (typeof value === "string") {
    collectNamesFromText(value, names);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectNames(item, names));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (
      /^(?:customer_name|customerName|reservation_name|guest_name)$/i.test(key)
    ) {
      addName(names, nested);
    }
    collectNames(nested, names);
  }
}

/**
 * 予約者名は、名前が実際に現れる文脈だけを置換する。
 * 単純な全置換にすると、確定済み集計データの商品名まで巻き込んで壊す
 * （予約者「山田」で商品「山田錦」が「予約客A錦」になる）。
 * 対象は収集規則と対になる3か所: 予約明細の「/ 氏名 /」、「氏名様・氏名さん」、
 * 「customer_name: 氏名」などのラベル付き。
 */
function replaceNameOccurrences(
  text: string,
  name: string,
  alias: string,
): string {
  if (!name || name.length < 2) return text;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`(/\\s*)${esc}(\\s*/)`, "gu"), `$1${alias}$2`)
    .replace(new RegExp(`${esc}(?=\\s*(?:様|さん))`, "gu"), alias)
    .replace(
      new RegExp(
        `(["']?(?:customer_name|customerName|reservation_name|guest_name|予約者|予約名|氏名)["']?\\s*[:：=]\\s*["']?)${esc}`,
        "gu",
      ),
      `$1${alias}`,
    );
}

function sanitizeText(
  raw: unknown,
  aliases: Map<string, string>,
): string {
  let text = String(raw ?? "");
  const names = [...aliases.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    text = replaceNameOccurrences(text, name, aliases.get(name) || "予約客");
  }

  // メールと電話は予約API側で除外済みだが、多層防御として自由入力からも落とす。
  text = text.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    "[メール非送信]",
  );
  text = text.replace(
    /(?<!\d)(?:\+?81[-\s]?)?(?:0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})(?!\d)/g,
    "[電話非送信]",
  );

  // アレルゲンや疾病に結びつき得る具体内容は外部LLMへ送らず、有無だけ残す。
  text = text.replace(
    /([/／]\s*)アレルギー\s+(?!記載|あり|なし)[^/／\n]+/gu,
    "$1アレルギーあり",
  );
  text = text.replace(
    /アレルギー(?:内容)?\s*[:：]\s*(?!あり|なし)[^/／\n、。]+/gu,
    "アレルギーあり",
  );
  return text;
}

function sanitizeValue(
  value: unknown,
  aliases: Map<string, string>,
  key = "",
): unknown {
  if (
    /^(?:customer_phone|phone|telephone|tel|email|email_address)$/i.test(key)
  ) {
    return null;
  }
  if (
    /^(?:allergy|allergies|allergy_label|allergy_detail|allergy_details|アレルギー|アレルギー内容)$/i
      .test(key)
  ) {
    if (value == null || value === "" || value === false) return null;
    return "アレルギーあり";
  }
  if (
    /^(?:customer_name|customerName|reservation_name|guest_name)$/i.test(key)
  ) {
    const name = normalizeCandidateName(value);
    return name ? aliases.get(name) || "予約客" : null;
  }
  if (typeof value === "string") return sanitizeText(value, aliases);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, aliases));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, nested]) => [
      nestedKey,
      sanitizeValue(nested, aliases, nestedKey),
    ]),
  );
}

/**
 * 1リクエスト内で同じ予約者は同じ仮名へ置換する。
 * 名前の並び順は入力内の初出順で固定し、集計・新規/リピート関係は維持する。
 */
export function sanitizeJournalAiPayload(
  input: JournalAiPrivacyInput,
): JournalAiPrivacyResult {
  const names: string[] = [];
  collectNames(input.systemInstruction, names);
  collectNames(input.salesData, names);
  collectNames(input.message, names);
  collectNames(input.chatHistory, names);
  collectNames(input.clarificationContext, names);
  const aliases = new Map(
    names.map((name, index) => [name, journalReservationAlias(index)]),
  );

  return {
    message: sanitizeText(input.message, aliases),
    chatHistory: sanitizeValue(input.chatHistory, aliases),
    systemInstruction: sanitizeText(input.systemInstruction, aliases),
    salesData: sanitizeValue(input.salesData, aliases),
    clarificationContext: sanitizeValue(input.clarificationContext, aliases),
    aliasCount: aliases.size,
  };
}
