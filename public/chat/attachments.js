'use strict';

function cardsFromMessage(msg) {
  if (msg.kind !== 'card') return null;
  const payload = typeof msg.payload === 'string' ? safeParseJson(msg.payload) : msg.payload;
  const cards = payload && Array.isArray(payload.cards) ? payload.cards : null;
  return cards && cards.length ? cards : null;
}

function safeParseJson(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

function safeImageDimension(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 99999) return null;
  return Math.trunc(number);
}

function imageFromMessage(msg) {
  if (msg.kind !== 'image') return null;
  const payload = typeof msg.payload === 'string' ? safeParseJson(msg.payload) : msg.payload;
  const image = payload && payload.image;
  return image && image.path ? image : null;
}

function stickerFromMessage(msg) {
  if (msg.kind !== 'sticker') return null;
  const payload = typeof msg.payload === 'string' ? safeParseJson(msg.payload) : msg.payload;
  const sticker = payload && payload.sticker;
  return sticker && sticker.id && sticker.path ? sticker : null;
}

async function loadStickerCatalog() {
  if (stickerCatalogLoaded) return stickerCatalog;
  try {
    const cached = JSON.parse(localStorage.getItem(STICKER_CATALOG_CACHE_KEY) || 'null');
    if (cached && Array.isArray(cached.items) && Date.now() - Number(cached.savedAt) < STICKER_CATALOG_CACHE_MS) {
      stickerCatalog = cached.items;
      stickerCatalogLoaded = true;
      void refreshStickerCatalog().catch(() => {});
      return stickerCatalog;
    }
  } catch (_) {}
  return refreshStickerCatalog();
}

async function refreshStickerCatalog() {
  const { data, error } = await sb.from('chat_stickers')
    .select('id,label,asset_path,sort_order,category')
    .eq('is_active', true)
    .order('sort_order');
  if (error) throw error;
  stickerCatalog = data || [];
  stickerCatalogLoaded = true;
  try {
    localStorage.setItem(STICKER_CATALOG_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), items: stickerCatalog }));
  } catch (_) {}
  return stickerCatalog;
}

function warmImageAssets() {
  const run = async () => {
    try {
      if (!profileIconCatalog) {
        const response = await fetch('profile-icons/catalog.json', { cache: 'force-cache' });
        if (response.ok) profileIconCatalog = await response.json();
      }
      const stickers = await loadStickerCatalog();
      stickers.slice(0, 8).forEach((sticker) => {
        const image = new Image();
        image.decoding = 'async';
        image.src = sticker.asset_path;
      });
    } catch (_) { /* アイドル時の先読み失敗は、一覧を開く時に再試行する。 */ }
  };
  if ('requestIdleCallback' in window) requestIdleCallback(() => void run(), { timeout: 2500 });
  else setTimeout(() => void run(), 800);
}

function renderStickerPicker() {
  const picker = $('stickerPicker');
  if (!picker) return;
  const visibleStickers = stickerCatalog.filter((sticker) => (sticker.category || 'emotion') === activeStickerCategory);
  picker.innerHTML = `
    <div class="sticker-send-modes" role="group" aria-label="イラストの表示サイズ">
      <button class="sticker-send-mode ${stickerSendMode === 'large' ? 'active' : ''}" type="button"
        aria-pressed="${stickerSendMode === 'large'}" data-sticker-mode="large">大きく送る</button>
      <button class="sticker-send-mode ${stickerSendMode === 'compact' ? 'active' : ''}" type="button"
        aria-pressed="${stickerSendMode === 'compact'}" data-sticker-mode="compact">文章内に入れる</button>
    </div>
    <div class="sticker-tabs" role="tablist" aria-label="イラストのカテゴリ">
      ${STICKER_CATEGORIES.map((category) => `
        <button class="sticker-tab ${category.id === activeStickerCategory ? 'active' : ''}" type="button"
          role="tab" aria-selected="${category.id === activeStickerCategory}" data-sticker-category="${category.id}">
          ${category.label}
        </button>
      `).join('')}
    </div>
    <div class="sticker-grid">${visibleStickers.map((sticker) => `
    <button class="sticker-option" type="button" data-sticker-id="${escapeHtml(sticker.id)}" title="${escapeHtml(sticker.label)}">
      <img src="${escapeHtml(sticker.asset_path)}" alt="" loading="lazy" decoding="async"><span>${escapeHtml(sticker.label)}</span>
    </button>
  `).join('')}</div>`;
}

async function toggleStickerPicker() {
  if (!currentGroupId || !currentUser) return;
  if (editingMessage) cancelMessageEdit();
  if (!requireCurrentRoomSend()) return;
  if (isGroupTrashed(findMineGroup(currentGroupId))) {
    alert('ゴミ箱のルームには送信できません。復元してから使ってください。');
    return;
  }
  const picker = $('stickerPicker');
  if (!picker) return;
  if (!picker.classList.contains('hidden')) {
    picker.classList.add('hidden');
    return;
  }
  try {
    // 本文入力中に開いた場合だけ、文章内へ添付するモードを先に選ぶ。
    stickerSendMode = $('messageInput')?.value.trim() ? 'compact' : 'large';
    await loadStickerCatalog();
    renderStickerPicker();
    picker.classList.remove('hidden');
  } catch (error) {
    console.error('Load sticker catalog error:', error);
    alert('感情イラストを読み込めませんでした');
  }
}

