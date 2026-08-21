import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const chat = readFileSync(new URL('../public/chat.html', import.meta.url), 'utf8');
const catalog = JSON.parse(readFileSync(new URL('../public/profile-icons/catalog.json', import.meta.url), 'utf8'));
const files = readdirSync(new URL('../public/profile-icons/', import.meta.url)).filter((name) => name.endsWith('.png'));

test('profile icon catalog exposes every optimized bundled icon', () => {
  assert.equal(catalog.length, 70);
  assert.equal(files.length, 70);
  assert.ok(catalog.every((icon) => /^profile-icons\/\d{3}\.png$/.test(icon.path)));
});

test('new and existing users can select bundled icons while uploads remain available', () => {
  assert.match(chat, /function pickUploadedUserIcon\(\)/);
  assert.match(chat, /function choosePresetUserIcon\(url\)/);
  assert.match(chat, /update\(\{ icon_url: url \}\)\.eq\('id', currentUser\.id\)/);
  assert.match(chat, /insert\(\{ id: uid, username, icon_url: pendingPresetUserIconUrl \|\| null \}\)/);
  assert.match(chat, /canvas\.toBlob\(resolve, 'image\/webp', 0\.82\)/);
  assert.match(chat, /cacheControl: '31536000'/);
  assert.match(chat, /profile-icons\/catalog\.json', \{ cache: 'force-cache' \}/);
});

test('profile icon choices stay large and spaced on mobile', () => {
  assert.match(chat, /\.profile-icon-grid \{[\s\S]*?repeat\(4, minmax\(78px, 1fr\)\)[\s\S]*?gap: 14px/);
  assert.match(chat, /@media \(max-width: 560px\) \{[\s\S]*?repeat\(3, minmax\(74px, 1fr\)\)/);
  assert.match(chat, /\.profile-icon-option \{[\s\S]*?min-height: 84px/);
  assert.match(chat, /\.profile-icon-option img \{[^}]*object-fit: contain/);
});
