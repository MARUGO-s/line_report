import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const htmlUrl = new URL('../public/jnm/jnl2txt.html', import.meta.url);

test('Journal store selector keeps lowercase storage keys displayable as canonical options', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  const start = html.indexOf('function resolveJournalStoreOptionKey(');
  const end = html.indexOf('async function initJournalStoreSelect()', start);
  assert.notEqual(start, -1, '店舗selectの大小文字対応ヘルパーが必要です');
  assert.notEqual(end, -1, '店舗selectの初期化位置を特定できません');
  const block = html.slice(start, end);

  assert.match(block, /store\.store_key\.toLowerCase\(\) === normalized/);
  assert.match(block, /const scopedKey = resolveJournalStoreOptionKey\(authStoreScope, stores\)/);
  assert.match(block, /const selectedOptionKey = resolveJournalStoreOptionKey\(key\)/);
  assert.match(block, /sel\.value = selectedOptionKey/);
  assert.match(block, /STORE_KEY = key/);

  const helper = block.match(/function resolveJournalStoreOptionKey\([\s\S]*?\n}\n/);
  assert.ok(helper, '店舗selectの大小文字対応ヘルパーを抽出できません');
  const context = {
    listJournalStores: () => [],
    String,
  };
  vm.runInNewContext(`${helper[0]}this.resolveOption = resolveJournalStoreOptionKey;`, context);
  const stores = [
    { store_key: 'marugoS', store_name: 'マルゴエス' },
    { store_key: 'bistrocavacava', store_name: 'Bistro CAVACAVA' },
  ];
  assert.equal(context.resolveOption('marugos', stores), 'marugoS');
  assert.equal(context.resolveOption('marugoS', stores), 'marugoS');
});
