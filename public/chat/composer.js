'use strict';

async function sendChatText(content, options) {
  const text = String(content || '').trim();
  if (!text || !currentGroupId || !currentUser) return false;
  if (!requireCurrentRoomSend()) return false;
  if (isGroupTrashed(findMineGroup(currentGroupId))) {
    alert('ゴミ箱のルームには送信できません。復元してから使ってください。');
    return false;
  }
  const withReply = options && options.withReply !== false;
  try {
    const { data, error } = await sb
      .from('chat_messages')
      .insert({
        group_id: currentGroupId,
        user_id: currentUser.id,
        username: currentUser.username,
        content: text,
        reply_to_id: withReply && replyTarget ? replyTarget.id : null,
        mentions: collectMentions(text),
        is_silent: isSilentSendActive === true
      })
      .select(MESSAGE_COLUMNS)
      .single();
    if (error) throw error;
    if (withReply) clearReplyTarget();
    lastMessages[data.group_id] = data;
    followNewMessages = true;
    if (viewHasLatest) addMessageToUI(data);
    else {
      await fillLatestGap();
      addMessageToUI(data);
    }
    renderGroups();
    dispatchPushForMessage(data.id);
    return true;
  } catch (error) {
    console.error('Send error:', error);
    alert(`送信に失敗しました: ${error.message || error}`);
    return false;
  }
}

async function sendMessage() {
  if (!currentGroupId || !currentUser) return;
  if (!requireCurrentRoomSend()) return;
  const input = $('messageInput');
  const content = input.value.trim();
  if (editingMessage) {
    const compact = !!stickerFromMessage(editingMessage) && stickerFromMessage(editingMessage).display === 'compact';
    if (!content && !compact) return;
    const ok = await saveEditedMessage(content);
    if (ok) {
      input.value = '';
      syncComposerModeUi();
      resizeComposer();
    }
    return;
  }
  if (!content && !pendingInlineSticker) return;

  if (isPrivateNoteMode) {
    pendingPrivateNoteContent = content;
    const ok = await savePrivateNote();
    if (ok) {
      input.value = '';
      isPrivateNoteMode = false;
      isSilentSendActive = false;
      syncComposerModeUi();
      resizeComposer();
    }
    return;
  }

  input.value = '';
  resizeComposer();
  input.focus();
  const inlineSticker = pendingInlineSticker;
  const ok = inlineSticker
    ? await sendSticker(inlineSticker.id, 'compact', content)
    : await sendChatText(content);
  if (!ok) {
    input.value = content;
    resizeComposer();
  } else {
    isSilentSendActive = false;
    isPrivateNoteMode = false;
    syncComposerModeUi();
    resizeComposer();
  }
}

function toggleSilentSend() {
  if (editingMessage) cancelMessageEdit();
  isSilentSendActive = !isSilentSendActive;
  if (isSilentSendActive) isPrivateNoteMode = false;
  syncComposerModeUi();
  renderSilentSendState();
  showChatToast(isSilentSendActive ? '🔕 通知なし（サイレント）ON' : '🔔 通常通知 ON');
}

function togglePrivateNoteMode() {
  if (!currentGroupId || !currentUser) return;
  if (editingMessage) cancelMessageEdit();
  isPrivateNoteMode = !isPrivateNoteMode;
  if (isPrivateNoteMode) {
    isSilentSendActive = false;
    if (pendingInlineSticker) {
      pendingInlineSticker = null;
      renderInlineStickerPreview();
    }
  }
  syncComposerModeUi();
  $('messageInput')?.focus();
  showChatToast(isPrivateNoteMode ? '個人メモモード' : '通常送信モード');
}

function clearComposerMode() {
  isSilentSendActive = false;
  isPrivateNoteMode = false;
  if (editingMessage) cancelMessageEdit();
  else syncComposerModeUi();
}

function toggleComposerSheet() {
  if (editingMessage) {
    cancelMessageEdit();
    return;
  }
  composerSheetOpen = !composerSheetOpen;
  syncComposerModeUi();
}

function closeComposerSheet() {
  composerSheetOpen = false;
  syncComposerModeUi();
}