function renderInlineStickerPreview() {
  const preview = $('inlineStickerPreview');
  if (!preview) return;
  if (!pendingInlineSticker) {
    preview.innerHTML = '';
    preview.classList.add('hidden');
    resizeComposer();
    return;
  }
  preview.innerHTML = `<img src="${escapeHtml(pendingInlineSticker.asset_path)}" alt=""><span>文章と一緒に送信</span><button type="button" aria-label="添付を外す" onclick="clearInlineSticker()">×</button>`;
  preview.classList.remove('hidden');
  resizeComposer();
}

function clearInlineSticker() {
  pendingInlineSticker = null;
  renderInlineStickerPreview();
}

function handleStickerSelection(stickerId) {
  if (stickerSendMode === 'compact') {
    pendingInlineSticker = stickerCatalog.find((sticker) => sticker.id === stickerId) || null;
    $('stickerPicker')?.classList.add('hidden');
    renderInlineStickerPreview();
    $('messageInput')?.focus();
    return;
  }
  sendSticker(stickerId, 'large');
}

async function sendSticker(stickerId, display = 'large', messageText = '') {
  if (!currentGroupId || !currentUser || !stickerId) return;
  if (!requireCurrentRoomSend()) return false;
  $('stickerPicker')?.classList.add('hidden');
  try {
    const { data, error } = await sb.from('chat_messages').insert({
      group_id: currentGroupId,
      user_id: currentUser.id,
      username: currentUser.username,
      content: messageText || '[感情イラスト]',
      kind: 'sticker',
      payload: { v: 1, kind: 'sticker', sticker: { id: stickerId, display } },
      reply_to_id: replyTarget ? replyTarget.id : null,
      mentions: collectMentions(messageText),
      is_silent: isSilentSendActive === true
    }).select(MESSAGE_COLUMNS).single();
    if (error) throw error;
    clearReplyTarget();
    if (display === 'compact') clearInlineSticker();
    lastMessages[data.group_id] = data;
    followNewMessages = true;
    if (viewHasLatest) addMessageToUI(data);
    else {
      await fillLatestGap();
      addMessageToUI(data);
    }
    scrollSentStickerIntoView(data.id);
    renderGroups();
    dispatchPushForMessage(data.id);
    return true;
  } catch (error) {
    console.error('Send sticker error:', error);
    alert(`感情イラストの送信に失敗しました: ${error.message || error}`);
    return false;
  }
}

// chat-images は非公開バケット。表示のたびに署名URLを作り、期限まで使い回す。
async function hydrateMessageImages() {
  const nodes = Array.from($('messages').querySelectorAll('img.msg-image[data-path]'));
  if (!nodes.length) return;

  const now = Date.now();
  const wanted = [...new Set(nodes.map((n) => n.dataset.path))];
  const missing = wanted.filter((p) => {
    const cached = signedImageUrls.get(p);
    return !cached || cached.expiresAt < now + 60000;
  });

  if (missing.length) {
    try {
      const { data, error } = await sb.storage
        .from('chat-images')
        .createSignedUrls(missing, 3600);
      if (error) throw error;
      (data || []).forEach((row) => {
        if (row.signedUrl && row.path) {
          signedImageUrls.set(row.path, { url: row.signedUrl, expiresAt: now + 3600000 });
        }
      });
    } catch (error) {
      console.error('Sign image url error:', error);
    }
  }

  nodes.forEach((node) => {
    const cached = signedImageUrls.get(node.dataset.path);
    if (cached && node.src !== cached.url) node.src = cached.url;
  });
  persistSignedImageCache();
}

async function hydrateMessageFiles() {
  const nodes = Array.from($('messages').querySelectorAll('a.file-attachment[data-file-path]'));
  if (!nodes.length) return;
  const wanted = [...new Set(nodes.map((node) => node.dataset.filePath).filter(Boolean))];
  try {
    const { data, error } = await sb.storage.from('chat-images').createSignedUrls(wanted, 3600);
    if (error) throw error;
    const urls = new Map((data || []).filter((row) => row.path && row.signedUrl).map((row) => [row.path, row.signedUrl]));
    nodes.forEach((node) => { const url = urls.get(node.dataset.filePath); if (url) node.href = url; });
  } catch (error) { console.error('Sign file url error:', error); }
}

function pickChatImage() {
  if (!currentGroupId || uploadingImage) return;
  if (!requireCurrentRoomSend()) return;
  if (isGroupTrashed(findMineGroup(currentGroupId))) {
    alert('ゴミ箱のルームには送信できません。復元してから使ってください。');
    return;
  }
  $('chatImageInput').click();
}

function isImageFile(file) {
  if (!file) return false;
  const type = String(file.type || '');
  const name = String(file.name || '').toLowerCase();
  return /^image\/(jpeg|png|webp|gif)$/.test(type) || /\.(jpe?g|png|webp|gif)$/.test(name);
}

