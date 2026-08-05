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
  WEEKDAY_ORDER: ['月', '火', '水', '木', '金', '土', '日'],
  AI_KNOWLEDGE_MAX_ITEMS: 5,
  AI_KNOWLEDGE_MAX_CHARS: 6000,
  AI_KNOWLEDGE_MAX_CHUNKS: 12,
  yen: (n) => `¥${Number(n || 0).toLocaleString('ja-JP')}`,
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
  'maskProductCodesInQueryForPeriodParse',
  'extractAllYearRefs',
  'extractPrimaryYearOnlyRef',
  'resolveComparisonTimeRefs',
  'hasAllSavedPeriodIntent',
  'resolveExhaustedPeriodClarificationScope',
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
  'extractYenAmountsFromQuery',
  'extractNamedProductMentions',
  'extractProductCodeHints',
  'extractProductSearchHints',
  'wantsProductTimelineSearch',
  'hasUsableProductTimelineFacts',
  'listTimelineSearchTargets',
  'collectProductsFromReport',
  'isCourseProductName',
  'productMatchesRequestedIntent',
  'selectRequestedProductsForQuery',
  'summarizeCourseTransactionsFromReports',
  'buildSavedReportCoverage',
  'formatCoverageMonth',
  'isMonthlyReportTitle',
  'isCrossMonthAggregateReport',
  'isSingleMonthCanonicalReport',
  'reportSummaryTotal',
  'mergeMonthlyAndDailyReportIndex',
  'selectReportsForSavedMonthGroup',
  'resolveIndexedSavedRangeIntent',
  'buildSavedDataClarificationReply',
  'hasAnsweredDataContext',
  'mentionsExplicitPeriod',
  'wantsSegmentBreakdown',
  'wantsDailyBreakdown',
  'resolveRelativeTimeRefs',
  'extractAllDayRefs',
  'extractDayScope',
  'extractAllRangeRefs',
  'extractRangeRef',
  'extractYearMonthFromText',
  'rangeRefLabel',
  'reportMatchesRangeRef',
  'aggregateSalesRows',
  'sortWeekdayRows',
  'mergeWeekdayBreakdowns',
  'mergeHourlyBreakdowns',
  'formatVerifiedDetailLines',
  'formatMonthlyMealFdTrendLines',
  'summarizeCourseMonthlyFacts',
  'formatCourseLineupFactsForAi',
  'monthEndIso',
  'knowledgePeriodLabel',
  'knowledgeOverlapsPeriod',
  'knowledgeTextSimilarity',
  'knowledgeSearchableText',
  'selectStoreKnowledgeForQuery',
  'selectKnowledgeChunksForQuery',
  'formatStoreKnowledgeBlock',
  'resolveKnowledgePeriodRange',
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
  assert.deepEqual(
    [...context.resolveIndexedSavedRangeIntent('全ての月を対象にしてください', reports).matched].map(x => x.id),
    ['202405', '202605', '202606', '202607'],
  );
  assert.deepEqual(
    [...context.resolveIndexedSavedRangeIntent('全部の期間でコースを比較', reports).matched].map(x => x.id),
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
  assert.match(context.resolveSavedDataClarificationReply('全ての月を対象にしてください', history), /保存済み全期間$/);
});

