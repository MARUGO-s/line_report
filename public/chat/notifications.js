'use strict';

function pushFunctionUrl(action) {
  const suffix = action ? `?action=${encodeURIComponent(action)}` : '';
  return `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/chat-push${suffix}`;
}

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent || '');
}

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function chatPushManager(registration) {
  if (window.pushManager) return window.pushManager;
  return registration?.pushManager || null;
}

async function chatPushRequest(action, options = {}) {
  const { data } = await sb.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('ログインが必要です');
  const response = await fetch(pushFunctionUrl(action), {
    method: options.method || 'POST',
    keepalive: options.keepalive === true,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: options.body == null ? undefined : JSON.stringify(options.body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ok === false) {
    throw new Error(result?.error || `通知API HTTP ${response.status}`);
  }
  return result;
}

async function initializeChatPwa() {
  serviceWorkerRegistration = await ensureChatServiceWorker();
  if (!serviceWorkerRegistration || !('PushManager' in window) || !('Notification' in window)) {
    renderNotificationStatus('unsupported');
    return;
  }
  try {
    if (Notification.permission === 'denied') {
      renderNotificationStatus('blocked');
      hidePushRestoreBar();
      return;
    }
    pushSubscription = await chatPushManager(serviceWorkerRegistration)?.getSubscription();
    if (!(currentUser && Notification.permission === 'granted')) {
      renderNotificationStatus(pushSubscription ? 'enabled' : 'disabled');
      hidePushRestoreBar();
      return;
    }
    let wantsPush = false;
    try {
      const prefs = await chatPushRequest('preferences', { body: {} });
      wantsPush = prefs.found === true && prefs.notifications_enabled === true;
    } catch (error) {
      console.error('Push preference restore error:', error);
      wantsPush = !!pushSubscription;
    }
    if (!wantsPush) {
      pushNotificationsEnabled = false;
      renderNotificationStatus('disabled');
      hidePushRestoreBar();
      return;
    }
    if (!pushSubscription) {
      renderNotificationStatus('needs-restore');
      showPushRestoreBar();
      return;
    }
    await savePushSubscription(pushSubscription, true).catch((error) => {
      console.error('Push subscription refresh error:', error);
    });
    await subscribePushPreferenceChanges().catch((error) => {
      console.error('Push preference realtime error:', error);
    });
    await syncPushPreference();
    hidePushRestoreBar();
  } catch (error) {
    console.error('Service worker registration error:', error);
    renderNotificationStatus('needs-restore');
    showPushRestoreBar();
  }
}

function ensureChatServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  if (!serviceWorkerPromise) {
    serviceWorkerPromise = navigator.serviceWorker.register('chat-sw.js', { scope: './' })
      .then(async (registration) => {
        const pending = registration.installing || registration.waiting;
        if (pending && pending.state !== 'activated') {
          await new Promise((resolve) => {
            const done = () => resolve();
            pending.addEventListener('statechange', () => {
              if (pending.state === 'activated' || pending.state === 'redundant') done();
            });
            setTimeout(done, 4000);
          });
        }
        return registration.active ? registration : navigator.serviceWorker.ready;
      })
      .catch((error) => {
        console.error('Service worker registration error:', error);
        serviceWorkerPromise = null;
        return null;
      });
  }
  return serviceWorkerPromise;
}

function showPushRestoreBar() {
  const bar = $('pushRestoreBar');
  if (bar) bar.classList.remove('hidden');
}

function hidePushRestoreBar() {
  const bar = $('pushRestoreBar');
  if (bar) bar.classList.add('hidden');
}

async function repairPushSubscription() {
  if (pushRepairing) return pushSubscription;
  if (isIosDevice() && !isStandaloneApp()) {
    throw new Error('iPhone／iPadでは、ホーム画面のM-talkから開いて通知を再開してください。');
  }
  pushRepairing = true;
  try {
    serviceWorkerRegistration = await ensureChatServiceWorker();
    if (!serviceWorkerRegistration || !('PushManager' in window)) {
      throw new Error('この端末では通知を利用できません');
    }
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('通知は許可されませんでした。端末の設定から変更できます。');
    }
    const manager = chatPushManager(serviceWorkerRegistration);
    if (!manager) throw new Error('この端末では通知を利用できません');
    const existing = await manager.getSubscription();
    if (existing) {
      await chatPushRequest('subscribe', {
        method: 'DELETE',
        body: { endpoint: existing.endpoint }
      }).catch((error) => {
        console.error('Push old subscription cleanup error:', error);
      });
      try { await existing.unsubscribe(); } catch (_) { /* 古い購読は破棄して作り直す */ }
    }
    pushSubscription = await manager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(CHAT_PUSH_PUBLIC_KEY)
    });
    await savePushSubscription(pushSubscription, true);
    pushNotificationsEnabled = true;
    await subscribePushPreferenceChanges().catch((error) => {
      console.error('Push preference realtime error:', error);
    });
    renderNotificationStatus('enabled');
    hidePushRestoreBar();
    await syncAppBadge();
    return pushSubscription;
  } finally {
    pushRepairing = false;
  }
}

