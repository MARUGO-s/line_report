import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  normalizeReminderSlots,
  buildReminderChatText,
  buildReminderChatCard,
  CALENDAR_TOMORROW_REMINDER_DEFAULTS,
} from '../supabase/functions/_shared/calendar_tomorrow_reminder.ts';

const migration = await readFile(
  new URL('../supabase/migrations/20260826020000_calendar_multi_reminders.sql', import.meta.url),
  'utf8',
);
const edgeCron = await readFile(
  new URL('../supabase/functions/calendar-tomorrow-cron/index.ts', import.meta.url),
  'utf8',
);
const roomSettings = await readFile(
  new URL('../public/room_settings.html', import.meta.url),
  'utf8',
);

test('normalizeReminderSlots handles fallbacks, limits to 3 slots, and validates values', () => {
  // 未設定時はフォールバック時刻（既定 19:00）で 1スロット生成
  const defSlots = normalizeReminderSlots(null, null, null);
  assert.equal(defSlots.length, 1);
  assert.equal(defSlots[0].id, 'default');
  assert.equal(defSlots[0].target, 'tomorrow');
  assert.equal(defSlots[0].hour, 19);
  assert.equal(defSlots[0].minute, 0);
  assert.equal(defSlots[0].enabled, true);

  // カスタムフォールバック時刻
  const customFallback = normalizeReminderSlots(undefined, 20, 30);
  assert.equal(customFallback[0].hour, 20);
  assert.equal(customFallback[0].minute, 30);

  // 複数スロット（最大3件制限）
  const multiRaw = [
    { id: 'slot_1', target: 'tomorrow', hour: 19, minute: 0, enabled: true },
    { id: 'slot_2', target: 'today', hour: 8, minute: 30, enabled: true },
    { id: 'slot_3', target: 'today', hour: 12, minute: 0, enabled: false },
    { id: 'slot_4', target: 'tomorrow', hour: 21, minute: 0, enabled: true }, // 4件目は無視される
  ];
  const normalized = normalizeReminderSlots(multiRaw);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].target, 'tomorrow');
  assert.equal(normalized[1].target, 'today');
  assert.equal(normalized[1].hour, 8);
  assert.equal(normalized[1].minute, 30);
  assert.equal(normalized[2].enabled, false);
});

test('buildReminderChatText and buildReminderChatCard adapt to today vs tomorrow target', () => {
  const targetDate = { year: 2026, month: 8, day: 25 };
  const mockEvents = [
    {
      id: 1,
      title: '全体ミーティング',
      description: '本社にて',
      startsAt: '2026-08-25T10:00:00+09:00',
      endsAt: '2026-08-25T11:00:00+09:00',
    },
  ];

  // 明日の予定（tomorrow）
  const tomorrowText = buildReminderChatText('マルゴ四谷', targetDate, mockEvents, 'tomorrow');
  assert.match(tomorrowText, /明日の予定 1件/);
  assert.match(tomorrowText, /10:00-11:00 全体ミーティング/);

  const tomorrowCard = buildReminderChatCard('マルゴ四谷', targetDate, mockEvents, 'https://example.com', 'tomorrow');
  assert.equal(tomorrowCard.header.eyebrow, '明日の予定');

  // 本日の予定（today）
  const todayText = buildReminderChatText('マルゴ四谷', targetDate, mockEvents, 'today');
  assert.match(todayText, /本日の予定 1件/);
  assert.match(todayText, /10:00-11:00 全体ミーティング/);

  const todayCard = buildReminderChatCard('マルゴ四谷', targetDate, mockEvents, 'https://example.com', 'today');
  assert.equal(todayCard.header.eyebrow, '本日の予定');
});

test('migration and edge function support multi-slot cron and slot logging', () => {
  assert.match(migration, /calendar_reminder_slots jsonb/);
  assert.match(migration, /slot_id text not null default 'default'/);
  assert.match(migration, /unique \(room_id, target_date, slot_id\)/);
  assert.match(migration, /elem->>'hour'/);

  assert.match(edgeCron, /calendar_reminder_slots/);
  assert.match(edgeCron, /targetDateObj\.year/);
  assert.match(edgeCron, /slot_id: slotId/);
});

test('room settings UI renders and saves reminder slots up to 3', () => {
  assert.match(roomSettings, /calendar_reminder_slots/);
  assert.match(roomSettings, /reminder-slot-target/);
  assert.match(roomSettings, /reminder-slot-time/);
  assert.match(roomSettings, /reminder-slot-add-btn/);
  assert.match(roomSettings, /reminder-slot-del-btn/);
});
