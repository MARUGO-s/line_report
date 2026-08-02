import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const htmlPath = new URL('../public/jnm/jnl2txt.html', import.meta.url);
const indexPath = new URL('../public/jnm/index.html', import.meta.url);
const historyPath = new URL('../public/jnm/ai-chat-pdf-history.html', import.meta.url);
const appThemePath = new URL('../public/jnm/app-theme.js', import.meta.url);
const html = await readFile(htmlPath, 'utf8');
const indexHtml = await readFile(indexPath, 'utf8');
const historyHtml = await readFile(historyPath, 'utf8');
const appThemeJs = await readFile(appThemePath, 'utf8');
const aiAnalyzeSource = await readFile(
  new URL('../supabase/functions/ai-analyze/index.ts', import.meta.url),
  'utf8',
);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const context = {
  SAVED_DATA_CLARIFICATION_MARKER: '保存データの分析対象を選んでください',
  AI_INTENT_CLARIFICATION_MARKER: '知りたい内容を具体化してください',
  monthKeyFromReport(report) {
    const text = String(report?.period || report?.title || '');
    const iso = text.match(/(20\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}`;
    const ja = text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月/);
    return ja ? `${ja[1]}-${String(Number(ja[2])).padStart(2, '0')}` : null;
  },
};
vm.createContext(context);
for (const name of [
  'extractAllMonthRefs',
  'resolveComparisonTimeRefs',
  'isSelfContainedAiQuestion',
  'applyAiClarificationCorrection',
  'resolveNaturalClarificationChoice',
  'resolveSavedDataClarificationReply',
  'resolveAiIntentClarificationReply',
  'needsAiIntentClarification',
  'countRecentClarificationsByKind',
  'countRecentIntentClarifications',
  'shouldAskAiIntentClarification',
  'buildAiIntentClarificationReply',
  'buildSavedDataNaturalClarificationReply',
  'normalizeAiClarificationText',
  'wantsItemBreakdown',
  'collectProductsFromReport',
  'isCourseProductName',
  'productMatchesRequestedIntent',
  'selectRequestedProductsForQuery',
  'summarizeCourseTransactionsFromReports',
  'buildSavedReportCoverage',
  'formatCoverageMonth',
  'isMonthlyReportTitle',
  'mergeMonthlyAndDailyReportIndex',
  'selectReportsForSavedMonthGroup',
  'resolveIndexedSavedRangeIntent',
  'buildSavedDataClarificationReply',
]) {
  vm.runInContext(`${extractFunction(html, name)}; this.${name} = ${name};`, context);
}
const naturalClarificationRequestSource = extractFunction(html, 'requestNaturalIntentClarification');
const savedReportSearchSource = extractFunction(html, 'searchSavedReportsByQuery');
const forecastHistorySource = extractFunction(html, 'collectMonthlyHistoryForForecast');

const reports = [
  { id: '202405', period: '2024年5月1日〜2024年5月31日' },
  { id: '202605', period: '2026-05-01〜2026-05-31' },
  { id: '202606', period: '2026-06-01〜2026-06-30' },
  { id: '202607', period: '2026年7月1日〜2026年7月31日' },
];

test('saved report coverage uses the actual oldest and latest stored months', () => {
  const coverage = context.buildSavedReportCoverage(reports);
  assert.deepEqual([...coverage.keys], ['2024-05', '2026-05', '2026-06', '2026-07']);
  assert.equal(coverage.first, '2024-05');
  assert.equal(coverage.last, '2026-07');
  assert.equal(coverage.monthCount, 4);
});

test('monthly report index excludes same-month daily rows and preserves every daily row for missing months', () => {
  const monthly = [
    { id: 'monthly-202607', title: '2026年7月 月間レポート', period: '2026-07-01〜2026-07-31' },
  ];
  const daily = [
    { id: 'daily-20260701', title: '2026年7月1日 日別レポート', period: '2026-07-01' },
    { id: 'daily-20260702', title: '2026年7月2日 日別レポート', period: '2026-07-02' },
    { id: 'daily-20260601', title: '2026年6月1日 日別レポート', period: '2026-06-01' },
    { id: 'daily-20260602', title: '2026年6月2日 日別レポート', period: '2026-06-02' },
  ];

  const merged = context.mergeMonthlyAndDailyReportIndex(monthly, daily);
  assert.deepEqual(
    [...merged.filter(row => context.monthKeyFromReport(row) === '2026-07')].map(row => row.id),
    ['monthly-202607'],
  );
  assert.deepEqual(
    [...merged.filter(row => context.monthKeyFromReport(row) === '2026-06')]
      .map(row => row.id)
      .sort(),
    ['daily-20260601', 'daily-20260602'],
  );
});

test('saved monthly reports outrank an active partial report and every supported monthly title is recognized', () => {
  const active = { id: 'active', title: '2026年7月 月間レポート', period: '2026-07', total: 100 };
  const saved = { id: 'saved', title: '2026年7月 月別レポート', period: '2026-07', total: 200 };
  assert.deepEqual(
    [...context.selectReportsForSavedMonthGroup([active, saved], active)].map(row => row.id),
    ['saved'],
  );
  assert.equal(context.isMonthlyReportTitle('2026年7月 月間レポート'), true);
  assert.equal(context.isMonthlyReportTitle('2026年7月 月別レポート'), true);
  assert.equal(context.isMonthlyReportTitle('合算売上レポート（2026年7月）'), true);
  assert.equal(context.isMonthlyReportTitle('合算日別売上レポート（2026年7月）'), false);
  const daily = [
    { id: 'd1', title: '2026年6月1日 日別レポート' },
    { id: 'd2', title: '2026年6月2日 日別レポート' },
  ];
  assert.deepEqual(
    [...context.selectReportsForSavedMonthGroup(daily, active)].map(row => row.id),
    ['d1', 'd2'],
  );
  const activeDaily = { id: 'same-day', title: '2026年6月1日 日別レポート', period: '2026-06-01' };
  const savedDaily = { ...activeDaily, source: 'cloud' };
  const deduped = [...context.selectReportsForSavedMonthGroup([activeDaily, savedDaily, daily[1]], activeDaily)];
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0], savedDaily, 'the cloud row replaces the same-ID active report');
});

test('latest, recent, and all-period intents select only the required reports', () => {
  assert.deepEqual(
    [...context.resolveIndexedSavedRangeIntent('最新月を分析して', reports).matched].map(x => x.id),
    ['202607'],
  );
  assert.deepEqual(
    [...context.resolveIndexedSavedRangeIntent('直近3か月の推移', reports).matched].map(x => x.id),
    ['202605', '202606', '202607'],
  );
  assert.deepEqual(
    [...context.resolveIndexedSavedRangeIntent('保存済み全期間を分析', reports).matched].map(x => x.id),
    ['202405', '202605', '202606', '202607'],
  );
});

test('a numeric reply to the clarification question becomes a searchable range intent', () => {
  const history = [{
    role: 'assistant',
    content: context.buildSavedDataClarificationReply(context.buildSavedReportCoverage(reports)),
  }];
  assert.match(context.resolveSavedDataClarificationReply('1', history), /^最新月/);
  assert.match(context.resolveSavedDataClarificationReply('2 売上推移', history), /^直近3か月/);
  assert.match(context.resolveSavedDataClarificationReply('4', history), /^全期間/);
});

test('ambiguous questions ask for an analysis focus before loading detailed data', () => {
  assert.equal(context.needsAiIntentClarification('2026年5月の売上を分析して'), true);
  assert.equal(context.needsAiIntentClarification('売上を比較して'), true);
  assert.equal(context.needsAiIntentClarification('2026年5月の売上推移を見せて'), false);
  assert.equal(context.needsAiIntentClarification('2026年5月の客単価は？'), false);
  assert.equal(context.needsAiIntentClarification('2026年5月と6月の売上を比較して'), false);
  const reply = context.buildAiIntentClarificationReply('2026年5月の売上を分析して');
  assert.match(reply, /2026年5月/);
  assert.match(reply, /売上|推移/);
  assert.match(reply, /[？?]$/);
  assert.doesNotMatch(reply, /(?:^|\n)\s*[1-9][.、)]/);
});

test('clarification metadata keeps the original question when the user replies naturally', () => {
  const history = [
    { role: 'user', content: '2026年5月の売上を分析して' },
    {
      role: 'assistant',
      content: '全体の推移と変化の理由のどちらを優先して見たいですか？',
      clarification: 'intent',
    },
    { role: 'user', content: '客数の変化を中心に理由も知りたい' },
  ];
  const resolved = context.resolveAiIntentClarificationReply(
    '客数の変化を中心に理由も知りたい',
    history,
  );
  assert.equal(resolved, '2026年5月の売上を分析して 客数の変化を中心に理由も知りたい');
});

test('natural clarification choices resolve 前者 without another AI call', () => {
  const history = [
    { role: 'user', content: '2026年7月の売上を比較して' },
    {
      role: 'assistant',
      content: '前月との比較と前年同月との比較では、どちらが近いですか？',
      clarification: 'intent',
      originalQuery: '2026年7月の売上を比較して',
      clarificationChoices: ['前月との比較', '前年同月との比較'],
    },
    { role: 'user', content: '前者' },
  ];
  assert.equal(
    context.resolveAiIntentClarificationReply('前者', history),
    '2026年7月の売上を比較して 前月との比較',
  );
});

test('period clarification keeps the analysis focus and a complete new request replaces it', () => {
  const history = [
    { role: 'user', content: 'ワインの実績はどう？' },
    {
      role: 'assistant',
      content: '最新月と直近数か月のどちらを見ますか？',
      clarification: 'period',
      originalQuery: 'ワインの実績はどう？',
    },
    { role: 'user', content: '直近3か月' },
  ];
  assert.equal(
    context.resolveSavedDataClarificationReply('直近3か月', history),
    'ワインの実績はどう？ 直近3か月',
  );
  assert.equal(
    context.resolveSavedDataClarificationReply('おまかせ', history),
    'ワインの実績はどう？ 保存済み最新月を対象に全体分析',
  );
  assert.equal(
    context.resolveSavedDataClarificationReply('全部', history),
    'ワインの実績はどう？ 保存済み全期間',
  );
  assert.equal(
    context.resolveSavedDataClarificationReply('半年', history),
    'ワインの実績はどう？ 直近半年',
  );
  assert.equal(
    context.resolveSavedDataClarificationReply('3か月', history),
    'ワインの実績はどう？ 直近3か月',
  );
  assert.equal(
    context.resolveSavedDataClarificationReply('2026年7月の商品内訳を見せて', history),
    '2026年7月の商品内訳を見せて',
  );
  const natural = context.buildSavedDataNaturalClarificationReply(
    'ワインの実績はどう？',
    context.buildSavedReportCoverage(reports),
  );
  assert.match(natural, /2024年5月/);
  assert.match(natural, /2026年7月/);
  assert.match(natural, /[？?]$/);
  assert.doesNotMatch(natural, /(?:^|\n)\s*[1-9][.、)]/);
});

test('a correction replaces the old month instead of adding a conflicting period', () => {
  const history = [
    { role: 'user', content: '2026年5月の売上を分析して' },
    {
      role: 'assistant',
      content: '推移と原因のどちらを見たいですか？',
      clarification: 'intent',
      originalQuery: '2026年5月の売上を分析して',
    },
    { role: 'user', content: '違う、6月' },
  ];
  assert.equal(
    context.resolveAiIntentClarificationReply('違う、6月', history),
    '2026年6月の売上を分析して',
  );
  assert.equal(
    context.resolveAiIntentClarificationReply('違う、6月の商品内訳', history),
    '2026年6月 商品内訳',
  );
  assert.equal(context.isSelfContainedAiQuestion('今年の客単価を見せて'), true);
  assert.equal(context.isSelfContainedAiQuestion('2026年全体の商品構成'), true);
});

test('relative comparisons expand to two absolute saved periods', () => {
  assert.equal(
    context.resolveComparisonTimeRefs('2026年7月を前月と比較して', '2026-07'),
    '2026年7月を2026年6月と比較して',
  );
  assert.equal(
    context.resolveComparisonTimeRefs('2026年7月を前年同月と比較して', '2026-07'),
    '2026年7月を2025年7月と比較して',
  );
  const latest = context.resolveComparisonTimeRefs('前月比を見せて', '2026-07');
  assert.match(latest, /2026年7月/);
  assert.match(latest, /2026年6月/);
  assert.equal(context.extractAllMonthRefs(latest).length, 2);
});

test('AI clarification text is normalized and template-like numbered lists are rejected', () => {
  assert.equal(
    context.normalizeAiClarificationText('### 確認\n客数と客単価のどちらを見たいですか'),
    '確認\n客数と客単価のどちらを見たいですか？',
  );
  assert.equal(
    context.normalizeAiClarificationText('1. 売上推移\n2. 商品構成'),
    '',
  );
});

test('period clarification requires a grounded period before accepting an AI ready plan', () => {
  assert.match(naturalClarificationRequestSource, /\bperiodIsSafe\b/);
  const readyReturnIndex = naturalClarificationRequestSource.indexOf("status: 'ready'");
  assert.notEqual(readyReturnIndex, -1, 'the natural clarifier must still support a ready plan');
  const readyGuardWindow = naturalClarificationRequestSource.slice(
    Math.max(0, readyReturnIndex - 1200),
    readyReturnIndex,
  );
  assert.match(
    readyGuardWindow,
    /\bperiodIsSafe\b/,
    'periodIsSafe must participate in the guard immediately before a ready plan is accepted',
  );
});

test('saved report search distinguishes an unavailable cloud lookup from a verified miss', () => {
  assert.match(savedReportSearchSource, /\bcloudLookupUnavailable\b/);
  assert.match(savedReportSearchSource, /\bunavailableCloudResult\s*\(/);
  assert.match(
    savedReportSearchSource,
    /cloudLookupUnavailable[\s\S]{0,800}unavailableCloudResult\s*\(/,
    'a cloud lookup failure must be routed to loadError even when currentReport exists',
  );
  assert.match(
    forecastHistorySource,
    /\bloadError\b[\s\S]*\bsavedReportsLoadError\b/,
    'forecast history must expose partial cloud or hydration failures instead of treating them as missing months',
  );
  assert.match(html, /if \(bundle\.loadError\) throw new Error\(bundle\.loadError\)/);
});

test('item-detail limits keep full-period totals and propagate detail hydration failures', () => {
  assert.match(
    savedReportSearchSource,
    /for \(const \[, group\] of monthEntries\)[\s\S]{0,240}summaryReports\.push/,
    'all month groups must remain in the core summary',
  );
  assert.match(
    savedReportSearchSource,
    /detailEntries\s*=\s*detailRangeLimited\s*\?\s*monthEntries\.slice\(0,\s*36\)\s*:\s*monthEntries/,
    'only detail hydration may be limited to the newest 36 months',
  );
  assert.match(savedReportSearchSource, /productSources\s*=\s*needsItemDetails\s*\?\s*detailHydrated\s*:\s*use/);
  assert.match(
    savedReportSearchSource,
    /selectRequestedProductsForQuery\(mergedProducts, q, 40\)/,
    'specific low-selling bottle/course items must be filtered before applying the result limit',
  );
  assert.match(savedReportSearchSource, /if \(hydrationFailed\) return unavailableCloudResult\(\)/);
});

test('bottle and course questions load exact journal items without double counting summaries', () => {
  assert.equal(context.wantsItemBreakdown('2026年7月のボトル本数を教えて'), true);
  assert.equal(context.wantsItemBreakdown('コース別売上を見たい'), true);
  assert.equal(context.wantsItemBreakdown('ワインの杯数は？'), true);
  assert.equal(context.wantsItemBreakdown('2026年7月の総売上は？'), false);

  const report = {
    topProducts: [{ name: 'Bottle Wine', qty: 8, amt: 96000, category: 'ドリンク' }],
    sales: [{
      customers: 4,
      groups: 2,
      items: [
        { name: 'Bottle Wine', qty: 8, amount: 96000, category: 'ドリンク' },
        { name: 'コース６品', qty: 4, amount: 32000, category: 'フード' },
        { name: 'Glass Wine', qty: 3, amount: 3600, category: 'ドリンク' },
      ],
    }],
  };
  const products = context.collectProductsFromReport(report);
  const bottle = products.find(row => row.name === 'Bottle Wine');
  assert.deepEqual({ qty: bottle.qty, amt: bottle.amt }, { qty: 8, amt: 96000 });

  const selected = context.selectRequestedProductsForQuery(products, 'ボトル本数とコース別売上', 20);
  assert.deepEqual([...selected].map(row => row.name).sort(), ['Bottle Wine', 'コース６品']);

  const courseTransactions = context.summarizeCourseTransactionsFromReports([report]);
  assert.deepEqual(
    { ...courseTransactions },
    { transactionCount: 1, groupCount: 2, customerCount: 4, hasDetailedSales: true },
  );

  const summaryOnly = context.collectProductsFromReport({ topProducts: report.topProducts });
  assert.deepEqual(
    { qty: summaryOnly[0].qty, amt: summaryOnly[0].amt },
    { qty: 8, amt: 96000 },
  );
  assert.match(html, /予約人数の専用項目: なし/);
  assert.match(html, /宴会件数の専用項目: なし/);
  assert.match(html, /保存DB全体に存在しないとは断定しない/);
  assert.doesNotMatch(html, /該当期間の保存データには \*\*商品別の明細/);
});

test('intent clarification stops after two consecutive rounds to avoid a question loop', () => {
  const oneRound = [
    { role: 'user', content: '売上を分析して' },
    { role: 'assistant', content: '何を優先しますか？', clarification: 'intent' },
    { role: 'user', content: 'もう少し詳しく' },
  ];
  const twoRounds = [
    ...oneRound,
    { role: 'assistant', content: 'どの観点を詳しくしますか？', clarification: 'intent' },
    { role: 'user', content: 'いい感じに見て' },
  ];
  assert.equal(context.countRecentIntentClarifications(oneRound), 1);
  assert.equal(context.shouldAskAiIntentClarification('もう少し詳しく', oneRound), true);
  assert.equal(context.countRecentIntentClarifications(twoRounds), 2);
  assert.equal(context.shouldAskAiIntentClarification('いい感じに見て', twoRounds), false);
  assert.equal(context.countRecentClarificationsByKind(twoRounds, 'intent'), 2);
  assert.equal(context.countRecentClarificationsByKind(twoRounds, 'period'), 0);
  assert.equal(context.shouldAskAiIntentClarification('おまかせ', oneRound), false);
  assert.equal(context.shouldAskAiIntentClarification('全部見て', oneRound), false);
  const mixedRounds = [
    { role: 'user', content: '売上を見て' },
    { role: 'assistant', content: '何を知りたいですか？', clarification: 'intent' },
    { role: 'user', content: '客単価' },
    { role: 'assistant', content: 'どの期間を見ますか？', clarification: 'period' },
    { role: 'user', content: 'いい感じに' },
  ];
  assert.equal(context.countRecentIntentClarifications(mixedRounds), 1);
  assert.equal(context.countRecentClarificationsByKind(mixedRounds, 'intent'), 1);
  assert.equal(context.countRecentClarificationsByKind(mixedRounds, 'period'), 1);
  assert.equal(context.shouldAskAiIntentClarification('いい感じに', mixedRounds), true);
});

test('both Journal Report entry files keep the planner and error distinction in sync', () => {
  assert.equal(indexHtml, html);
  assert.match(html, /needsClarification/);
  assert.match(html, /needsIntentClarification/);
  assert.match(html, /AI_INTENT_CLARIFICATION_MARKER/);
  assert.match(html, /データが無いとは判断していません/);
  assert.match(html, /local-query-planner/);
  assert.match(naturalClarificationRequestSource, /action:\s*['"]clarify['"]/);
  assert.match(naturalClarificationRequestSource, /purpose:\s*['"]clarification_only['"]/);
  assert.doesNotMatch(naturalClarificationRequestSource, /salesData\s*:/);
  assert.match(naturalClarificationRequestSource, /slice\(0, -1\)/);
  assert.match(naturalClarificationRequestSource, /slice\(-6\)/);
  assert.match(aiAnalyzeSource, /action === "clarify"/);
  assert.match(aiAnalyzeSource, /CLARIFICATION_PROMPT/);
  assert.match(aiAnalyzeSource, /一度に質問するのは最も重要な一つだけ/);
  assert.match(aiAnalyzeSource, /max_completion_tokens: 800/);
  assert.match(aiAnalyzeSource, /max_tokens: 350/);
  assert.match(aiAnalyzeSource, /fetchTextWithTimeout/);
  assert.match(aiAnalyzeSource, /\.slice\(-12\)/);
  assert.match(aiAnalyzeSource, /slice\(0, 1600\)/);
  assert.match(html, /aiChatHistory\.slice\(0, -1\)\.slice\(-12\)/);
  assert.match(html, /originalQuery:\s*resolvedChatQuery/);
  assert.match(html, /salesData:\s*salesDataForAi/);
  assert.match(
    html,
    /needsClarification\s*&&\s*countRecentClarificationsByKind\(aiChatHistory,\s*['"]period['"]\)\s*>=\s*2/,
  );
});

test('Journal Report pages default to light while preserving an explicit dark choice', () => {
  assert.match(historyHtml, /localStorage\.getItem\(KEY\) \|\| 'light'/);
  assert.match(historyHtml, /=== 'dark' \? 'dark' : 'light'/);
  assert.match(historyHtml, /catch\(_\) \{ return 'light'; \}/);
  assert.match(appThemeJs, /String\(v \|\| 'light'\)/);
  assert.match(appThemeJs, /catch \(_\) \{ return 'light'; \}/);
});

test('mobile AI chat follows the visual viewport and keeps its composer visible', () => {
  assert.match(html, /height: var\(--ai-viewport-height, 100dvh\)/);
  assert.match(html, /top: var\(--ai-viewport-top, 0px\)/);
  assert.match(html, /window\.visualViewport\.addEventListener\('resize'/);
  assert.match(html, /window\.visualViewport\.addEventListener\('scroll'/);
  assert.match(html, /input\.scrollIntoView\(\{ block: 'nearest'/);
  assert.match(html, /font-size: 16px;/);
  assert.match(html, /!e\.isComposing/);
});
