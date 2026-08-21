import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const chat = await readFile(new URL('../public/chat.html', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260821123000_chat_emotion_stickers.sql', import.meta.url), 'utf8');
const gifMigration = await readFile(new URL('../supabase/migrations/20260821140500_chat_emotion_sticker_gif.sql', import.meta.url), 'utf8');
const stickerMigrations = migration + gifMigration;

test('M-talk exposes all emotion illustrations from the database catalog', async () => {
  const assets = (await readdir(new URL('../public/stickers/face/', import.meta.url))).filter((name) => /\.(png|gif)$/.test(name));
  assert.equal(assets.length, 40);
  assert.match(migration, /create table if not exists public\.chat_stickers/);
  assert.match(migration, /create policy chat_stickers_select_authenticated/);
  for (const asset of assets) assert.match(stickerMigrations, new RegExp(`stickers/face/${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(gifMigration, /check \(asset_path ~ '\^stickers\/face\/\.\+\\\.\(png\|gif\)\$'\)/);
  assert.match(gifMigration, /'hello-character', 'こんにちは', 'stickers\/face\/rh4dx-0yp8a\.gif', 40/);
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
});
