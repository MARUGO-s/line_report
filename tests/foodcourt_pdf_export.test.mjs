import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/foodcourt.html', import.meta.url), 'utf8');
const reportSource = source.slice(source.indexOf('  function openReportWindow('), source.indexOf('  // レポート出力用のグラフデータを、'));
const sample = '【質問】\n検証用の質問\n【回答】\nこれは合成データです。\n| 指標 | 保守 | 標準 | 強気 |\n| --- | --- | --- | --- |\n| 検証 | 10 | 20 | 30 |\n【末尾】\nEND-OF-REPORT';

function harness(userAgent = 'Chrome/145.0 Safari/537.36') {
  const urls = new Map();
  const links = [];
  const timers = [];
  const overlays = [];
  const context = vm.createContext({
    Blob, console, navigator: { userAgent }, location: { href: 'https://example.test/line_report/foodcourt.html' },
    STORE_NAMES: { test: '検証用店舗' }, currentStore: () => 'test',
    escapeHtml: (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    URL: class extends URL {
      static createObjectURL(blob) { const url = `blob:test/${urls.size}`; urls.set(url, blob); return url; }
      static revokeObjectURL(url) { urls.delete(url); }
    },
    document: {
      createElement: () => ({ click() { links.push(this); } }),
      body: { appendChild() {}, removeChild() {} },
    },
    window: {},
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); },
  });
  vm.runInContext(reportSource, context);
  context.showReportOverlay = (html) => overlays.push(html);
  return { context, urls, links, timers, overlays };
}

test('all browsers keep the report in a connected frame without Blob, popup or timer dependency', () => {
  for (const ua of ['Version/26.0 Safari/605.1.15', 'Chrome/145.0 Safari/537.36', 'iPhone CriOS/145.0', 'iPad FxiOS/145.0', 'Line/15.0', 'Firefox/145.0']) {
    const h = harness(ua);
    h.context.openReportWindow('PDF検証', sample, null);
    for (const timer of h.timers) timer.callback();
    assert.equal(h.links.length, 0, ua);
    assert.equal(h.urls.size, 0, ua);
    assert.equal(h.timers.length, 0, ua);
    assert.match(h.overlays[0], /END-OF-REPORT/);
  }
});

test('repeated output builds the next report without changing the earlier report text', () => {
  const h = harness();
  h.context.openReportWindow('一つ目', sample, null);
  h.context.openReportWindow('二つ目', sample + '\\nSECOND-REPORT', null);
  assert.match(h.overlays[0], /END-OF-REPORT/);
  assert.doesNotMatch(h.overlays[0], /SECOND-REPORT/);
  assert.match(h.overlays[1], /SECOND-REPORT/);
});

test('overlay attaches a titled srcdoc frame, replaces only itself, and closes back to the source page', () => {
  const h = harness();
  const children = [];
  const makeElement = (tag) => ({
    tag, style: {}, children: [], attributes: {}, handlers: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(event, callback) { this.handlers[event] = callback; },
    appendChild(child) { this.children.push(child); },
    remove() { const i = children.indexOf(this); if (i >= 0) children.splice(i, 1); },
  });
  h.context.document = { createElement: makeElement, body: { style: {}, appendChild: child => children.push(child) } };
  h.context.$ = id => children.find(child => child.id === id);
  // Exercise the actual DOM lifecycle, not the interception used by the opener tests.
  vm.runInContext(reportSource, h.context);
  h.context.openReportWindow('一つ目', sample, null);
  assert.equal(children.length, 1);
  const frame = children[0].children.find(child => child.tag === 'iframe');
  assert.equal(frame.title, 'AI分析レポート（印刷用）');
  assert.match(frame.attributes.srcdoc, /END-OF-REPORT/);
  assert.equal(h.context.document.body.style.overflow, 'hidden');
  h.context.openReportWindow('二つ目', 'NEXT-REPORT', null);
  assert.equal(children.length, 1);
  assert.match(children[0].children.find(child => child.tag === 'iframe').attributes.srcdoc, /NEXT-REPORT/);
  children[0].children.find(child => child.tag === 'button').handlers.click();
  assert.equal(children.length, 0);
  assert.equal(h.context.document.body.style.overflow, '');
});

test('report preserves Japanese, scenario table, long text and escaped user content', () => {
  const h = harness();
  const html = h.context.buildReportHtml('<img src=x onerror=alert(1)>', sample + '\n' + '長文の検証です。\n'.repeat(300) + '<script>alert(1)</script>\nLONG-END', null);
  assert.match(html, /<meta charset="UTF-8"/i);
  assert.match(html, /検証用店舗/);
  assert.match(html, /<table/);
  assert.match(html, /保守/);
  assert.match(html, /LONG-END/);
  assert.doesNotMatch(html, /<img src=x|<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /https:\/\/example\.test\/line_report\/vendor\/chart\.umd\.min\.js/);
});