function syncComposerModeUi() {
  // ジャーナルAIは1対1専用。加えて、取込先の店舗が決まらないと使えないので
  // 店舗Botのいる1対1に限る（人同士のDMでは出さない）。
  const journalBtn = $('journalAiBtn');
  if (journalBtn) journalBtn.classList.toggle('hidden', !currentRoomAllowsJournalAi());
  const chip = $('composerModeChip');
  const chipIcon = $('composerModeIcon');
  const chipText = $('composerModeText');
  const hint = $('composerHintText');
  const input = $('messageInput');
  const send = $('composerSendBtn');
  const sendLabel = $('composerSendLabel');
  const plus = $('composerPlusBtn');
  const sheet = $('composerSheet');
  const text = String(input?.value || '').trim();
  const compactEdit = !!(editingMessage && stickerFromMessage(editingMessage) && stickerFromMessage(editingMessage).display === 'compact');
  const mode = editingMessage ? 'edit' : (isPrivateNoteMode ? 'memo' : (isSilentSendActive ? 'silent' : 'normal'));

  if (chip) {
    chip.classList.toggle('visible', mode !== 'normal');
    chip.classList.toggle('memo', mode === 'memo');
    chip.classList.toggle('edit', mode === 'edit');
  }
  if (chipIcon) chipIcon.textContent = mode === 'edit' ? '✎' : (mode === 'memo' ? '📝' : '🔕');
  if (chipText) chipText.textContent = mode === 'edit'
    ? '編集中 ・ この発言の本文を直します'
    : mode === 'memo'
    ? '個人メモ ・ 自分だけに表示、送信されません'
    : 'サイレント送信 ・ 全員に届くが通知は鳴りません';
  if (hint) hint.textContent = mode === 'edit'
    ? '保存で反映。通知は送り直しません'
    : mode === 'memo'
    ? '相手には届きません'
    : mode === 'silent' ? '届きますが通知は鳴りません' : 'Enterで送信';
  if (input) {
    input.placeholder = mode === 'edit' ? '直す本文を入力' : (mode === 'memo' ? '自分用のメモを入力' : 'メッセージを入力');
    input.classList.toggle('composer-input-active', mode !== 'normal');
    input.classList.toggle('composer-input-empty', !text);
  }
  if (send) {
    send.disabled = mode === 'edit' ? (!text && !compactEdit) : !text;
    send.classList.toggle('memo-mode', mode === 'memo');
    send.setAttribute('aria-label', mode === 'edit' ? '編集を保存' : mode === 'memo' ? 'メモを保存' : mode === 'silent' ? '通知せず送信' : '送信');
  }
  if (sendLabel) sendLabel.textContent = mode === 'edit' ? '保存' : mode === 'memo' ? 'メモを保存' : mode === 'silent' ? '通知せず送信' : '送信';
  if (plus) {
    plus.classList.toggle('active', composerSheetOpen);
    plus.setAttribute('aria-expanded', composerSheetOpen ? 'true' : 'false');
  }
  if (sheet) sheet.classList.toggle('visible', composerSheetOpen);
}

function renderSilentSendState() {
  const btn = $('silentToggleBtn');
  if (!btn) return;
  btn.classList.toggle('active', isSilentSendActive);
  btn.textContent = isSilentSendActive ? '🔕' : '🔔';
  btn.title = isSilentSendActive ? '通知なしで送信（ON）' : '通知ありで送信（OFF）';
  btn.setAttribute('aria-label', btn.title);
}

function openSearchLauncher() {
  $('searchLauncherOverlay')?.classList.remove('hidden');
}

function closeSearchLauncher() {
  $('searchLauncherOverlay')?.classList.add('hidden');
}

function keepDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}

function renderKeepItems() {
  const list = $('keepList');
  if (!list) return;
  if (!keepItems.length) {
    list.innerHTML = '<div class="schedule-hint">まだKeepメモはありません。</div>';
    return;
  }
  list.innerHTML = keepItems.map((item) => {
    const payload = typeof item.payload === 'string' ? safeParseJson(item.payload) : item.payload;
    const path = item.kind === 'image' && payload?.image?.path ? String(payload.image.path) : '';
    const cached = path ? signedImageUrls.get(path) : null;
    const body = path
      ? `<img class="keep-image" data-keep-path="${escapeHtml(path)}" src="${escapeHtml(cached?.url || '')}" alt="Keepした画像" onclick="if (this.src) openImageViewer(this.src)"><div>画像</div>`
      : escapeHtml(item.content || '[保存データ]');
    return `
    <div class="keep-item">
      <div class="keep-item-body">${body}<div class="keep-item-meta">${escapeHtml(keepDate(item.created_at))}</div></div>
      <button class="keep-delete" type="button" aria-label="Keepメモを削除" onclick="deleteKeepMemo(${Number(item.id)})">×</button>
    </div>`;
  }).join('');
  void hydrateKeepImages();
}

async function hydrateKeepImages() {
  const nodes = [...document.querySelectorAll('#keepList img[data-keep-path]')];
  if (!nodes.length) return;
  const urls = await albumSignedUrls(nodes.map((node) => node.dataset.keepPath));
  nodes.forEach((node) => { const url = urls.get(node.dataset.keepPath); if (url) node.src = url; });
}

async function loadKeepItems() {
  if (!currentUser) return;
  const { data, error } = await sb.from('chat_keep_items')
    .select('id,kind,content,payload,created_at,updated_at')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  keepItems = data || [];
  renderKeepItems();
}

async function openKeepMemo() {
  if (!currentUser) return;
  closeComposerSheet();
  $('keepOverlay')?.classList.remove('hidden');
  try { await loadKeepItems(); } catch (error) { console.error('Load Keep memo error:', error); alert('Keepメモを読み込めませんでした'); }
  $('keepInput')?.focus();
}

function closeKeepMemo() {
  $('keepOverlay')?.classList.add('hidden');
}

async function saveKeepMemo() {
  if (!currentUser) return;
  const input = $('keepInput');
  const content = String(input?.value || '').trim();
  if (!content) { input?.focus(); return; }
  try {
    const { data, error } = await sb.from('chat_keep_items')
      .insert({ user_id: currentUser.id, kind: 'text', content })
      .select('id,kind,content,payload,created_at,updated_at').single();
    if (error) throw error;
    keepItems = [data, ...keepItems];
    if (input) input.value = '';
    renderKeepItems();
    showChatToast('Keepメモに保存しました');
  } catch (error) { console.error('Save Keep memo error:', error); alert(`Keepメモの保存に失敗しました: ${error.message || error}`); }
}

