import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import vm from 'node:vm';

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
