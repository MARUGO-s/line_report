import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../public/foodcourt.html', import.meta.url), 'utf8');

test('Q&A input is multiline and Enter does not submit to the AI', () => {
  assert.match(page, /<textarea id="qInput"[^>]*rows="3"/);
  assert.match(page, /Enterで改行・変換確定/);
  assert.match(page, /\.qbar input,\.qbar textarea\{flex-basis:100%;\}/);
  assert.match(page, /<button class="btn primary" id="qBtn" type="button">質問する<\/button>/);
  assert.match(page, /Q&A入力はtextarea。Enterは改行またはIME変換の確定に使い、AI解析は質問ボタンだけで開始する/);
  assert.doesNotMatch(page, /dom\.qInput\.addEventListener\(['"]keydown['"][\s\S]*?askQuestion\(\)/);
});

test('only the Q&A button and explicit suggestion choices call askQuestion', () => {
  const qEvents = page.match(/dom\.q(Input|Btn)\.addEventListener\([^;]+/g) || [];
  assert.equal(qEvents.some((event) => event.includes('qInput') && event.includes('keydown')), false);
  assert.equal(qEvents.some((event) => event.includes('qBtn') && event.includes("'click'")), true);
  assert.match(page, /data-qa-choice/);
  assert.match(page, /qaChoiceLock/);
  assert.match(page, /askQuestion\(btn\.getAttribute\('data-qa-choice'\)\)/);
});