const CHAT_FILE_MAX_BYTES = 25 * 1024 * 1024;
const CHAT_FILE_MIMES = new Set([
  // HEIC はブラウザ（Safari以外）が復号できないので画像扱いにせず、
  // 原本のままファイルとして送る。canvas 縮小に回すと失敗する。
  'image/heic', 'image/heif',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'application/zip',
  // 電子ジャーナルの原本。店舗ルームでのみ受け、取込へ回す。
  'application/x-lzh-compressed'
]);

// アプリ内で中身まで開ける形式。ここに無いものは保存して開いてもらう。
const CHAT_PREVIEW_PDF = new Set(['application/pdf']);
const CHAT_PREVIEW_TEXT = new Set(['text/plain', 'text/csv']);
// 本文を読み込む上限。巨大なCSVで固まらせない。
const CHAT_PREVIEW_TEXT_MAX_BYTES = 512 * 1024;

// 電子ジャーナル(.lzh)はトークに添付させない。
// pos-journal.html → /pos-journals/upload が正本の取込経路で、単なる保管ではなく
// ファイル名先頭4桁での店舗コード検証、同一内容の重複スキップ、ファイル名の日付
// からの対象月判定、会計0件の不完全日の修復、Journal Report の日別・月間レポート
// 再作成までを行う。ここに添付すると、それらが一切走らないまま
// 「登録できた」ように見える写しだけが残り、原本が二重管理になる。
function isJournalArchiveFile(file) {
  return /\.(lzh|lha)$/i.test(String((file && file.name) || ''));
}

// 店舗ルーム（または店舗Botのいるルーム）なら、その店舗として取り込める。
// それ以外のルームは取込先の店舗が決まらないので、従来どおり画面へ誘導する。
function currentRoomAcceptsJournalArchive() {
  const group = findMineGroup(currentGroupId);
  if (group && group.is_store_room && group.store_key) return true;
  return groupMembers.some((user) => user && user.is_bot && user.store_key);
}

// 落とした本人が次に何をすればよいか分かるようにする。
function promptJournalArchive() {
  const ok = confirm(
    '電子ジャーナル（.lzh）はトークに添付できません。\n\n'
    + '原本は「電子ジャーナル」画面から取り込んでください。\n'
    + '店舗コードの照合・重複スキップ・対象月の判定・保存レポートの再作成は、'
    + 'そちらでしか行われません。\n\n'
    + '電子ジャーナル画面を開きますか？'
  );
  if (ok) window.open(new URL('pos-journal.html', window.location.href).href, '_blank', 'noopener');
}

function isSupportedChatFile(file) {
  if (!file || Number(file.size) > CHAT_FILE_MAX_BYTES) return false;
  if (isImageFile(file)) return true;
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  return CHAT_FILE_MIMES.has(type) || /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|zip|heic|heif|lzh)$/.test(name);
}

function imageFilesFromList(list) {
  return Array.from(list || []).filter(isImageFile);
}

function chatFilesFromList(list) {
  return Array.from(list || []).filter(isSupportedChatFile);
}

function isFileDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function setChatDropActive(on) {
  const overlay = $('chatDropOverlay');
  if (!overlay) return;
  overlay.classList.toggle('hidden', !on);
  overlay.setAttribute('aria-hidden', on ? 'false' : 'true');
  const card = overlay.querySelector('.chat-drop-card');
  if (card) {
    const store = myGroups.find((g) => g.id === currentGroupId);
    card.textContent = store && store.is_store_room
      ? '画像をドロップして送信（メディア閲覧へ保存）／PDF・Office等のファイルにも対応'
      : '画像・ファイルをドロップして送信';
  }
}

// 送信前に長辺1600pxへ縮小する。現場のスマホ写真をそのまま送ると重すぎるため。
async function prepareChatImage(file) {
  assertIconFile(file);
  const image = await loadIconImage(file);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const maxEdge = 1600;
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (!blob) throw new Error('画像の変換に失敗しました');
  return { blob, width, height };
}

async function uploadChatImage(file, groupId) {
  const { blob, width, height } = await prepareChatImage(file);
  const path = `groups/${groupId}/${crypto.randomUUID()}.jpg`;
  const { error: uploadError } = await sb.storage
    .from('chat-images')
    .upload(path, blob, { contentType: 'image/jpeg', cacheControl: '3600' });
  if (uploadError) throw uploadError;
  return { path, width, height };
}

async function uploadChatFile(file, groupId) {
  if (!isSupportedChatFile(file)) throw new Error('対応形式または容量上限（10MB）を確認してください');
  const ext = String(file.name || '').toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] || '.bin';
  const path = `groups/${groupId}/${crypto.randomUUID()}${ext}`;
  const { error } = await sb.storage.from('chat-images').upload(path, file, { contentType: file.type || 'application/octet-stream', cacheControl: '3600' });
  if (error) throw error;
  return { path, name: String(file.name || '添付ファイル').slice(0, 180), mime: String(file.type || 'application/octet-stream').slice(0, 120), size: Number(file.size) || 0 };
}