async function deleteKeepMemo(id) {
  if (!currentUser || !Number.isFinite(Number(id))) return;
  if (!confirm('このKeepメモを削除しますか？')) return;
  const { error } = await sb.from('chat_keep_items').delete().eq('id', Number(id));
  if (error) { alert(`Keepメモの削除に失敗しました: ${error.message || error}`); return; }
  keepItems = keepItems.filter((item) => Number(item.id) !== Number(id));
  renderKeepItems();
}

async function saveMessageToKeep(msg) {
  if (!currentUser || !msg) return;
  const content = msg.kind === 'image' ? '[画像]' : String(msg.content || '').trim();
  if (!content) { alert('このメッセージはKeepに保存できません'); return; }
  const { data, error } = await sb.from('chat_keep_items')
    .insert({ user_id: currentUser.id, kind: 'text', content })
    .select('id,kind,content,payload,created_at,updated_at').single();
  if (error) { alert(`Keepへの保存に失敗しました: ${error.message || error}`); return; }
  keepItems = [data, ...keepItems];
  showChatToast('Keepメモに保存しました');
}

function albumDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ja-JP');
}

async function albumSignedUrls(paths) {
  const wanted = [...new Set(paths.filter(Boolean))];
  const result = new Map();
  const missing = wanted.filter((path) => {
    const cached = signedImageUrls.get(path);
    if (cached && cached.expiresAt > Date.now() + 60000) { result.set(path, cached.url); return false; }
    return true;
  });
  if (missing.length) {
    const { data, error } = await sb.storage.from('chat-images').createSignedUrls(missing, 3600);
    if (error) throw error;
    (data || []).forEach((row) => {
      if (!row.path || !row.signedUrl) return;
      signedImageUrls.set(row.path, { url: row.signedUrl, expiresAt: Date.now() + 3600000 });
      result.set(row.path, row.signedUrl);
    });
    persistSignedImageCache();
  }
  wanted.forEach((path) => { if (!result.has(path) && signedImageUrls.has(path)) result.set(path, signedImageUrls.get(path).url); });
  return result;
}

async function loadAlbumItems(albumId) {
  const { data, error } = await sb.from('chat_album_items')
    .select('id,album_id,group_id,message_id,storage_path,caption,added_by,created_at')
    .eq('album_id', albumId).order('created_at', { ascending: false });
  if (error) throw error;
  const rows = data || [];
  const urls = await albumSignedUrls(rows.map((row) => row.storage_path));
  albumItemsById.set(Number(albumId), rows.map((row) => ({ ...row, url: urls.get(row.storage_path) || '' })));
}

function renderAlbumSourceList() {
  const panel = $('albumSourcePanel');
  const list = $('albumSourceList');
  if (!panel || !list) return;
  if (!selectedAlbumId) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const existing = new Set((albumItemsById.get(Number(selectedAlbumId)) || []).map((row) => Number(row.message_id)));
  const images = currentMessages.filter((message) => imageFromMessage(message) && !existing.has(Number(message.id)));
  const meta = $('albumSourceMeta');
  if (meta) meta.textContent = `${images.length}枚が未追加`;
  if (!images.length) { list.innerHTML = '<div class="schedule-hint">追加できる画像がありません。</div>'; return; }
  list.innerHTML = images.map((message) => {
    const image = imageFromMessage(message);
    const cached = signedImageUrls.get(image.path);
    return `<div class="album-source-row"><img src="${escapeHtml(cached?.url || '')}" data-path="${escapeHtml(image.path)}" alt="画像を開く" onclick="if (this.src) openImageViewer(this.src,{messageId:${Number(message.id)},storagePath:'${escapeHtml(image.path)}'})"><span>${escapeHtml(albumDate(message.created_at))}</span><button type="button" aria-label="アルバムに追加" onclick="addMessageToAlbum(${Number(selectedAlbumId)},${Number(message.id)})">追加</button></div>`;
  }).join('');
  void hydrateAlbumSourceImages();
}

async function hydrateAlbumSourceImages() {
  const nodes = [...document.querySelectorAll('#albumSourceList img[data-path]')];
  const urls = await albumSignedUrls(nodes.map((node) => node.dataset.path));
  nodes.forEach((node) => { const url = urls.get(node.dataset.path); if (url) node.src = url; });
}

