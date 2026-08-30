import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { readChatPageSourceSync } from './helpers/chat-page-source.mjs';

const chat = readChatPageSourceSync();
const catalog = JSON.parse(readFileSync(new URL('../public/profile-icons/catalog.json', import.meta.url), 'utf8'));
const files = readdirSync(new URL('../public/profile-icons/', import.meta.url)).filter((name) => name.endsWith('.png'));
const serviceWorker = readFileSync(new URL('../public/chat-sw.js', import.meta.url), 'utf8');

test('profile icon catalog exposes every optimized bundled icon', () => {
  assert.equal(catalog.length, 93);
  assert.equal(files.length, 93);
  assert.ok(catalog.every((icon) => /^profile-icons\/\d{3}\.png$/.test(icon.path)));
});

// 店舗ロゴはカタログへ複製せず STORE_BOT_LOGOS から組み立てる。複製すると
// 店舗の追加時に二重管理となり、表示名も実際の店舗名からずれる。
test('store logos are offered from the store registry, not duplicated into the catalog', () => {
  assert.ok(catalog.every((icon) => !icon.path.includes('icons/store-bots/')));
  assert.match(chat, /function storeIconOptions\(\)/);
  assert.match(chat, /Object\.entries\(STORE_BOT_LOGOS\)\.map\(\(\[storeKey, path\]\) => \(\{/);
  assert.match(chat, /label: storeDisplayLabel\(storeKey\)/);
  assert.match(chat, /\.\.\.storeIconOptions\(\)\.map\(iconOptionHtml\)/);
  assert.match(chat, /\.\.\.profileIconCatalog\.map\(iconOptionHtml\)/);
  assert.match(chat, /\.profile-icon-group-label \{[\s\S]*?grid-column: 1 \/ -1/);
});

// catalog.json は追加のたびに中身が変わる。cache-first と force-cache を重ねると
// アイコンを増やしても古い一覧が返り続け、新しい絵が誰にも届かない。
test('the icon catalog can be refreshed after new icons ship', () => {
  // Service Worker が cache-first にするのは画像そのものだけ。
  assert.match(serviceWorker, /\/\\\.\(png\|jpe\?g\|webp\|gif\|svg\)\$\/i\.test\(url\.pathname\)/);
  assert.match(serviceWorker, /&& \(url\.pathname\.includes\('\/profile-icons\/'\)/);
  // ページ側も、常に検証してから使う取り方にする。
  assert.doesNotMatch(chat, /catalog\.json', \{ cache: 'force-cache' \}/);
  assert.match(chat, /catalog\.json', \{ cache: 'no-cache' \}/);
});

test('new and existing users can select bundled icons while uploads remain available', () => {
  assert.match(chat, /function pickUploadedIcon\(\)/);
  assert.match(chat, /function choosePresetIcon\(url\)/);
  assert.match(chat, /update\(\{ icon_url: url \}\)\.eq\('id', currentUser\.id\)/);
  assert.match(chat, /rpc\('chat_complete_signup'/);
  assert.match(chat, /p_icon_url: iconUrl/);
  assert.match(chat, /canvas\.toBlob\(resolve, 'image\/webp', 0\.82\)/);
  assert.match(chat, /cacheControl: '31536000'/);
  assert.match(chat, /profile-icons\/catalog\.json', \{ cache: 'no-cache' \}/);
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
  assert.match(chat, /プレースホルダーが折り返す幅では[\s\S]*?resizeComposer\(\);/);
  assert.match(chat, /window\.addEventListener\('resize',[\s\S]*?resizeComposer\(\);[\s\S]*?syncChatViewport\(\);/);
  assert.match(chat, /context\.measureText\(input\.placeholder\)\.width \/ innerWidth/);
  assert.match(chat, /Math\.max\(40, input\.scrollHeight, placeholderHeight\)/);
});

test('rich cards use enlarged type for reservations and receipt results', () => {
  assert.match(chat, /\.msg-card-title \{\s*font-size: 18px/);
  assert.match(chat, /\.msg-card-field \{[^}]*font-size: 15px/);
  assert.match(chat, /\.msg-card-field dt \{[\s\S]*?flex: 0 0 88px;[\s\S]*?min-width: max-content;[\s\S]*?white-space: nowrap;/);
  assert.match(chat, /\.msg-card-line \.msg-card-field dt \{[^}]*min-width: max-content;[^}]*white-space: nowrap;/);
  assert.match(chat, /\.msg-card-line \.msg-card-field \{[^}]*font-size: 15px/);
  assert.match(chat, /\.msg-card-action \{[\s\S]*?font-size: 16px/);
  assert.match(chat, /\.msg-card-heading \{ font-size: 15px/);
});

test('rich cards use half-size row gaps with tighter readable line spacing', () => {
  assert.match(chat, /\.msg-card-body \{[\s\S]*?gap: 5px/);
  assert.match(chat, /\.msg-card-field \{[^}]*line-height: 1\.4/);
  assert.match(chat, /\.msg-card-para \+ \.msg-card-para \{ margin-top: 3px; \}/);
  assert.match(chat, /\.msg-card-line \.msg-card-body \{ gap: 1px/);
});
