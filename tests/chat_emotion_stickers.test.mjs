import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const chat = await readFile(new URL('../public/chat.html', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260821123000_chat_emotion_stickers.sql', import.meta.url), 'utf8');
const addedStickerMigration = await readFile(new URL('../supabase/migrations/20260823030000_chat_emotion_stickers_more.sql', import.meta.url), 'utf8');
const categoryMigration = await readFile(new URL('../supabase/migrations/20260823033000_chat_sticker_categories_and_symbols.sql', import.meta.url), 'utf8');

test('M-talk exposes all emotion illustrations from the database catalog', async () => {
  const assets = (await readdir(new URL('../public/stickers/face/', import.meta.url))).filter((name) => name.endsWith('.png'));
  assert.equal(assets.length, 93);
  assert.match(migration, /create table if not exists public\.chat_stickers/);
  assert.match(migration, /create policy chat_stickers_select_authenticated/);
  const symbolAssets = (await readdir(new URL('../public/stickers/symbol/', import.meta.url))).filter((name) => name.endsWith('.png'));
  assert.equal(symbolAssets.length, 39);
  const stickerMigrations = `${migration}\n${addedStickerMigration}\n${categoryMigration}`;
  for (const asset of assets) assert.match(stickerMigrations, new RegExp(`stickers/face/${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  for (const asset of symbolAssets) assert.match(categoryMigration, new RegExp(`stickers/symbol/${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('authenticated users can send only active catalog stickers', () => {
  assert.match(migration, /kind in \('text', 'card', 'image', 'sticker'\)/);
  assert.match(migration, /new\.kind not in \('text', 'image', 'sticker'\)/);
  assert.match(migration, /from public\.chat_stickers where id = v_sticker_id and is_active/);
  assert.match(migration, /new\.content := '\[感情イラスト\] ' \|\| v_sticker_label/);
  assert.match(migration, /when \(new\.kind <> 'sticker'\)/);
});

test('composer picker sends and renders sticker messages', () => {
  assert.match(chat, /id="stickerPicker"/);
  assert.match(chat, /class="attach-btn sticker-trigger-btn"/);
  assert.match(chat, /\.sticker-trigger-btn \{[\s\S]*?font-size: 28px;/);
  assert.match(chat, /from\('chat_stickers'\)/);
  assert.match(chat, /kind: 'sticker'/);
  assert.match(chat, /function stickerFromMessage\(msg\)/);
  assert.match(chat, /class="msg-sticker"/);
  assert.match(chat, /sendSticker\(button\.dataset\.stickerId\)/);
  assert.match(chat, /STICKER_CATALOG_CACHE_KEY/);
  assert.match(chat, /loading="lazy" decoding="async"/);
  assert.match(chat, /warmImageAssets\(\)/);
});

test('sticker picker separates emotion and symbol illustrations with swipeable tabs', () => {
  assert.match(categoryMigration, /add column if not exists category text not null default 'emotion'/);
  assert.match(categoryMigration, /category in \('emotion', 'symbol'\)/);
  assert.match(chat, /STICKER_CATEGORIES = \[[\s\S]*?'emotion'[\s\S]*?'感情'[\s\S]*?'symbol'[\s\S]*?'漫符・記号'/);
  assert.match(chat, /\.sticker-tabs \{[\s\S]*?overflow-x: auto/);
  assert.match(chat, /data-sticker-category/);
  assert.match(chat, /stickerCatalog\.filter\(\(sticker\) => \(sticker\.category \|\| 'emotion'\) === activeStickerCategory\)/);
});
