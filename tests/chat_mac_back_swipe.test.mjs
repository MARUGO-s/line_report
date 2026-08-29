import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatPageSourceSync } from './helpers/chat-page-source.mjs';

const chatSource = readChatPageSourceSync();

test('Macの右スワイプは、トーク画面でだけ一覧へ戻る', () => {
  assert.match(chatSource, /const MAC_BACK_SWIPE_DISTANCE = 72;/);
  assert.match(chatSource, /document\.addEventListener\('wheel', \(e\) => \{[\s\S]*?currentGroupId/);
  assert.match(chatSource, /!target\.closest\('#mainContent'\)/);
  assert.match(chatSource, /Math\.abs\(e\.deltaX\) <= Math\.abs\(e\.deltaY\) \|\| e\.deltaX >= -1/);
  assert.match(chatSource, /if \(e\.cancelable\) e\.preventDefault\(\);/);
  assert.match(chatSource, /macBackSwipeDistance \+= Math\.abs\(e\.deltaX\);/);
  assert.match(chatSource, /if \(macBackSwipeDistance < MAC_BACK_SWIPE_DISTANCE\) return;[\s\S]*?closeChat\(\);/);
  assert.doesNotMatch(chatSource, /history\.back\(\)/);
});
