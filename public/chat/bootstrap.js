'use strict';

function formatTalkTime(value) {
  const d = new Date(value);
  if (isNaN(d)) return '';
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diffDays === 0) {
    const hour = d.getHours();
    const minute = String(d.getMinutes()).padStart(2, '0');
    const suffix = hour < 12 ? '午前' : '午後';
    const h12 = hour % 12 || 12;
    return `${suffix} ${h12}:${minute}`;
  }
  if (diffDays === 1) return '昨日';
  if (diffDays < 7) return d.toLocaleDateString('ja-JP', { weekday: 'short' });
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatTime(value) {
  const d = new Date(value);
  return isNaN(d) ? '' : d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

$('emailInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') $('passwordInput').focus(); });
$('passwordInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') login(); });
$('signupEmailInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') $('signupPasswordInput').focus(); });
$('signupPasswordInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') $('signupPasswordConfirm').focus(); });
$('signupPasswordConfirm').addEventListener('keypress', (e) => { if (e.key === 'Enter') signup(); });
$('usernameInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') createProfile(); });
$('newGroupInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') createGroup(); });
$('messageInput').addEventListener('focus', () => {
  syncChatViewport(true);
  setTimeout(() => syncChatViewport(true), 180);
});

$('userIconInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const prepared = await prepareIconFile(file);
    pendingPresetUserIconUrl = '';
    if (currentUser) {
      await saveUserIcon(prepared);
    } else {
      pendingUserIconFile = prepared;
      previewLocalIcon($('profileIconPreview'), prepared, 'icon');
    }
  } catch (error) {
    alert(error.message || error);
  }
});

$('groupIconInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !currentGroupId) return;
  try {
    await saveGroupIcon(currentGroupId, file);
  } catch (error) {
    alert(error.message || `アイコンの保存に失敗しました: ${error.message || error}`);
  }
});

$('newGroupIconInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const prepared = await prepareIconFile(file);
    pendingGroupIconFile = prepared;
    previewLocalIcon($('newGroupIconPreview'), prepared, 'icon');
  } catch (error) {
    alert(error.message || error);
  }
});

$('chatImageInput').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (isJournalArchiveFile(file)) {
    if (currentRoomAcceptsJournalArchive()) sendChatFile(file);
    else promptJournalArchive();
    return;
  }
  if (!isSupportedChatFile(file)) { showChatToast('対応形式または容量上限（10MB）を確認してください'); return; }
  askSendModeForFiles([file]);
});

document.addEventListener('dragenter', (e) => {
  if (!currentGroupId || !canCurrentUserSend() || !isFileDrag(e)) return;
  e.preventDefault();
  setChatDropActive(true);
});
document.addEventListener('dragover', (e) => {
  if (!currentGroupId || !canCurrentUserSend() || !isFileDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  setChatDropActive(true);
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget && document.body.contains(e.relatedTarget)) return;
  setChatDropActive(false);
});
document.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  setChatDropActive(false);
  if (!currentGroupId || !canCurrentUserSend()) return;
  const dropped = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  const files = chatFilesFromList(dropped);
  // 混在で落とされたときも、落ちた .lzh を黙って捨てない。
  const journalFiles = dropped.filter(isJournalArchiveFile);
  if (journalFiles.length) {
    if (currentRoomAcceptsJournalArchive()) {
      // このルームの店舗として電子ジャーナルへ取り込む。
      for (const file of journalFiles) sendChatFile(file);
    } else {
      promptJournalArchive();
    }
    if (files.length) askSendModeForFiles(files);
    return;
  }
  if (!files.length) {
    showChatToast('画像・PDF・Office・CSV・ZIP（10MB以内）をドロップしてください');
    return;
  }
  askSendModeForFiles(files);
});
document.addEventListener('dragend', () => setChatDropActive(false));

$('messageInput').addEventListener('paste', (e) => {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const imageItem = items.find((item) => item.type && item.type.startsWith('image/'));
  if (!imageItem) return;
  const file = imageItem.getAsFile();
  if (!file || !currentGroupId || !canCurrentUserSend()) return;
  e.preventDefault();
  askSendModeForFiles([file]);
});

$('messages').addEventListener('scroll', handleMessagesScroll, { passive: true });

