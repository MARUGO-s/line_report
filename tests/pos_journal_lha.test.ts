import {
  decodeLh5,
  extractLhaArchive,
  listLhaEntries,
} from "../supabase/functions/_shared/pos_journal_lha.ts";
import {
  buildPosJournalSummary,
  detectPosJournalStoreCode,
  parsePosJournalText,
  POS_JOURNAL_REPORT_PARSER_VERSION,
  reconcilePosJournalDayDetail,
  resolvePosJournalStore,
} from "../supabase/functions/_shared/pos_journal.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`assertEquals failed\nactual: ${a}\nexpected: ${e}`);
  }
}

function assertThrows(fn: () => unknown): void {
  let thrown = false;
  try {
    fn();
  } catch {
    thrown = true;
  }
  if (!thrown) throw new Error("Expected function to throw");
}

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
    }
  }
  return crc & 0xffff;
}

function wrapLevel2Lh0(fileName: string, payload: Uint8Array): Uint8Array {
  const fileNameBytes = new TextEncoder().encode(fileName);
  const commonExt = new Uint8Array([0x00, 0x61, 0x62, 0x63, 0x00, 0x00]);
  const nameExt = new Uint8Array(1 + fileNameBytes.length + 2);
  nameExt[0] = 0x01;
  nameExt.set(fileNameBytes, 1);
  new DataView(nameExt.buffer).setUint16(
    nameExt.length - 2,
    commonExt.length,
    true,
  );
  const headerSize = 26 + nameExt.length + commonExt.length;
  const archive = new Uint8Array(headerSize + payload.length + 1);
  const view = new DataView(archive.buffer);
  view.setUint16(0, headerSize, true);
  archive.set(new TextEncoder().encode("-lh0-"), 2);
  view.setUint32(7, payload.length, true);
  view.setUint32(11, payload.length, true);
  archive[20] = 2;
  view.setUint16(21, crc16(payload), true);
  archive[23] = 0x55;
  view.setUint16(24, nameExt.length, true);
  archive.set(nameExt, 26);
  archive.set(commonExt, 26 + nameExt.length);
  archive.set(payload, headerSize);
  return archive;
}

Deno.test("POS store codes resolve to their verified stores", () => {
  assertEquals(
    detectPosJournalStoreCode("101520260602221907580001.lzh"),
    "1015",
  );
  assertEquals(resolvePosJournalStore("1015"), {
    storeKey: "bistrocavacava",
    storeName: "Bistro CAVACAVA",
  });
  assertEquals(
    detectPosJournalStoreCode("102020251129221906200001.lzh"),
    "1020",
  );
  assertEquals(resolvePosJournalStore("1020"), {
    storeKey: "bistrocavacava",
    storeName: "Bistro CAVACAVA",
  });
  assertEquals(
    detectPosJournalStoreCode("102220260825222010000001.lzh"),
    "1022",
  );
  assertEquals(resolvePosJournalStore("1022"), {
    storeKey: "marugos",
    storeName: "マルゴエス",
  });
  assertEquals(resolvePosJournalStore("9999"), null);
});

Deno.test("POS store code migration seeds the historical CAVACAVA code", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../supabase/migrations/20260910020000_pos_journal_store_code_1020.sql",
      import.meta.url,
    ),
  );
  assertEquals(
    /'1020'\s*,\s*'bistrocavacava'\s*,\s*'Bistro CAVACAVA'/.test(sql),
    true,
  );
  assertEquals(sql.includes("on conflict (store_code) do update"), true);
  assertEquals(sql.includes("raise exception"), true);
});

Deno.test("POS store code migration registers the verified MARUGO S code", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../supabase/migrations/20260830054941_add_marugos_pos_journal_store_code.sql",
      import.meta.url,
    ),
  );
  assertEquals(
    /'1022'\s*,\s*'marugos'\s*,\s*'マルゴエス'/.test(sql),
    true,
  );
  assertEquals(sql.includes("on conflict (store_code) do update"), true);
  assertEquals(sql.includes("raise exception"), true);
});

Deno.test("monthly summary de-duplicates business dates and sorts them", () => {
  const summary = buildPosJournalSummary({
    storeKey: "bistrocavacava",
    storeName: "Bistro CAVACAVA",
    storeCode: "1015",
    month: "2026-06",
    fileCount: 3,
    days: [
      {
        business_date: "2026-06-03",
        gross_sales: 2200,
        net_sales: 2000,
        tax: 200,
        groups: 1,
        guests: 2,
        pay_cash: { amount: 2200 },
        receipts: [],
        source: "b.lzh",
      },
      {
        business_date: "2026-06-02",
        gross_sales: 1100,
        net_sales: 1000,
        tax: 100,
        groups: 1,
        guests: 1,
        pay_credit: { amount: 1100 },
        receipts: [],
        source: "a.lzh",
      },
      {
        business_date: "2026-06-03",
        gross_sales: 3300,
        net_sales: 3000,
        tax: 300,
        groups: 2,
        guests: 3,
        pay_cash: { amount: 3300 },
        receipts: [],
        source: "new.lzh",
      },
    ],
  });
  assertEquals(summary.days.map((day) => day.business_date), [
    "2026-06-02",
    "2026-06-03",
  ]);
  assertEquals(summary.totals.gross_sales, 4400);
  assertEquals(summary.totals.guests, 4);
  assertEquals(summary.totals.avg_spend, 1100);
});