async function repairPushSubscriptionFromBar() {
  renderNotificationStatus('working');
  try {
    await repairPushSubscription();
    alert('通知を再開しました。新しいトークが来ると届きます。');
  } catch (error) {
    console.error('Push repair error:', error);
    renderNotificationStatus(Notification.permission === 'denied' ? 'blocked' : 'needs-restore');
    if (Notification.permission !== 'denied') showPushRestoreBar();
    alert(error.message || '通知の再開に失敗しました');
  }
}

function renderNotificationStatus(status) {
  const states = {
    enabled: ['🔔', '通知はオンです。押すとオフにできます'],
    working: ['…', '通知を設定しています'],
    blocked: ['🚫', 'ブラウザまたは端末の設定で通知を許可してください'],
    unsupported: ['—', 'このブラウザでは通知を利用できません'],
    'needs-restore': ['🔕', '通知が切れたのでタップして再開'],
    disabled: ['🔕', '新着通知をオンにする']
  };
  const view = states[status] || states.disabled;
  document.querySelectorAll('[data-notification-toggle]').forEach((button) => {
    button.classList.toggle('enabled', status === 'enabled');
    button.classList.toggle('blocked', status === 'blocked');
    button.classList.toggle('needs-restore', status === 'needs-restore');
    button.disabled = status === 'working';
    const icon = button.querySelector('.notification-icon');
    if (icon) icon.textContent = view[0];
    button.title = view[1];
    button.setAttribute('aria-label', view[1]);
  });
  document.querySelectorAll('[data-push-test]').forEach((button) => {
    button.classList.toggle('hidden', status !== 'enabled');
    button.disabled = status === 'working' || pushTesting;
  });
}

function unreadTotal() {
  return Object.values(unread).reduce((sum, value) => {
    const count = Number(value);
    return sum + (Number.isSafeInteger(count) && count > 0 ? count : 0);
  }, 0);
}

async function syncAppBadge(total = pushNotificationsEnabled ? unreadTotal() : 0) {
  const count = Number(total);
  const badgeCount = Number.isSafeInteger(count) && count > 0 ? count : 0;
  try {
    if (badgeCount > 0 && 'setAppBadge' in navigator) {
      await navigator.setAppBadge(badgeCount);
      return;
    }
    if (badgeCount === 0 && 'clearAppBadge' in navigator) {
      await navigator.clearAppBadge();
      return;
    }
    const registration = serviceWorkerRegistration || await ensureChatServiceWorker();
    const worker = registration?.active || registration?.waiting || registration?.installing;
    if (worker) worker.postMessage({ type: 'SET_APP_BADGE', count: badgeCount });
  } catch (error) {
    // Badging API非対応でもトーク・Web Push本体は継続する。
    console.error('App badge sync error:', error);
  }
}

async function savePushSubscription(subscription, activate) {
  return chatPushRequest('subscribe', {
    body: {
      subscription: subscription.toJSON(),
      preview_enabled: true,
      activate: activate === true
    }
  });
}

