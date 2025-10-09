import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const targetPath = path.join(projectRoot, 'node_modules', 'pdf-parse', 'index.js');

try {
  const original = readFileSync(targetPath, 'utf8');
  const PATTERN = /let\s+isDebugMode\s*=\s*!module\.parent\s*;/;

  if (!PATTERN.test(original)) {
    console.log('[postinstall] pdf-parse index.js already patched or signature not found.');
  } else {
    const patched = original.replace(PATTERN, 'let isDebugMode = false;');
    writeFileSync(targetPath, patched, 'utf8');
    console.log('[postinstall] Patched pdf-parse index.js to disable debug routine.');
  }
} catch (error) {
  console.warn('[postinstall] Could not patch pdf-parse index.js:', error.message);
}
