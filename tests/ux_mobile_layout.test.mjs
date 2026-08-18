import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (rel) => readFile(new URL(rel, root), 'utf8');

test('sales sheet links stay hidden unless they have an http(s) URL', async () => {
  const config = await read('public/pages-config.js');
  assert.match(config, /function isUsableSalesSheetUrl/);
  assert.match(config, /#salesSheetNavLink/);
  assert.match(config, /preventDefault/);

  const analytics = await read('public/analytics.html');
  assert.match(analytics, /LINE_REPORT_PAGES\.isUsableSalesSheetUrl/);
  assert.match(analytics, /lsa-navitem\[hidden\]/);
});

test('analytics and reviews wrap the header pills on a narrow phone', async () => {
  const analytics = await read('public/analytics.html');
  const reviews = await read('public/reviews.html');
  assert.match(analytics, /\.status \{ flex-wrap: wrap; overflow: visible; \}/);
  assert.match(reviews, /\.status \{ flex-wrap: wrap; overflow: visible; \}/);
});

test('media document filters stack to full width on a phone', async () => {
  const media = await read('public/media.html');
  const mobile = media.slice(media.indexOf('@media (max-width: 880px)'));
  assert.match(mobile, /\.controls \{ flex-direction: column;/);
  assert.match(mobile, /min-width: 0 !important/);
});

test('system map and evolution tabs wrap instead of clipping', async () => {
  const map = await read('public/system-map.html');
  const evo = await read('public/foodcourt-evolution.html');
  assert.match(map, /\.tabs\{flex-wrap:wrap;overflow:visible\}/);
  assert.match(evo, /\.page-tabs\{gap:12px 16px;margin-top:27.6px;flex-wrap:wrap;overflow:visible;\}/);
});
