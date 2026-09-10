import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("sales screens share the notice renderer and journal summary stays store-scoped", () => {
  for (
    const file of [
      "analytics.html",
      "foodcourt.html",
      "pos-journal.html",
      "jnm/jnl2txt.html",
    ]
  ) {
    assert.match(read("public/" + file), /sales-source-notice\.js/);
    assert.match(read("public/" + file), /LINE_REPORT_SALES/);
  }
  const api = read("supabase/functions/admin-api/index.ts");
  assert.ok(api.includes('"GET /pos-journals/sales-summary"'));
  assert.ok(api.includes('"/pos-journals/sales-summary",'));
  assert.match(
    api,
    /fetchUnifiedSalesSummary\(supabase, normalizePosJournalStoreKey/,
  );
  assert.match(api, /!validSalesDate\(from\)/);
});

test("notice displays exact differences as text, supports tax edits, and clears old content", () => {
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.style = {};
      this.textContent = "";
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren() {
      this.children = [];
      this.textContent = "";
    }
    get text() {
      return [this.textContent, ...this.children.map((c) => c.text)].join("\n");
    }
  }
  const window = {};
  vm.runInNewContext(read("public/sales-source-notice.js"), {
    window,
    document: { createElement: (t) => new Element(t) },
  });
  const root = new Element("div");
  let edited;
  const day = {
    date: "2026-01-01 <img onerror=bad()>",
    sales_source: "mixed",
    journal_values: {},
    receipt_values: {},
    source_by_field: { gross_sales_yen: "manual" },
    tax_needs_review: true,
    source_differences: [{
      field: "gross_sales_yen",
      journal: 1100,
      receipt: 1000,
      difference: 100,
    }],
  };
  window.LINE_REPORT_SALES.render(root, {
    series: [day],
    totals: {
      gross_sales_yen: 1200,
      net_sales_yen: 0,
      net_sales_known: false,
      guest_count: 5,
      party_count: 2,
    },
  }, { onTaxEdit: (d) => edited = d });
  assert.match(root.text, /日別修正 → ジャーナル確定日計 → レシート/);
  assert.match(root.text, /1,100円.*1,000円.*\+100円/);
  assert.match(root.text, /税抜 未確定/);
  const walk = (n) => [n, ...n.children.flatMap(walk)];
  assert.equal(walk(root).some((n) => n.tag === "img"), false);
  walk(root).find((n) => n.tag === "button").onclick();
  assert.equal(edited, day);
  window.LINE_REPORT_SALES.render(root, {
    series: [],
    monthly_fallbacks: [{ month: "2026-01" }],
    totals: {
      gross_sales_yen: 3000,
      net_sales_known: false,
      guest_count: 4,
      party_count: 2,
    },
  });
  assert.match(root.text, /月次登録値/);
  assert.doesNotMatch(root.text, /1,100円|onerror/);
});

test("reports and sheet exports use shared daily source; cron links never embed admin secret", () => {
  for (
    const file of [
      "receipt_reply_context.ts",
      "receipt_report_aggregate.ts",
      "receipt_sheets_pilot_sync.ts",
      "admin_receipt_sales.ts",
    ]
  ) {
    assert.match(
      read("supabase/functions/_shared/" + file),
      /fetchUnifiedDailySales/,
    );
  }
  const cron = read(
    "supabase/functions/receipt-midreport-cron/functions/_shared/receipt_report_flex.ts",
  );
  assert.doesNotMatch(cron, /ADMIN_DASHBOARD_TOKEN/);
  assert.match(cron, /buildReceiptAnalyticsDashboardUrlForLine/);
  const jnm = read("public/jnm/jnl2txt.html");
  assert.match(jnm, /unifiedSalesPending/);
  assert.match(jnm, /currentReport\s*!==\s*report/);
});

test('receipt-equivalent imports preserve higher-priority daily sources',()=>{
  const code=read('supabase/functions/_shared/daily_sales_import.ts');
  const tail=code.slice(code.indexOf('// 1) 対象日（0の日も含む）の既存レシートを全消し'));
  assert.doesNotMatch(tail,/from\("line_sales_manual_day"\)/);
  assert.match(tail,/const clearedManualDay = 0/);
});