function renderAlbums() {
  const list = $('albumList');
  if (!list) return;
  const detail = selectedAlbumId !== null ? albums.find((row) => Number(row.id) === Number(selectedAlbumId)) : null;
  const isDetail = !!detail;
  $('albumCreateRow')?.classList.toggle('hidden', isDetail);
  $('albumDetailBar')?.classList.toggle('hidden', !isDetail);
  const title = $('albumViewTitle');
  const sub = $('albumViewSub');
  if (title) title.textContent = isDetail ? detail.name : 'アルバム';
  if (sub) sub.textContent = isDetail ? '画像を並べ替え・追加・削除できます。' : 'このルームの画像を、みんなで整理・閲覧できます。';
  if (!isDetail) {
    if (!albums.length) { list.innerHTML = '<div class="schedule-hint" style="padding:37px 0;text-align:center;">まだアルバムがありません。上の欄から作成してください。</div>'; }
    else list.innerHTML = albums.map((album) => {
      const items = albumItemsById.get(Number(album.id)) || [];
      const editable = canEditAlbum(album);
      const cells = Array.from({ length: 4 }, (_, index) => {
        const item = items[index];
        return item?.url ? `<span><img src="${escapeHtml(item.url)}" alt=""></span>` : `<span>${index === 3 && items.length > 4 ? `+${items.length - 3}` : '·'}</span>`;
      }).join('');
      const confirming = albumDeleteConfirmId === Number(album.id);
      const actions = confirming
        ? `<div class="album-confirm"><span>削除しますか？</span><button class="send-mode-now" type="button" onclick="deleteAlbum(${Number(album.id)})">削除</button><button type="button" class="album-cancel-delete" onclick="cancelAlbumDelete()">やめる</button></div>`
        : `<div style="display:flex;gap:9px;align-items:center;">${editable ? `<button class="album-remove" type="button" aria-label="削除確認" onclick="askDeleteAlbum(${Number(album.id)})">♢</button>` : ''}<button class="send-mode-now" type="button" onclick="selectAlbum(${Number(album.id)})">開く</button></div>`;
      return `<div class="album-card"><div style="display:flex;align-items:center;gap:14px;"><div class="album-library-mosaic">${cells}</div><div style="flex:1;min-width:0;"><div class="album-card-title">${escapeHtml(album.name)}</div><small style="margin:2px 0 0;color:#7d7979;font-size:11.5px;">${items.length}枚 · ${escapeHtml(albumDate(album.updated_at || album.created_at))}</small></div>${actions}</div></div>`;
    }).join('');
    $('albumFooterNote').textContent = `${albums.length}件のアルバム · ${albums.reduce((total, album) => total + (albumItemsById.get(Number(album.id)) || []).length, 0)}枚`;
    $('albumSourcePanel')?.classList.add('hidden');
    return;
  }
  const items = albumItemsById.get(Number(detail.id)) || [];
  const editable = canEditAlbum(detail);
  list.innerHTML = `<div class="album-detail-meta">${items.length}枚 · 更新 ${escapeHtml(albumDate(detail.updated_at || detail.created_at))}</div><div class="album-detail-grid">${items.map((item) => item.url ? `<div class="album-photo"><img src="${escapeHtml(item.url)}" alt="画像を開く" title="クリックして拡大・ダウンロード" onclick="openImageViewer('${escapeHtml(item.url)}',{messageId:${Number(item.message_id)},storagePath:'${escapeHtml(item.storage_path)}'})">${editable ? `<button class="album-photo-remove" type="button" aria-label="このアルバムから外す" onclick="removeAlbumItem(${Number(item.id)},${Number(detail.id)})">×</button>` : ''}</div>` : '').join('')}</div>${items.length ? '' : '<div class="schedule-hint" style="padding:37px 0;text-align:center;">画像がありません。「画像を追加」から選んでください。</div>'}`;
  $('albumFooterNote').textContent = `${items.length}枚 · 更新 ${albumDate(detail.updated_at || detail.created_at)}`;
  if (!$('albumSourcePanel')?.classList.contains('hidden')) renderAlbumSourceList();
}

async function loadAlbums() {
  if (!currentGroupId) return;
  const { data, error } = await sb.from('chat_albums').select('id,group_id,name,created_by,created_at,updated_at').eq('group_id', currentGroupId).order('updated_at', { ascending: false });
  if (error) throw error;
  albums = data || [];
  albumItemsById = new Map();
  for (const album of albums) await loadAlbumItems(album.id);
  renderAlbums();
}

async function openAlbumManager() {
  if (!currentGroupId || !currentUser) return;
  if (!requireCurrentRoomView()) return;
  closeComposerSheet();
  selectedAlbumId = null;
  $('albumOverlay')?.classList.remove('hidden');
  try { await loadAlbums(); } catch (error) { console.error('Load albums error:', error); alert('アルバムを読み込めませんでした'); }
}

function closeAlbumManager() {
  $('albumOverlay')?.classList.add('hidden');
  selectedAlbumId = null;
  albumDeleteConfirmId = null;
  $('albumSourcePanel')?.classList.add('hidden');
}

function backToAlbumLibrary() {
  selectedAlbumId = null;
  albumDeleteConfirmId = null;
  $('albumSourcePanel')?.classList.add('hidden');
  renderAlbums();
}

function toggleAlbumSourcePanel() {
  const panel = $('albumSourcePanel');
  if (!panel || !selectedAlbumId) return;
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) renderAlbumSourceList();
}

function askDeleteAlbum(albumId) {
  albumDeleteConfirmId = Number(albumId);
  renderAlbums();
}

function cancelAlbumDelete() {
  albumDeleteConfirmId = null;
  renderAlbums();
}

async function createAlbum() {
  if (!currentGroupId || !currentUser || !requireCurrentRoomSend()) return;
  const input = $('albumNameInput');
  const name = String(input?.value || '').trim();
  if (!name) { input?.focus(); return; }
  const { data, error } = await sb.from('chat_albums').insert({ group_id: currentGroupId, name, created_by: currentUser.id }).select('id,group_id,name,created_by,created_at,updated_at').single();
  if (error) { alert(`アルバムの作成に失敗しました: ${error.message || error}`); return; }
  albums = [data, ...albums];
  if (input) input.value = '';
  await loadAlbumItems(data.id);
  selectedAlbumId = null;
  albumDeleteConfirmId = null;
  renderAlbums();
}

async function selectAlbum(albumId) {
  selectedAlbumId = Number(albumId);
  if (!albumItemsById.has(selectedAlbumId)) await loadAlbumItems(selectedAlbumId);
  renderAlbums();
}

function canEditAlbum(album) {
  return !!(album && currentUser && (String(album.created_by) === String(currentUser.id) || canCurrentUserManage()));
}

