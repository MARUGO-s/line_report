/** POS電子ジャーナル（LZH/LH5 + ESC/POS + CP932）の解析・月次集約。 */
import { extractLhaArchive } from "./pos_journal_lha.ts";

export const POS_JOURNAL_STORE_CODE_MAP: Readonly<
  Record<string, {
    storeKey: string;
    storeName: string;
  }>
> = {
  "1015": { storeKey: "bistrocavacava", storeName: "Bistro CAVACAVA" },
};

export type PosJournalReceiptItem = {
  code: string;
  name: string;
  unit: number;
  qty: number;
  amount: number;
};

export type PosJournalReceipt = {
  no: string;
  time: string;
  pay: string;
  total: number | null;
  guests: number | null;
  table_no?: string;
  slip_no?: string;
  items: PosJournalReceiptItem[];
};

export type PosJournalDay = Record<string, unknown> & {
  business_date: string;
  receipts: PosJournalReceipt[];
  source: string;
};

export type PosJournalSummary = {
  meta: Record<string, unknown>;
  totals: Record<string, number>;
  payment_breakdown: Record<string, { count: number; amount: number }>;
  item_ranking: Array<
    { code: string; name: string; qty: number; amount: number }
  >;
  days: PosJournalDay[];
};

const HEADER_RE =
  /^\s*(\d{4}-\d{2})\s+No\.(\d+)\s+(\d{4})年\s*(\d+)月\s*(\d+)日\((.)\)\s*(\d+)時(\d+)分/;
const ITEM_CODE_RE = /^\s{2}(\d{13})\s+(\S.*?)\s*$/;
const ITEM_PRICE_RE = /@\s*([\d,]+)\s*x\s*([\d,]+)\s+\\\s*([\d,]+)/;
const FULLWIDTH_MAP: Readonly<Record<string, string>> = {
  "０": "0",
  "１": "1",
  "２": "2",
  "３": "3",
  "４": "4",
  "５": "5",
  "６": "6",
  "７": "7",
  "８": "8",
  "９": "9",
  "，": ",",
  "．": ".",
  "％": "%",
  "／": "/",
  "－": "-",
};

function normalizeWide(value: string): string {
  return String(value || "").replace(
    /[０-９，．％／－]/g,
    (char) => FULLWIDTH_MAP[char] ?? char,
  );
}

function stripEscPos(raw: Uint8Array): string {
  const output: number[] = [];
  for (let index = 0; index < raw.length;) {
    const byte = raw[index];
    if (byte === 0x1b || byte === 0x1c) {
      index += 3;
      continue;
    }
    output.push(byte);
    index += 1;
  }
  return new TextDecoder("shift-jis", { fatal: false }).decode(
    Uint8Array.from(output),
  );
}

function amount(value: string): number | null {
  const match = normalizeWide(value).match(/\\\s*([\d,]+)/);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

function firstInt(value: string, unit: string): number | null {
  const match = normalizeWide(value).match(new RegExp(`([\\d,]+)\\s*${unit}`));
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

type JournalRecord = {
  no: string;
  y: number;
  mo: number;
  d: number;
  wd: string;
  hh: number;
  mi: number;
  lines: string[];
};

function splitRecords(text: string): JournalRecord[] {
  const records: JournalRecord[] = [];
  let current: JournalRecord | null = null;
  for (const line of text.split(/\r?\n|\r/g)) {
    const match = line.match(HEADER_RE);
    if (match) {
      if (current) records.push(current);
      current = {
        no: match[2],
        y: Number(match[3]),
        mo: Number(match[4]),
        d: Number(match[5]),
        wd: match[6],
        hh: Number(match[7]),
        mi: Number(match[8]),
        lines: [],
      };
    } else if (current) current.lines.push(line);
  }
  if (current) records.push(current);
  return records;
}

function valueNear(lines: string[], index: number, look = 2): number | null {
  for (
    let cursor = index;
    cursor < Math.min(index + look + 1, lines.length);
    cursor += 1
  ) {
    const value = amount(lines[cursor]);
    if (value != null) return value;
  }
  return null;
}

function parseSettlement(record: JournalRecord): Record<string, unknown> {
  const lines = record.lines;
  const output: Record<string, unknown> = {};
  for (const line of lines) {
    const match = normalizeWide(line).match(
      /営業日付[：:]\s*(\d{4})年\s*(\d+)月\s*(\d+)日/,
    );
    if (match) {
      output.business_date = `${Number(match[1]).toString().padStart(4, "0")}-${
        Number(match[2]).toString().padStart(2, "0")
      }-${Number(match[3]).toString().padStart(2, "0")}`;
      break;
    }
  }
  const amountLabels: Readonly<Record<string, string>> = {
    net_sales: "純 売 上",
    tax: "消 費 税",
    gross_sales: "総 売 上",
    avg_spend: "客単価",
    discount_total: "★割引合計",
    pay_total: "★支払合計",
    tax_out: " 外税",
    tax_in: " 内税",
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const [key, label] of Object.entries(amountLabels)) {
      if (!(key in output) && line.includes(label)) {
        const value = amount(line) ?? valueNear(lines, index, 1);
        if (value != null) output[key] = value;
      }
    }
    if (line.includes("会計組数・客数")) {
      for (
        let cursor = index;
        cursor < Math.min(index + 3, lines.length);
        cursor += 1
      ) {
        const groups = firstInt(lines[cursor], "組");
        const guests = firstInt(lines[cursor], "名");
        if (groups != null) output.groups = groups;
        if (guests != null) output.guests = guests;
      }
    }
    if (line.includes("店内飲食売上")) {
      for (
        let cursor = index;
        cursor < Math.min(index + 3, lines.length);
        cursor += 1
      ) {
        const items = firstInt(lines[cursor], "点");
        const sales = amount(lines[cursor]);
        if (items != null) output.dinein_items = items;
        if (sales != null) output.dinein_sales = sales;
      }
    }
  }
  const paymentBlock = (label: string): { count: number; amount: number } => {
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(label)) continue;
      let count = 0;
      let value = 0;
      for (
        let cursor = index;
        cursor < Math.min(index + 3, lines.length);
        cursor += 1
      ) {
        const foundCount = firstInt(lines[cursor], "回");
        const foundAmount = amount(lines[cursor]);
        if (foundCount != null) count = foundCount;
        if (foundAmount != null) value = foundAmount;
      }
      return { count, amount: value };
    }
    return { count: 0, amount: 0 };
  };
  output.pay_cash = paymentBlock("現計");
  output.pay_credit = paymentBlock("クレジット計");
  output.pay_tabelog = paymentBlock("食べログ");
  output.pay_ikyu = paymentBlock("一休");
  output.pay_gurunavi = paymentBlock("ぐるなび");
  return output;
}

