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
  assert.match(chat, /function pickUploadedIcon\(\)/);
  assert.match(chat, /function choosePresetIcon\(url\)/);
  assert.match(chat, /update\(\{ icon_url: url \}\)\.eq\('id', currentUser\.id\)/);
  assert.match(chat, /insert\(\{ id: uid, username, icon_url: pendingPresetUserIconUrl \|\| null \}\)/);
  assert.match(chat, /canvas\.toBlob\(resolve, 'image\/webp', 0\.82\)/);
  assert.match(chat, /cacheControl: '31536000'/);
  assert.match(chat, /profile-icons\/catalog\.json', \{ cache: 'force-cache' \}/);
});

test('talk room icons can use the same presets or an uploaded image', () => {
  assert.match(chat, /openPresetIconPicker\('group'\)/);
  assert.match(chat, /iconPickerTarget === 'group' \? 'groupIconInput' : 'userIconInput'/);
  assert.match(chat, /await applyGroupIconUrl\(currentGroupId, url\)/);
  assert.match(chat, /update\(\{ icon_url: url \}\)\.eq\('id', groupId\)/);
});

test('profile icon choices stay large and spaced on mobile', () => {
  assert.match(chat, /\.profile-icon-grid \{[\s\S]*?repeat\(4, minmax\(78px, 1fr\)\)[\s\S]*?gap: 14px/);
  assert.match(chat, /@media \(max-width: 560px\) \{[\s\S]*?repeat\(3, minmax\(74px, 1fr\)\)/);
  assert.match(chat, /\.profile-icon-option \{[\s\S]*?min-height: 84px/);
  assert.match(chat, /\.profile-icon-option img \{[^}]*object-fit: contain/);
});

test('reaction details identify each user with a transparent icon background', () => {
  assert.match(chat, /function openReactionDetails\(messageId\)/);
  assert.match(chat, /groupMembers\.find\(\(member\) => String\(member\.id\) === String\(row\.user_id\)\)/);
  assert.match(chat, /const iconUrl = user \? personIconUrl\(user\) : ''/);
  assert.match(chat, /reaction-detail-avatar[^}]*background: transparent/);
  assert.match(chat, /if \(chip\) \{ openReactionDetails\(Number\(chip\.dataset\.messageId\)\); return; \}/);
});

test('message action menu stays compact with horizontal icon actions', () => {
  assert.match(chat, /\.msg-menu \{[\s\S]*?width: min\(292px, calc\(100vw - 24px\)\)/);
  assert.match(chat, /\.msg-menu \{[\s\S]*?background: rgba\(35, 35, 38, 0\.4\)/);
  assert.match(chat, /\.msg-menu-emojis \{[\s\S]*?grid-template-columns: repeat\(5, 40px\)[\s\S]*?justify-content: space-between/);
  assert.match(chat, /class="msg-menu-actions"/);
  assert.match(chat, /msg-menu-action-icon/);
});

test('reaction menu shows all varied emotions without scrolling', () => {
  assert.match(chat, /const REACTION_CHOICES = \[[\s\S]*?'😡'[\s\S]*?'😓'[\s\S]*?'🤔'[\s\S]*?'🙄'[\s\S]*?'😭'[\s\S]*?'🎉'[\s\S]*?'👏'[\s\S]*?'👀'[\s\S]*?'🤷'/);
  assert.doesNotMatch(chat, /\.msg-menu-emojis \{[^}]*overflow-x: auto/);
  assert.match(chat, /Math\.min\(preferredTop, window\.innerHeight - menuRect\.height - 8\)/);
});

test('compact composer uses a short placeholder without desktop-only instructions', () => {
  assert.match(chat, /const compactComposer = isMobileLayout\(\) \|\| window\.innerWidth <= 1024/);
  assert.match(chat, /compactComposer[\s\S]*?'メッセージを入力（#メモ対応）'/);
  assert.match(chat, /compactComposer[\s\S]*?'メッセージを入力'[\s\S]*?'メッセージ（Shift\+Enterで改行）'/);
});
