import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (rel) => readFile(new URL(rel, root), 'utf8');

test('sales sheet links stay hidden unless they have an http(s) URL', async () => {
  const config = await read('public/pages-config.js');
  assert.match(config, /function isUsableSalesSheetUrl/);
  assert.match(config, /#salesSheetNavLink/);
  assert.match(config, /preventDefault/);

  const analytics = await read('public/analytics.html');
  assert.match(analytics, /LINE_REPORT_PAGES\.isUsableSalesSheetUrl/);
  assert.match(analytics, /lsa-navitem\[hidden\]/);
});

test('analytics and reviews wrap the header pills on a narrow phone', async () => {
  const analytics = await read('public/analytics.html');
  const reviews = await read('public/reviews.html');
  assert.match(analytics, /\.status \{ flex-wrap: wrap; overflow: visible; \}/);
  assert.match(reviews, /\.status \{ flex-wrap: wrap; overflow: visible; \}/);
});

test('media document filters stack to full width on a phone', async () => {
  const media = await read('public/media.html');
  const mobile = media.slice(media.indexOf('@media (max-width: 880px)'));
  assert.match(mobile, /\.controls \{ flex-direction: column;/);
  assert.match(mobile, /min-width: 0 !important/);
});

test('system map and evolution tabs wrap instead of clipping', async () => {
  const map = await read('public/system-map.html');
  const evo = await read('public/foodcourt-evolution.html');
  assert.match(map, /\.tabs\{flex-wrap:wrap;overflow:visible\}/);
  assert.match(evo, /\.page-tabs\{gap:12px 16px;margin-top:27.6px;flex-wrap:wrap;overflow:visible;\}/);
});

test('chat mobile layout keeps controls inside phone safe areas and prevents page zoom', async () => {
  const chat = await read('public/chat.html');
  assert.match(chat, /minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover/);
  assert.match(chat, /--mobile-safe-top: max\(12px, env\(safe-area-inset-top, 0px\)\)/);
  assert.match(chat, /--mobile-safe-bottom: max\(12px, env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(chat, /--mobile-safe-left: max\(8px, env\(safe-area-inset-left, 0px\)\)/);
  assert.match(chat, /--mobile-safe-right: max\(8px, env\(safe-area-inset-right, 0px\)\)/);
  assert.match(chat, /touch-action: pan-x pan-y/);
  assert.match(chat, /--chat-viewport-height: 100dvh/);
  assert.match(chat, /height: var\(--chat-viewport-height\)/);
  assert.match(chat, /max-height: 600px\) and \(pointer: coarse\)/);
  assert.match(chat, /\.invite-overlay \{\s+position: absolute;\s+padding:/);
  assert.match(chat, /\.login-screen \{\s+position: absolute;\s+padding:/);
  assert.match(chat, /input\[type="search"\],[\s\S]*?font-size: 16px/);
  assert.match(chat, /function syncChatViewport\(keepComposerVisible = false\)/);
  assert.match(chat, /window\.visualViewport\.addEventListener\('resize'/);
  assert.match(chat, /window\.visualViewport\.addEventListener\('scroll'/);
  assert.match(chat, /messageInput'\)\.addEventListener\('focus'/);
  assert.match(chat, /function preventMobileZoomGesture\(event\)/);
  assert.match(chat, /event\.touches\.length > 1/);
  assert.match(chat, /addEventListener\('gesturestart', preventMobileZoomGesture, \{ passive: false \}\)/);
  assert.match(chat, /addEventListener\('gestureend', preventMobileZoomGesture, \{ passive: false \}\)/);
  assert.match(chat, /addEventListener\('touchmove', preventMobileZoomGesture, \{ passive: false \}\)/);
});