async function archiveChatImageInMediaLibrary(messageId, groupId) {
  const { data: sessionData } = await sb.auth.getSession();
  const accessToken = String(sessionData?.session?.access_token || '');
  const endpoint = CONFIG.adminApiUrl ? CONFIG.adminApiUrl('/chat-media-archive') : '';
  if (!accessToken || !endpoint) throw new Error('メディアライブラリへの接続を確認できませんでした。');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message_id: messageId, group_id: groupId }),
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'メディアライブラリへの保存に失敗しました。');
  return result;
}

function isHeicFile(file) {
  const type = String((file && file.type) || '').toLowerCase();
  const name = String((file && file.name) || '').toLowerCase();
  return type === 'image/heic' || type === 'image/heif' || /\.(heic|heif)$/.test(name);
}

function jpegFileName(name) {
  const base = String(name || 'photo').replace(/\.(heic|heif)$/i, '');
  return /\.jpe?g$/i.test(base) ? base : `${base}.jpg`;
}

// HEIC を JPEG にしてから通常の画像経路へ渡す。
// Safari は HEIC をそのまま復号できるので、まず標準機能で試す。
// 復号できないブラウザのときだけ変換ライブラリ（1.3MB）を読み込む。
async function convertHeicToJpeg(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (blob) return new File([blob], jpegFileName(file.name), { type: 'image/jpeg' });
  } catch (_error) {
    // 標準機能では復号できない。下のライブラリに任せる。
  }
  const heic2anyLib = await loadVendorScript('vendor/heic2any.min.js', 'heic2any');
  const converted = await heic2anyLib({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const blob = Array.isArray(converted) ? converted[0] : converted;
  if (!blob) throw new Error('HEIC の変換に失敗しました');
  return new File([blob], jpegFileName(file.name), { type: 'image/jpeg' });
}

// 画像として送れる形に整える。HEIC 以外はそのまま返す。
async function normalizeImageFile(file) {
  if (!isHeicFile(file)) return file;
  showChatToast('写真を変換しています…');
  return convertHeicToJpeg(file);
}

async function sendChatImage(file) {
  if (isHeicFile(file)) {
    try {
      file = await normalizeImageFile(file);
    } catch (error) {
      console.error('HEIC convert error:', error);
      // 変換できなければ原本のままファイルとして送る（送れないより良い）。
      return sendChatFile(file);
    }
  }
  if (!isImageFile(file)) return sendChatFile(file);
  if (!currentGroupId || !currentUser || uploadingImage) return;
  if (!requireCurrentRoomSend()) return;
  uploadingImage = true;
  $('chatImageInput').disabled = true;
  const groupId = currentGroupId;

  try {
    const image = await uploadChatImage(file, groupId);
    const { data, error } = await sb
      .from('chat_messages')
      .insert({
        group_id: groupId,
        user_id: currentUser.id,
        username: currentUser.username,
        content: '[画像]',
        kind: 'image',
        payload: { v: 1, kind: 'image', image: { path: image.path, w: image.width, h: image.height } },
        is_silent: isSilentSendActive === true
      })
      .select(MESSAGE_COLUMNS)
      .single();
    if (error) throw error;

    try {
      await archiveChatImageInMediaLibrary(data.id, groupId);
    } catch (archiveError) {
      console.error('Archive chat image error:', archiveError);
      showChatToast('画像は送信されましたが、メディアライブラリへの保存に失敗しました。');
    }

    lastMessages[data.group_id] = data;
    followNewMessages = true;
    if (viewHasLatest) addMessageToUI(data);
    else {
      await fillLatestGap();
      addMessageToUI(data);
    }
    renderGroups();
    dispatchPushForMessage(data.id);
  } catch (error) {
    console.error('Send image error:', error);
    alert(`画像の送信に失敗しました: ${error.message || error}`);
  } finally {
    uploadingImage = false;
    $('chatImageInput').disabled = false;
    $('chatImageInput').value = '';
  }
}

async function sendChatFile(file) {
  if (!currentGroupId || !currentUser || uploadingImage) return;
  if (!requireCurrentRoomSend()) return;
  uploadingImage = true;
  $('chatImageInput').disabled = true;
  try {
    const attachment = await uploadChatFile(file, currentGroupId);
    const { data, error } = await sb.from('chat_messages').insert({
      group_id: currentGroupId, user_id: currentUser.id, username: currentUser.username,
      content: `[${attachment.name}]`, kind: 'file',
      payload: { v: 1, kind: 'file', file: attachment }, is_silent: isSilentSendActive === true
    }).select(MESSAGE_COLUMNS).single();
    if (error) throw error;
    lastMessages[data.group_id] = data;
    followNewMessages = true;
    if (viewHasLatest) addMessageToUI(data);
    else {
      await fillLatestGap();
      addMessageToUI(data);
    }
    renderGroups();
    dispatchPushForMessage(data.id);
  } catch (error) {
    console.error('Send file error:', error);
    alert(`ファイルの送信に失敗しました: ${error.message || error}`);
  } finally {
    uploadingImage = false;
    $('chatImageInput').disabled = false;
    $('chatImageInput').value = '';
  }
}

function askSendModeForFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length || !currentGroupId || !currentUser) return;
  if (!requireCurrentRoomSend()) return;
  pendingSendFiles = list;
  const hint = $('sendModeHint');
  if (hint) {
    hint.textContent = list.length > 1
      ? `このファイル ${list.length} 件を今すぐ送りますか？ 予約配信も選べます。`
      : 'このファイルを今すぐ送りますか？ 予約配信も選べます。';
  }
  $('sendModeOverlay').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeSendMode() {
  const overlay = $('sendModeOverlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.classList.remove('modal-open');
  if (!$('scheduleOverlay') || $('scheduleOverlay').classList.contains('hidden')) {
    pendingSendFiles = [];
    scheduleTarget = 'text';
  }
}

async function chooseSendNow() {
  const files = pendingSendFiles.slice();
  pendingSendFiles = [];
  scheduleTarget = 'text';
  $('sendModeOverlay').classList.add('hidden');
  document.body.classList.remove('modal-open');
  for (const file of files) await sendChatImage(file);
}

function chooseSendLater() {
  if (!pendingSendFiles.length) return;
  if (pendingSendFiles.some((file) => !isImageFile(file) && !isHeicFile(file))) {
    alert('PDF・Office等のファイルは、まず今すぐ送信してください。');
    return;
  }
  scheduleTarget = 'files';
  $('sendModeOverlay').classList.add('hidden');
  openScheduleSend();
}

const CHAT_PREVIEW_SHEET = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);
const CHAT_PREVIEW_DOC = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);
// 表が巨大でも描画で固まらせない。
const CHAT_PREVIEW_SHEET_MAX_ROWS = 500;
const CHAT_PREVIEW_SHEET_MAX_COLS = 40;

