import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readChatPageSource } from './helpers/chat-page-source.mjs';

const chat = await readChatPageSource();

const expectedStoreLogos = {
  marugo: 'marugo.svg', marugosecond: 'marugosecond.svg', marugogrande: 'marugogrande.svg',
  sannanaichi: 'sannanaichi.svg', shenlong: 'shenlong.svg', claudia2: 'claudia2.svg',
  sauvage: 'sauvage.svg', barpelota: 'barpelota.svg', briccola: 'briccola.svg',
  violette: 'violette.svg', marugootto: 'marugootto.svg', donaiya: 'donaiya.svg',
  marugoyotsuya: 'marugoyotsuya.svg', sushikoruri: 'sushikoruri.svg',
  bistrocavacava: 'bistrocavacava.svg', marugoS: 'marugo-s.svg',
  marugoshinbashi: 'marugoshinbashi.svg', marugomarunouchi: 'marugomarunouchi.svg',
  yakinikumarugo: 'yakinikumarugo.svg', erics: 'erics.svg', mitan: 'mitan.svg', marugoD: 'marugo-d.svg',
};

test('all configured stores have a bundled M-talk Bot logo', async () => {
  for (const [storeKey, fileName] of Object.entries(expectedStoreLogos)) {
    assert.match(chat, new RegExp(`${storeKey}: 'icons/store-bots/${fileName.replace('.', '\\.')}'`));
    const svg = await readFile(new URL(`../public/icons/store-bots/${fileName}`, import.meta.url), 'utf8');
    assert.match(svg, /<svg\b/i);
  }
});

test('store Bot logos override profile icons and are used for direct-room icons', () => {
  assert.match(chat, /return storeBotLogoUrl\(user\) \|\| String\(\(user && user\.icon_url\) \|\| ''\)/);
  assert.match(chat, /if \(group && group\.is_direct && group\.peer\) return personIconUrl\(group\.peer\)/);
  assert.match(chat, /if \(group && group\.is_store_room\) return storeBotLogoForKey\(group\.store_key\) \|\| group\.icon_url/);
  assert.match(chat, /const iconUrl = personIconUrl\(user\)/);
});

test('store Bot logos use a white background without changing regular profile images', () => {
  assert.match(chat, /img\[src\*="icons\/store-bots\/"\][\s\S]*?background: #fff;[\s\S]*?object-fit: contain;[\s\S]*?padding: 4px;/);
  assert.match(chat, /\.rail-avatar img,[\s\S]*?object-fit: cover;/);
});

test('store Bot logos show a red bot mark inside the avatar', () => {
  assert.match(chat, /showBotMark \? '<span class="store-bot-avatar-mark" aria-hidden="true">bot<\/span>' : ''/);
  assert.match(chat, /\.store-bot-avatar-mark \{[\s\S]*?color: #d70015;[\s\S]*?font-size: 8px;/);
  assert.match(chat, /right: 7px;[\s\S]*?bottom: 6px;/);
});

// 店舗ロゴは一般ユーザー・グループも選べるため、アイコンのパスで bot を判定すると
// 人やグループに bot バッジが付く。判定は必ず相手が店舗Botかどうかで行う。
test('bot mark follows the account, not the icon path', () => {
  assert.doesNotMatch(chat, /icons\/store-bots\/'\)/);
  assert.match(chat, /function avatarHtml\(name, iconUrl, showBotMark = false\)/);
  assert.match(chat, /function paintAvatar\(el, name, iconUrl, showBotMark = false\)/);
  assert.match(chat, /avatarHtml\(personAvatarKey\(user\), iconUrl, isStoreBot\(user\)\)/);
  assert.match(chat, /avatarHtml\(user\.username, user\.icon_url, isStoreBot\(user\)\)/);
  assert.match(chat, /function roomAvatarIsBot\(group\)/);
  assert.match(chat, /if \(group\.is_direct && group\.peer\) return isStoreBot\(group\.peer\)/);
  assert.match(chat, /paintAvatar\(\$\('chatGroupAvatar'\), roomTitle\(group\), roomIcon\(group\), roomAvatarIsBot\(group\)\)/);
});