function parseWeather(record: JournalRecord): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const line of record.lines) {
    const weather = line.match(/天候\s*([^\s　]+)/);
    if (weather && !line.includes("入力") && weather[1] !== "入力") {
      output.weather = weather[1].trim();
    }
    const temperature = normalizeWide(line).match(/気温\s*(\d+)/);
    if (temperature) output.temp_c = Number(temperature[1]);
  }
  return output;
}

function parseSale(record: JournalRecord): PosJournalReceipt | null {
  const text = record.lines.join("\n");
  if (text.includes("オーダーキャンセル")) return null;
  let pay = "";
  for (const line of record.lines) {
    if (/計[0-9０-９]+\s+現計/.test(normalizeWide(line))) pay = "現金";
    else if (/計[0-9０-９]+\s+クレジット/.test(line)) pay = "クレジット";
    else if (/計[0-9０-９]+\s+食べログ/.test(line)) pay = "食べログ";
    else if (/計[0-9０-９]+\s+一休/.test(line)) pay = "一休";
    else if (/計[0-9０-９]+\s+ぐるなび/.test(line)) pay = "ぐるなび";
  }
  if (!pay) return null;
  const items: PosJournalReceiptItem[] = [];
  for (let index = 0; index < record.lines.length; index += 1) {
    const item = record.lines[index].match(ITEM_CODE_RE);
    if (!item || index + 1 >= record.lines.length) continue;
    const price = normalizeWide(record.lines[index + 1]).match(ITEM_PRICE_RE);
    if (!price) continue;
    items.push({
      code: item[1],
      name: item[2].trim(),
      unit: Number(price[1].replace(/,/g, "")),
      qty: Number(price[2].replace(/,/g, "")),
      amount: Number(price[3].replace(/,/g, "")),
    });
    index += 1;
  }
  if (!items.length) return null;
  let total: number | null = null;
  let guests: number | null = null;
  let tableNo = "";
  let slipNo = "";
  for (const line of record.lines) {
    const normalized = String(line || "").normalize("NFKC");
    if (/合\s*計\s/.test(line)) total = amount(line) ?? total;
    guests = firstInt(line, "名") ?? guests;
    const table = normalized.match(
      /伝票\s*No\.?\s*([^\s]+)\s+テーブル\s*No\.?\s*([^\s]+)/,
    );
    if (table) {
      const slip = String(table[1] || "").trim();
      const tbl = String(table[2] || "").trim();
      if (slip && !/^保留/.test(slip)) slipNo = slip;
      if (tbl && !/^保留/.test(tbl) && tbl !== ".") tableNo = tbl;
    }
  }
  return {
    no: record.no,
    time: `${String(record.hh).padStart(2, "0")}:${
      String(record.mi).padStart(2, "0")
    }`,
    pay,
    total,
    guests,
    ...(tableNo ? { table_no: tableNo } : {}),
    ...(slipNo ? { slip_no: slipNo } : {}),
    items,
  };
}

export function parsePosJournalLzh(
  bytes: Uint8Array,
  sourceFileName: string,
): PosJournalDay {
  const entries = extractLhaArchive(bytes);
  const texts = entries
    .filter((entry) => /\.jnl$/i.test(entry.fileName))
    .map((entry) => stripEscPos(entry.data));
  return parsePosJournalTexts(texts, sourceFileName);
}

