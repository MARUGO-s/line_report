'use strict';

const CONFIG = window.LINE_REPORT_PAGES || {};
const SUPABASE_URL = CONFIG.PROJECT_URL || 'https://hocbnifuactbvmyjraxy.supabase.co';
const SUPABASE_ANON_KEY = CONFIG.RECEIPT_ADMIN_ANON_KEY || '';

function authEmailRedirectUrl() {
  try {
    const url = new URL('chat.html', window.location.href);
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return 'https://marugo-s.github.io/line_report/chat.html';
  }
}

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

let currentUser = null;
let currentChatAccess = null;
let chatAccessExpiryTimer = null;
let currentRoomMembership = null;
let currentGroupId = null;
let scheduledMessages = [];
let pendingSendFiles = [];
let scheduleTarget = 'text';
let myGroups = [];
let otherGroups = [];
let unread = {};
let lastMessages = {};
let talkTab = 'all';
const TALK_PIN_LIMIT = 5;
const SWIPE_BTN_W = 72;
const SWIPE_OPEN = SWIPE_BTN_W * 2;
let openSwipeWrap = null;
let talkMenuGroup = null;
let seenMessageIds = new Set();
let channel = null;
let pendingCredentials = null;
let pendingUserIconFile = null;
let pendingPresetUserIconUrl = '';
let profileIconCatalog = null;
let iconPickerTarget = 'user';
let pendingGroupIconFile = null;
let inviteToken = '';
let inviteMembers = [];
let invitePeople = [];
let registeredUsers = [];
let selectedUserIds = new Set();
let serviceWorkerRegistration = null;
let serviceWorkerPromise = null;
let pushSubscription = null;
let pushPreferenceChannel = null;
let pushNotificationsEnabled = false;
let pushRepairing = false;
let pushTesting = false;
let pendingOpenGroupId = null;
let chatViewportFrame = 0;
let composerResizeObserver = null;
// 開いているトークの読み込み済みメッセージ（created_at 昇順）。
let currentMessages = [];
// 開いているトークの個人メモ（本人にだけ表示。送信されない）。
let currentPrivateNotes = [];
let keepItems = [];
let albums = [];
let selectedAlbumId = null;
let albumDeleteConfirmId = null;
let albumItemsById = new Map();
let stickerCatalog = [];
let stickerCatalogLoaded = false;
let activeStickerCategory = 'emotion';
let stickerSendMode = 'large';
let pendingInlineSticker = null;
const STICKER_CATEGORIES = [
  { id: 'emotion', label: '感情' },
  { id: 'symbol', label: '漫符・記号' },
];
const STICKER_CATALOG_CACHE_KEY = 'mtalk-sticker-catalog-v3';
const STICKER_CATALOG_CACHE_MS = 24 * 60 * 60 * 1000;
let historyExhausted = false;
let loadingHistory = false;
// 読み込み済みの範囲が最新の発言まで届いているか。
// 検索から途中へジャンプすると false になる。その間に新着が来たら
// 間の発言を読み足して穴を埋め、見ていた位置は維持する。
let viewHasLatest = true;
let jumpingToLatest = false;
let fillingLatestGap = false;
// 下端に張り付いているか（新着で自動スクロールするかの判断）。
let followNewMessages = true;
let messageSearchSeq = 0;
let messageSearchHits = [];
let uploadingImage = false;
const signedImageUrls = new Map();
const SIGNED_URL_STORAGE_KEY = 'mtalk-signed-images-v1';
const ROOM_VIEW_CACHE_LIMIT = 12;
const roomViewCache = new Map();
let selectGroupSeq = 0;
const MESSAGE_PAGE_SIZE = 50;
const MESSAGE_COLUMNS =
  'id, group_id, user_id, username, content, kind, payload, reply_to_id, mentions, is_silent, created_at, edited_at, edit_history';
