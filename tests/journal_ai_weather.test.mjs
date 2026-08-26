/**
 * Journal Report（jnm/jnl2txt.html）の通常AI分析・チャットが、
 * 既に収集済みの天気・気温（sales[].weather / sales[].tempC）を
 * 日別売上へ反映して渡すことを検証する。
 *
 * 経緯: 天気データ自体はcollectWeatherByDate/enrichSalesWeatherFromCloudJournals
 * 等で以前から取得・保存されていたが、通常AI（buildSalesDataForAI経由の分析、
 * formatVerifiedDetailLines経由のチャット）にはシリアライズしていなかった
 * （scripts/verify-journal-ai-data-flow.mjs の "weather" gapが検出していた）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../public/jnm/jnl2txt.html', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let paramsEnd = -1;
  for (let i = paramsStart; i < source.length; i += 1) {
    if (source[i] === '(') paramsDepth += 1;
    if (source[i] === ')') paramsDepth -= 1;
    if (paramsDepth === 0) {
      paramsEnd = i;
      break;
    }
  }
  assert.notEqual(paramsEnd, -1, `${name} parameters must close`);
  const brace = source.indexOf('{', paramsEnd);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

const context = {
  console,
  Number,
  Math,
  Array,
  Object,
  String,
  Date,
};
vm.createContext(context);

// yen / sortWeekdayRows / formatMonthlyMealFdTrendLines は formatVerifiedDetailLines /
// aggregateSalesRows が参照する依存関数。実装をそのまま持ち込み、切り出し漏れで
// 「未定義でも例外にならず出力が壊れる」誤判定を防ぐ。
vm.runInContext(
  `const yen = n => '¥' + (n<0?'-':'') + Math.abs(n).toLocaleString('ja-JP');`
  + `const WEEKDAY_ORDER = ['月', '火', '水', '木', '金', '土', '日'];`,
  context,
);
vm.runInContext(extractFunction(html, 'sortWeekdayRows'), context);
vm.runInContext(extractFunction(html, 'formatMonthlyMealFdTrendLines'), context);
vm.runInContext(extractFunction(html, 'aggregateSalesRows'), context);
vm.runInContext(extractFunction(html, 'formatVerifiedDetailLines'), context);

test('aggregateSalesRows: 同じ日の伝票から天気・気温を日別へ集約する', () => {
  const rows = [
    { date: '2026-06-01', total: 10000, customers: 4, weekday: '月', weather: '晴れ', tempC: 28 },
    { date: '2026-06-01', total: 5000, customers: 2, weekday: '月', weather: '', tempC: null },
    { date: '2026-06-02', total: 8000, customers: 3, weekday: '火' },
  ];
  const agg = context.aggregateSalesRows(rows);
  const day1 = agg.dailyBreakdown.find((d) => d.date === '2026-06-01');
  const day2 = agg.dailyBreakdown.find((d) => d.date === '2026-06-02');
  assert.equal(day1.weather, '晴れ', '同日2件目に天気が無くても1件目の値を保持する');
  assert.equal(day1.tempC, 28);
  assert.equal(day2.weather, '', '天気データが無い日は空のまま（勝手に補完しない）');
  assert.equal(day2.tempC, null);
});

test('formatVerifiedDetailLines: 日別売上の行に天気・気温を書き添える', () => {
  const text = context.formatVerifiedDetailLines({
    dailyBreakdown: [
      { date: '2026-06-01', weekday: '月', totalSales: 15000, customers: 6, count: 4, avgSpend: 2500, weather: '晴れ', tempC: 28 },
      { date: '2026-06-02', weekday: '火', totalSales: 8000, customers: 3, count: 2, avgSpend: 2666 },
    ],
  });
  assert.match(text, /2026-06-01.*天気 晴れ28℃/, `天気付きの日別行が生成されていること:\n${text}`);
  assert.doesNotMatch(
    text.split('\n').find((line) => line.includes('2026-06-02')) ?? '',
    /天気/,
    '天気データが無い日には天気欄を付けない',
  );
  assert.match(text, /座標をもとにした日別の観測・予報値/, '天気の出典・限界を示す注記があること');
});

test('formatVerifiedDetailLines: 天気データが一切無い期間では注記を付けない', () => {
  const text = context.formatVerifiedDetailLines({
    dailyBreakdown: [
      { date: '2026-06-01', weekday: '月', totalSales: 15000, customers: 6, count: 4, avgSpend: 2500 },
    ],
  });
  assert.doesNotMatch(text, /天気/, '天気情報が無い場合は言及しない（無いのに触れて誤解させない）');
});

// buildSalesDataForAI 側（AI分析＝salesData JSONとして丸ごとAIへ渡る経路）も、
// 日別集計ループへ weather/tempC の取り込みを追加している。これは巨大な
// クロージャ内関数のため個別抽出はせず、ソース上の存在とスコープだけを検証する
// （scripts/verify-journal-ai-data-flow.mjs が実際の統合可否を検証する）。
test('buildSalesDataForAI: 日別集計ループがweather/tempCを取り込む', () => {
  const body = extractFunction(html, 'buildSalesDataForAI');
  assert.match(body, /daily\[dStr\]\.weather = String\(s\.weather\)/);
  assert.match(body, /daily\[dStr\]\.tempC = Number\(s\.tempC\)/);
});
