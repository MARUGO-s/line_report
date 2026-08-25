import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// public/jnm/jnl2txt.html から mtalkPlainTextFromMarkdown を取り出して評価する。
async function loadFormatter() {
  const html = await readFile(new URL('../public/jnm/jnl2txt.html', import.meta.url), 'utf8');
  const start = html.indexOf('function mtalkPlainTextFromMarkdown');
  assert.notEqual(start, -1, 'mtalkPlainTextFromMarkdown が jnl2txt.html に見つかりません');
  const marker = 'async function postAiAnswerToMtalk';
  const end = html.indexOf(marker, start);
  assert.notEqual(end, -1, 'postAiAnswerToMtalk が見つかりません（抽出範囲の終端）');
  const source = html.slice(start, end);
  const context = {};
  vm.createContext(context);
  new vm.Script(`${source}\nthis.mtalkPlainTextFromMarkdown = mtalkPlainTextFromMarkdown;`).runInContext(context);
  return context.mtalkPlainTextFromMarkdown;
}

test('Markdownの見出し・強調・水平線を読みやすいテキストへ整形する', async () => {
  const format = await loadFormatter();
  const md = [
    '## ビストロ サヴァサヴァ',
    '### 2026年7月の売上実績と振り返り',
    '',
    '**フード59%**、ドリンク41%でした。',
    '',
    '---',
    '',
    '- ディナー中心',
    '- ワインのペアリング',
  ].join('\n');
  const out = format(md);
  assert.match(out, /^■ ビストロ サヴァサヴァ$/m);
  assert.match(out, /^▪ 2026年7月の売上実績と振り返り$/m);
  assert.match(out, /フード59%、ドリンク41%でした。/);
  assert.doesNotMatch(out, /\*\*/, '強調記号 ** が残っています');
  assert.doesNotMatch(out, /^#/m, '見出し記号 # が残っています');
  assert.match(out, /^・ディナー中心$/m);
  assert.match(out, /────────/);
});

test('2列の表を「項目：値」に整形し、区切り行と記号を除去する', async () => {
  const format = await loadFormatter();
  const md = [
    '| 指標 | 実績 |',
    '|---|---:|',
    '| 総売上 | **¥1,300,000** |',
    '| 総来店客数 | **124名** |',
    '| 客単価 | **¥10,484** |',
  ].join('\n');
  const out = format(md);
  assert.match(out, /^指標：実績$/m);
  assert.match(out, /^総売上：¥1,300,000$/m);
  assert.match(out, /^総来店客数：124名$/m);
  assert.match(out, /^客単価：¥10,484$/m);
  assert.doesNotMatch(out, /\|/, 'パイプ記号 | が残っています');
  assert.doesNotMatch(out, /-{3,}/, '表の区切り行が残っています');
});

test('3列以上の表はスラッシュ区切りにする', async () => {
  const format = await loadFormatter();
  const md = [
    '| 日付 | 売上 | 客数 |',
    '|---|---|---|',
    '| 7/1 | ¥50,000 | 8名 |',
  ].join('\n');
  const out = format(md);
  assert.match(out, /^日付 \/ 売上 \/ 客数$/m);
  assert.match(out, /^7\/1 \/ ¥50,000 \/ 8名$/m);
});

test('空文字は空文字を返す', async () => {
  const format = await loadFormatter();
  assert.equal(format(''), '');
  assert.equal(format(null), '');
});