let isSilentSendActive = false;
let isPrivateNoteMode = false;
let editingMessage = null;
let composerSheetOpen = false;
// Inline personal-note mode hands its text to the existing note persistence path.
let pendingPrivateNoteContent = null;
const CHAT_BOT_USER_ID = '00000000-0000-4000-8000-00000000b071';
const CHAT_USER_COLUMNS = 'id, username, icon_url, is_bot, store_key, bot_deleted_at';
const CHAT_ACCESS_COLUMNS = 'user_id, access_enabled, can_start_direct, can_create_group, can_browse_users, default_can_send, signup_status, restriction_reason, restricted_until, deleted_at';
let userStoreKeysById = {};
let pendingStoreRequest = null;
const STORE_BOT_LOGOS = Object.freeze({
  marugo: 'icons/store-bots/marugo.svg',
  marugosecond: 'icons/store-bots/marugosecond.svg',
  marugogrande: 'icons/store-bots/marugogrande.svg',
  sannanaichi: 'icons/store-bots/sannanaichi.svg',
  shenlong: 'icons/store-bots/shenlong.svg',
  claudia2: 'icons/store-bots/claudia2.svg',
  sauvage: 'icons/store-bots/sauvage.svg',
  barpelota: 'icons/store-bots/barpelota.svg',
  briccola: 'icons/store-bots/briccola.svg',
  violette: 'icons/store-bots/violette.svg',
  marugootto: 'icons/store-bots/marugootto.svg',
  donaiya: 'icons/store-bots/donaiya.svg',
  marugoyotsuya: 'icons/store-bots/marugoyotsuya.svg',
  sushikoruri: 'icons/store-bots/sushikoruri.svg',
  bistrocavacava: 'icons/store-bots/bistrocavacava.svg',
  marugoS: 'icons/store-bots/marugo-s.svg',
  marugoshinbashi: 'icons/store-bots/marugoshinbashi.svg',
  marugomarunouchi: 'icons/store-bots/marugomarunouchi.svg',
  yakinikumarugo: 'icons/store-bots/yakinikumarugo.svg',
  erics: 'icons/store-bots/erics.svg',
  mitan: 'icons/store-bots/mitan.svg',
  marugoD: 'icons/store-bots/marugo-d.svg',
});
function isReservationBot(user) {
  return !!(user && (String(user.id) === CHAT_BOT_USER_ID || user.username === '予約通知'));
}
function isStoreBot(user) {
  return !!(user && user.is_bot && user.store_key);
}
function storeBotLogoForKey(storeKey) {
  const rawKey = String(storeKey || '').trim();
  if (STORE_BOT_LOGOS[rawKey]) return STORE_BOT_LOGOS[rawKey];
  const matchedKey = Object.keys(STORE_BOT_LOGOS).find((key) => key.toLowerCase() === rawKey.toLowerCase());
  return matchedKey ? STORE_BOT_LOGOS[matchedKey] : '';
}
function storeBotLogoUrl(user) {
  return isStoreBot(user) ? storeBotLogoForKey(user.store_key) : '';
}
function personIconUrl(user) {
  return storeBotLogoUrl(user) || String((user && user.icon_url) || '');
}
function isStoreBotDirect(group) {
  return !!(group && group.is_direct && group.peer && isStoreBot(group.peer));
}
function isBotUser(user) {
  return !!(user && (user.is_bot || isReservationBot(user)));
}
function botMarkHtml() {
  return '<span class="bot-mark">Bot</span>';
}
function storeBotDisplayName(storeName) {
  const raw = String(storeName || '').trim();
  const base = raw.replace(/[\s\u3000]*bot$/i, '').trim() || raw;
  return base ? `${base} bot` : 'bot';
}
function findStoreBotUser(id) {
  const sid = String(id || '');
  if (!sid) return null;
  return (registeredUsers || []).find((u) => String(u.id) === sid && isStoreBot(u))
    || (groupMembers || []).find((u) => String(u.id) === sid && isStoreBot(u))
    || (inviteMembers || []).find((u) => String(u.id) === sid && isStoreBot(u))
    || null;
}
function personName(user) {
  return isStoreBot(user) ? storeBotDisplayName(user.username) : String((user && user.username) || '');
}
function personAvatarKey(user) {
  return isStoreBot(user)
    ? String((user && user.username) || '').replace(/[\s\u3000]*bot$/i, '').trim() || storeBotDisplayName(user && user.username)
    : String((user && user.username) || '');
}
function isStoreBotId(id) {
  return !!findStoreBotUser(id);
}
function speakerName(userId, username) {
  const bot = findStoreBotUser(userId);
  if (bot) return personName(bot);
  return String(username || '');
}
// 開いているトークの参加者・既読時刻・リアクション。
let groupMembers = [];
let memberStripOpen = false;
let memberCounts = {};
let botRoomIds = new Set();
let groupReadStates = [];
let reactionsByMessage = new Map();
// 引用元の本文（返信の表示用）。読み込み済みに無いものだけ後から取りに行く。
let quotedMessages = new Map();
let replyTarget = null;
let forwardMessage = null;
let mentionCandidates = [];
let mentionActiveIndex = 0;
const REACTION_CHOICES = [
  '👍', '✅', '🙏', '😂', '❤️', '😮',
  '😡', '😓', '🤔', '🙄', '😭', '🎉', '👏', '👀', '🤷'
];
const INVITE_KEY = 'chat_pending_invite';
const CHAT_PUSH_PUBLIC_KEY = 'BBUr0ob7hbB-k5JguWO1LgACXgpSjwPYkeoGRwNhDBE88ynjbEyRlY02LA3RZXr_oQrOcu86djYWsEncbTKiLtE';

