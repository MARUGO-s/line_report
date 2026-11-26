import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const adminApi = await readFile(
  new URL('../supabase/functions/admin-api/index.ts', import.meta.url),
  'utf8',
);

test('product-search supports mode=catalog for mobile registered product listing and rankings', () => {
  const searchStart = adminApi.indexOf('async function searchPosJournalProducts(');
  const catalogStart = adminApi.indexOf('async function fetchPosJournalProductCatalog(');
  assert.notEqual(searchStart, -1);
  assert.notEqual(catalogStart, -1);

  const searchHead = adminApi.slice(searchStart, searchStart + 700);
  assert.match(searchHead, /url\.searchParams\.get\("mode"\) === "catalog"/);
  assert.match(searchHead, /fetchPosJournalProductCatalog\(supabase, storeKey, url\)/);

  const catalogBody = adminApi.slice(catalogStart, searchStart);
  assert.match(catalogBody, /journal_product_monthly_index/);
  assert.match(catalogBody, /scanPosJournalParsedRows/);
  assert.match(catalogBody, /sort === "qty"/);
  assert.match(catalogBody, /sort === "name"/);
  assert.match(catalogBody, /share_pct:/);
  assert.match(catalogBody, /total_products:/);
  assert.match(catalogBody, /mode: "catalog"/);
});