async function sendPushTest(options = {}) {
  if (pushTesting) return;
  pushTesting = true;
  renderNotificationStatus('working');
  try {
    serviceWorkerRegistration = await ensureChatServiceWorker();
    pushSubscription = await chatPushManager(serviceWorkerRegistration)?.getSubscription();
    if (!pushSubscription || Notification.permission !== 'granted') {
      throw new Error('この端末の通知登録がありません。ベルを押して通知を再設定してください。');
    }
    await savePushSubscription(pushSubscription, true);
    const testId = randomUuid();
    try {
      localStorage.setItem(PUSH_TEST_PENDING_KEY, JSON.stringify({
        test_id: testId,
        created_at: Date.now()
      }));
    } catch (_) {}
    const result = await chatPushRequest('test', {
      body: {
        endpoint: pushSubscription.endpoint,
        test_id: testId,
        delay_ms: 4000,
        client_state: {
          permission: Notification.permission,
          standalone: isStandaloneApp(),
          controller: !!navigator.serviceWorker.controller,
          visibility: document.visibilityState,
          push_manager: 'PushManager' in window
        }
      },
      keepalive: true
    });
    if (result.ok !== true || Number(result.failed) !== 0) {
      throw new Error('テスト通知を予約できませんでした。通知を再設定してください。');
    }
    showChatToast('4秒後にこの端末へ通知を送ります。今すぐホーム画面へ戻ってください');
    pushNotificationsEnabled = true;
    renderNotificationStatus('enabled');
    void flushPushDiagnostics();
    void pollPushDiagnosticStatus(result.test_id || testId);
    if (!options.silentSuccess) {
      showChatToast('テスト通知を送信しました。届かなければM-talkを開き直すと診断結果を確認できます');
    }
  } catch (error) {
    try { localStorage.removeItem(PUSH_TEST_PENDING_KEY); } catch (_) {}
    console.error('Push test error:', error);
    renderNotificationStatus(Notification.permission === 'denied' ? 'blocked' : 'needs-restore');
    if (Notification.permission !== 'denied') showPushRestoreBar();
    if (!options.silentFailure) alert(error.message || 'テスト通知に失敗しました');
    throw error;
  } finally {
    pushTesting = false;
    document.querySelectorAll('[data-push-test]').forEach((button) => {
      button.disabled = false;
    });
  }
}

async function flushPushDiagnostics() {
  if (!currentUser || !('caches' in window)) return;
  try {
    const cache = await caches.open('line-report-chat-push-diagnostics');
    const requests = await cache.keys();
    for (const request of requests) {
      const response = await cache.match(request);
      if (!response) continue;
      const row = await response.json().catch(() => null);
      if (!row?.test_id || !row?.stage) {
        await cache.delete(request);
        continue;
      }
      try {
        await chatPushRequest('diagnostic', {
          body: {
            test_id: row.test_id,
            stage: row.stage,
            detail: row.detail || null
          }
        });
        await cache.delete(request);
      } catch (error) {
        console.error('Push diagnostic upload error:', error);
      }
    }
  } catch (error) {
    console.error('Push diagnostic flush error:', error);
  }
}

async function pollPushDiagnosticStatus(testId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1200 : 1800));
    await flushPushDiagnostics();
    try {
      const result = await chatPushRequest('diagnostic-status', { body: { test_id: testId } });
      const stages = new Set((result.events || []).map((row) => row.stage));
      if (stages.has('server_failed')) {
        const failed = (result.events || []).find((row) => row.stage === 'server_failed');
        alert(`Apple Pushへの送信に失敗しました。${failed?.detail ? `\n${failed.detail}` : ''}`);
        try { localStorage.removeItem(PUSH_TEST_PENDING_KEY); } catch (_) {}
        return;
      }
      if (stages.has('notification_failed')) {
        const failed = (result.events || []).find((row) => row.stage === 'notification_failed');
        alert(`iPhoneはPushを受信しましたが、通知表示に失敗しました。${failed?.detail ? `\n${failed.detail}` : ''}`);
        try { localStorage.removeItem(PUSH_TEST_PENDING_KEY); } catch (_) {}
        return;
      }
      if (stages.has('notification_shown')) {
        const registration = serviceWorkerRegistration || await ensureChatServiceWorker();
        const listed = registration && 'getNotifications' in registration
          ? await registration.getNotifications({ tag: `chat-push-test-${testId}` }).catch(() => [])
          : [];
        showChatToast(
          listed.length
            ? 'iPhoneの通知センターへ登録済みです'
            : 'iPhoneで通知表示処理まで成功しました',
        );
        try { localStorage.removeItem(PUSH_TEST_PENDING_KEY); } catch (_) {}
        return;
      }
    } catch (error) {
      console.error('Push diagnostic status error:', error);
    }
  }
  showChatToast('Apple送信済みですが、Service Worker受信記録がありません。M-talkを開き直してください');
  try { localStorage.removeItem(PUSH_TEST_PENDING_KEY); } catch (_) {}
}