$('messages').addEventListener('click', (e) => {
  if (!e.target.closest) return;

  const deleteNote = e.target.closest('[data-delete-note]');
  if (deleteNote) { deletePrivateNote(deleteNote.dataset.deleteNote); return; }

  // 画像はクリックで拡大。署名URLは hydrate 済みの src をそのまま使う。
  const commandBtn = e.target.closest('[data-card-command]');
  if (commandBtn) {
    sendCardCommand(commandBtn.getAttribute('data-card-command'));
    return;
  }

  const cardLink = e.target.closest('a.msg-card-action[href]');
  if (cardLink) {
    try {
      const url = new URL(cardLink.getAttribute('href'), window.location.href);
      const path = url.pathname.replace(/\/+$/, '');
      if (path.endsWith('/mtalk_schedule.html') || path.endsWith('mtalk_schedule.html')) {
        const id = Number(url.searchParams.get('group_id') || url.searchParams.get('group') || '');
        if (Number.isSafeInteger(id) && id > 0) {
          e.preventDefault();
          openReservationSchedule(id, url.searchParams.get('tab'));
          return;
        }
      }
    } catch (_err) { /* 通常のリンクとして開く */ }
  }

  const img = e.target.closest('img.msg-image');
  if (img && img.src) { openImageViewer(img.src); return; }

  const chip = e.target.closest('.reaction-chip');
  if (chip) { openReactionDetails(Number(chip.dataset.messageId)); return; }

  const readMark = e.target.closest('.read-mark');
  if (readMark) { openReadDetails(Number(readMark.dataset.readFor)); return; }

  const menuBtn = e.target.closest('[data-menu-for]');
  if (menuBtn) { openMessageMenu(menuBtn.dataset.menuFor, menuBtn); return; }

  const quote = e.target.closest('[data-jump-to]');
  if (quote) jumpToLoadedMessage(Number(quote.dataset.jumpTo));
});

// メニューの外側を触ったら閉じる。
document.addEventListener('click', (e) => {
  if (!e.target.closest) return;
  if (e.target.closest('.msg-menu') || e.target.closest('[data-menu-for]')) return;
  closeMessageMenu();
});
document.addEventListener('click', (e) => {
  if (!composerSheetOpen || !e.target.closest) return;
  if (e.target.closest('#composerSheet, #composerPlusBtn')) return;
  closeComposerSheet();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest) return;
  const picker = $('stickerPicker');
  if (!picker || picker.classList.contains('hidden')) return;
  if (e.target.closest('#stickerPicker, #composerStickerBtn, #composerSheet')) return;
  picker.classList.add('hidden');
});
$('messages').addEventListener('scroll', closeMessageMenu, { passive: true });

$('stickerPicker').addEventListener('click', (e) => {
  const mode = e.target.closest('[data-sticker-mode]');
  if (mode) {
    stickerSendMode = mode.dataset.stickerMode === 'compact' ? 'compact' : 'large';
    renderStickerPicker();
    return;
  }
  const category = e.target.closest('[data-sticker-category]');
  if (category) {
    activeStickerCategory = category.dataset.stickerCategory;
    renderStickerPicker();
    return;
  }
  const button = e.target.closest('[data-sticker-id]');
  if (button) handleStickerSelection(button.dataset.stickerId);
});
const switchStickerCategoryBySwipe = (dx, dy) => {
  if (Math.abs(dx) < 45 || Math.abs(dx) <= Math.abs(dy)) return;
  const currentIndex = STICKER_CATEGORIES.findIndex((category) => category.id === activeStickerCategory);
  if (currentIndex < 0) return;
  // 右スワイプで次のカテゴリ（感情→漫符・記号）、左スワイプで戻る。
  const nextIndex = dx > 0
    ? Math.min(STICKER_CATEGORIES.length - 1, currentIndex + 1)
    : Math.max(0, currentIndex - 1);
  if (nextIndex === currentIndex) return;
  activeStickerCategory = STICKER_CATEGORIES[nextIndex].id;
  renderStickerPicker();
};
let stickerSwipeStart = null;
$('stickerPicker').addEventListener('touchstart', (e) => {
  const touch = e.touches && e.touches[0];
  if (!touch) return;
  stickerSwipeStart = { x: touch.clientX, y: touch.clientY };
}, { passive: true });
$('stickerPicker').addEventListener('touchend', (e) => {
  if (!stickerSwipeStart) return;
  const touch = e.changedTouches && e.changedTouches[0];
  const start = stickerSwipeStart;
  stickerSwipeStart = null;
  if (!touch) return;
  const dx = touch.clientX - start.x;
  const dy = touch.clientY - start.y;
  switchStickerCategoryBySwipe(dx, dy);
}, { passive: true });
let stickerMouseStart = null;
$('stickerPicker').addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  stickerMouseStart = { x: e.clientX, y: e.clientY };
});
window.addEventListener('mouseup', (e) => {
  if (!stickerMouseStart) return;
  const start = stickerMouseStart;
  stickerMouseStart = null;
  switchStickerCategoryBySwipe(e.clientX - start.x, e.clientY - start.y);
});
$('stickerPicker').addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaX) < 20 || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  e.preventDefault();
  switchStickerCategoryBySwipe(e.deltaX, e.deltaY);
}, { passive: false });