async function removeAlbumItem(itemId, albumId) {
  if (!currentUser || !Number.isFinite(Number(itemId))) return;
  const album = albums.find((row) => Number(row.id) === Number(albumId));
  if (!canEditAlbum(album)) { alert('このアルバムを編集する権限がありません'); return; }
  const { error } = await sb.from('chat_album_items').delete().eq('id', Number(itemId));
  if (error) { alert(`アルバムからの削除に失敗しました: ${error.message || error}`); return; }
  const rows = (albumItemsById.get(Number(albumId)) || []).filter((row) => Number(row.id) !== Number(itemId));
  albumItemsById.set(Number(albumId), rows);
  renderAlbums();
  showChatToast('アルバムから削除しました');
}

async function deleteAlbum(albumId) {
  if (!currentUser || !Number.isFinite(Number(albumId))) return;
  const album = albums.find((row) => Number(row.id) === Number(albumId));
  if (!canEditAlbum(album)) { alert('このアルバムを削除する権限がありません'); return; }
  const { error } = await sb.from('chat_albums').delete().eq('id', Number(albumId));
  if (error) { alert(`アルバムの削除に失敗しました: ${error.message || error}`); return; }
  albums = albums.filter((row) => Number(row.id) !== Number(albumId));
  albumItemsById.delete(Number(albumId));
  if (selectedAlbumId === Number(albumId)) selectedAlbumId = null;
  albumDeleteConfirmId = null;
  renderAlbums();
  showChatToast('アルバムを削除しました');
}

async function addMessageToAlbum(albumId, messageId) {
  if (!currentGroupId || !currentUser || !requireCurrentRoomSend()) return;
  const message = currentMessages.find((row) => Number(row.id) === Number(messageId));
  const image = message && imageFromMessage(message);
  if (!image?.path) return;
  const { error } = await sb.from('chat_album_items').insert({ album_id: Number(albumId), group_id: currentGroupId, message_id: Number(messageId), storage_path: image.path, added_by: currentUser.id });
  if (error) { alert(`アルバムへの追加に失敗しました: ${error.message || error}`); return; }
  await loadAlbumItems(albumId);
  renderAlbums();
  showChatToast('アルバムに追加しました');
}

// 個人メモ: 送信は一切行わない。保存先はDBだが、他の参加者・Bot・管理画面には見せない。
function openPrivateNoteComposer() {
  if (!currentGroupId || !currentUser) return;
  const input = $('privateNoteInput');
  if (input) input.value = '';
  $('privateNoteOverlay')?.classList.remove('hidden');
  if (input) input.focus();
}

function closePrivateNoteComposer() {
  $('privateNoteOverlay')?.classList.add('hidden');
}

async function savePrivateNote() {
  if (!currentGroupId || !currentUser) return;
  const input = $('privateNoteInput');
  const contentOverride = pendingPrivateNoteContent;
  pendingPrivateNoteContent = null;
  const content = contentOverride == null ? String(input?.value || '').trim() : String(contentOverride || '').trim();
  if (!content) { input?.focus(); return false; }
  if (content.length > 500) { alert('個人メモは500文字までです'); return; }
  try {
    const { data, error } = await sb
      .from('chat_private_notes')
      .insert({ group_id: currentGroupId, user_id: currentUser.id, content })
      .select('id, group_id, content, created_at')
      .single();
    if (error) throw error;
    if (contentOverride == null) closePrivateNoteComposer();
    if (data && !currentPrivateNotes.some((n) => n.id === data.id)) {
      currentPrivateNotes = currentPrivateNotes.concat([data]);
      renderMessageList();
      if (followNewMessages) scrollMessagesToBottom();
    }
    return true;
  } catch (error) {
    console.error('Save private note error:', error);
    alert(error.message || '個人メモの保存に失敗しました');
    return false;
  }
}

async function deletePrivateNote(noteId) {
  const id = Number(noteId);
  if (!Number.isSafeInteger(id)) return;
  if (!confirm('この個人メモを削除しますか？')) return;
  try {
    const { error } = await sb.from('chat_private_notes').delete().eq('id', id);
    if (error) throw error;
    currentPrivateNotes = currentPrivateNotes.filter((n) => n.id !== id);
    renderMessageList();
  } catch (error) {
    console.error('Delete private note error:', error);
    alert(error.message || '個人メモの削除に失敗しました');
  }
}

function triggerMessageSearchFromLauncher() {
  closeSearchLauncher();
  const searchInput = $('talkSearch');
  if (searchInput) {
    if (talkTab !== 'all') {
      switchTalkTab('all');
    }
    searchInput.focus();
    searchInput.select();
  }
}

function triggerScheduleFromLauncher() {
  closeSearchLauncher();
  openReservationSchedule();
}

async function triggerMediaFromLauncher() {
  closeSearchLauncher();
  const group = myGroups.find((item) => Number(item.id) === Number(currentGroupId));
  if (!group || !roomHasStoreBot(group)) { showChatToast('店舗Botと連携したトークを開いてからメディアを表示してください。'); return; }
  const viewer = window.open('', '_blank');
  try {
    const { data } = await sb.auth.getSession();
    const token = String(data?.session?.access_token || '');
    const response = await fetch(CONFIG.adminApiUrl('/chat-media-link'), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: currentGroupId }) });
    const body = await response.json();
    if (!response.ok || !body.login_token) throw new Error(body.error || '閲覧リンクを作成できませんでした。');
    const target = new URL('https://marugo-s.github.io/line_report/media.html');
    target.searchParams.set('from', 'mtalk'); target.searchParams.set('lt', body.login_token);
    if (viewer) { viewer.opener = null; viewer.location.href = target.href; } else window.location.assign(target.href);
  } catch (error) { if (viewer) viewer.close(); showChatToast(error.message || 'メディアを開けませんでした。'); }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDateTimeLocalValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function defaultScheduleAt() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  date.setMinutes(Math.ceil(date.getMinutes() / 5) * 5);
  return date;
}

