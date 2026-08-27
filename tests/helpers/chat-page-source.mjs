import { readFile, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const readFileAsync = promisify(readFile);
const publicDir = new URL('../../public/', import.meta.url);

function referencedAssets(html) {
  const paths = [];
  for (const match of html.matchAll(/<link\b[^>]*\bhref="(chat\/[^"]+\.css)"[^>]*>/gi)) {
    paths.push(match[1]);
  }
  for (const match of html.matchAll(/<script\b[^>]*\bsrc="(chat\/[^"]+\.js)"[^>]*><\/script>/gi)) {
    paths.push(match[1]);
  }
  return paths;
}

export async function readChatPageSource() {
  const html = await readFileAsync(new URL('chat.html', publicDir), 'utf8');
  const assets = await Promise.all(
    referencedAssets(html).map((path) => readFileAsync(new URL(path, publicDir), 'utf8')),
  );
  return `${html}\n${assets.join('\n')}`;
}

export function readChatPageSourceSync() {
  const html = readFileSync(new URL('chat.html', publicDir), 'utf8');
  const assets = referencedAssets(html).map((path) => readFileSync(new URL(path, publicDir), 'utf8'));
  return `${html}\n${assets.join('\n')}`;
}

export function chatScriptPaths() {
  const html = readFileSync(new URL('chat.html', publicDir), 'utf8');
  return referencedAssets(html).filter((path) => path.endsWith('.js'));
}
