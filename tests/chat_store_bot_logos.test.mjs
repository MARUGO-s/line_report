import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const chat = await readFile(new URL('../public/chat.html', import.meta.url), 'utf8');

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