const $ = (id) => document.getElementById(id);
const CREDENTIAL_KEY = 'chat_saved_credentials';
const PUSH_TEST_PENDING_KEY = 'mtalk_push_test_pending_v1';
const AVATAR_COLORS = ['#7ac943', '#4fc3f7', '#ff8a65', '#ba68c8', '#ffd54f', '#4db6ac', '#f06292', '#7986cb'];

function measureComposerInset() {
  const composer = $('inputArea');
  const main = document.querySelector('.main-content');
  if (!composer || composer.classList.contains('hidden') || !main) return 0;
  const mainRect = main.getBoundingClientRect();
  const composerRect = composer.getBoundingClientRect();
  // 入力欄は fixed で下へずらす場合があるため、offsetHeight ではなく
  // メイン領域へ実際に重なっている高さを予約する。
  return Math.max(0, Math.min(mainRect.height, Math.round(mainRect.bottom - composerRect.top)));
}

function syncChatViewport(keepComposerVisible = false) {
  const isMobileLayout = window.matchMedia('(max-width: 768px), (max-height: 600px) and (pointer: coarse)').matches;
  const root = document.documentElement;
  if (!isMobileLayout) {
    if (chatViewportFrame) cancelAnimationFrame(chatViewportFrame);
    chatViewportFrame = 0;
    root.style.removeProperty('--chat-viewport-height');
    root.style.removeProperty('--chat-viewport-top');
    root.style.removeProperty('--chat-composer-height');
    root.style.removeProperty('--chat-bottom-gap');
    return;
  }

  const viewport = window.visualViewport;
  const viewportTop = Math.max(0, Math.round(viewport ? viewport.offsetTop : 0));
  const visualHeight = Math.max(1, Math.round(viewport ? viewport.height : window.innerHeight));
  const layoutHeight = Math.max(1, Math.round(window.innerHeight));
  const input = $('messageInput');
  const keyboardOpen = keepComposerVisible || (input && document.activeElement === input);
  const extraBottom = keyboardOpen ? 0 : Math.max(0, layoutHeight - viewportTop - visualHeight);
  const viewportHeight = keyboardOpen
    ? visualHeight
    : Math.max(visualHeight, layoutHeight - viewportTop);
  root.style.setProperty('--chat-viewport-height', `${viewportHeight}px`);
  root.style.setProperty('--chat-viewport-top', `${viewportTop}px`);
  root.style.setProperty('--chat-bottom-gap', `${extraBottom}px`);
  root.style.setProperty('--chat-composer-height', `${measureComposerInset()}px`);

  if (chatViewportFrame) cancelAnimationFrame(chatViewportFrame);
  chatViewportFrame = requestAnimationFrame(() => {
    chatViewportFrame = 0;
    root.style.setProperty('--chat-composer-height', `${measureComposerInset()}px`);
    // 入力欄の高さや位置が変わっても、最新追従中なら入力欄の直上を保つ。
    if (viewHasLatest && followNewMessages) scrollMessagesToBottom();
    else resolveUnloadedLatestGap();
    const focused = $('messageInput');
    if (!focused || (!keepComposerVisible && document.activeElement !== focused)) return;
    focused.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function randomUuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function preventMobileZoomGesture(event) {
  const isMobileLayout = window.matchMedia('(max-width: 768px), (max-height: 600px) and (pointer: coarse)').matches;
  if (!isMobileLayout) return;
  if (!event.touches || event.touches.length > 1) event.preventDefault();
}
