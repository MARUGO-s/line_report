import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readChatPageSourceSync } from './helpers/chat-page-source.mjs';

const root = new URL('..', import.meta.url);
const chat = readChatPageSourceSync();
const migration = fs.readFileSync(new URL('supabase/migrations/20260828010000_chat_file_attachments.sql', root), 'utf8');

test('M-talk accepts private office/document attachments and renders signed downloads', () => {
  assert.match(migration, /chat_messages_kind_check[\s\S]*'file'/);
  assert.match(migration, /application\/pdf/);
  assert.match(migration, /chat_set_message_author/);
  assert.match(chat, /id="chatImageInput"[\s\S]*application\/pdf/);
  assert.match(chat, /function uploadChatFile\(file, groupId\)/);
  assert.match(chat, /kind: 'file'/);
  assert.match(chat, /function hydrateMessageFiles\(\)/);
  assert.match(chat, /class="file-attachment"/);
});

test('text messages turn safe http(s) URLs into link preview cards', () => {
  assert.match(chat, /function firstMessageUrl\(content\)/);
  assert.match(chat, /function renderLinkPreview\(content\)/);
  assert.match(chat, /class="link-preview"/);
  assert.match(chat, /rel="noopener noreferrer"/);
  assert.match(chat, /safeHttpUrl\(match\[0\]/);
});

function calendarContext(overrides = {}) {
  const context = vm.createContext({
    URL, console, window: { location: { href: 'https://marugo-s.github.io/line_report/chat.html' } },
    currentGroupId: 41, talkMenuGroup: { id: 99 }, currentRoomMembership: null,
    currentChatAccess: { access_enabled: true },
    myGroups: [{ id: 41, membership: { can_view: true, can_manage: false } }],
    alerts: [],
    alert(message) { context.alerts.push(message); },
    escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'); },
    ...overrides,
  });
  for (const file of ['permissions', 'rooms', 'attachments']) {
    vm.runInContext(fs.readFileSync(new URL(`public/chat/${file}.js`, root), 'utf8'), context);
  }
  context.closeTalkContextMenu = () => {};
  return context;
}

test('old reservation cards render M-talk links without modifying the stored LINE payload', () => {
  const ctx = calendarContext();
  const action = { label: '予約カレンダーを開く', url: 'https://marugo-s.github.io/line_report/reservation.html?from=line&store_key=synthetic&month=2026-10&lt=synthetic-token&group_id=99#private' };
  for (const actions of [{ action }, { actions: [action] }]) {
    const card = { header: { title: '架空の予約通知' }, ...actions };
    const before = JSON.stringify(card);
    const rendered = ctx.renderCard(card, 41);
    assert.match(rendered, /mtalk_schedule\.html\?from=chat&amp;group_id=41&amp;tab=reservations&amp;month=2026-10/);
    assert.doesNotMatch(rendered, /target="_blank"|synthetic-token|store_key|private|group_id=99/);
    assert.equal(JSON.stringify(card), before);
  }
  assert.match(chat, /renderCard\(card, msg\.group_id\)/);
});

test('calendar routing checks origin and exact application path; unrelated links stay external', () => {
  const ctx = calendarContext();
  for (const url of [
    'https://example.org/line_report/reservation.html',
    'https://example.org/line_report/mtalk_schedule.html?group_id=41',
    'https://marugo-s.github.io/other/reservation.html',
    'https://marugo-s.github.io/line_report/fake-mtalk_schedule.html',
    'https://marugo-s.github.io/line_report/analytics.html',
    'https://fake@marugo-s.github.io/line_report/reservation.html',
    'javascript:alert(1)',
  ]) assert.equal(ctx.resolveMtalkCardScheduleLink(url, 41), null, url);
  assert.match(ctx.renderCardAction({ url: 'https://example.org/', label: '外部サイト' }, 41), /target="_blank" rel="noopener noreferrer"/);
  assert.equal(ctx.renderCardAction({ url: 'javascript:alert(1)' }, 41), '');
  assert.match(ctx.renderCardAction({ command: '予約確認', label: '確認' }, 41), /data-card-command="予約確認"/);
});

test('legacy links require their message room, while M-talk event links retain their group and tab', () => {
  const ctx = calendarContext();
  for (const id of [undefined, null, 0, -1, 1.5, 'invalid', Number.MAX_SAFE_INTEGER + 1]) {
    const html = ctx.renderCardAction({ url: 'reservation.html?group_id=99', label: '開く' }, id);
    assert.match(html, /disabled/);
    assert.doesNotMatch(html, /href=/);
  }
  const event = ctx.resolveMtalkCardScheduleLink('mtalk_schedule.html?group=42&tab=events&month=2026-13&token=synthetic', 41);
  assert.equal(event.url, 'https://marugo-s.github.io/line_report/mtalk_schedule.html?from=chat&group_id=42&tab=events');
  ctx.window.location.href = 'http://localhost:8799/line_report/chat.html';
  assert.match(ctx.resolveMtalkCardScheduleLink('https://marugo-s.github.io/line_report/reservation.html', 41).url, /^http:\/\/localhost:8799\/line_report\/mtalk_schedule.html/);
  for (const month of ['2026-01', '2026-12']) assert.equal(ctx.mtalkScheduleMonth(month), month);
  for (const month of ['', '2026-00', '2026-13', '0000-01', '2026-1', '2026-01-01']) assert.equal(ctx.mtalkScheduleMonth(month), '');
});

test('card click opens the M-talk reservation tab in-place and view-only membership is sufficient', () => {
  const ctx = calendarContext();
  let click;
  ctx.$ = () => ({ addEventListener(type, handler) { assert.equal(type, 'click'); click = handler; } });
  const bootstrap = fs.readFileSync(new URL('public/chat/bootstrap.js', root), 'utf8');
  const start = bootstrap.indexOf("$('messages').addEventListener('click',");
  vm.runInContext(bootstrap.slice(start, bootstrap.indexOf('// メニューの外側', start)), ctx);
  let prevented = false;
  const link = { getAttribute() { return 'reservation.html?lt=synthetic-token&month=2026-10'; } };
  click({ target: { closest(selector) { return selector === 'a.msg-card-action[href]' ? link : null; } }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(ctx.alerts.length, 0);
  assert.equal(ctx.window.location.href, 'https://marugo-s.github.io/line_report/mtalk_schedule.html?from=chat&group_id=41&tab=reservations&month=2026-10');
});

test('calendar navigation still blocks unknown rooms, revoked viewing and stopped accounts', () => {
  for (const state of [
    { myGroups: [] },
    { currentRoomMembership: { can_view: false, can_manage: true } },
    { currentChatAccess: { access_enabled: false } },
    { currentChatAccess: null },
  ]) {
    const ctx = calendarContext(state);
    const before = ctx.window.location.href;
    ctx.openReservationSchedule(41, 'reservations');
    assert.equal(ctx.window.location.href, before);
    assert.equal(ctx.alerts.length, 1);
  }
});

const calendarStoreRoom = { id: 42, store_key: 'synthetic', is_store_room: true, membership: { can_view: true } };

test('LINE calendar entry resolves only its unique viewable store room and preserves month', () => {
  const ctx = calendarContext({ myGroups: [calendarStoreRoom] });
  const url = 'https://marugo-s.github.io/line_report/chat.html?calendar=reservations&store_key=Synthetic&month=2026-10&group_id=99&lt=old';
  ctx.window.location.href = url;
  assert.equal(ctx.resolveMtalkCardScheduleLink(url, 41).groupId, 42);
  assert.equal(ctx.openRequestedReservationCalendar(true), true);
  assert.equal(ctx.window.location.href, 'https://marugo-s.github.io/line_report/mtalk_schedule.html?from=chat&group_id=42&tab=reservations&month=2026-10');
  assert.equal(ctx.alerts.length, 0);
});

test('LINE entry fails closed for unavailable memberships, ambiguous stores and stopped users', () => {
  for (const overrides of [
    { myGroups: [] },
    { myGroups: [{ ...calendarStoreRoom, membership: { can_view: false } }] },
    { myGroups: [{ ...calendarStoreRoom, is_store_room: false }] },
    { myGroups: [{ ...calendarStoreRoom, trashed_at: '2026-09-01' }] },
    { myGroups: [calendarStoreRoom, { ...calendarStoreRoom, id: 43 }] },
    { myGroups: [calendarStoreRoom], currentChatAccess: { access_enabled: false } },
  ]) {
    const ctx = calendarContext(overrides);
    const before = 'https://marugo-s.github.io/line_report/chat.html?calendar=reservations&store_key=synthetic';
    ctx.window.location.href = before;
    assert.equal(ctx.openRequestedReservationCalendar(true), true);
    assert.equal(ctx.window.location.href, before);
    assert.equal(ctx.alerts.length, 1);
  }
  const ctx = calendarContext({ myGroups: [calendarStoreRoom] });
  assert.equal(ctx.openRequestedReservationCalendar(), false);
  ctx.window.location.href += '?calendar=reservations&store_key=synthetic';
  const before = ctx.window.location.href;
  ctx.openRequestedReservationCalendar(false);
  assert.equal(ctx.window.location.href, before);
  assert.match(ctx.alerts[0], /通信状態/);
  assert.ok(chat.includes('if (openRequestedReservationCalendar(groupsLoaded === true)) return;'));
});
