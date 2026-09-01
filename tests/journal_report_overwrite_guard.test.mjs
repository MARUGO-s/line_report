// 分類の付け替えが保存済みレポートの売上を縮めないことを守るテスト。
//
// 2026-07 と 2026-08 の月間レポートが、分類更新のたびに
// 3,172伝票 → 1,820伝票（総売上 5,892,466 → 3,682,102）へ書き換えられた。
// 原因は resolveSalesForCurrentReport が保存済み明細(posJournalDays)を見ずに
// LZH原本のブラウザ再解析へ落ち、その再解析が検算に通らない会計を捨てるため。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../public/jnm/jnl2txt.html', import.meta.url),
  'utf8',
);

/** `function name(` から対応する閉じ括弧までを取り出す。 */
function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  // 引数の分割代入 `{ productKey=null }` を本体の開き括弧と取り違えないよう、
  // まず引数リストを閉じてから本体を探す。
  let parens = 0;
  let bodyFrom = source.indexOf('(', start);
  for (let i = bodyFrom; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') {
      parens -= 1;
      if (parens === 0) { bodyFrom = i + 1; break; }
    }
  }
  let depth = 0;
  const open = source.indexOf('{', bodyFrom);
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} is unbalanced`);
}

const isShrunkAgainstSavedReport = new Function(
  `${sliceFunction('isShrunkAgainstSavedReport')}\nreturn isShrunkAgainstSavedReport;`,
)();

test('a rebuilt month that lost receipts is refused, not written', () => {
  // 実際に壊れた値。分類を変えただけで総売上が 6割 に縮んだ。
  const saved = { totalSales: 5892466, salesCount: 3172 };
  assert.equal(
    isShrunkAgainstSavedReport({ total: 3682102, salesCount: 1820 }, saved),
    true,
  );
  // 総額が同じでも伝票が減っていれば取りこぼしている。
  assert.equal(
    isShrunkAgainstSavedReport({ total: 5892466, salesCount: 1820 }, saved),
    true,
  );
  // 件数が同じでも総額が減っていれば取りこぼしている。
  // 2つの検査は片方だけでは足りないので、両方を独立に確かめる。
  assert.equal(
    isShrunkAgainstSavedReport({ total: 3682102, salesCount: 3172 }, saved),
    true,
  );
});

test('an unchanged or grown month still writes', () => {
  const saved = { totalSales: 5892466, salesCount: 3172 };
  // 分類の付け替えは金額も件数も動かさない。これが通常の経路。
  assert.equal(
    isShrunkAgainstSavedReport({ total: 5892466, salesCount: 3172 }, saved),
    false,
  );
  // 原本を追加取り込みした月は増える。止めてはいけない。
  assert.equal(
    isShrunkAgainstSavedReport({ total: 6000000, salesCount: 3200 }, saved),
    false,
  );
  // 保存済みが無い（新規月）／数値を持たない古い行は判定材料が無い。
  assert.equal(isShrunkAgainstSavedReport({ total: 1, salesCount: 1 }, null), false);
  assert.equal(isShrunkAgainstSavedReport({ total: 1, salesCount: 1 }, {}), false);
});

test('the month upsert consults the guard before writing', () => {
  const fn = sliceFunction('upsertMonthReportsFromSales');
  assert.match(
    fn,
    /if\(isShrunkAgainstSavedReport\(daily,existingDaily\)\|\|isShrunkAgainstSavedReport\(monthly,existingMonthly\)\)\{/,
  );
  // 判定より前に書き込みへ進めてはいけない。
  assert.ok(
    fn.indexOf('isShrunkAgainstSavedReport') < fn.indexOf('writeSavedReports'),
    'the guard must run before writeSavedReports',
  );
});

test('saved receipt detail is used before re-parsing the LZH originals', () => {
  const fn = sliceFunction('resolveSalesForCurrentReport');
  assert.match(fn, /const savedSales=await loadSavedSalesForCurrentReport\(\);/);
  assert.ok(
    fn.indexOf('loadSavedSalesForCurrentReport') < fn.indexOf('loadSalesFromCloudJournals'),
    'posJournalDays must be tried before downloading journal originals',
  );

  // 一覧から開いた行は要約しか持たないため、詳細を取り直す必要がある。
  const loader = sliceFunction('loadSavedSalesForCurrentReport');
  assert.match(loader, /reviveSalesFromSharedPosJournalDays\(currentReport\?\.posJournalDays\)/);
  assert.match(loader, /fetchSupabaseReportById\(id,\{ forceRefresh:true \}\)/);
  assert.match(loader, /reviveSalesFromSharedPosJournalDays\(full\.posJournalDays\)/);
});

test('month reports fall back to posJournalDays instead of reporting no receipts', () => {
  const fn = sliceFunction('loadSalesFromCloudMonthReports');
  assert.match(
    fn,
    /const rows=revived\.length\?revived:reviveSalesFromSharedPosJournalDays\(full\?\.posJournalDays\);/,
  );
});