function formatScheduleAt(value) {
  const date = new Date(value);
  if (isNaN(date)) return '';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function showChatToast(message) {
  const toast = $('chatToast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showChatToast.timer);
  showChatToast.timer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

async function loadScheduledMessages() {
  const bar = $('scheduleBar');
  if (!currentGroupId || !currentUser || !canCurrentUserSend() || isGroupTrashed(findMineGroup(currentGroupId))) {
    scheduledMessages = [];
    if (bar) bar.classList.add('hidden');
    return;
  }
  try {
    const { data, error } = await sb
      .from('chat_scheduled_messages')
      .select('id, content, send_at, kind')
      .eq('group_id', currentGroupId)
      .eq('user_id', currentUser.id)
      .is('sent_at', null)
      .is('cancelled_at', null)
      .order('send_at', { ascending: true });
    if (error) throw error;
    scheduledMessages = data || [];
  } catch (error) {
    console.error('Load scheduled error:', error);
    scheduledMessages = [];
  }
  renderScheduleBar();
  renderSchedulePendingList();
}

function renderScheduleBar() {
  const bar = $('scheduleBar');
  const btn = document.querySelector('.schedule-btn');
  if (btn) btn.classList.toggle('active', scheduledMessages.length > 0);
  if (!bar) return;
  if (!scheduledMessages.length) {
    bar.classList.add('hidden');
    return;
  }
  const next = scheduledMessages[0];
  const more = scheduledMessages.length > 1 ? ` ほか${scheduledMessages.length - 1}件` : '';
  bar.innerHTML = `
    <span>予約 ${escapeHtml(formatScheduleAt(next.send_at))}${more}</span>
    <button type="button" onclick="openTextScheduleSend()">管理</button>
  `;
  bar.classList.remove('hidden');
}

function renderSchedulePendingList() {
  const list = $('schedulePendingList');
  if (!list) return;
  if (!scheduledMessages.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = `<div class="invite-label">このルームの予約</div>` + scheduledMessages.map((row) => `
    <div class="schedule-pending-item">
      <div>
        <div>${escapeHtml(formatScheduleAt(row.send_at))}</div>
        <div class="schedule-hint">${escapeHtml(
          row.kind === 'image'
            ? '[画像]'
            : row.kind === 'sticker'
            ? (row.content && row.content !== '[感情イラスト]' ? `[イラスト] ${row.content}` : '[感情イラスト]')
            : String(row.content || '').slice(0, 80)
        )}</div>
      </div>
      <button type="button" onclick="cancelScheduledMessage(${Number(row.id)})">取消</button>
    </div>
  `).join('');
}

function openTextScheduleSend() {
  pendingSendFiles = [];
  scheduleTarget = 'text';
  openScheduleSend();
}

function openScheduleSend() {
  if (!currentGroupId || !currentUser) return;
  if (!requireCurrentRoomSend()) return;
  if (isGroupTrashed(findMineGroup(currentGroupId))) {
    alert('ゴミ箱のルームには予約送信できません。復元してから使ってください。');
    return;
  }
  const input = $('scheduleAtInput');
  if (input) {
    const next = defaultScheduleAt();
    input.value = toDateTimeLocalValue(next);
    input.min = toDateTimeLocalValue(new Date(Date.now() + 30 * 1000));
  }
  const hint = document.querySelector('#scheduleOverlay .schedule-hint');
  if (hint) {
    if (scheduleTarget === 'files') {
      hint.textContent = '指定した日時になると、この画像が自動で送信されます。';
    } else if (pendingInlineSticker) {
      const hasText = Boolean(($('messageInput')?.value || '').trim());
      hint.textContent = hasText
        ? '指定した日時になると、メッセージと感情イラストが自動で送信されます。'
        : '指定した日時になると、感情イラストが自動で送信されます。';
    } else {
      hint.textContent = '指定した日時になると、このルームへ自動で送信されます。';
    }
  }
  renderSchedulePendingList();
  $('scheduleOverlay').classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeScheduleSend() {
  const overlay = $('scheduleOverlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.classList.remove('modal-open');
  pendingSendFiles = [];
  scheduleTarget = 'text';
}

async function confirmScheduleSend() {
  if (!currentGroupId || !currentUser) return;
  if (!requireCurrentRoomSend()) return;
  const raw = $('scheduleAtInput').value;
  const sendAt = raw ? new Date(raw) : null;
  if (!sendAt || isNaN(sendAt)) {
    alert('送信日時を指定してください');
    return;
  }
  if (sendAt.getTime() < Date.now() + 30 * 1000) {
    alert('送信日時は現在より後にしてください');
    return;
  }

  if (scheduleTarget === 'files') {
    const files = pendingSendFiles.slice();
    if (!files.length) {
      alert('予約する画像がありません');
      return;
    }
    try {
      for (const rawFile of files) {
        const file = await normalizeImageFile(rawFile);
        const image = await uploadChatImage(file, currentGroupId);
        const { error } = await sb.rpc('chat_schedule_message', {
          p_group_id: currentGroupId,
          p_content: '[画像]',
          p_send_at: sendAt.toISOString(),
          p_reply_to_id: replyTarget ? replyTarget.id : null,
          p_mentions: [],
          p_kind: 'image',
          p_payload: { v: 1, kind: 'image', image: { path: image.path, w: image.width, h: image.height } }
        });
        if (error) throw error;
      }
      pendingSendFiles = [];
      scheduleTarget = 'text';
      closeScheduleSend();
      await loadScheduledMessages();
      showChatToast(`${formatScheduleAt(sendAt)} に画像を予約しました`);
    } catch (error) {
      console.error('Schedule image error:', error);
      alert(error.message || '予約に失敗しました');
    }
    return;
  }

  const content = ($('messageInput').value || '').trim();
  const hasSticker = Boolean(pendingInlineSticker && pendingInlineSticker.id);

  if (!content && !hasSticker) {
    alert('メッセージを入力するか、感情イラストを選択してください');
    return;
  }
  try {
    let p_kind = 'text';
    let p_payload = null;
    let finalContent = content;

    if (hasSticker) {
      p_kind = 'sticker';
      const displayMode = content ? 'compact' : (stickerSendMode || 'large');
      p_payload = { v: 1, kind: 'sticker', sticker: { id: pendingInlineSticker.id, display: displayMode } };
      if (!finalContent) finalContent = '[感情イラスト]';
    }

    const { error } = await sb.rpc('chat_schedule_message', {
      p_group_id: currentGroupId,
      p_content: finalContent.slice(0, 2000),
      p_send_at: sendAt.toISOString(),
      p_reply_to_id: replyTarget ? replyTarget.id : null,
      p_mentions: collectMentions(content),
      p_kind: p_kind,
      p_payload: p_payload
    });
    if (error) throw error;
    $('messageInput').value = '';
    clearInlineSticker();
    resizeComposer();
    clearReplyTarget();
    closeScheduleSend();
    await loadScheduledMessages();
    const toastMsg = hasSticker && content
      ? `${formatScheduleAt(sendAt)} にメッセージとイラストを予約しました`
      : (hasSticker ? `${formatScheduleAt(sendAt)} にイラストを予約しました` : `${formatScheduleAt(sendAt)} に予約しました`);
    showChatToast(toastMsg);
  } catch (error) {
    console.error('Schedule send error:', error);
    alert(error.message || '予約に失敗しました');
  }
}

async function cancelScheduledMessage(id) {
  if (!confirm('この予約送信を取り消しますか？')) return;
  try {
    const { error } = await sb.rpc('chat_cancel_scheduled_message', { p_id: id });
    if (error) throw error;
    await loadScheduledMessages();
    showChatToast('予約を取り消しました');
  } catch (error) {
    console.error('Cancel scheduled error:', error);
    alert(error.message || '取消に失敗しました');
  }
}

function resizeComposer() {
  const input = $('messageInput');
  if (!input) return;
  const stickerButton = document.querySelector('#composerStickerBtn') || document.querySelector('.sticker-trigger-btn');
  const hasMessage = Boolean(input.value.trim()) || Boolean(pendingInlineSticker);
  stickerButton?.classList.toggle('message-ready', hasMessage);
  if (stickerButton) {
    stickerButton.title = hasMessage ? 'アイコンを文章内に入れる' : '感情イラスト';
    stickerButton.setAttribute('aria-label', stickerButton.title);
  }
  input.style.height = 'auto';
  let placeholderHeight = 40;
  if (!input.value && input.placeholder) {
    const style = getComputedStyle(input);
    const canvas = resizeComposer.canvas || (resizeComposer.canvas = document.createElement('canvas'));
    const context = canvas.getContext('2d');
    if (context) {
      context.font = style.font;
      const innerWidth = Math.max(1, input.clientWidth
        - parseFloat(style.paddingLeft || 0)
        - parseFloat(style.paddingRight || 0));
      const lineHeight = parseFloat(style.lineHeight) || 21;
      const verticalPadding = parseFloat(style.paddingTop || 0) + parseFloat(style.paddingBottom || 0);
      const placeholderLines = Math.max(1, Math.ceil(context.measureText(input.placeholder).width / innerWidth));
      placeholderHeight = Math.ceil(verticalPadding + (lineHeight * placeholderLines) + 2);
    }
  }
  input.style.height = `${Math.min(120, Math.max(40, input.scrollHeight, placeholderHeight))}px`;
  // 複数行入力や文章内アイコンのプレビュー解除で入力欄が縮んだ時も、
  // 固定入力欄用の予約高さをその場で更新する。
  syncChatViewport();
}

function composingKey(e) {
  return !!(e.isComposing || e.keyCode === 229);
}

function handleKeyPress(e) {
  // メンション候補が出ている間は、上下と Enter を候補選択に使う。
  if (mentionCandidates.length && !$('mentionPop').classList.contains('hidden')) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      mentionActiveIndex = (mentionActiveIndex + step + mentionCandidates.length) % mentionCandidates.length;
      updateMentionPicker();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      applyMention(mentionActiveIndex);
      return;
    }
    if (e.key === 'Escape') {
      $('mentionPop').classList.add('hidden');
      mentionCandidates = [];
      return;
    }
  }
  if (e.key === 'Escape' && replyTarget) {
    clearReplyTarget();
    return;
  }
  if (e.key === 'Escape' && editingMessage) {
    e.preventDefault();
    cancelMessageEdit();
    return;
  }
  // PC: Enter で送信、Shift+Enter で改行。スマホは送信ボタンがあるので Enter は改行。
  if (e.key === 'Enter' && !e.shiftKey && !composingKey(e) && !isMobileLayout()) {
    e.preventDefault();
    sendMessage();
  }
}

async function logout() {
  closeAccountMenu();
  closeTalkContextMenu();
  closeForward();
  closeOpenSwipe();
  if (channel) { await dropRealtimeChannel(channel); channel = null; }
  if (pushPreferenceChannel) { await dropRealtimeChannel(pushPreferenceChannel); pushPreferenceChannel = null; }
  if (pushSubscription) {
    const endpoint = pushSubscription.endpoint;
    try {
      await chatPushRequest('subscribe', { method: 'DELETE', body: { endpoint } });
    } catch (error) {
      console.error('Push sign out API cleanup error:', error);
    }
    try {
      await pushSubscription.unsubscribe();
    } catch (error) {
      console.error('Push sign out local cleanup error:', error);
    }
    pushSubscription = null;
  }
  await syncAppBadge(0);
  try {
    await sb.auth.signOut();
  } catch (error) {
    console.error('Sign out error:', error);
  }
  resetToLogin();
}

function resetToLogin() {
  if (chatAccessExpiryTimer) {
    clearTimeout(chatAccessExpiryTimer);
    chatAccessExpiryTimer = null;
  }
  currentUser = null;
  currentChatAccess = null;
  currentRoomMembership = null;
  currentGroupId = null;
  myGroups = [];
  otherGroups = [];
  unread = {};
  lastMessages = {};
  registeredUsers = [];
  selectedUserIds = new Set();
  seenMessageIds = new Set();
  pendingCredentials = null;
  pendingUserIconFile = null;
  pendingPresetUserIconUrl = '';
  pendingGroupIconFile = null;
  isSilentSendActive = false;
  isPrivateNoteMode = false;
  composerSheetOpen = false;
  pendingPrivateNoteContent = null;
  keepItems = [];
  albums = [];
  selectedAlbumId = null;
  albumItemsById = new Map();
  closeKeepMemo();
  closeAlbumManager();
  serviceWorkerRegistration = null;
  pushSubscription = null;
  pushPreferenceChannel = null;
  pushNotificationsEnabled = false;
  document.body.classList.remove('chat-open');
  $('loginScreen').classList.remove('hidden');
  $('profileForm').classList.add('hidden');
  $('signupForm').classList.add('hidden');
  $('chatAccessBlocked').classList.add('hidden');
  $('loginForm').classList.remove('hidden');
  $('navRail').classList.add('hidden');
  $('sidebar').classList.add('hidden');
  $('mainContent').classList.add('hidden');
  $('usernameInput').value = '';
  hideNotice();
  applySavedCredentials();
  updateTitle();
  renderNotificationStatus('disabled');
  syncAppBadge(0);
  syncComposerModeUi();
}

function applySavedCredentials() {
  const saved = loadSavedCredentials();
  if (saved) {
    $('emailInput').value = saved.email;
    $('passwordInput').value = saved.password || '';
    $('rememberInput').checked = true;
    $('loginBtn').focus();
  } else {
    $('passwordInput').value = '';
    $('rememberInput').checked = false;
    $('emailInput').focus();
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentUser) {
    if (currentGroupId) markGroupRead(currentGroupId);
    else loadUnread();
  }
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'REFRESH_APP_BADGE' && currentUser && !document.hidden) {
      if (currentGroupId) markGroupRead(currentGroupId);
      else loadUnread();
    }
    if (event.data?.type === 'FLUSH_PUSH_DIAGNOSTICS' && currentUser) {
      flushPushDiagnostics();
    }
  });
  // 新しいService Workerが有効化されたら、古い画面を1回だけ自動再読込する。
  // iOSのホーム画面アプリは開いたままだと旧UIが残り、通知テストボタン等の
  // 新機能が出ないため。無限リロードを防ぐため sessionStorage で1回に限定する。
  let swReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swReloaded) return;
    swReloaded = true;
    try {
      if (sessionStorage.getItem('mtalk-sw-reloaded') === '1') return;
      sessionStorage.setItem('mtalk-sw-reloaded', '1');
    } catch (_) { /* storage不可でも続行 */ }
    location.reload();
  });
  // 復帰時に新しいService Workerの取得を促す。
  const checkForServiceWorkerUpdate = () => {
    navigator.serviceWorker.getRegistration().then((registration) => {
      if (!registration) return;
      registration.update().catch(() => {});
      const waiting = registration.waiting;
      if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
    }).catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkForServiceWorkerUpdate();
  });
  checkForServiceWorkerUpdate();
  flushPushDiagnostics();
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => syncChatViewport());
  window.visualViewport.addEventListener('scroll', () => syncChatViewport());
}
window.addEventListener('resize', () => {
  resizeComposer();
  syncChatViewport();
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => syncChatViewport(), 100);
});
if (window.ResizeObserver && $('inputArea')) {
  composerResizeObserver = new ResizeObserver(() => syncChatViewport());
  composerResizeObserver.observe($('inputArea'));
}
document.addEventListener('gesturestart', preventMobileZoomGesture, { passive: false });
document.addEventListener('gesturechange', preventMobileZoomGesture, { passive: false });
document.addEventListener('gestureend', preventMobileZoomGesture, { passive: false });
document.addEventListener('touchmove', preventMobileZoomGesture, { passive: false });
