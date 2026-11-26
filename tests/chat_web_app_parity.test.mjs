import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

function loadAppCompatSandbox(extra = {}) {
  const code = fs.readFileSync(path.join(PUBLIC_DIR, 'chat', 'app_compat.js'), 'utf8');
  const sandbox = {
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    JSON,
    Promise,
    URL,
    document: {
      addEventListener() {},
      body: { classList: { add() {}, remove() {} } },
    },
    window: {},
    $: () => null,
    escapeHtml: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
    }[m])),
    currentUser: { id: 'u-me', username: '自分' },
    currentGroupId: 10,
    groupMembers: [
      { id: 'u-me', username: '自分', is_bot: false },
      { id: 'u-other', username: '田中', is_bot: false },
      { id: 'u-bot', username: '店舗Bot', is_bot: true },
    ],
    canCurrentUserSend: () => true,
    personName: (u) => u?.username || '',
    speakerName: (_id, name) => name || 'メンバー',
    fileFromMessage: (msg) => (msg?.kind === 'file' ? msg?.payload?.file || null : null),
    imageFromMessage: (msg) => (msg?.kind === 'image' ? msg?.payload?.image || null : null),
    ...extra,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'public/chat/app_compat.js' });
  return sandbox;
}

test('app_compat.js parses and renders gallery, voice, video, call_log, and interactive cards safely', () => {
  const sb = loadAppCompatSandbox();

  // 1) 複数写真ギャラリー
  const galleryMsg = {
    id: 101,
    kind: 'image',
    content: '[写真 3枚]',
    payload: {
      v: 1,
      kind: 'image',
      image: { path: 'groups/10/a.jpg', w: 800, h: 600 },
      gallery: [
        { path: 'groups/10/a.jpg', w: 800, h: 600 },
        { path: 'groups/10/b.jpg', w: 800, h: 600 },
        { path: 'groups/10/c.jpg', w: 800, h: 600 },
      ],
    },
  };
  assert.deepEqual(Array.from(sb.galleryPathsFromMessage(galleryMsg)), [
    'groups/10/a.jpg',
    'groups/10/b.jpg',
    'groups/10/c.jpg',
  ]);
  const galleryRendered = sb.renderAppCompatMessageBody(galleryMsg);
  assert.equal(galleryRendered.extraClass, 'gallery');
  assert.match(galleryRendered.html, /msg-gallery/);
  assert.match(galleryRendered.html, /3枚/);

  // 2) ボイスメッセージ
  const voiceMsg = {
    id: 102,
    kind: 'file',
    content: '🎤 ボイスメッセージ (0:18)',
    payload: {
      v: 1,
      kind: 'file',
      file: { path: 'groups/10/v.m4a', name: 'voice.m4a', mime: 'audio/mp4', size: 22000 },
      voice_memo: { duration_seconds: 18 },
    },
  };
  const voiceRendered = sb.renderAppCompatMessageBody(voiceMsg);
  assert.equal(voiceRendered.extraClass, 'voice');
  assert.match(voiceRendered.html, /<audio class="voice-audio"/);
  assert.match(voiceRendered.html, /文字で見る/);
  assert.match(voiceRendered.html, /0:18/);

  // 3) 動画メッセージ
  const videoMsg = {
    id: 103,
    kind: 'file',
    content: '[clip.mp4]',
    payload: {
      v: 1,
      kind: 'file',
      file: { path: 'groups/10/clip.mp4', name: 'clip.mp4', mime: 'video/mp4', size: 1048576 },
    },
  };
  assert.equal(sb.isVideoMessage(videoMsg), true);
  const videoRendered = sb.renderAppCompatMessageBody(videoMsg);
  assert.equal(videoRendered.extraClass, 'video');
  assert.match(videoRendered.html, /<video class="msg-video"/);

  // 4) 通話ログ
  const callMsg = {
    id: 104,
    kind: 'text',
    content: '音声通話 02:34',
    payload: {
      v: 1,
      call_log: { call_type: 'audio', is_group: false, outcome: 'ended', duration_seconds: 154 },
    },
  };
  const callRendered = sb.renderAppCompatMessageBody(callMsg);
  assert.equal(callRendered.extraClass, 'call-log');
  assert.match(callRendered.html, /音声通話/);
  assert.match(callRendered.html, /02:34/);

  // 5) 確認依頼 + XSS エスケープ検証
  const ackMsg = {
    id: 105,
    user_id: 'u-other',
    kind: 'text',
    content: '【重要・要確認】<script>alert(1)</script>',
    payload: {
      v: 1,
      ack_request: {
        title: '<script>alert(1)</script>シフト変更',
        body: '明日10時集合 <img src=x onerror=alert(1)>',
        urgent: true,
      },
    },
  };
  const ackRendered = sb.renderAppCompatMessageBody(ackMsg);
  assert.equal(ackRendered.extraClass, 'interactive');
  assert.match(ackRendered.html, /確認しました/);
  assert.doesNotMatch(ackRendered.html, /<script>/);
  assert.doesNotMatch(ackRendered.html, /<img /);

  // 6) チェックリスト & 投票
  const clMsg = {
    id: 106,
    kind: 'text',
    content: '【チェックリスト】閉店',
    payload: {
      v: 1,
      checklist: { title: '閉店チェック', items: [{ id: 'i1', text: 'レジ締め' }, { id: 'i2', text: 'ガス確認' }] },
    },
  };
  const clRendered = sb.renderAppCompatMessageBody(clMsg);
  assert.match(clRendered.html, /data-checklist-toggle="106"/);
  assert.match(clRendered.html, /0 \/ 2 完了/);

  const pollMsg = {
    id: 107,
    kind: 'text',
    content: '【投票】日程',
    payload: {
      v: 1,
      poll: {
        question: '次回会議',
        multiple: false,
        anonymous: false,
        options: [{ id: 'o1', label: '火曜' }, { id: 'o2', label: '水曜' }],
      },
    },
  };
  const pollRendered = sb.renderAppCompatMessageBody(pollMsg);
  assert.match(pollRendered.html, /data-poll-vote="107"/);
  assert.match(pollRendered.html, /火曜/);

  // 7) / マニュアル質問判定
  assert.equal(sb.isHelpQaInputText('/ ボイスメッセージの送り方'), true);
  assert.equal(sb.isHelpQaInputText('／おやすみ時間の設定'), true);
  assert.equal(sb.isHelpQaInputText('通常のメッセージ'), false);
  assert.equal(sb.extractHelpQaQuestion('／ おやすみ時間の設定 '), 'おやすみ時間の設定');
});