// メンション候補
$('messageInput').addEventListener('input', () => {
  updateMentionPicker();
  resizeComposer();
  syncComposerModeUi();
});
$('messageInput').addEventListener('blur', () => {
  // 候補のクリックが先に走るよう、閉じるのを少し遅らせる。
  setTimeout(() => $('mentionPop').classList.add('hidden'), 150);
});
syncComposerModeUi();
$('mentionPop').addEventListener('mousedown', (e) => {
  const row = e.target.closest('.mention-row');
  if (!row) return;
  e.preventDefault();
  applyMention(Number(row.dataset.index));
});

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeTalkContextMenu();
      closeForward();
      closeComposerSheet();
      $('stickerPicker')?.classList.add('hidden');
  closeOpenSwipe();
  closeScheduleSend();
  closeSendMode();
  if (editingMessage) cancelMessageEdit();
});
document.querySelector('.groups-scroll').addEventListener('scroll', () => {
  closeTalkContextMenu();
  closeOpenSwipe();
}, { passive: true });

$('talkCtxPin').onclick = () => {
  if (!talkMenuGroup) return;
  const group = talkMenuGroup;
  runTalkAction(() => setTalkPinned(group, !group.pinned_at));
};
$('talkCtxMute').onclick = () => {
  if (!talkMenuGroup) return;
  const group = talkMenuGroup;
  runTalkAction(() => setTalkMuted(group, !group.muted_at));
};
$('talkCtxSettings').onclick = () => {
  if (!talkMenuGroup) return;
  openRoomSettings(talkMenuGroup.id);
};
$('talkCtxHide').onclick = () => {
  if (!talkMenuGroup) return;
  const group = talkMenuGroup;
  runTalkAction(() => setTalkHidden(group, true));
};
$('talkCtxDelete').onclick = () => {
  if (!talkMenuGroup) return;
  const group = talkMenuGroup;
  runTalkAction(() => leaveTalk(group));
};
$('talkCtxTrash').onclick = () => {
  if (!talkMenuGroup) return;
  const group = talkMenuGroup;
  runTalkAction(() => trashTalk(group));
};
$('talkCtxRestore').onclick = () => {
  if (!talkMenuGroup) return;
  const group = talkMenuGroup;
  runTalkAction(() => restoreTalk(group));
};
$('talkCtxPurge').onclick = () => {
  if (!talkMenuGroup) return;
  const group = talkMenuGroup;
  runTalkAction(() => purgeTalk(group));
};
if ($('trashBannerRestore')) {
  $('trashBannerRestore').onclick = () => {
    const group = findMineGroup(currentGroupId);
    if (!group) return;
    runTalkAction(() => restoreTalk(group));
  };
}
if ($('trashBannerPurge')) {
  $('trashBannerPurge').onclick = () => {
    const group = findMineGroup(currentGroupId);
    if (!group) return;
    runTalkAction(() => purgeTalk(group));
  };
};

$('rememberInput').addEventListener('change', (e) => {
  if (!e.target.checked) clearCredentials();
});
$('signupRememberInput').addEventListener('change', (e) => {
  if (!e.target.checked) clearCredentials();
});

sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    if (channel) { sb.removeChannel(channel); channel = null; }
    resetToLogin();
  }
});

captureInviteFromUrl();
captureRequestedGroup();
syncChatViewport();
ensureChatServiceWorker();

function consumeAuthRedirectUrl() {
  const hash = String(location.hash || '');
  const params = new URLSearchParams(location.search);
  const fromHash = /access_token=|refresh_token=|type=signup|type=recovery|type=magiclink/.test(hash);
  const fromCode = params.has('code');
  if (!fromHash && !fromCode) return false;
  const url = new URL(location.href);
  url.hash = '';
  if (fromCode) url.searchParams.delete('code');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  return true;
}

(async () => {
  const pendingAuthLink = /access_token=|refresh_token=|type=signup|type=recovery|type=magiclink/.test(String(location.hash || ''))
    || new URLSearchParams(location.search).has('code');
  const { data } = await sb.auth.getSession();
  const fromAuthLink = consumeAuthRedirectUrl() || pendingAuthLink;
  if (data?.session) {
    if (fromAuthLink) showNotice('メールアドレスの確認が完了しました。');
    await afterSignIn();
  } else {
    applySavedCredentials();
    try {
      if (sessionStorage.getItem(INVITE_KEY)) {
        showNotice('ログインまたは新規登録すると、招待されたトークに参加できます。');
      }
    } catch (_) {}
  }
})();
