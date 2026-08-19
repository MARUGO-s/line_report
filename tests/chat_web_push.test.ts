import assert from "node:assert/strict"
import { readFile, stat } from "node:fs/promises"
import test from "node:test"
import {
  base64UrlEncode,
  buildWebPushRequest,
} from "../supabase/functions/_shared/web_push.ts"

const root = new URL("..", import.meta.url)
const read = (relative: string) => readFile(new URL(relative, root), "utf8")

test("chat PWA registers a service worker and lets the signed-in user enable notifications", async () => {
  const [html, indexHtml, manifest, serviceWorker] = await Promise.all([
    read("public/chat.html"),
    read("public/index.html"),
    read("public/chat.webmanifest"),
    read("public/chat-sw.js"),
  ])
  const parsedManifest = JSON.parse(manifest)

  assert.equal(parsedManifest.start_url, "/line_report/chat.html")
  assert.equal(parsedManifest.display, "standalone")
  assert.match(html, /rel="manifest" href="chat\.webmanifest"/)
  assert.match(html, /rel="icon" type="image\/svg\+xml" href="icons\/chat-logo-v3\.svg"/)
  assert.match(html, /rel="icon" href="icons\/chat-favicon-v3\.ico" sizes="any"/)
  assert.match(html, /rel="icon" type="image\/png" sizes="48x48" href="icons\/chat-favicon-48x48-v3\.png"/)
  assert.match(html, /rel="icon" type="image\/png" sizes="32x32" href="icons\/chat-favicon-32x32-v3\.png"/)
  assert.match(html, /rel="icon" type="image\/png" sizes="16x16" href="icons\/chat-favicon-16x16-v3\.png"/)
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="icons\/chat-apple-touch-icon-v3\.png"/)
  assert.match(html, /src="icons\/chat-logo-v3\.svg"/)
  assert.doesNotMatch(html, /line-report-favicon/)
  assert.match(indexHtml, /icons\/line-report-favicon\.ico/)
  assert.doesNotMatch(indexHtml, /chat-favicon/)
  assert.equal(parsedManifest.icons[0].src, "icons/chat-android-192x192-v3.png")
  assert.equal(parsedManifest.icons[1].src, "icons/chat-maskable-192x192-v3.png")
  assert.equal(parsedManifest.icons[2].src, "icons/chat-android-512x512-v3.png")
  assert.equal(parsedManifest.icons[3].src, "icons/chat-maskable-512x512-v3.png")
  const iconPaths = [
    "public/icons/chat-logo-v3.svg",
    "public/icons/chat-favicon-v3.ico",
    "public/icons/chat-favicon-16x16-v3.png",
    "public/icons/chat-favicon-32x32-v3.png",
    "public/icons/chat-favicon-48x48-v3.png",
    "public/icons/chat-apple-touch-icon-v3.png",
    ...parsedManifest.icons.map((icon: { src: string }) => `public/${icon.src}`),
  ]
  for (const path of iconPaths) {
    assert.ok((await stat(new URL(path, root))).size > 0, `${path} must exist`)
  }
  assert.match(html, /vendor\/supabase\/supabase-2\.110\.9\.min\.js/)
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/npm\/@supabase/)
  assert.match(html, /navigator\.serviceWorker\.register\('chat-sw\.js'/)
  assert.match(html, /Notification\.requestPermission\(\)/)
  assert.match(html, /pushManager\.subscribe\(/)
  assert.match(html, /CHAT_PUSH_PUBLIC_KEY/)
  assert.match(html, /dispatchPushForMessage\(data\.id\)/)
  assert.match(html, /subscribePushPreferenceChanges/)
  assert.match(html, /syncPushPreference/)
  assert.match(serviceWorker, /addEventListener\('push'/)
  assert.match(serviceWorker, /line-report-chat-v18/)
  assert.match(serviceWorker, /chat-logo-v3\.svg/)
  assert.match(serviceWorker, /chat-apple-touch-icon-v3\.png/)
  assert.match(serviceWorker, /chat-android-192x192-v3\.png/)
  assert.match(serviceWorker, /chat-favicon-v3\.ico/)
  assert.match(serviceWorker, /chat-favicon-32x32-v3\.png/)
  assert.match(serviceWorker, /chat-favicon-16x16-v3\.png/)
  assert.match(serviceWorker, /chat-favicon-48x48-v3\.png/)
  assert.match(serviceWorker, /showNotification/)
  assert.match(serviceWorker, /notificationclick/)
  assert.match(serviceWorker, /setAppBadge/)
  assert.match(serviceWorker, /clearAppBadge/)
  assert.match(serviceWorker, /data\.badge_count/)
  assert.match(serviceWorker, /SET_APP_BADGE/)
  assert.match(serviceWorker, /REFRESH_APP_BADGE/)
  assert.match(serviceWorker, /client\.visibilityState !== 'visible'/)
  assert.match(serviceWorker, /chat\.html/)
  assert.match(serviceWorker, /if \(!isChatNavigation && !CHAT_ASSET_URLS\.has\(url\.href\)\) return/)
  assert.match(serviceWorker, /key\.startsWith\('line-report-chat-'\)/)
  assert.match(html, /Push sign out API cleanup error/)
  assert.match(html, /Push sign out local cleanup error/)
  assert.match(html, /function unreadTotal\(\)/)
  assert.match(html, /async function syncAppBadge/)
  assert.match(html, /navigator\.setAppBadge/)
  assert.match(html, /navigator\.clearAppBadge/)
  assert.match(html, /syncAppBadge\(0\)/)
  assert.match(html, /event\.data\?\.type === 'REFRESH_APP_BADGE'/)
  assert.match(html, /if \(pushNotificationsEnabled\) \{\s+loadUnread\(\)/)
  assert.match(html, /function bindTalkSwipe/)
  assert.match(html, /function openTalkContextMenu/)
  assert.match(html, /トークの設定/)
  assert.match(html, /chat_set_pin/)
  assert.match(html, /chat_set_mute/)
  assert.match(html, /chat_set_hidden/)
  assert.match(html, /ピン留めは5件までです/)
  assert.match(html, /swipe-hide/)
  assert.match(html, /swipe-delete/)
  assert.match(html, /↩ リプライ/)
  assert.doesNotMatch(html, /返信する/)
  assert.match(html, /data-action="copy"/)
  assert.match(html, /data-action="forward"/)
  assert.match(html, /data-action="delete"/)
  assert.match(html, /function openForward/)
  assert.match(html, /function copyMessage/)
  assert.match(html, /chat_leave_group/)
  assert.match(html, /chat_kick_member/)
  assert.match(html, /退出させる/)
  assert.match(html, /ルームを退出/)
  assert.match(html, /function toggleMemberStrip/)
  assert.match(html, /chatMemberCount/)
  assert.match(html, /memberStrip/)
  assert.match(html, /function talkListCountLabel/)
  assert.match(html, /talk-list-count/)
  assert.match(html, /is_store_room/)
  assert.match(html, /店舗固定ルームは退出・削除できません/)
  assert.match(html, /<textarea id="messageInput"/)
  assert.match(html, /Shift\+Enter で改行/)
  assert.match(html, /!isMobileLayout\(\)/)
  assert.match(html, /function setChatDropActive/)
  assert.match(html, /画像をドロップして送信（メディア閲覧へ保存）/)
  assert.match(serviceWorker, /line-report-chat-v18/)
})

test("chat store rooms are locked and forward #メモ to Journal Report", async () => {
  const migration = await read("supabase/migrations/20260819230000_chat_store_rooms.sql")
  assert.match(migration, /is_store_room boolean not null default false/)
  assert.match(migration, /chat_groups_store_room_uidx/)
  assert.match(migration, /店舗固定ルームは退出できません/)
  assert.match(migration, /chat-knowledge\?action=dispatch/)
  const fn = await read("supabase/functions/chat-knowledge/index.ts")
  assert.match(fn, /hasKnowledgeMemoTag/)
  assert.match(fn, /process-line-post/)
  assert.match(fn, /processStoreRoomImageLikeLine/)
  assert.match(fn, /removeStoreRoomMediaForChatMessage/)
  const media = await read("supabase/functions/_shared/line_media_store.ts")
  assert.match(media, /export async function saveMediaBytesToLibrary/)
  const bridge = await read("supabase/functions/_shared/chat_store_file_bridge.ts")
  assert.match(bridge, /saveStoreRoomFileToMediaLibrary/)
  assert.match(bridge, /画像を確認しました/)
  const config = await read("supabase/config.toml")
  assert.match(config, /\[functions\.chat-knowledge\][\s\S]*verify_jwt = false/)
  const timeoutMigration = await read("supabase/migrations/20260819240000_chat_knowledge_dispatch_timeout.sql")
  assert.match(timeoutMigration, /timeout_milliseconds := 60000/)
})

test("chat members can leave a room and owners can kick others", async () => {
  const migration = await read("supabase/migrations/20260819223000_chat_leave_and_kick.sql")
  assert.match(migration, /create or replace function public\.chat_leave_group/)
  assert.match(migration, /create or replace function public\.chat_kick_member/)
  assert.match(migration, /このアカウントは退出させられません/)
})

test("chat messages can be deleted by their author", async () => {
  const migration = await read("supabase/migrations/20260819220000_chat_message_delete.sql")
  assert.match(migration, /create policy chat_messages_delete_own on public.chat_messages/)
  assert.match(migration, /using \(user_id = auth.uid\(\)\)/)
})

test("chat swipe prefs store mute and hide per user", async () => {
  const migration = await read("supabase/migrations/20260819211000_chat_swipe_prefs.sql")
  assert.match(migration, /add column if not exists muted_at timestamptz/)
  assert.match(migration, /add column if not exists hidden_at timestamptz/)
  assert.match(migration, /create or replace function public\.chat_set_mute/)
  assert.match(migration, /create or replace function public\.chat_set_hidden/)
})

test("chat pin schema stores a per-user pin and caps at five rooms", async () => {
  const migration = await read("supabase/migrations/20260819203000_chat_pins.sql")
  assert.match(migration, /add column if not exists pinned_at timestamptz/)
  assert.match(migration, /create or replace function public\.chat_set_pin/)
  assert.match(migration, /ピン留めは5件までです/)
  assert.match(migration, /grant execute on function public\.chat_set_pin\(bigint, boolean\) to authenticated/)
})

test("chat push schema protects device subscriptions and deduplicates dispatch", async () => {
  const migration = await read(
    "supabase/migrations/20260818220643_chat_web_push_notifications.sql",
  )
  assert.match(migration, /create table if not exists public\.chat_push_subscriptions/)
  assert.match(migration, /revoke all on table public\.chat_push_subscriptions from public, anon, authenticated/)
  assert.match(migration, /grant select, insert, update, delete on table public\.chat_push_subscriptions to service_role/)
  assert.match(migration, /create table if not exists public\.chat_push_dispatches/)
  assert.match(migration, /message_id bigint primary key references public\.chat_messages/)
  assert.match(migration, /chat_claim_push_dispatch/)
  assert.match(migration, /interval '5 minutes'/)
  assert.match(migration, /create table if not exists public\.chat_push_internal_config/)
  assert.match(migration, /chat_get_vapid_config/)
  assert.match(migration, /vault\.decrypted_secrets/)
  assert.match(migration, /create table if not exists public\.chat_push_user_preferences/)
  assert.match(migration, /chat_push_user_preferences_select_self/)
  assert.match(migration, /chat_messages_enqueue_push/)
  assert.match(migration, /after insert on public\.chat_messages/)
  assert.match(migration, /net\.http_post/)
  assert.match(migration, /alter publication supabase_realtime add table public\.chat_push_user_preferences/)

  const badgeMigration = await read(
    "supabase/migrations/20260819015213_chat_app_icon_badges.sql",
  )
  assert.match(badgeMigration, /create or replace function public\.chat_push_unread_totals\(p_user_ids uuid\[\]\)/)
  assert.match(badgeMigration, /m\.user_id <> recipients\.user_id/)
  assert.match(badgeMigration, /m\.created_at > rs\.last_read_at/)
  assert.match(badgeMigration, /select distinct value as user_id/)
  assert.match(badgeMigration, /count\(m\.id\)::bigint as unread_count/)
  assert.match(badgeMigration, /group by recipients\.user_id/)
  assert.match(badgeMigration, /revoke all on function public\.chat_push_unread_totals\(uuid\[\]\) from public, anon, authenticated/)
  assert.match(badgeMigration, /grant execute on function public\.chat_push_unread_totals\(uuid\[\]\) to service_role/)
})

test("chat push endpoint requires Supabase Auth and excludes the sender", async () => {
  const edge = await read("supabase/functions/chat-push/index.ts")
  assert.match(edge, /authClient\.auth\.getUser\(token\)/)
  assert.match(edge, /internalDispatchAuthorized/)
  assert.match(edge, /secureEqual/)
  assert.match(edge, /Only the message sender can dispatch its notification/)
  assert.match(edge, /\.neq\("user_id", message\.user_id\)/)
  assert.match(edge, /status === 404 \|\| status === 410/)
  assert.match(edge, /is_active: !expired/)
  assert.match(edge, /CHAT_VAPID_PRIVATE_KEY/)
  assert.match(edge, /chat_get_vapid_config/)
  assert.match(edge, /preview_enabled/)
  assert.match(edge, /action === "preferences"/)
  assert.match(edge, /chat_push_unread_totals/)
  assert.match(edge, /badge_count: unreadTotals\.get\(row\.user_id\) \?\? null/)
  assert.match(edge, /muted_at/)
  assert.match(edge, /chat-android-192x192-v3\.png/)
  assert.match(edge, /chat-favicon-48x48-v3\.png/)
  assert.match(edge, /バッジ件数の取得失敗でWeb Push本体を止めない/)
})

test("Web Push request uses VAPID and aes128gcm encryption", async () => {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair
  const privateJwk = await crypto.subtle.exportKey("jwk", privateKey)
  const vapidPublic = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey))

  const clientKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  ) as CryptoKeyPair
  const clientPublic = new Uint8Array(await crypto.subtle.exportKey("raw", clientKeys.publicKey))
  const authSecret = crypto.getRandomValues(new Uint8Array(16))

  const request = await buildWebPushRequest(
    {
      endpoint: "https://push.example.test/send/subscription",
      p256dh: base64UrlEncode(clientPublic),
      auth: base64UrlEncode(authSecret),
    },
    { title: "トーク", body: "新しいメッセージ" },
    {
      publicKey: base64UrlEncode(vapidPublic),
      privateKey: String(privateJwk.d),
      subject: "mailto:test@example.com",
    },
  )

  assert.equal(request.headers["Content-Encoding"], "aes128gcm")
  assert.match(request.headers.Authorization, /^vapid t=.+, k=.+/)
  assert.equal(request.headers.TTL, "86400")
  assert.ok(request.body.length > 100)
  assert.equal(request.body[20], 65, "encrypted record must carry a P-256 public key")
})
