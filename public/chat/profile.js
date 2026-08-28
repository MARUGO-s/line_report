'use strict';

async function afterSignIn() {
  const { data: userData, error: userError } = await sb.auth.getUser();
  if (userError || !userData?.user) {
    await sb.auth.signOut();
    resetToLogin();
    return;
  }

  const { data, error } = await sb
    .from('chat_users')
    .select(CHAT_USER_COLUMNS)
    .eq('id', userData.user.id)
    .maybeSingle();

  if (error) {
    console.error('Profile load error:', error);
    showLoginError(`プロフィールの取得に失敗しました: ${error.message}`);
    return;
  }

  if (!data) {
    $('loginForm').classList.add('hidden');
    $('signupForm').classList.add('hidden');
    $('profileForm').classList.remove('hidden');
    renderStorePicker('profileStorePick', []);
    $('usernameInput').focus();
    return;
  }

  currentUser = data;
  try {
    await loadCurrentChatAccess();
  } catch (accessError) {
    console.error('M-talk access load error:', accessError);
    showLoginError(`M-talk利用状態の取得に失敗しました: ${accessError.message || accessError}`);
    return;
  }
  if (chatAccessIsBlocked(currentChatAccess)) {
    showChatAccessBlocked();
    subscribeRealtime();
    return;
  }
  startSession();
}

function listKnownStores() {
  const pages = window.LINE_REPORT_PAGES || {};
  if (typeof pages.listStores === 'function') return pages.listStores();
  return Object.entries(pages.STORE_NAMES || {}).map(([store_key, store_name]) => ({
    store_key,
    store_name
  }));
}

function storeDisplayLabel(storeKey) {
  const pages = window.LINE_REPORT_PAGES || {};
  if (typeof pages.getPreferredStoreDisplayLabel === 'function') {
    return pages.getPreferredStoreDisplayLabel(storeKey) || storeKey;
  }
  return (pages.STORE_NAMES && pages.STORE_NAMES[storeKey]) || storeKey;
}

function formatStoreLabels(keys) {
  return (keys || []).map((key) => storeDisplayLabel(key)).filter(Boolean).join('、');
}

function renderStorePicker(containerId, selectedKeys) {
  const el = $(containerId);
  if (!el) return;
  const selected = new Set((selectedKeys || []).map((key) => String(key)));
  el.innerHTML = listKnownStores().map((store) => {
    const key = String(store.store_key || '');
    if (!key) return '';
    const checked = selected.has(key) ? ' checked' : '';
    return `<label class="store-pick-item"><input type="checkbox" value="${escapeHtml(key)}"${checked}><span>${escapeHtml(storeDisplayLabel(key))}</span></label>`;
  }).join('');
}

function selectedStoreKeys(containerId) {
  return [...($(containerId)?.querySelectorAll('input[type="checkbox"]:checked') || [])]
    .map((input) => String(input.value || '').trim())
    .filter(Boolean);
}

function myStoreKeys() {
  return (currentUser && userStoreKeysById[currentUser.id]) || [];
}

function sharesAffiliationWith(user) {
  if (!user || !currentUser || user.id === currentUser.id) return false;
  const mine = myStoreKeys();
  if (!mine.length) return false;
  if (isStoreBot(user)) return mine.includes(user.store_key);
  if (isBotUser(user)) return false;
  const theirs = userStoreKeysById[user.id] || [];
  return mine.some((key) => theirs.includes(key));
}

async function loadUserStores() {
  if (!currentUser) {
    userStoreKeysById = {};
    return;
  }
  const { data, error } = await sb.from('chat_user_stores').select('user_id, store_key');
  if (error) throw error;
  const next = {};
  (data || []).forEach((row) => {
    const id = String(row.user_id || '');
    const key = String(row.store_key || '');
    if (!id || !key) return;
    if (!next[id]) next[id] = [];
    if (!next[id].includes(key)) next[id].push(key);
  });
  userStoreKeysById = next;
}

async function loadPendingStoreRequest() {
  if (!currentUser) {
    pendingStoreRequest = null;
    return;
  }
  const { data, error } = await sb
    .from('chat_store_change_requests')
    .select('id, kind, requested_store_keys, current_store_keys, status, created_at')
    .eq('user_id', currentUser.id)
    .eq('status', 'pending')
    .maybeSingle();
  if (error) throw error;
  pendingStoreRequest = data || null;
}

async function createProfile() {
  const username = $('usernameInput').value.trim();
  if (!username) return showLoginError('表示名を入力してください');
  const storeKeys = selectedStoreKeys('profileStorePick');
  if (!storeKeys.length) return showLoginError('所属店舗を1つ以上選んでください');

  $('profileBtn').disabled = true;
  try {
    const { data: sessionData } = await sb.auth.getSession();
    const uid = sessionData?.session?.user?.id;
    if (!uid) {
      showLoginError('セッションが切れました。もう一度ログインしてください');
      return;
    }

    let iconUrl = pendingPresetUserIconUrl || null;
    if (pendingUserIconFile) {
      try {
        iconUrl = await uploadIcon(`users/${uid}`, pendingUserIconFile);
      } catch (iconError) {
        console.error('Profile icon error:', iconError);
      }
      pendingUserIconFile = null;
      pendingPresetUserIconUrl = iconUrl || '';
    }

    const { data, error } = await sb.rpc('chat_complete_signup', {
      p_username: username,
      p_store_keys: storeKeys,
      p_icon_url: iconUrl
    });

    if (error) {
      if (/許可されていません/.test(error.message)) {
        showLoginError('このアカウントはチャットの利用を許可されていません。管理者にご連絡ください');
      } else if (/duplicate|unique/i.test(error.message)) {
        showLoginError('その表示名は既に使われています');
      } else {
        showLoginError(`登録に失敗しました: ${error.message}`);
      }
      return;
    }

    currentUser = Array.isArray(data) ? data[0] : data;
    pendingUserIconFile = null;
    pendingPresetUserIconUrl = '';

    if (pendingCredentials && pendingCredentials.remember) {
      saveCredentials(pendingCredentials.email);
    }
    pendingCredentials = null;

    $('profileForm').classList.add('hidden');
    $('loginForm').classList.remove('hidden');
    await loadCurrentChatAccess();
    if (chatAccessIsBlocked(currentChatAccess)) {
      showChatAccessBlocked();
      subscribeRealtime();
      return;
    }
    startSession();
  } finally {
    $('profileBtn').disabled = false;
  }
}

function startSession() {
  renderUserAvatars();
  hideChatAccessBlocked();
  $('loginScreen').classList.add('hidden');
  $('navRail').classList.remove('hidden');
  $('sidebar').classList.remove('hidden');
  $('mainContent').classList.remove('hidden');
  subscribeRealtime();
  loadUserStores().catch((error) => console.error('Load stores error:', error));
  loadPendingStoreRequest().catch((error) => console.error('Load store request error:', error));
  initializeChatPwa();
  warmImageAssets();
  void flushPushDiagnostics();
  void resumePendingPushTest();
  syncGlobalCapabilityUi();
  loadGroups().then(async () => {
    await consumeInvite();
    await openRequestedGroup();
  });
}

function showLoginError(message) {
  const error = $('loginError');
  error.textContent = message;
  error.classList.remove('hidden');
  setTimeout(() => error.classList.add('hidden'), 6000);
}

function showNotice(message) {
  const notice = $('loginNotice');
  notice.textContent = message;
  notice.classList.remove('hidden');
}

function hideNotice() {
  $('loginNotice').classList.add('hidden');
}