// Office の描画ライブラリは重い（合計1.5MB超）ので、
// その形式を実際に開いたときだけ読み込む。二重読込もしない。
const vendorScriptPromises = new Map();
function loadVendorScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (vendorScriptPromises.has(src)) return vendorScriptPromises.get(src);
  const promise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => window[globalName]
      ? resolve(window[globalName])
      : reject(new Error(`${globalName} was not exposed`));
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
  vendorScriptPromises.set(src, promise);
  return promise;
}

// Excel は自前で表を組む。ライブラリのHTML出力をそのまま挿すより、
// 値を文字列として入れるほうが安全。
async function renderSheetPreview(box, buffer) {
  const XLSXLib = await loadVendorScript('vendor/xlsx.full.min.js', 'XLSX');
  const book = XLSXLib.read(buffer, { type: 'array' });
  const names = Array.isArray(book.SheetNames) ? book.SheetNames : [];
  if (!names.length) throw new Error('no sheets');
  box.className = 'file-viewer-text file-viewer-sheet';
  box.textContent = '';

  const tabs = document.createElement('div');
  tabs.className = 'file-viewer-tabs';
  const body = document.createElement('div');
  body.className = 'file-viewer-sheet-body';

  const drawSheet = (name) => {
    const rows = XLSXLib.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '', raw: false });
    const shown = rows.slice(0, CHAT_PREVIEW_SHEET_MAX_ROWS);
    const table = document.createElement('table');
    shown.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      const cells = (Array.isArray(row) ? row : []).slice(0, CHAT_PREVIEW_SHEET_MAX_COLS);
      cells.forEach((cell) => {
        const td = document.createElement(rowIndex === 0 ? 'th' : 'td');
        td.textContent = String(cell == null ? '' : cell);
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    body.textContent = '';
    body.appendChild(table);
    if (rows.length > shown.length) {
      const note = document.createElement('div');
      note.className = 'file-viewer-note';
      note.textContent = `先頭 ${CHAT_PREVIEW_SHEET_MAX_ROWS} 行のみ表示しています（全 ${rows.length} 行）。`;
      body.appendChild(note);
    }
  };

  names.forEach((name, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `file-viewer-tab${index === 0 ? ' active' : ''}`;
    tab.textContent = name;
    tab.addEventListener('click', () => {
      tabs.querySelectorAll('.file-viewer-tab').forEach((el) => el.classList.remove('active'));
      tab.classList.add('active');
      drawSheet(name);
    });
    tabs.appendChild(tab);
  });

  if (names.length > 1) box.appendChild(tabs);
  box.appendChild(body);
  drawSheet(names[0]);
}

// Word は mammoth が組み立てたHTMLを受け取る。文書由来の内容なので、
// スクリプトも javascript: 遷移も効かない sandbox iframe に閉じ込める。
async function renderDocPreview(box, buffer) {
  const mammothLib = await loadVendorScript('vendor/mammoth.browser.min.js', 'mammoth');
  const result = await mammothLib.convertToHtml({ arrayBuffer: buffer });
  const frame = document.createElement('iframe');
  frame.className = 'file-viewer-doc';
  frame.setAttribute('sandbox', '');
  frame.srcdoc = '<!doctype html><meta charset="utf-8">'
    + '<style>body{margin:0;padding:18px;font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;'
    + 'font-size:14px;line-height:1.7;color:#111;}img{max-width:100%;height:auto;}'
    + 'table{border-collapse:collapse;}td,th{border:1px solid #d0d0d0;padding:4px 8px;}</style>'
    + (result && result.value ? result.value : '<p>本文がありません。</p>');
  box.className = 'file-viewer-doc-wrap';
  box.textContent = '';
  box.appendChild(frame);
}

