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
});