test('chat.html, realtime.js, and chat-admin.html wire all app-parity hooks without inline bloat', () => {
  const chatHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'chat.html'), 'utf8');
  assert.match(chatHtml, /src="chat\/app_compat\.js\?v=/);
  assert.match(chatHtml, /id="chatImageInput"[^>]*multiple/);
  assert.match(chatHtml, /video\/mp4/);
  assert.match(chatHtml, /id="voiceRecordBar"/);
  assert.match(chatHtml, /id="appCompatOverlay"/);
  assert.match(chatHtml, /openQuietHoursModal\(\)/);
  assert.match(chatHtml, /openUnreadDigestModal\(\)/);
  assert.match(chatHtml, /openRoomAiSummaryModal\(\)/);

  const realtimeJs = fs.readFileSync(path.join(PUBLIC_DIR, 'chat', 'realtime.js'), 'utf8');
  assert.match(realtimeJs, /table:\s*'chat_message_interactions'/);
  assert.match(realtimeJs, /handleInteractionRealtimeChange/);

  const adminHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'chat-admin.html'), 'utf8');
  assert.match(adminHtml, /data-jump="usage"/);
  assert.match(adminHtml, /id="usage"/);
  assert.match(adminHtml, /src="chat\/admin_usage\.js\?v=/);
  assert.match(adminHtml, /MTALK_ADMIN_USAGE/);

  const appCompatJs = fs.readFileSync(path.join(PUBLIC_DIR, 'chat', 'app_compat.js'), 'utf8');
  assert.doesNotMatch(appCompatJs, /CONFIG\.supabaseUrl|CONFIG\.supabaseKey/);
  assert.match(appCompatJs, /SUPABASE_URL/);
  assert.match(appCompatJs, /SUPABASE_ANON_KEY/);
  assert.match(appCompatJs, /\/functions\/v1\/chat-ai-summary/);
  assert.match(appCompatJs, /\/functions\/v1\/chat-push\?action=preferences/);

  const adminUsageJs = fs.readFileSync(path.join(PUBLIC_DIR, 'chat', 'admin_usage.js'), 'utf8');
  assert.match(adminUsageJs, /\/functions\/v1\/chat-admin-usage/);
  assert.match(adminUsageJs, /x-admin-token/);
  assert.match(adminUsageJs, /x-admin-surface/);
});