test('print styling hides controls, not the report body', () => {
  const html = harness().context.buildReportHtml('印刷検証', sample, null);
  const css = html.slice(html.indexOf('@media print'), html.indexOf('</style>'));
  assert.match(css, /\.no-print-bar/);
  assert.doesNotMatch(css, /(?:\.container|\.report-body|body)\s*\{[^}]*display:\s*none/);
  assert.match(html, /<main class="report-body">[\s\S]*END-OF-REPORT/);
});

test('chart rendering failure still opens the text report', () => {
  const h = harness();
  const original = h.context.buildReportHtml;
  h.context.console = { error() {} };
  h.context.buildReportHtml = (title, content, charts) => {
    if (charts) throw new Error('synthetic chart failure');
    return original(title, content, charts);
  };
  h.context.openReportWindow('本文フォールバック', sample, { invalid: true });
  assert.match(h.overlays[0], /END-OF-REPORT/);
});

test('Q&A, summary, daily and weekly archives share the fixed report opener', () => {
  for (const [start, end] of [
    ['window.exportSingleQa =', 'window.exportQaConversation ='],
    ['window.exportQaConversation =', 'window.exportSummary ='],
    ['window.exportSummary =', '// レポート出力用のグラフデータを、'],
    ['function openArchivedDailyReport(', 'function openArchivedWeeklyReport('],
    ['function openArchivedWeeklyReport(', 'function buildWeeklyChartData('],
  ]) {
    const begin = source.indexOf(start);
    const finish = source.indexOf(end, begin + start.length);
    assert.ok(begin >= 0 && finish > begin, `missing source boundary: ${start}`);
    assert.match(source.slice(begin, finish), /openReportWindow\(/);
  }
});

test('Q&A PDF uses the editorial layout instead of red number highlights', () => {
  const h = harness();
  const answer = [
    '【結論】',
    '焼きたてクロワッサンは**入口商品**として有望です。',
    '',
    '【数字から見た判断】',
    '客数は125人、売上は¥239,577でした。',
    '',
    '施策案：ライブ日限定',
    '| 対象客 | 若年女性ライブ来場者 |',
    '| 実施内容 | ・紙袋でテイクアウト |',
    '| 判定・中止ライン | まず1〜2回のライブ日で検証する |',
    '',
    '注釈: この表の数値はすべて【仮定(シナリオ)】',
    '| 項目 | 保守 | 標準 | 強気 |',
    '| --- | --- | --- | --- |',
    '| 予想売価 | ¥380 | ¥420 | ¥480 |',
    '',
    '【最終判断】',
    '大量常備ではなく限定テストを支持します。',
  ].join('\n');
  h.context.qaHistory = [
    { role: 'user', content: 'クロワッサンをお出ししようと思っています。どう思いますか？' },
    { role: 'assistant', content: answer, score: 82 },
  ];
  const items = h.context.collectQaExportItems();
  assert.equal(items.length, 1);
  const body = h.context.buildQaExportBodyHtml(items);
  const page = h.context.buildReportHtml('検証', '', null, {
    theme: 'qa',
    preformattedHtml: body,
    subtitle: '焼きたてクロワッサン施策について相談した回答例',
    questionCount: 1,
  });
  assert.match(page, /売上分析AI/);
  assert.match(page, /body class="qa-theme"/);
  assert.match(page, /qa-callout/);
  assert.match(page, /qa-callout-label">結論/);
  assert.match(page, /qa-callout-label">最終判断/);
  assert.match(page, /qa-h2/);
  assert.match(page, /数字から見た判断/);
  assert.match(page, /qa-table-kv/);
  assert.match(page, /判定・中止ライン/);
  assert.doesNotMatch(page, /qa-th">判定</);
  assert.match(page, /qa-caption/);
  assert.match(page, /仮定\(シナリオ\)/);
  assert.match(page, /<strong>入口商品<\/strong>/);
  assert.match(body, /Q1/);
  assert.match(body, /82点/);
  assert.doesNotMatch(page, /color: #E74C3C/);
  assert.doesNotMatch(page, />AI分析レポート</);
});

test('conversation PDF builds a scored table of contents and skips clarifications', () => {
  const h = harness();
  h.context.qaHistory = [
    { role: 'user', content: '質問A' },
    { role: 'assistant', content: '【結論】Aです', score: 80 },
    { role: 'user', content: '期間は？' },
    { role: 'assistant', clarification: true, content: '期間を選んでください', choices: ['今月'] },
    { role: 'user', content: '質問B' },
    { role: 'assistant', content: '【判断】Bです', score: 70 },
  ];
  const items = h.context.collectQaExportItems();
  assert.equal(items.length, 2);
  const html = h.context.buildQaExportBodyHtml(items);
  assert.match(html, /qa-toc/);
  assert.match(html, /Q1/);
  assert.match(html, /Q2/);
  assert.match(html, /80点/);
  assert.match(html, /70点/);
  assert.doesNotMatch(html, /期間を選んでください/);
  h.context.window.exportQaConversation();
  assert.match(h.overlays[0], /qa-toc/);
  assert.match(h.overlays[0], /売上分析AI/);
});