function parsePosJournalTexts(
  texts: string[],
  sourceFileName: string,
): PosJournalDay {
  let settlement: Record<string, unknown> | null = null;
  let weather: Record<string, unknown> = {};
  const receipts: PosJournalReceipt[] = [];
  for (const text of texts) {
    for (const record of splitRecords(text)) {
      const body = record.lines.join("\n");
      if (body.includes("日計精算レポート") && !settlement) {
        settlement = parseSettlement(record);
      } else if (body.includes("天候入力")) {
        weather = { ...weather, ...parseWeather(record) };
      } else {
        const sale = parseSale(record);
        if (sale) receipts.push(sale);
      }
    }
  }
  if (!settlement || typeof settlement.business_date !== "string") {
    throw new Error("日計精算レポートまたは営業日付を読み取れませんでした。");
  }
  return {
    ...settlement,
    ...weather,
    business_date: String(settlement.business_date),
    receipts,
    source: sourceFileName,
  };
}

/** Tests and trusted import tools may parse already-decoded journal text. */
export function parsePosJournalText(
  text: string,
  sourceFileName: string,
): PosJournalDay {
  return parsePosJournalTexts([String(text ?? "")], sourceFileName);
}

export function detectPosJournalStoreCode(fileName: string): string {
  const match = String(fileName || "").match(/^(\d{4})/);
  return match?.[1] ?? "";
}

export function resolvePosJournalStore(
  storeCode: string,
): { storeKey: string; storeName: string } | null {
  return POS_JOURNAL_STORE_CODE_MAP[String(storeCode || "").trim()] ?? null;
}

function sumDays(days: PosJournalDay[], key: string): number {
  return days.reduce((sum, day) => sum + (Number(day[key]) || 0), 0);
}

export function buildPosJournalSummary(params: {
  storeKey: string;
  storeName: string;
  storeCode: string;
  month: string;
  days: PosJournalDay[];
  fileCount: number;
  generatedAt?: string;
}): PosJournalSummary {
  const dayMap = new Map<string, PosJournalDay>();
  for (const day of params.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.business_date)) continue;
    dayMap.set(day.business_date, day);
  }
  const days = Array.from(dayMap.values()).sort((a, b) =>
    a.business_date.localeCompare(b.business_date)
  );
  const itemMap = new Map<
    string,
    { code: string; name: string; qty: number; amount: number }
  >();
  const paymentBreakdown: Record<string, { count: number; amount: number }> =
    {};
  for (const day of days) {
    for (const receipt of day.receipts || []) {
      const payment = paymentBreakdown[receipt.pay] ?? { count: 0, amount: 0 };
      payment.count += 1;
      payment.amount += Number(receipt.total) || 0;
      paymentBreakdown[receipt.pay] = payment;
      for (const item of receipt.items || []) {
        const key = `${item.code}\u0000${item.name}`;
        const current = itemMap.get(key) ??
          { code: item.code, name: item.name, qty: 0, amount: 0 };
        current.qty += Number(item.qty) || 0;
        current.amount += Number(item.amount) || 0;
        itemMap.set(key, current);
      }
    }
  }
  const gross = sumDays(days, "gross_sales");
  const guests = sumDays(days, "guests");
  return {
    meta: {
      store_key: params.storeKey,
      store_name: params.storeName,
      store_code: params.storeCode,
      month: params.month,
      file_count: params.fileCount,
      day_count: days.length,
      generated_at: params.generatedAt ?? new Date().toISOString(),
    },
    totals: {
      net_sales: sumDays(days, "net_sales"),
      tax: sumDays(days, "tax"),
      gross_sales: gross,
      groups: sumDays(days, "groups"),
      guests,
      avg_spend: guests ? Math.round(gross / guests) : 0,
      cash_amount: days.reduce(
        (sum, day) =>
          sum +
          (Number((day.pay_cash as { amount?: unknown } | undefined)?.amount) ||
            0),
        0,
      ),
      credit_amount: days.reduce(
        (sum, day) =>
          sum +
          (Number(
            (day.pay_credit as { amount?: unknown } | undefined)?.amount,
          ) || 0),
        0,
      ),
      tabelog_amount: days.reduce(
        (sum, day) =>
          sum +
          (Number(
            (day.pay_tabelog as { amount?: unknown } | undefined)?.amount,
          ) || 0),
        0,
      ),
      ikyu_amount: days.reduce(
        (sum, day) =>
          sum +
          (Number((day.pay_ikyu as { amount?: unknown } | undefined)?.amount) ||
            0),
        0,
      ),
      gurunavi_amount: days.reduce(
        (sum, day) =>
          sum +
          (Number(
            (day.pay_gurunavi as { amount?: unknown } | undefined)?.amount,
          ) || 0),
        0,
      ),
    },
    payment_breakdown: paymentBreakdown,
    item_ranking: Array.from(itemMap.values()).sort((a, b) =>
      b.amount - a.amount || b.qty - a.qty || a.name.localeCompare(b.name, "ja")
    ),
    days,
  };
}
