import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chatScriptPaths } from './helpers/chat-page-source.mjs';

test('all public HTML files contain valid JavaScript syntax without parse errors', async () => {
  const publicDir = new URL('../public/', import.meta.url);
  const files = await readdir(publicDir);
  const htmlFiles = files.filter(f => f.endsWith('.html'));

  for (const htmlFile of htmlFiles) {
    const content = await readFile(new URL(htmlFile, publicDir), 'utf8');
    const scriptRegex = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    let scriptIdx = 0;
    while ((match = scriptRegex.exec(content)) !== null) {
      scriptIdx++;
      const code = match[1].trim();
      if (!code) continue;
      // Skip type="application/json" etc.
      if (match[0].includes('type="application/json"') || match[0].includes('type="importmap"')) {
        continue;
      }
      try {
        new vm.Script(code, { filename: `${htmlFile}#script${scriptIdx}` });
      } catch (err) {
        assert.fail(`Syntax error in ${htmlFile} script #${scriptIdx}: ${err.message}`);
      }
    }
  }
});

test('all external M-talk scripts contain valid JavaScript syntax', async () => {
  const publicDir = new URL('../public/', import.meta.url);
  const paths = chatScriptPaths();
  assert.ok(paths.length > 0);
  for (const path of paths) {
    const code = await readFile(new URL(path, publicDir), 'utf8');
    assert.doesNotThrow(() => new vm.Script(code, { filename: path }));
  }
});

test('M-talk keeps presentation and behavior in external assets', async () => {
  const html = await readFile(new URL('../public/chat.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/i);
  assert.match(html, /href="chat\/chat\.css"/);
  assert.equal(chatScriptPaths().length, 11);
});