Deno.test("invalid and truncated LHA files fail closed", () => {
  assertThrows(() => listLhaEntries(new Uint8Array()));
  assertThrows(() => decodeLh5(new Uint8Array([0]), 10));
  assertThrows(() => extractLhaArchive(new Uint8Array(30)));
});

Deno.test("journal parser reads completed sale with a fullwidth payment digit", () => {
  const text = [
    "0001-01   No.1001  2026年 6月 2日(火) 20時32分",
    "  0000000000101   コース６品",
    "                      @8,000x   1     \\8,000",
    "合 計                        \\８,０００",
    "        計２       クレジット         \\8,000",
    "                               2名",
    "0001-01   No.1002  2026年 6月 2日(火) 22時19分",
    "★★   日計精算レポート   ★★",
    "  営業日付：                    2026年 6月 2日",
    "純 売 上                           \\７,２７３",
    "消 費 税                              \\７２７",
    "総 売 上                           \\８,０００",
    " 会計組数・客数",
    "                  １組                    ２名",
    " クレジット計",
    "                  １回              \\８,０００",
    "0001-01   No.1003  2026年 6月 2日(火) 22時20分",
    "★電子ｼﾞｬｰﾅﾙ送信    正常終了",
  ].join("\r\n");
  const day = parsePosJournalText(text, "101520260602221907580001.lzh");
  assertEquals(day.business_date, "2026-06-02");
  assertEquals(day.parsed_complete, true);
  assertEquals(day.gross_sales, 8000);
  assertEquals(day.receipts.length, 1);
  assertEquals(day.receipts[0].pay, "クレジット");
  assertEquals(day.receipts[0].items[0].name, "コース６品");
});

Deno.test("MARUGO-s generic and mixed payment rows keep receipts until gross reconciliation", async () => {
  const text = await Deno.readTextFile(
    new URL("./fixtures/marugos-payment-methods.jnl.txt", import.meta.url),
  );
  const day = parsePosJournalText(text, "102220260829230000000001.lzh");
  assertEquals(day.receipts.map((receipt) => receipt.pay), [
    "QRコード",
    "電子マネー",
    "東京ドーム利用券",
    "ドームシティ食事券",
    "複数",
  ]);
  assertEquals(day.receipts.map((receipt) => receipt.total), [
    1000,
    1000,
    1000,
    1000,
    1000,
  ]);
  const reconciled = reconcilePosJournalDayDetail(day);
  assertEquals(reconciled.detailComplete, true);
  assertEquals(reconciled.grossSales, 5000);
  assertEquals(reconciled.reconciledReceiptTotal, 5000);
  assertEquals(reconciled.receipts.length, 5);
});

Deno.test("MARUGO-s keeps no-currency cancellations, explicit discounts, and completed no-pay sales", async () => {
  const text = await Deno.readTextFile(
    new URL(
      "./fixtures/marugos-cancel-discount-nopay.jnl.txt",
      import.meta.url,
    ),
  );
  const day = parsePosJournalText(text, "102220260711230000000001.lzh");
  assertEquals(POS_JOURNAL_REPORT_PARSER_VERSION, "2026-08-30-v21");
  assertEquals(day.receipts.map((receipt) => receipt.no), [
    "1001",
    "1002",
    "1003",
  ]);
  assertEquals(day.receipts.map((receipt) => receipt.pay), [
    "QRコード",
    "クレジット",
    "支払情報なし",
  ]);
  assertEquals(day.receipts[0].items.map((item) => item.amount), [
    12800,
    -12800,
    6000,
    600,
  ]);
  assertEquals(day.receipts[1].items.at(-1), {
    code: "__journal_adjustment__",
    name: "割引",
    unit: -1470,
    qty: 1,
    amount: -1470,
    category: "その他",
    isCharge: false,
  });
  assertEquals(
    day.receipts[2].items
      .filter((item) => item.code === "__journal_adjustment__")
      .map((item) => item.amount),
    [-50, 50],
  );
  const reconciled = reconcilePosJournalDayDetail(day);
  assertEquals(reconciled.detailComplete, true);
  assertEquals(reconciled.reason, "matched");
  assertEquals(reconciled.reconciledReceiptTotal, 20330);
  assertEquals(reconciled.reconciledItemTotal, 20330);
  assertEquals(reconciled.itemMismatchReceiptCount, 0);
  const summary = buildPosJournalSummary({
    storeKey: "marugos",
    storeName: "マルゴエス",
    storeCode: "1022",
    month: "2026-07",
    fileCount: 1,
    days: [day],
  });
  assertEquals(
    summary.item_ranking.some((item) =>
      item.name === "割引" || item.name === "値引" ||
      item.name === "変更前商品"
    ),
    false,
  );
  assertEquals(
    summary.item_ranking.some((item) => item.name === "変更後商品"),
    true,
  );
});

