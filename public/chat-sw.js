'use strict';

const CHAT_CACHE = 'line-report-chat-v29';
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
      .then((cache) => cache.addAll(CHAT_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('line-report-chat-') && key !== CHAT_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isChatNavigation = event.request.mode === 'navigate' && url.pathname.endsWith('/chat.html');
  if (!isChatNavigation && !CHAT_ASSET_URLS.has(url.href)) return;

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

  const title = String(data.title || 'M-talk');
  const options = {
    body: String(data.body || '新しいメッセージがあります'),
    icon: data.icon || './icons/chat-android-192x192-v3.png',
    badge: data.badge || './icons/chat-favicon-48x48-v3.png',
    tag: data.tag || 'line-report-chat',
    renotify: data.renotify !== false,
    timestamp: Number(data.timestamp) || Date.now(),
    data: {
      url: data.url || './chat.html',
      group_id: data.group_id || null,
      message_id: data.message_id || null,
    },
  };
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    updateAppBadgeAndRefreshVisibleClients(data.badge_count),
  ]));
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