function fileAttachmentIcon(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'application/pdf') return '📕';
  if (m.includes('word')) return '📘';
  if (m.includes('sheet') || m.includes('excel')) return '📗';
  if (m.includes('presentation') || m.includes('powerpoint')) return '📙';
  if (m === 'application/zip') return '🗜️';
  if (m.startsWith('image/')) return '🖼️';
  if (m.startsWith('text/')) return '📄';
  return '📎';
}

// 添付ファイルを保存せずその場で開く。
// PDF はブラウザ内蔵ビューア、テキスト/CSV は取得して整形表示する。
// Office と ZIP はブラウザ単体で描画できないため保存してもらう
// （外部の変換サービスへ送る手もあるが、顧客名の入った資料が社外へ出るので採らない）。
async function openFileViewer(path, meta = {}) {
  const mime = String(meta.mime || '').toLowerCase();
  const name = String(meta.name || '添付ファイル');
  let signedUrl = '';
  try {
    const { data, error } = await sb.storage.from('chat-images').createSignedUrl(path, 3600);
    if (error) throw error;
    signedUrl = data && data.signedUrl ? data.signedUrl : '';
  } catch (error) {
    console.error('Sign file url error:', error);
    alert('ファイルを開けませんでした');
    return;
  }
  const safeUrl = safeHttpUrl(signedUrl);
  if (!safeUrl) return;

  const overlay = document.createElement('div');
  overlay.className = 'image-viewer file-viewer';
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKeydown); };
  const onKeydown = (event) => { if (event.key === 'Escape') close(); };

  let inner = '';
  if (CHAT_PREVIEW_PDF.has(mime)) {
    inner = `<iframe class="file-viewer-frame" src="${escapeHtml(safeUrl)}" title="${escapeHtml(name)}"></iframe>`;
  } else if (CHAT_PREVIEW_TEXT.has(mime) || CHAT_PREVIEW_SHEET.has(mime) || CHAT_PREVIEW_DOC.has(mime)) {
    inner = '<div class="file-viewer-text">読み込んでいます…</div>';
  } else {
    inner = `<div class="file-viewer-text">この形式はアプリ内で表示できません。<br>保存してから開いてください。</div>`;
  }
  overlay.innerHTML = `<button type="button" class="image-viewer-close" aria-label="閉じる">閉じる</button>`
    + `<button type="button" class="image-viewer-download">ダウンロード</button>`
    + `<div class="file-viewer-title">${escapeHtml(name)}</div>${inner}`;

  overlay.onclick = (event) => { if (event.target === overlay) close(); };
  overlay.querySelector('.image-viewer-close').addEventListener('click', close);
  overlay.querySelector('.image-viewer-download').addEventListener('click', (event) => {
    event.stopPropagation();
    const link = document.createElement('a');
    link.href = safeUrl;
    link.download = name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  });
  document.addEventListener('keydown', onKeydown);
  document.body.appendChild(overlay);

  const needsFetch = CHAT_PREVIEW_TEXT.has(mime) || CHAT_PREVIEW_SHEET.has(mime) || CHAT_PREVIEW_DOC.has(mime);
  if (needsFetch) {
    const box = overlay.querySelector('.file-viewer-text');
    try {
      const res = await fetch(safeUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (CHAT_PREVIEW_SHEET.has(mime)) {
        await renderSheetPreview(box, buf);
      } else if (CHAT_PREVIEW_DOC.has(mime)) {
        await renderDocPreview(box, buf);
      } else {
        const truncated = buf.byteLength > CHAT_PREVIEW_TEXT_MAX_BYTES;
        const slice = truncated ? buf.slice(0, CHAT_PREVIEW_TEXT_MAX_BYTES) : buf;
        const text = new TextDecoder('utf-8').decode(slice);
        box.className = 'file-viewer-text file-viewer-pre';
        box.textContent = truncated ? `${text}\n\n…（先頭 512KB のみ表示しています）` : text;
      }
    } catch (error) {
      console.error('File preview error:', error);
      // .doc（旧形式）は mammoth が扱えない。ここに来たら保存してもらう。
      box.className = 'file-viewer-text';
      box.textContent = '本文を読み込めませんでした。保存してから開いてください。';
    }
  }
}