async function resumePendingPushTest() {
  let row = null;
  try {
    row = JSON.parse(localStorage.getItem(PUSH_TEST_PENDING_KEY) || 'null');
  } catch (_) {
    try { localStorage.removeItem(PUSH_TEST_PENDING_KEY); } catch (_) {}
  }
  const testId = String(row?.test_id || '');
  const createdAt = Number(row?.created_at);
  if (!testId || !Number.isFinite(createdAt) || Date.now() - createdAt > 10 * 60 * 1000) {
    try { localStorage.removeItem(PUSH_TEST_PENDING_KEY); } catch (_) {}
    return;
  }
  await flushPushDiagnostics();
  void pollPushDiagnosticStatus(testId);
}

async function subscribePushPreferenceChanges() {
  if (!currentUser || !pushSubscription) return;
  const state = pushPreferenceChannel && pushPreferenceChannel.state;
  if (state === 'joined' || state === 'joining') return;
  const previous = pushPreferenceChannel;
  pushPreferenceChannel = null;
  await dropRealtimeChannel(previous);
  const next = sb.channel(`chat-push-preference-${currentUser.id}-${Date.now()}`);
  next.on('postgres_changes',
    {
      event: '*',
      schema: 'public',
      table: 'chat_push_user_preferences',
      filter: `user_id=eq.${currentUser.id}`
    },
    (payload) => {
      pushNotificationsEnabled = payload.new?.notifications_enabled === true;
      renderNotificationStatus(pushNotificationsEnabled ? 'enabled' : 'disabled');
      if (pushNotificationsEnabled) {
        loadUnread();
      } else {
        syncAppBadge(0);
      }
    });
  pushPreferenceChannel = next;
  next.subscribe();
}

async function syncPushPreference() {
  if (!pushSubscription) return;
  try {
    const result = await chatPushRequest('preferences', { body: {} });
    pushNotificationsEnabled = result.found && result.notifications_enabled === true;
    renderNotificationStatus(pushNotificationsEnabled ? 'enabled' : 'disabled');
    syncAppBadge();
  } catch (error) {
    console.error('Push preference sync error:', error);
  }
}

async function togglePushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    alert('このブラウザでは新着通知を利用できません');
    renderNotificationStatus('unsupported');
    return;
  }
  if (isIosDevice() && !isStandaloneApp()) {
    alert('iPhone／iPadでは、先に共有メニューから「ホーム画面に追加」し、ホーム画面のM-talkから開いてください。');
    return;
  }
  renderNotificationStatus('working');
  try {
    serviceWorkerRegistration = await ensureChatServiceWorker() || serviceWorkerRegistration || await navigator.serviceWorker.ready;
    pushSubscription = await chatPushManager(serviceWorkerRegistration)?.getSubscription();
    if (pushSubscription && Notification.permission === 'granted' && pushNotificationsEnabled) {
      await chatPushRequest('preferences', {
        body: { notifications_enabled: false }
      });
      pushNotificationsEnabled = false;
      renderNotificationStatus('disabled');
      hidePushRestoreBar();
      await syncAppBadge(0);
      alert('新着通知をオフにしました');
      return;
    }

    await repairPushSubscription();
    alert('新しいトークが入るとスマホへ通知します');
  } catch (error) {
    console.error('Push enable error:', error);
    renderNotificationStatus(Notification.permission === 'denied' ? 'blocked' : 'needs-restore');
    if (Notification.permission !== 'denied') showPushRestoreBar();
    alert(error.message || '通知の設定に失敗しました');
  }
}

async function dispatchPushForMessage(messageId) {
  if (!messageId) return;
  try {
    await chatPushRequest('dispatch', { body: { message_id: messageId } });
  } catch (error) {
    // メッセージ送信自体は成功しているため、通知障害だけを画面送信失敗にはしない。
    console.error('Push dispatch error:', error);
  }
}
