import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readChatPageSource } from './helpers/chat-page-source.mjs';

const root = new URL('../', import.meta.url);
const read = (rel) => rel === 'public/chat.html'
  ? readChatPageSource()
  : readFile(new URL(rel, root), 'utf8');

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

test('chat notification test button stays out of the talk tab row on desktop', async () => {
  const chat = await read('public/chat.html');
  assert.match(chat, /class="talk-tabs-scroll"/);
  assert.match(chat, /class="talk-tabs-actions"/);
  assert.match(chat, /\.talk-tabs-actions \{\s+display: none;/);
  assert.match(chat, /\.talk-tabs-actions \{ display: flex; \}/);
  assert.match(chat, /\.talk-tabs-actions \.push-test-btn \{[\s\S]*?white-space: nowrap;/);
  const actionsAt = chat.indexOf('class="talk-tabs-actions"');
  const actions = chat.slice(actionsAt, actionsAt + 900);
  assert.match(actions, /data-push-test/);
  assert.match(actions, /通知テスト/);
  assert.doesNotMatch(chat.slice(chat.indexOf('class="talk-tabs-scroll"'), actionsAt), /data-push-test/);
});

test('short chat histories stay next to the composer instead of leaving a middle gap', async () => {
  const chat = await read('public/chat.html');
  assert.match(chat, /\.messages::before \{[\s\S]*?margin-top: auto;/);
});

test('AI loading sub-label wraps instead of overflowing the chat bubble', async () => {
  const html = await read('public/jnm/jnl2txt.html');

  // 見出し行は点滅ドットを同じ行に保つため nowrap のままでよい。
  assert.match(html, /\.ai-loading-label \{[^}]*white-space: nowrap;/);

  // 長い補足行が同じクラスを使うと折り返せず、吹き出しの右端で文字が切れる。
  // 実際に「…を開始しま」で切れる不具合が出たため、専用クラスへ分けた。
  const sub = html.match(/\.ai-loading-sub \{[^}]*\}/);
  assert.ok(sub, '.ai-loading-sub must exist');
  assert.match(sub[0], /white-space: normal;/);
  assert.doesNotMatch(sub[0], /white-space: nowrap;/);

  // 親が吹き出し幅を超えると、子を折り返しても切れたままになる。
  assert.match(html, /\.ai-loading-wrap \{[^}]*max-width: 100%;/);

  // 補足行が nowrap のクラスへ戻っていないこと。
  assert.doesNotMatch(
    html,
    /class="ai-loading-label"[^>]*>準備完了後に/,
    'the long sub-label must not reuse the nowrap label class',
  );
  assert.match(html, /class="ai-loading-sub">準備完了後に/);
});

test('classification workspace uses select-and-assign, not 21 parallel lanes', async () => {
  const html = await read('public/jnm/jnl2txt.html');

  // 分類先が21個に増え、レーン並列では空欄が場所を取り、目的地まで長距離
  // ドラッグが必要だった。左で選び右のボタンで移す二面構成にした。
  assert.match(html, /class="classification-split"/);
  assert.match(html, /class="classification-target"/);
  assert.doesNotMatch(html, /class="classification-board"/);

  // 分類先はグループに分ける。21個をただ並べても目的地を探せない。
  assert.match(html, /const CLASSIFICATION_TARGET_GROUPS=\[/);
  for (const label of ['フード内訳', 'ワイン（グラス）', 'ワイン（ボトル）']) {
    assert.ok(html.includes(label), `target group ${label} must exist`);
  }

  // 絞り込みが無いと目的の商品に辿り着けない。
  assert.match(html, /id="classifySearch"/);
  assert.match(html, /id="classifyUnsetOnly"/);

  // display:flex は hidden 属性より詳細度が高い。この行が無いと絞り込んでも
  // 行が消えず、件数表示とだけ食い違う（実際にその症状が出た）。
  assert.match(html, /\.classification-item\[hidden\]\{display:none\}/);

  // 隠れた行が選択されたままだと、見えないものが移動して事故になる。
  assert.match(html, /if\(!visible\) el\.classList\.remove\('selected'\);/);

  // ドラッグは従来どおり残す。慣れた操作を奪わない。
  assert.match(html, /target\.addEventListener\('drop'/);
  assert.match(html, /addEventListener\('dragstart'/);
});

test('moved rows are unmistakable and can be hidden once handled', async () => {
  const html = await read('public/jnm/jnl2txt.html');

  // 破線の枠は行の区切り線に見え、移動済みだと分からなかった。
  // 左の色帯と淡い背景にして、行そのものが変化したと読めるようにする。
  const moved = html.match(/\.classification-item\.pending-move\{[^}]*\}/);
  assert.ok(moved, '.pending-move style must exist');
  assert.match(moved[0], /border-left:3px solid/);
  assert.doesNotMatch(moved[0], /dashed/);

  // 「旧分類 → 新分類」を出す。どこから動かしたかが分かると戻す判断ができる。
  assert.match(html, /\.classification-from\{[^}]*text-decoration:line-through/);
  assert.match(html, /class="classification-from"/);
  assert.match(html, /data-origin=/);

  // 元の分類へ戻したら移動扱いを解除すること。戻したのに印が残ると混乱する。
  assert.match(html, /const back=origin===category;/);
  assert.match(html, /el\.classList\.toggle\('pending-move',!back\);/);

  // 片付いた行を隠せると残りに集中できる。
  assert.match(html, /id="classifyHideMoved"/);
  assert.match(html, /function classifyItemIsMoved\(el\)/);
  // data-moved だけ見ると、ドラッグで印が付かなかった行が残る。
  // 未反映キューと pending-move も「移動済み」とみなす。
  assert.match(html, /el\.classList\.contains\('pending-move'\)/);
  assert.match(html, /pendingCategoryMoves\|\|\{\},key\)/);
  // ドロップは dataTransfer のキー照合に頼らず、ドラッグ中の行そのものを使う。
  assert.match(html, /const el=classifyDraggingItem/);
  assert.match(html, /classifyDraggingItem=item;/);

  // クリックとドラッグで表示が食い違わないよう、描画は1箇所に集約する。
  assert.equal((html.match(/applyCategoryToItem\(el,category\)/g) || []).length, 2);
  assert.match(html, /markMoved\(el,category\)/);

  // 間違えた移動は1件ずつ戻せる。隠したあともトレイから再配置できる。
  assert.match(html, /class="ci-undo"/);
  assert.match(html, /id="classifyMovedWrap"/);
  assert.match(html, /function unqueuePendingCategoryMove/);
  assert.match(html, /const undo=event\.target\.closest\('\.ci-undo'\)/);
  assert.match(html, /origin===category\) unqueuePendingCategoryMove/);

  // 再描画をまたいでも移動状態が残ること。classificationRows は未反映の移動を
  // row.category へ反映するため、元の分類を別に持たないと描画時に
  // 「どこから動かしたか」が失われ、data-moved が 0 のままになって隠せない。
  assert.match(html, /row\.originCategory=row\.category;/);
  assert.match(html, /const moved=Object\.prototype\.hasOwnProperty\.call\(row,'originCategory'\);/);
  assert.match(html, /data-moved="\$\{moved\?'1':'0'\}"/);
  // 初期描画で data-moved を 0 に固定しないこと（それが原因で隠せなかった）。
  assert.doesNotMatch(html, /data-origin="\$\{esc\(row\.category\|\|''\)\}" data-moved="0"/);
});