function openImageViewer(src, options = {}) {
  const safeSrc = safeHttpUrl(src);
  if (!safeSrc) return;
  const overlay = document.createElement('div');
  overlay.className = 'image-viewer';
  overlay.innerHTML = `<button type="button" class="image-viewer-close" aria-label="画像を閉じる">閉じる</button><button type="button" class="image-viewer-download">ダウンロード</button><img src="${escapeHtml(safeSrc)}" alt="画像"><div class="image-viewer-actions"><button type="button" data-viewer-action="save">保存</button><button type="button" data-viewer-action="save-as">名前を付けて保存</button><button type="button" data-viewer-action="forward">転送</button><button type="button" data-viewer-action="keep">Keepメモに転送</button></div>`;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKeydown); };
  const onKeydown = (event) => { if (event.key === 'Escape') close(); };
  overlay.onclick = (event) => { if (event.target === overlay) close(); };
  overlay.querySelector('.image-viewer-close').addEventListener('click', close);
  overlay.querySelector('img').addEventListener('click', (event) => event.stopPropagation());
  overlay.querySelector('.image-viewer-download').addEventListener('click', async (event) => {
    event.stopPropagation();
    await downloadImage(safeSrc);
  });
  overlay.querySelectorAll('[data-viewer-action]').forEach((button) => button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const action = button.dataset.viewerAction;
    if (action === 'save') return downloadImage(safeSrc);
    if (action === 'save-as') {
      const name = window.prompt('保存するファイル名', `mtalk-image-${Date.now()}.jpg`);
      if (name) await downloadImage(safeSrc, name);
      return;
    }
    if (action === 'keep') {
      await saveImageToKeep(options.storagePath, options.messageId);
      return;
    }
    if (action === 'forward') {
      const message = await resolveAlbumMessage(options.messageId, options.storagePath);
      if (!message) { alert('この画像を転送できるメッセージ情報がありません'); return; }
      close();
      await openForward(message);
    }
  }));
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKeydown);
}

async function downloadImage(src, fileName = '') {
  const safeSrc = safeHttpUrl(src);
  if (!safeSrc) return;
  try {
    const response = await fetch(safeSrc);
    if (!response.ok) throw new Error('画像を取得できませんでした');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const cleanedName = String(fileName || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
    anchor.download = cleanedName || `mtalk-image-${Date.now()}.jpg`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.warn('Image download fallback:', error);
    const anchor = document.createElement('a');
    anchor.href = safeSrc;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    anchor.download = '';
    anchor.click();
  }
}

async function saveImageToKeep(storagePath, messageId) {
  if (!currentUser || !storagePath) { alert('Keepメモへ転送できる画像情報がありません'); return; }
  const message = await resolveAlbumMessage(messageId, storagePath);
  const image = message && imageFromMessage(message);
  if (!image || image.path !== storagePath) { alert('画像の確認に失敗しました'); return; }
  const { error } = await sb.from('chat_keep_items').insert({
    user_id: currentUser.id,
    kind: 'image',
    payload: { v: 1, image: { path: storagePath } }
  });
  if (error) { alert(`Keepメモへの転送に失敗しました: ${error.message || error}`); return; }
  showChatToast('Keepメモに転送しました');
}

async function resolveAlbumMessage(messageId, storagePath) {
  let message = currentMessages.find((row) => Number(row.id) === Number(messageId));
  if (message || !messageId) return message || null;
  const { data, error } = await sb.from('chat_messages').select(MESSAGE_COLUMNS).eq('id', Number(messageId)).maybeSingle();
  if (error) { console.error('Load album message error:', error); return null; }
  const image = data && imageFromMessage(data);
  return image && (!storagePath || image.path === storagePath) ? data : null;
}

// javascript: 等を踏まないよう、リンクは http(s) のみ通す。
function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ''), window.location.href);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '';
  } catch (_) {
    return '';
  }
}

function renderCardSection(section) {
  if (!section || typeof section !== 'object') return '';

  if (section.type === 'fields') {
    return (Array.isArray(section.rows) ? section.rows : []).map((row) => {
      const paragraphs = Array.isArray(row.paragraphs) && row.paragraphs.length
        ? row.paragraphs.map((p) => `<div class="msg-card-para">${escapeHtml(p)}</div>`).join('')
        : escapeHtml(row.value ?? '');
      const ddClass = row.weight === 'bold' ? ' class="is-bold"' : '';
      const color = row.color ? ` style="color:${escapeHtml(row.color)}"` : '';
      return `<dl class="msg-card-field"><dt>${escapeHtml(row.label ?? '')}</dt><dd${ddClass}${color}>${paragraphs}</dd></dl>`;
    }).join('');
  }

  if (section.type === 'list') {
    return (Array.isArray(section.items) ? section.items : []).map((item) => {
      const top = [
        `<span class="msg-card-time">${escapeHtml(item.time ?? '--:--')}</span>`,
        `<span class="msg-card-name">${escapeHtml(item.name ?? '')}</span>`,
        item.size ? `<span class="msg-card-size">${escapeHtml(item.size)}</span>` : ''
      ].join('');
      return `<div class="msg-card-item">
        <div class="msg-card-item-top">${top}</div>
        ${item.note ? `<div class="msg-card-note">${escapeHtml(item.note)}</div>` : ''}
        ${item.warn ? `<div class="msg-card-warn">${escapeHtml(item.warn)}</div>` : ''}
      </div>`;
    }).join('');
  }

  if (section.type === 'note') {
    const classes = ['msg-card-empty'];
    if (section.weight === 'bold') classes.push('is-bold');
    if (section.size === 'xs') classes.push('is-xs');
    const color = section.color ? ` style="color:${escapeHtml(section.color)}"` : '';
    return `<div class="${classes.join(' ')}"${color}>${escapeHtml(section.text ?? '')}</div>`;
  }
  if (section.type === 'separator') return '<hr class="msg-card-sep">';
  if (section.type === 'heading') {
    return `<div class="msg-card-heading">${escapeHtml(section.text ?? '')}</div>`;
  }

  return '';
}