test('ambiguous questions ask for an analysis focus before loading detailed data', () => {
  assert.equal(context.needsAiIntentClarification('2026年5月の売上を分析して'), true);
  assert.equal(context.needsAiIntentClarification('売上を比較して'), true);
  assert.equal(context.needsAiIntentClarification('2026年5月の売上推移を見せて'), false);
  assert.equal(context.needsAiIntentClarification('2026年5月の客単価は？'), false);
  assert.equal(context.needsAiIntentClarification('2026年5月と6月の売上を比較して'), false);
  // 素の「売上」だけの数値照会は聞き返さずに答える（最も自然で最も多い言い回し）
  assert.equal(context.needsAiIntentClarification('2026年6月の売上は？'), false);
  assert.equal(context.needsAiIntentClarification('6月の売上を教えて'), false);
  assert.equal(context.needsAiIntentClarification('売上はいくら？'), false);
  assert.equal(context.needsAiIntentClarification('2026年6月はいくら？'), false);
  // wantsItemBreakdown が明細を取りに行く語彙は、意図確認で止めない
  for (const q of ['ボトルは何本？', 'コースは何件？', '室料はいくら？', 'シャンパンは何本？', 'ビールは何杯？']) {
    assert.equal(context.needsAiIntentClarification(q), false, q);
    assert.equal(context.wantsItemBreakdown(q) || /室料/.test(q), true, q);
  }
  assert.equal(context.needsAiIntentClarification('2026年7月の曜日別売上は？'), false);
  assert.equal(context.needsAiIntentClarification('ランチの客単価は？'), false);
  // 目的が本当に分からない発話は従来どおり確認する
  for (const q of ['最近どう？', 'どうなってる？', 'ざっくり見て']) {
    assert.equal(context.needsAiIntentClarification(q), true, q);
  }
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
    context.resolveSavedDataClarificationReply('全ての月を対象にしてください', history),
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

test('all-month wording survives the clarification retry guard instead of shrinking to latest month', () => {
  assert.equal(context.hasAllSavedPeriodIntent('全ての月を対象にしてください'), true);
  assert.equal(context.hasAllSavedPeriodIntent('全部の期間を読み込んで'), true);
  assert.equal(context.hasAllSavedPeriodIntent('全体像を見たい'), false);
  assert.equal(context.hasAllSavedPeriodIntent('全て', true), true);
  assert.equal(context.resolveExhaustedPeriodClarificationScope('全ての月を対象にしてください'), '保存済み全期間');
  assert.equal(context.resolveExhaustedPeriodClarificationScope('期間は任せます'), '保存済み最新月');
  const exactHistory = [
    {
      role: 'assistant',
      content: 'SPコースを導入した年月を教えてください？',
      clarification: 'period',
      originalQuery: 'SPコース導入前後のコース点数と客単価を分析してください',
    },
    { role: 'user', content: 'Journal Reportから初出を起点にしてください' },
    {
      role: 'assistant',
      content: '最新月、直近数か月、特定月のどれですか？',
      clarification: 'period',
      originalQuery: 'SPコース導入前後のコース点数と客単価を分析してください Journal Reportから初出を起点にしてください',
    },
  ];
  const resolved = context.resolveSavedDataClarificationReply('全ての月を対象にしてください', exactHistory);
  assert.match(resolved, /保存済み全期間$/);
  assert.equal(context.countRecentClarificationsByKind(exactHistory, 'period'), 2);
  assert.deepEqual(
    [...context.resolveIndexedSavedRangeIntent(resolved, reports).matched].map((row) => row.id),
    ['202405', '202605', '202606', '202607'],
  );
  assert.match(
    html,
    /resolveExhaustedPeriodClarificationScope\(resolvedChatQuery\)/,
    'the retry guard must derive its scope from the user-confirmed query',
  );
  assert.doesNotMatch(
    html,
    /countRecentClarificationsByKind\(aiChatHistory, 'period'\) >= 2\)[\s\S]{0,260}保存済み最新月を対象に全体を分析/,
    'an explicit all-period answer must not be overwritten with the latest month',
  );
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
    /detailEntries\s*=\s*detailRangeLimited\s*\?\s*monthEntries\.slice\(0,\s*detailLimit\)\s*:\s*monthEntries/,
    'only detail hydration may be limited by the month cap',
  );
  assert.match(
    savedReportSearchSource,
    /detailLimit\s*=\s*needsItemDetails\s*\?\s*36\s*:\s*12/,
    'item questions may hydrate up to 36 months, other detail lookups up to 12',
  );
  assert.match(savedReportSearchSource, /productSources\s*=\s*wantsDetail\s*\?\s*detailHydrated\s*:\s*use/);
  assert.match(
    savedReportSearchSource,
    /selectRequestedProductsForQuery\(mergedProducts, q, 40\)/,
    'specific low-selling bottle/course items must be filtered before applying the result limit',
  );
  assert.match(savedReportSearchSource, /if \(hydrationFailed\) return unavailableCloudResult\(\)/);
});

