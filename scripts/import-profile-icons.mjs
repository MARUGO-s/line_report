#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const sourceDir = resolve(process.argv[2] || '');
const outputDir = resolve(process.argv[3] || 'public/profile-icons');
if (!process.argv[2]) throw new Error('素材フォルダを指定してください');

const files = readdirSync(sourceDir)
  .filter((name) => /\.(png|jpe?g)$/i.test(name))
  .sort((a, b) => a.localeCompare(b, 'ja'));

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const catalog = files.map((name, index) => {
  const id = String(index + 1).padStart(3, '0');
  const outputName = `${id}.png`;
  const source = join(sourceDir, name);
  const output = join(outputDir, outputName);
  const dimensions = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', source], { encoding: 'utf8' });
  const width = Number(dimensions.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(dimensions.match(/pixelHeight:\s*(\d+)/)?.[1]);
  const square = Math.min(width, height);
  if (!square) throw new Error(`画像サイズを取得できません: ${name}`);
  const cropped = join(outputDir, `.${id}-cropped.png`);
  execFileSync('sips', ['-c', String(square), String(square), '-s', 'format', 'png', source, '--out', cropped], { stdio: 'ignore' });
  execFileSync('sips', ['-z', '256', '256', cropped, '--out', output], { stdio: 'ignore' });
  rmSync(cropped, { force: true });
  return { id, label: basename(name, extname(name)).normalize('NFC'), path: `profile-icons/${outputName}` };
});

writeFileSync(join(outputDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`profile icons: ${catalog.length}`);