function renderCardAction(action) {
  if (!action || typeof action !== 'object') return '';
  const label = escapeHtml(action.label || '開く');
  const command = String(action.command || '').trim();
  const actionClass = action.style === 'primary' ? 'msg-card-action' : 'msg-card-action secondary';
  if (command) {
    return `<button type="button" class="${actionClass}" data-card-command="${escapeHtml(command)}">${label}</button>`;
  }
  const url = safeHttpUrl(action.url);
  if (!url) return '';
  return `<a class="${actionClass}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function renderCard(card) {
  if (!card || typeof card !== 'object') return '';
  const header = card.header || {};
  const sections = (Array.isArray(card.sections) ? card.sections : [])
    .map(renderCardSection)
    .join('');
  const actions = Array.isArray(card.actions) && card.actions.length
    ? card.actions
    : (card.action ? [card.action] : []);
  const actionHtml = actions.map(renderCardAction).filter(Boolean).join('');
  const lineLike = card.variant === 'line';
  const title = String(header.title || '');
  return `<div class="msg-card${lineLike ? ' msg-card-line' : ''}">
    ${!lineLike && title ? `<div class="msg-card-header">
      ${header.eyebrow ? `<div class="msg-card-eyebrow">${escapeHtml(header.eyebrow)}</div>` : ''}
      <div class="msg-card-title">${escapeHtml(title)}</div>
      ${header.subtitle ? `<div class="msg-card-subtitle">${escapeHtml(header.subtitle)}</div>` : ''}
    </div>` : ''}
    <div class="msg-card-body">${sections}</div>
    ${actionHtml ? `<div class="msg-card-actions">${actionHtml}</div>` : ''}
  </div>`;
}

function parseSignupReviewCommand(text) {
  const match = /^mtalk-signup:(approve|deny):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
    .exec(String(text || '').trim());
  if (!match) return null;
  return { approve: match[1].toLowerCase() === 'approve', userId: match[2] };
}

function parseStoreChangeCommand(text) {
  const match = /^mtalk-stores:(approve|deny):(\d+)$/i.exec(String(text || '').trim());
  if (!match) return null;
  return { approve: match[1].toLowerCase() === 'approve', requestId: Number(match[2]) };
}

async function reviewSignupFromCard(approve, userId) {
  if (!currentUser) return;
  if (!canCurrentUserManage()) {
    alert('この操作はルームの管理権限が必要です');
    return;
  }
  try {
    const { error } = await sb.rpc('chat_review_signup', {
      p_user_id: userId,
      p_approve: approve === true
    });
    if (error) throw error;
    alert(approve
      ? '許可しました。この人は閲覧のみで始まります。'
      : '不許可にしました。');
  } catch (error) {
    console.error('Signup review error:', error);
    alert(error.message || '操作に失敗しました');
  }
}

async function reviewStoreChangeFromCard(approve, requestId) {
  if (!currentUser) return;
  if (!canCurrentUserManage()) {
    alert('この操作はルームの管理権限が必要です');
    return;
  }
  try {
    const { error } = await sb.rpc('chat_review_store_change', {
      p_request_id: requestId,
      p_approve: approve === true
    });
    if (error) throw error;
    alert(approve ? '所属店舗の変更を許可しました。' : '所属店舗の変更を不許可にしました。');
  } catch (error) {
    console.error('Store change review error:', error);
    alert(error.message || '操作に失敗しました');
  }
}

async function sendCardCommand(text) {
  const content = String(text || '').trim();
  if (!content || !currentUser) return;
  const signup = parseSignupReviewCommand(content);
  if (signup) {
    await reviewSignupFromCard(signup.approve, signup.userId);
    return;
  }
  const storeChange = parseStoreChangeCommand(content);
  if (storeChange) {
    await reviewStoreChangeFromCard(storeChange.approve, storeChange.requestId);
    return;
  }
  if (!currentGroupId) return;
  if (!requireCurrentRoomSend()) return;
  try {
    const { data, error } = await sb
      .from('chat_messages')
      .insert({
        group_id: currentGroupId,
        user_id: currentUser.id,
        username: currentUser.username,
        content,
        is_silent: isSilentSendActive === true
      })
      .select(MESSAGE_COLUMNS)
      .single();
    if (error) throw error;
    lastMessages[data.group_id] = data;
    followNewMessages = true;
    if (viewHasLatest) addMessageToUI(data);
    else {
      await fillLatestGap();
      addMessageToUI(data);
    }
    renderGroups();
    dispatchPushForMessage(data.id);
  } catch (error) {
    console.error('Card command error:', error);
    alert(error.message || '操作に失敗しました');
  }
}