test('brand monthly sales questions extract named products and trigger journal timeline search', () => {
  const q = '2026年のサッポロ赤星の売れ行きを月ごとにまとめて';
  const named = context.extractNamedProductMentions(q);
  assert.equal(named.some((m) => m.q === 'サッポロ赤星'), true);
  assert.equal(context.wantsProductTimelineSearch(q), true);
  assert.equal(context.wantsItemBreakdown(q), true);
  const targets = context.listTimelineSearchTargets(context.extractProductSearchHints(q));
  assert.equal(targets.some((t) => t.q === 'サッポロ赤星' && t.role === 'mentioned'), true);

  // 店舗固有名ではなく、カタカナ銘柄＋売れ行き語なら同様に拾う（ドライゼロ等）
  const dry = 'ドライゼロは何本売れた？';
  assert.equal(context.extractNamedProductMentions(dry).some((m) => m.q === 'ドライゼロ'), true);
  assert.equal(context.wantsProductTimelineSearch(dry), true);
  assert.equal(
    context.listTimelineSearchTargets(context.extractProductSearchHints('ドライゼロの月別売上'))
      .some((t) => t.q === 'ドライゼロ'),
    true,
  );

  // 漢字銘柄（名称中に「の」を含む）も拾う
  const kinobi = '2026年の季の美の売れ行きを教えて';
  assert.equal(context.extractNamedProductMentions(kinobi).some((m) => m.q === '季の美'), true);
  assert.equal(context.wantsProductTimelineSearch(kinobi), true);
  assert.equal(
    context.extractNamedProductMentions('「季の美」の売れ行き').some((m) => m.q === '季の美'),
    true,
  );

  // 商品コード下4桁でもジャーナル横断検索する
  // vm コンテキストの配列は realm が違うため deepEqual せず中身を比較する
  assert.deepEqual([...context.extractProductCodeHints('2103の売れ行きを月ごとに')], ['2103']);
  assert.deepEqual([...context.extractProductCodeHints('コード下4桁 2103 の売上')], ['2103']);
  assert.deepEqual([...context.extractProductCodeHints('商品コード:0000000002103の分析')], ['2103']);
  assert.equal(context.extractProductCodeHints('2026年の売上').length, 0);
  assert.equal(context.extractProductCodeHints('5500円コースの売れ行き').includes('5500'), false);
  assert.equal(context.wantsProductTimelineSearch('2103の売れ行きを月ごとにまとめて'), true);
  assert.equal(
    context.listTimelineSearchTargets(context.extractProductSearchHints('下4桁2103の売上'))
      .some((t) => t.code === '2103' && t.kind === 'code'),
    true,
  );

  // 商品コード0023を「0023年」と誤認しない（本命の2026年を取る）
  const codeYearQ = '商品コード0023の2026年の売れ行きを月ごとにまとめて下さい';
  assert.deepEqual([...context.extractProductCodeHints(codeYearQ)], ['0023']);
  assert.deepEqual([...context.extractAllYearRefs(codeYearQ)], ['2026']);
  assert.equal(context.extractPrimaryYearOnlyRef(codeYearQ), '2026');
  assert.equal(context.extractPrimaryYearOnlyRef('商品コード0023の売れ行き'), null);

  // 裸の「0023の2026年…」もコード＋年として分離できる
  const bareCodeYearQ = '0023の2026年の売れ行きを月ごとにまとめて';
  assert.deepEqual([...context.extractProductCodeHints(bareCodeYearQ)], ['0023']);
  assert.equal(context.extractPrimaryYearOnlyRef(bareCodeYearQ), '2026');
  assert.equal(context.wantsProductTimelineSearch(bareCodeYearQ), true);

  // 意図確認で銘柄の何本／売れたを止めない
  assert.equal(context.needsAiIntentClarification('ドライゼロは何本売れた？'), false);
  assert.equal(context.needsAiIntentClarification('季の美の初出はいつ？'), false);
  assert.equal(context.needsAiIntentClarification('2103の売れ行きを教えて'), false);
  assert.equal(context.wantsItemBreakdown('ドライゼロは何本売れた？'), true);

  // 導入・初出語でも銘柄を抽出し、日付接頭辞を剥がす
  assert.equal(context.extractNamedProductMentions('季の美の初出月は？').some((m) => m.q === '季の美'), true);
  assert.equal(
    context.extractNamedProductMentions('7月5日の季の美の売れ行き').some((m) => m.q === '季の美'),
    true,
  );
  assert.equal(
    context.extractNamedProductMentions('Glass Wineの売れ行き').some((m) => m.q === 'Glass Wine'),
    true,
  );
  assert.equal(
    context.extractNamedProductMentions('「ドライゼロ」について教えて').some((m) => m.q === 'ドライゼロ'),
    true,
  );

  // コード文脈の3桁も下4桁ゼロ埋めで拾う
  assert.deepEqual([...context.extractProductCodeHints('商品コード123の売上')], ['0123']);

  assert.equal(
    context.hasUsableProductTimelineFacts({
      firstSeen: null,
      targets: [{ firstSeen: null, totalQty: 0, byMonth: [] }],
    }),
    false,
  );
  assert.equal(
    context.hasUsableProductTimelineFacts({
      firstSeen: null,
      targets: [{ firstSeen: { year_month: '2026-07' }, totalQty: 5, byMonth: [{ year_month: '2026-07', qty: 5 }] }],
    }),
    true,
  );
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
  assert.match(aiAnalyzeSource, /slice\(\s*0,\s*1600,\s*\)/);
  assert.match(html, /aiChatHistory\.slice\(0, -1\)\.slice\(-12\)/);
  assert.match(html, /originalQuery:\s*resolvedChatQuery/);
  assert.match(html, /salesData:\s*salesDataForAi/);
  assert.match(
    html,
    /needsClarification\s*&&\s*countRecentClarificationsByKind\(aiChatHistory,\s*['"]period['"]\)\s*>=\s*2/,
  );
});

test('uploaded file names and parser errors are rendered as text, never executable HTML', () => {
  for (const source of [html, indexHtml]) {
    assert.doesNotMatch(source, /head\.innerHTML\s*=\s*`<div class="fname">/);
    assert.match(source, /fileName\.textContent=String\(it\.name\|\|''\)/);
    assert.match(source, /errorText\.textContent=String\(it\.error\|\|''\)/);
    assert.match(source, /fileName\.textContent=txtName\(String\(it\.name\|\|''\)\)/);
  }
});

test('Journal history deletion is recoverable through the trash UI', () => {
  assert.match(html, /id="journalTrashBtn"/);
  assert.match(html, /function renderJournalTrash\(/);
  assert.match(html, /method:\s*'PATCH'/);
  assert.match(html, /action:\s*'restore'/);
  assert.match(html, /ゴミ箱へ移動しました/);
  assert.match(historyHtml, /Journal Report本体の「ゴミ箱・復元」から戻せます/);
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

test('follow-up questions keep the new month instead of reusing the previous one', () => {
  // 「2026年5月」→「6月の売上は？」で、前の発話を丸ごと前置して古い月を拾わないこと
  assert.match(
    savedReportSearchSource,
    /const ownQuery = q;/,
    'the raw utterance must be kept before the context back-fill',
  );
  assert.match(
    savedReportSearchSource,
    /hasOwnMonth[\s\S]{0,200}\$\{prevYear\}年 \$\{q\}/,
    'when the new utterance names a month, only the year may be inherited',
  );
  assert.match(
    savedReportSearchSource,
    /hasOwnDay && prevMonth[\s\S]{0,160}\$\{prevYear\}年\$\{parseInt\(prevMonth, 10\)\}月/,
    'a bare day must inherit both year and month',
  );
  // 年を一度しか書かない比較も2期間として扱う
  assert.deepEqual(
    [...context.extractAllMonthRefs('2026年5月と6月を比較して')].map(ref => ref.key),
    ['2026-05', '2026-06'],
  );
  assert.deepEqual(
    [...context.extractAllMonthRefs('202606と202607を比較して')].map(ref => ref.key),
    ['2026-06', '2026-07'],
  );
  assert.deepEqual([...context.extractAllMonthRefs('直近3か月の売上')], []);
  assert.deepEqual(
    [...context.extractAllMonthRefs('2026年7月の売上')].map(ref => ref.key),
    ['2026-07'],
  );
});

test('answered conversations do not re-ask the purpose when only the period changes', () => {
  const answered = [
    { role: 'user', content: '2026年5月の総売上は？' },
    { role: 'assistant', content: '2026年5月の総売上は¥1,120,850です。' },
  ];
  const asked = [
    { role: 'user', content: '売上を分析して' },
    { role: 'assistant', content: '何を優先しますか？', clarification: 'intent' },
  ];
  assert.equal(context.hasAnsweredDataContext(answered), true);
  assert.equal(context.hasAnsweredDataContext(asked), false);
  assert.equal(context.hasAnsweredDataContext([]), false);
  assert.equal(context.mentionsExplicitPeriod('15日はどうだった？'), true);
  assert.equal(context.mentionsExplicitPeriod('どうかな'), false);
  // 回答済みの流れで期間だけ言い換えた発話は聞き返さない
  assert.equal(context.shouldAskAiIntentClarification('15日はどうだった？', answered, '15日はどうだった？'), false);
  // 会話の頭から曖昧なままなら従来どおり確認する
  assert.equal(context.shouldAskAiIntentClarification('どうかな', answered, 'どうかな'), true);
  assert.equal(context.shouldAskAiIntentClarification('15日はどうだった？', [], '15日はどうだった？'), true);
});

test('day-level questions are answered per day instead of rolling up to the month', () => {
  assert.deepEqual(
    [...context.extractAllDayRefs('2026年7月15日の売上')].map(ref => ref.iso),
    ['2026-07-15'],
  );
  assert.deepEqual(
    [...context.extractAllDayRefs('2026年7月1日〜7日の売上')].map(ref => ref.iso),
    ['2026-07-01', '2026-07-07'],
  );
  assert.equal(context.extractDayScope('2026年7月の売上'), null);
  assert.equal(context.extractDayScope('直近7日の売上'), null, '期間の長さを日付と誤認しない');
  assert.equal(context.extractDayScope('2026年7月の3日間'), null);
  const single = context.extractDayScope('2026年7月15日の売上');
  assert.deepEqual([single.from.iso, single.to.iso, single.label], ['2026-07-15', '2026-07-15', '2026年7月15日']);
  const range = context.extractDayScope('2026年7月1日から2026年7月7日までの売上');
  assert.deepEqual([range.from.iso, range.to.iso], ['2026-07-01', '2026-07-07']);
  // 相対日付
  assert.match(context.resolveRelativeTimeRefs('昨日の売上'), /\d{4}年\d{1,2}月\d{1,2}日の売上/);
  assert.match(context.resolveRelativeTimeRefs('明日の予約'), /\d{4}年\d{1,2}月\d{1,2}日の予約/);
  assert.match(context.resolveRelativeTimeRefs('先週の売上'), /\d{4}年\d{1,2}月\d{1,2}日〜\d{4}年\d{1,2}月\d{1,2}日/);
  assert.match(context.resolveRelativeTimeRefs('来週の予約'), /\d{4}年\d{1,2}月\d{1,2}日〜\d{4}年\d{1,2}月\d{1,2}日/);
  assert.match(context.resolveRelativeTimeRefs('今月の売上'), /\d{4}年\d{1,2}月の売上/);
  // 日付が特定できた場合は月へ丸めず日単位の集計へ入る
  assert.match(savedReportSearchSource, /const dayScope = extractDayScope\(q\);/);
  assert.match(savedReportSearchSource, /await summarizeDayScope\(/);
  assert.match(
    savedReportSearchSource,
    /const dayScope[\s\S]*const rangeRef = extractRangeRef\(q\)/,
    'day scope must be resolved before the month-range branch',
  );
});

test('reservation-only and day-scope queries do not require a saved sales report', () => {
  assert.match(html, /function isReservationFocusedQuery\(query\)/);
  assert.match(savedReportSearchSource, /async function tryReservationOnlyMonthRange/);
  assert.match(savedReportSearchSource, /buildReservationOnlyQueryResult/);
  assert.match(savedReportSearchSource, /reservationFacts:\s*scopedFacts/);
  assert.match(savedReportSearchSource, /tryReservationOnlyMonthRange\(targetKey, targetKey/);
  assert.match(
    savedReportSearchSource,
    /allReports\.length === 0 && !isReservationFocusedQuery\(q\) && !wantsProductTimelineSearch\(q\)/,
    'empty saved reports must still allow journal product-timeline questions',
  );
  assert.match(html, /function reservationJstDateKeyForClient\(value\)/);
  assert.match(savedReportSearchSource, /enrichReservationFacts\([\s\S]*q,\s*true/);
  assert.match(savedReportSearchSource, /async function tryProductTimelineFallback/);
  assert.match(savedReportSearchSource, /journalProductSearchOnly:\s*true/);
  assert.match(html, /verifiedData\.journalProductSearchOnly/);
});

test('same-year month ranges like 2026年1月〜7月 expand to the full inclusive span', () => {
  // vm 文脈のオブジェクトは deepEqual でホスト側リテラルと比較できないことがあるため JSON 経由で見る
  const asJson = (v) => JSON.parse(JSON.stringify(v));
  // 年を片側だけ書いた自然な範囲。従来は null → 端点の1月と7月だけ比較扱いになっていた。
  assert.deepEqual(asJson(context.extractRangeRef('2026年1月〜7月の売上推移を分析して')), {
    fromYear: 2026, fromMonth: 1, toYear: 2026, toMonth: 7, wasYearOnly: false,
  });
  assert.deepEqual(asJson(context.extractRangeRef('2026年1月から7月までの売上')), {
    fromYear: 2026, fromMonth: 1, toYear: 2026, toMonth: 7, wasYearOnly: false,
  });
  assert.deepEqual(asJson(context.extractRangeRef('2026年1月から7月までの売り上げデータをまとめて表示して')), {
    fromYear: 2026, fromMonth: 1, toYear: 2026, toMonth: 7, wasYearOnly: false,
  });
  assert.deepEqual(asJson(context.extractRangeRef('2026年の1月から7月まで')), {
    fromYear: 2026, fromMonth: 1, toYear: 2026, toMonth: 7, wasYearOnly: false,
  });
  // 両端に年がある従来形式も維持
  assert.deepEqual(asJson(context.extractRangeRef('2025年11月〜2026年2月')), {
    fromYear: 2025, fromMonth: 11, toYear: 2026, toMonth: 2, wasYearOnly: false,
  });
  // 比較「と」は範囲ではない
  assert.equal(context.extractRangeRef('2026年1月と7月を比較して'), null);
});

test('multiple continuous ranges are kept as separate comparison periods', () => {
  const asJson = (v) => JSON.parse(JSON.stringify(v));
  const question = '2025年の3月から7月までと、2026年3月から7月までの、それぞれの平均来客数と平均客単価を教えて';
  assert.deepEqual(asJson(context.extractAllRangeRefs(question)), [
    { fromYear: 2025, fromMonth: 3, toYear: 2025, toMonth: 7, wasYearOnly: false },
    { fromYear: 2026, fromMonth: 3, toYear: 2026, toMonth: 7, wasYearOnly: false },
  ]);
  assert.deepEqual(asJson(context.extractRangeRef(question)), {
    fromYear: 2025, fromMonth: 3, toYear: 2025, toMonth: 7, wasYearOnly: false,
  });
  assert.match(savedReportSearchSource, /const rangeRefs = extractAllRangeRefs\(q\);/);
  assert.match(savedReportSearchSource, /if \(rangeRefs\.length >= 2\)/);
  assert.match(
    savedReportSearchSource,
    /const rangeRefs[\s\S]*const rangeRef = extractRangeRef\(q\)/,
    'multiple range comparison must run before the single-range early return',
  );
  assert.equal(context.rangeRefLabel(context.extractAllRangeRefs(question)[0]), '2025年3月〜7月');
  const reportsForComparison = [
    { title: '月間売上レポート（2025年3月）', period: '2025-03-01〜2025-03-31' },
    { title: '月間売上レポート（2025年7月）', period: '2025-07-01〜2025-07-31' },
    { title: '月間売上レポート（2026年3月）', period: '2026-03-01〜2026-03-31' },
    { title: '合算売上レポート（2025年11月〜2026年6月）', period: '2025-11-01〜2026-06-30' },
  ];
  const [first, second] = context.extractAllRangeRefs(question);
  assert.deepEqual(
    reportsForComparison.filter((r) => context.reportMatchesRangeRef(r, first)).map((r) => context.monthKeyFromReport(r)),
    ['2025-03', '2025-07'],
  );
  assert.deepEqual(
    reportsForComparison.filter((r) => context.reportMatchesRangeRef(r, second)).map((r) => context.monthKeyFromReport(r)),
    ['2026-03'],
    'cross-month aggregate reports must stay excluded',
  );
  assert.match(html, /monthlyAvgCustomers: monthlyBreakdown\.length \? Math\.round\(cust \/ monthlyBreakdown\.length\) : 0/);
  assert.match(html, /月間平均来客数: \$\{p\.monthlyAvgCustomers \|\| 0\}名/);
});

test('course lineup keeps the full journal monthly series on both sides of a product introduction', () => {
  const rows = [
    { year_month: '2024-11', qty: 20, amount: 160000 },
    { year_month: '2025-12', qty: 30, amount: 240000 },
    { year_month: '2026-01', qty: 12, amount: 96000 },
    { year_month: '2026-07', qty: 88, amount: 615000 },
  ];
  assert.deepEqual(
    { ...context.summarizeCourseMonthlyFacts(rows.slice(0, 2)) },
    {
      monthCount: 2,
      qty: 50,
      amount: 400000,
      firstMonth: '2024-11',
      lastMonth: '2025-12',
    },
  );
  assert.match(html, /月次コース販売（ジャーナル原本の保存全期間・導入前を含む）/);
  assert.match(html, /固有商品の導入月 \$\{facts\.pivotMonth\} を境にしたコース全体比較/);
  assert.match(html, /固有商品の導入前0点を、既存コース全体の0点へ読み替えることは禁止/);
  assert.match(html, /facts\.byMonth\.forEach/);
  assert.doesNotMatch(
    extractFunction(html, 'formatCourseLineupFactsForAi'),
    /facts\.byMonth\.slice\(-\d+\)/,
    'the authoritative course monthly series must not silently discard pre-introduction months',
  );
  const formatted = context.formatCourseLineupFactsForAi({
    rootCauseGuard: 'guard',
    note: 'note',
    searchScope: 'q=コース',
    scannedFiles: 40,
    totalQty: 150,
    totalAmount: 1200000,
    pivotMonth: '2026-01',
    beforePivot: context.summarizeCourseMonthlyFacts(rows.slice(0, 2)),
    onAfterPivot: context.summarizeCourseMonthlyFacts(rows.slice(2)),
    byMonth: rows.map((row) => ({ ...row, names: [], units: [] })),
    unitLeaders: [],
    core: [],
    exceptions: [],
    aliasClusters: [],
    coverageGaps: [],
  });
  assert.match(formatted, /2024-11: コース全体 20点/);
  assert.match(formatted, /2025-12: コース全体 30点/);
  assert.match(formatted, /導入月より前: 2か月 \/ コース全体 50点/);
  assert.match(formatted, /導入月以降: 2か月 \/ コース全体 100点/);
});

test('verified aggregates carry every stored breakdown so the AI never has to say it is missing', () => {
  const sales = [
    {
      date: '2026-07-01', hour: 19, weekday: '水', mealPeriod: 'ディナー', total: 60000, customers: 4, groups: 1,
      items: [
        { name: 'コース８品', qty: 4, amount: 40000, category: 'フード', isCharge: false },
        { name: 'ボトルワイン', qty: 1, amount: 15000, category: '飲料', isCharge: false },
        { name: '個室料金', qty: 1, amount: 5000, category: '室料', isCharge: false },
      ],
    },
    {
      date: '2026-07-02', hour: 12, weekday: '木', mealPeriod: 'ランチ', total: 8000, customers: 2, groups: 1,
      items: [
        { name: 'ランチセット', qty: 2, amount: 7000, category: 'フード', isCharge: false },
        { name: 'チャージ料', qty: 2, amount: 1000, category: 'フード', isCharge: true },
      ],
    },
  ];
  const agg = context.aggregateSalesRows(sales);
  assert.equal(agg.totalSales, 68000);
  assert.equal(agg.foodTotal + agg.drinkTotal + agg.roomTotal + agg.otherTotal, agg.totalSales);
  assert.equal(agg.roomTotal, 5000);
  assert.equal(agg.chargeTotal, 1000);
  assert.deepEqual([agg.lunchTotal, agg.dinnerTotal], [8000, 60000]);
  assert.deepEqual([agg.lunchCustomers, agg.dinnerCustomers], [2, 4]);
  assert.deepEqual([...agg.dailyBreakdown].map(row => row.date), ['2026-07-01', '2026-07-02']);
  assert.deepEqual([...agg.weekdayBreakdown].map(row => row.weekday), ['水', '木'], '曜日は月→日の順に並べる');
  assert.deepEqual([...agg.hourlyBreakdown].map(row => row.hour), [12, 19]);

  const merged = context.mergeWeekdayBreakdowns([
    { weekdayBreakdown: [{ weekday: '月', totalSales: 100, customerCount: 2, transactionCount: 1 }] },
    { weekdayBreakdown: [{ weekday: '月', totalSales: 50, customerCount: 1, transactionCount: 1 }] },
  ]);
  assert.deepEqual(
    { weekday: merged[0].weekday, totalSales: merged[0].totalSales, customerCount: merged[0].customerCount },
    { weekday: '月', totalSales: 150, customerCount: 3 },
  );
  const hourly = context.mergeHourlyBreakdowns([
    { hourlyBreakdown: [{ hour: 19, totalSales: 100, customers: 2, count: 1 }] },
    { hourlyBreakdown: [{ hour: 19, totalSales: 20, customers: 1, count: 1 }] },
  ]);
  assert.deepEqual({ hour: hourly[0].hour, totalSales: hourly[0].totalSales }, { hour: 19, totalSales: 120 });

  const text = context.formatVerifiedDetailLines({
    totalSales: 68000, foodTotal: 48000, drinkTotal: 15000, roomTotal: 5000, otherTotal: 0, chargeTotal: 1000,
    lunchTotal: 8000, dinnerTotal: 60000, lunchCustomers: 2, dinnerCustomers: 4,
    weekdayBreakdown: agg.weekdayBreakdown,
    hourlyBreakdown: agg.hourlyBreakdown,
    dailyBreakdown: agg.dailyBreakdown,
    missingPeriods: ['2025年7月'],
  });
  assert.match(text, /カテゴリ内訳/);
  assert.match(text, /室料/);
  assert.match(text, /うちチャージ/);
  assert.match(text, /ランチ／ディナー/);
  assert.match(text, /曜日別売上/);
  assert.match(text, /時間帯別売上/);
  assert.match(text, /日別売上/);
  assert.match(text, /保存データが無い期間: 2025年7月/);
  assert.equal(context.formatVerifiedDetailLines({}), '');

  // 集計結果と AI プロンプトの双方に載ること
  assert.match(html, /weekdayBreakdown,\s*\n\s*hourlyBreakdown,/);
  assert.match(html, /\$\{formatVerifiedDetailLines\(verifiedData\)\}/);
  assert.match(html, /\$\{formatVerifiedDetailLines\(p, '  '\)\}/);
  assert.match(html, /記載があるのに「その内訳はありません」と答えないでください/);
});

test('drink and segment questions reach the stored journal items', () => {
  for (const q of ['ワインはいくら売れた？', 'シャンパンは何本？', 'ビールは何杯？', '日本酒の売上は？']) {
    assert.equal(context.wantsItemBreakdown(q), true, q);
  }
  for (const q of ['曜日別の売上は？', '時間帯別の推移は？', 'ランチとディナーの内訳は？', 'ピークは何時？']) {
    assert.equal(context.wantsSegmentBreakdown(q), true, q);
  }
  assert.equal(context.wantsDailyBreakdown('2026年7月15日の売上'), true);
  assert.equal(context.wantsDailyBreakdown('日別の推移は？'), true);
  assert.equal(context.wantsDailyBreakdown('2026年7月の総売上は？'), false);
  assert.equal(context.wantsSegmentBreakdown('2026年7月の総売上は？'), false);
});

test('a comparison with only one stored side still returns the stored numbers', () => {
  assert.match(
    savedReportSearchSource,
    /if \(periods\.length === 1\) return \{ \.\.\.periods\[0\], missingPeriods \};/,
    'the available month must be returned instead of a bare "not found"',
  );
  assert.match(
    savedReportSearchSource,
    /if \(yearPeriods\.length === 1\) return \{ \.\.\.yearPeriods\[0\], missingPeriods: missingYears \};/,
  );
  assert.match(savedReportSearchSource, /return \{ multiPeriod: true, periods, missingPeriods \};/);
  assert.match(html, /queryResult\.missingPeriods\.join\('・'\)/);
});

test('store knowledge is attached by period overlap, not only by similarity', () => {
  const items = [
    { id: 1, category: '施策', title: '7月ワインフェア', summary: 'グラス3種入替', body_text: 'ボトルアップセル強化', tags: ['ワイン'], period_start: '2026-07-01', period_end: '2026-07-31', is_active: true },
    { id: 2, category: 'メニュー', title: '夏グランドメニュー', summary: '前菜4品入替', body_text: '', tags: [], period_start: '2026-06-01', period_end: null, is_active: true },
    { id: 3, category: 'マニュアル', title: '接客マニュアル', summary: 'ペアリング提案トーク', body_text: '', tags: [], period_start: null, period_end: null, is_active: true },
    { id: 4, category: '施策', title: '3月ランチ強化', summary: 'ランチセット導入', body_text: '', tags: [], period_start: '2026-03-01', period_end: '2026-03-31', is_active: true },
    { id: 5, category: '施策', title: '終了した企画', summary: '無効化済み', body_text: '', tags: [], period_start: '2026-07-01', period_end: '2026-07-31', is_active: false },
  ];
  assert.equal(context.monthEndIso('2026-07'), '2026-07-31');
  assert.equal(context.monthEndIso('2024-02'), '2024-02-29', 'うるう年');
  assert.equal(context.knowledgePeriodLabel(items[2]), '常時有効');
  assert.equal(context.knowledgePeriodLabel(items[1]), '2026-06-01 〜');

  // 期間は確定集計（月次・日別）から求める
  const julyRange = context.resolveKnowledgePeriodRange({
    label: '2026年7月の売上データ',
    monthlyBreakdown: [{ key: '2026-07', label: '2026年7月' }],
  });
  assert.deepEqual({ ...julyRange }, { from: '2026-07-01', to: '2026-07-31' });
  const dayRange = context.resolveKnowledgePeriodRange({
    label: '2026年7月15日の売上データ',
    dailyBreakdown: [{ date: '2026-07-15' }],
  });
  assert.deepEqual({ ...dayRange }, { from: '2026-07-15', to: '2026-07-15' });
  const compareRange = context.resolveKnowledgePeriodRange({
    multiPeriod: true,
    periods: [
      { monthlyBreakdown: [{ key: '2026-03' }] },
      { monthlyBreakdown: [{ key: '2026-07' }] },
    ],
  });
  assert.deepEqual({ ...compareRange }, { from: '2026-03-01', to: '2026-07-31' });
  assert.equal(context.resolveKnowledgePeriodRange(null), null);

  // 期間が重なる資料は、質問文との類似度に関係なく必ず添付する
  assert.equal(context.knowledgeOverlapsPeriod(items[0], julyRange), true);
  assert.equal(context.knowledgeOverlapsPeriod(items[3], julyRange), false);
  assert.equal(context.knowledgeOverlapsPeriod(items[2], julyRange), true, '期間なしは常時有効');
  assert.equal(context.knowledgeOverlapsPeriod(items[0], null), true, '期間不明の質問では候補に残す');

  const july = [...context.selectStoreKnowledgeForQuery('2026年7月の売上が伸びた要因は？', julyRange, items)]
    .map(row => row.title);
  assert.deepEqual(july, ['7月ワインフェア', '夏グランドメニュー', '接客マニュアル']);
  assert.equal(july.includes('終了した企画'), false, '無効化した資料は使わない');

  const march = [...context.selectStoreKnowledgeForQuery('2026年3月の客単価は？', context.resolveKnowledgePeriodRange({ monthlyBreakdown: [{ key: '2026-03' }] }), items)]
    .map(row => row.title);
  assert.deepEqual(march, ['3月ランチ強化', '接客マニュアル'], '対象外の月の施策は混ぜない');

  assert.deepEqual([...context.selectStoreKnowledgeForQuery('質問', julyRange, [])], []);
});

test('the knowledge prompt block never becomes the source of numbers', () => {
  const items = [
    { category: '施策', title: '7月ワインフェア', summary: 'グラス3種入替', body_text: 'ボトルアップセル強化', tags: ['ワイン'], period_start: '2026-07-01', period_end: '2026-07-31', is_active: true },
  ];
  assert.equal(context.formatStoreKnowledgeBlock([]), '');
  const block = context.formatStoreKnowledgeBlock(items);
  assert.match(block, /【店舗ナレッジ（この店舗が登録した施策・メニュー資料／/);
  assert.match(block, /\[施策\] 7月ワインフェア（2026-07-01 〜 2026-07-31）/);
  assert.match(block, /概要: グラス3種入替/);
  assert.match(block, /本ナレッジを数値の出典にしてはいけません/);
  assert.match(block, /登録資料によると/);
  assert.match(block, /※これは推測です/);

  // 長文でも上限を超えない
  const huge = context.formatStoreKnowledgeBlock([
    { category: 'メニュー', title: '長文', summary: 'あ'.repeat(3000), body_text: 'い'.repeat(9000), tags: [], period_start: null, period_end: null, is_active: true },
  ]);
  assert.ok(huge.length < 7000, `block too long: ${huge.length}`);

  // チャット・分析レポートの双方へ注入され、数値の正本は確定集計のままであること
  assert.match(html, /\d+\. 【店舗ナレッジ】が提示されている場合は/);
  assert.match(
    html,
    /\$\{integrated\.storeOpsBlock\}\$\{verifiedDataBlock\}\$\{integrated\.knowledgeBlock\}/,
  );
  assert.match(html, /integrated\.knowledgeBlock/);
  assert.match(html, /loadStoreKnowledgeForAi/);
});

test('store knowledge API and storage stay behind the admin API', async () => {
  const adminApi = await readFile(
    new URL('../supabase/functions/admin-api/index.ts', import.meta.url),
    'utf8',
  );
  for (const route of [
    '"/pos-journals/knowledge"',
    '"/pos-journals/knowledge/item"',
    '"/pos-journals/knowledge/upload"',
    '"/pos-journals/knowledge/download"',
  ]) {
    assert.ok(adminApi.includes(route), `${route} must be registered for store-scoped logins`);
  }
  // 他店アクセスの拒否が全ハンドラに入っていること
  const handlers = ['saveStoreKnowledge', 'deleteStoreKnowledgeItem', 'uploadStoreKnowledgeFile'];
  for (const name of handlers) {
    const start = adminApi.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const body = adminApi.slice(start, start + 4000);
    assert.match(body, /他店舗のデータにはアクセスできません/, name);
  }
  // 既定は論理削除（過去期間の回答に必要なため残す）
  const deleteBody = adminApi.slice(adminApi.indexOf('async function deleteStoreKnowledgeItem('));
  assert.match(deleteBody.slice(0, 3000), /is_active: false/);

  const migration = await readFile(
    new URL('../supabase/migrations/20260802220000_store_knowledge_documents.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.store_knowledge_documents from anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on public\.store_knowledge_documents to service_role/);
  assert.match(migration, /'store-knowledge',\s*\n\s*'store-knowledge',\s*\n\s*false/, 'bucket must stay private');
});
