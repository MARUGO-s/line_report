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
  'resolveSavedDataClarificationReply',
  'buildSavedReportCoverage',
  'formatCoverageMonth',
  'resolveIndexedSavedRangeIntent',
  'buildSavedDataClarificationReply',
]) {
  vm.runInContext(`${extractFunction(html, name)}; this.${name} = ${name};`, context);
}

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

test('both Journal Report entry files keep the planner and error distinction in sync', () => {
  assert.equal(indexHtml, html);
  assert.match(html, /needsClarification/);
  assert.match(html, /データが無いとは判断していません/);
  assert.match(html, /local-query-planner/);
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
