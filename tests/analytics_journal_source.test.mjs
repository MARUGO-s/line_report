import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/analytics.html', import.meta.url), 'utf8');
const helper = html.match(/function hasRecordedDailySales\(row\) \{[\s\S]*?\n\}/)[0];
test('charts accept journal overrides, retain explicit zero, and exclude unrecorded zero', () => {
  const check = vm.runInNewContext(`(${helper})`);
  assert.equal(check({receipt_count: 0, manual_gross: true, gross_sales_yen: 1100}), true);
  assert.equal(check({receipt_count: 0, manual_gross: true, gross_sales_yen: 0}), true);
  assert.equal(check({receipt_count: 0, gross_sales_yen: 0}), false);
  assert.equal(check({receipt_count: 0, manual_guest: true}), false);
  assert.equal(check({receipt_count: 2}), true);
  assert.equal(check(null), false);
});
test('weekday, weather scatters, cross table and daily empty styling use recorded-day predicate', () => {
  assert.doesNotMatch(html, /filter\(d => d\.receipt_count > 0/);
  assert.match(html, /hasRecordedDailySales\(d\) && state\.weather\[d\.date\]\?\.temp != null/);
  assert.match(html, /hasRecordedDailySales\(d\) && state\.weather\[d\.date\]\?\.rain != null/);
  assert.equal((html.match(/state\.dailySeries\.filter\(hasRecordedDailySales\)/g) || []).length, 2);
  assert.match(html, /row && !hasRecordedDailySales\(row\)/);
  assert.match(html, /ジャーナル連携・手入力/);
});
