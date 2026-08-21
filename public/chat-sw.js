'use strict';

const CHAT_CACHE = 'line-report-chat-v50';
const CHAT_SHELL = [
  './chat.html',
  './chat.webmanifest',
  './pages-config.js',
  './vendor/supabase/supabase-2.110.9.min.js',
  './icons/chat-logo-v3.svg',
  './icons/chat-android-192x192-v3.png',
  './icons/chat-android-512x512-v3.png',
  './icons/chat-maskable-192x192-v3.png',
  './icons/chat-maskable-512x512-v3.png',
  './icons/chat-apple-touch-icon-v3.png',
  './icons/chat-favicon-v3.ico',
  './icons/chat-favicon-32x32-v3.png',
  './icons/chat-favicon-16x16-v3.png',
  './icons/chat-favicon-48x48-v3.png',
];
const CHAT_ENTRY_URL = new URL('./chat.html', self.location.href).href;
const CHAT_ASSET_URLS = new Set(CHAT_SHELL.map((path) => new URL(path, self.location.href).href));
const CHAT_PUSH_DIAGNOSTIC_QUEUE = 'line-report-chat-push-diagnostics';

async function queuePushDiagnostic(testId, stage, detail) {
  if (!testId) return;
  try {
    const cache = await caches.open(CHAT_PUSH_DIAGNOSTIC_QUEUE);
    const key = new Request(new URL(`./__push-diagnostic__/${testId}/${stage}`, self.location.href).href);
    await cache.put(key, new Response(JSON.stringify({
      test_id: testId,
      stage,
      detail: String(detail || '').slice(0, 500) || null,
      created_at: new Date().toISOString(),
    }), { headers: { 'Content-Type': 'application/json' } }));
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: 'FLUSH_PUSH_DIAGNOSTICS' });
  } catch (error) {
    console.error('Push diagnostic queue error:', error);
  }
}

async function updateAppBadge(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  const count = Number(value);
  if (!Number.isSafeInteger(count)) return;
  try {
    if (count > 0 && 'setAppBadge' in self.navigator) {
      await self.navigator.setAppBadge(count);
    } else if (count <= 0 && 'clearAppBadge' in self.navigator) {
      await self.navigator.clearAppBadge();
    }
  } catch (error) {
    // バッジ非対応・OS設定拒否でも通知本体は表示する。
    console.error('App badge update error:', error);
  }
}

async function updateAppBadgeAndRefreshVisibleClients(value) {
  try {
    await updateAppBadge(value);
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      const url = new URL(client.url);
      if (client.visibilityState !== 'visible' || !url.pathname.endsWith('/chat.html')) continue;
      client.postMessage({ type: 'REFRESH_APP_BADGE' });
    }
  } catch (error) {
    // クライアント同期失敗も通知表示を妨げない。
    console.error('App badge client refresh error:', error);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CHAT_CACHE)
      .then((cache) => cache.addAll(CHAT_SHELL).catch(() => Promise.all(
        CHAT_SHELL.map((path) => cache.add(path).catch(() => undefined)),
      )))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => (
            key.startsWith('line-report-chat-')
            && key !== CHAT_CACHE
            && key !== CHAT_PUSH_DIAGNOSTIC_QUEUE
          ))
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => Promise.all(clients.map((client) => {
        const url = new URL(client.url);
        if (!url.pathname.endsWith('/chat.html') || !('navigate' in client)) return undefined;
        // iOSのホーム画面アプリが旧HTMLを保持していても、新SW有効化時に
        // network-firstのchat.htmlへ一度だけ遷移して最新UIへ切り替える。
        return client.navigate(client.url).catch(() => undefined);
      }))),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isChatNavigation = event.request.mode === 'navigate' && url.pathname.endsWith('/chat.html');
  const isRuntimeImageAsset = url.pathname.includes('/profile-icons/') || url.pathname.includes('/stickers/face/');
  if (!isChatNavigation && !CHAT_ASSET_URLS.has(url.href) && !isRuntimeImageAsset) return;

  if (isChatNavigation) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CHAT_CACHE).then((cache) => cache.put(CHAT_ENTRY_URL, copy));
          }
          return response;
        })
        .catch(() => caches.match(CHAT_ENTRY_URL)),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => (
      cached || fetch(event.request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CHAT_CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
    )),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : '新しいメッセージがあります' };
  }

  // 対応WebKitのDeclarative Web Push標準形式を優先する。対応ブラウザでは
  // Service Workerが失敗してもOSがfallback通知を表示し、未対応ブラウザでは
  // このハンドラーが従来どおりnotification辞書を表示する。
  const declarative = data?.web_push === 8030 && data?.notification && typeof data.notification === 'object'
    ? data.notification
    : null;
  const metadata = declarative?.data && typeof declarative.data === 'object'
    ? declarative.data
    : data;
  const title = String(declarative?.title || data.title || 'M-talk');
  const targetUrl = String(declarative?.navigate || metadata?.url || data.url || './chat.html');
  const testId = String(metadata?.test_id || '');
  const options = {
    body: String(declarative?.body || data.body || '新しいメッセージがあります'),
    icon: declarative?.icon || data.icon || './icons/chat-android-192x192-v3.png',
    badge: declarative?.badge || data.badge || './icons/chat-favicon-48x48-v3.png',
    tag: declarative?.tag || data.tag || 'line-report-chat',
    renotify: true,
    data: {
      url: targetUrl,
      group_id: metadata?.group_id || null,
      message_id: metadata?.message_id || null,
    },
  };
  const declarativeBadge = Number(declarative?.app_badge ?? data.app_badge);
  const legacyBadge = Number(data.badge_count);
  const badgeCount = Number.isSafeInteger(declarativeBadge) ? declarativeBadge : legacyBadge;
  event.waitUntil((async () => {
    // userVisibleOnlyを守るため、診断I/Oより先に通知表示を開始する。
    const showPromise = self.registration.showNotification(title, options);
    const receivedPromise = queuePushDiagnostic(testId, 'sw_received', 'push_event');
    try {
      await showPromise;
      await Promise.all([
        receivedPromise,
        queuePushDiagnostic(testId, 'notification_shown', 'showNotification_resolved'),
      ]);
    } catch (error) {
      await Promise.allSettled([
        receivedPromise,
        queuePushDiagnostic(
          testId,
          'notification_failed',
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ),
      ]);
      throw error;
    } finally {
      await updateAppBadgeAndRefreshVisibleClients(badgeCount);
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './chat.html', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        const url = new URL(client.url);
        if (!url.pathname.endsWith('/chat.html')) continue;
        if ('navigate' in client) await client.navigate(target);
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    }),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'SET_APP_BADGE') return;
  event.waitUntil(updateAppBadge(event.data.count));
});

self.addEventListener('message', (event) => {
  // ページから明示的に要求された時だけ、待機中のSWを即時有効化する。
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