Deno.test("MARUGO-s transaction change removes the referenced sale and VOID copy only", () => {
  const sale = (no: string, time: string, total: string, extra = "") => [
    `0001-01   No.${no}  2026年 7月 2日(木) ${time}`,
    "  0000000000101   マンゴーラッシー",
    `                      @${total}x   1     \\${total}`,
    `合 計                           \\${total}`,
    `        計２       クレジット           \\${total}`,
    ...(extra ? [extra] : []),
    "                               1名",
  ];
  const text = [
    ...sale("4418", "20時41分", "900"),
    ...sale("4419", "20時44分", "900", "★ＶＯＩＤ Ｎｏ．4418"),
    ...sale("4420", "20時44分", "900"),
    "0001-01   No.4499  2026年 7月 2日(木) 23時00分",
    "★★   日計精算レポート   ★★",
    "  営業日付：                    2026年 7月 2日",
    "純 売 上                             \\818",
    "消 費 税                              \\82",
    "総 売 上                             \\900",
    " 会計組数・客数",
    "                  1組                    1名",
  ].join("\r\n");
  const day = parsePosJournalText(text, "102220260702223702060001.lzh");
  assertEquals(day.receipts.map((receipt) => receipt.no), ["4420"]);
  const reconciled = reconcilePosJournalDayDetail(day);
  assertEquals(reconciled.detailComplete, true);
  assertEquals(reconciled.reconciledReceiptTotal, 900);
});

Deno.test("zero-sales settlement is complete even without receipts", () => {
  const text = [
    "0001-01   No.1001  2025年11月12日(水) 22時00分",
    "★★   日計精算レポート   ★★",
    "  営業日付：                    2025年11月12日",
    "純 売 上                               \\0",
    "消 費 税                               \\0",
    "総 売 上                               \\0",
    " 会計組数・客数",
    "                  0組                    0名",
  ].join("\r\n");
  const day = parsePosJournalText(text, "102020251112220006060001.lzh");
  assertEquals(day.business_date, "2025-11-12");
  assertEquals(day.receipts, []);
  assertEquals(day.gross_sales, 0);
  assertEquals(day.parsed_complete, true);
});

Deno.test("zero-sales completion migration targets only the verified source hash", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../supabase/migrations/20260910030000_pos_journal_zero_sales_complete_marker.sql",
      import.meta.url,
    ),
  );
  assertEquals(sql.includes("2025-11-12"), true);
  assertEquals(sql.includes("102020251112220006060001.lzh"), true);
  assertEquals(
    sql.includes("596da7196b5b52a2ebd989e72c9b1eb2fe60c2939f6c916b55e2b4ab9d6c6386"),
    true,
  );
  assertEquals(sql.includes("jsonb_set"), true);
  assertEquals(sql.includes("parsed_complete"), true);
});

Deno.test("journal parser preserves negative cancellation item rows", () => {
  const text = [
    "0001-01   No.1001  2026年 6月 2日(火) 20時32分",
    "  0000000000101   コース６品",
    "                      @8,000x   2     \\16,000",
    "  0000000000101   コース６品",
    "                      @8,000x  -1     \\-8,000",
    "合 計                         \\8,000",
    "        計１       クレジット         \\8,000",
    "                               1名",
    "0001-01   No.1002  2026年 6月 2日(火) 22時19分",
    "★★   日計精算レポート   ★★",
    "  営業日付：                    2026年 6月 2日",
    "純 売 上                           \\7,273",
    "消 費 税                             \\727",
    "総 売 上                           \\8,000",
    " 会計組数・客数",
    "                  1組                    1名",
    " クレジット計",
    "                  1回               \\8,000",
  ].join("\r\n");
  const day = parsePosJournalText(text, "101520260602221907580001.lzh");
  assertEquals(day.receipts[0].items, [
    {
      code: "0000000000101",
      name: "コース６品",
      unit: 8000,
      qty: 2,
      amount: 16000,
    },
    {
      code: "0000000000101",
      name: "コース６品",
      unit: 8000,
      qty: -1,
      amount: -8000,
    },
  ]);
  assertEquals(
    day.receipts[0].items.reduce((sum, item) => sum + item.amount, 0),
    8000,
  );
});
