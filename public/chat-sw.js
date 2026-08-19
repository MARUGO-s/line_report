'use strict';

const CHAT_CACHE = 'line-report-chat-v1';
const CHAT_SHELL = [
  './chat.html',
  './chat.webmanifest',
  './pages-config.js',
  './vendor/supabase/supabase-2.110.9.min.js',
  './icons/android-chrome-192x192.png',
  './icons/android-chrome-512x512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];
const CHAT_ENTRY_URL = new URL('./chat.html', self.location.href).href;
const CHAT_ASSET_URLS = new Set(CHAT_SHELL.map((path) => new URL(path, self.location.href).href));

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

  const title = String(data.title || 'トーク');
  const options = {
    body: String(data.body || '新しいメッセージがあります'),
    icon: data.icon || './icons/android-chrome-192x192.png',
    badge: data.badge || './icons/favicon-48x48.png',
    tag: data.tag || 'line-report-chat',
    renotify: data.renotify !== false,
    timestamp: Number(data.timestamp) || Date.now(),
    data: {
      url: data.url || './chat.html',
      group_id: data.group_id || null,
      message_id: data.message_id || null,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
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
