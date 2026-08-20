import assert from "node:assert/strict"
import { readFile, stat } from "node:fs/promises"
import test from "node:test"
import {
  base64UrlEncode,
  buildWebPushRequest,
} from "../supabase/functions/_shared/web_push.ts"
import { mtalkCardFromLineReply } from "../supabase/functions/_shared/chat_flex_card.ts"
import {
  isMtalkSyntheticRoomId,
  mtalkSyntheticRoomId,
  parseMtalkSyntheticRoomId,
} from "../supabase/functions/_shared/mtalk_room_id.ts"

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
  assert.match(html, /navigator\.serviceWorker\.register\('chat-sw\.js', \{ scope: '\.\/' \}/)
  assert.doesNotMatch(html, /chat-sw\.js\?v=/)
  assert.match(html, /Notification\.requestPermission\(\)/)
  assert.match(html, /pushManager\.subscribe\(/)
  assert.match(html, /CHAT_PUSH_PUBLIC_KEY/)
  assert.match(html, /dispatchPushForMessage\(data\.id\)/)
  assert.match(html, /subscribePushPreferenceChanges/)
  assert.match(html, /syncPushPreference/)
  assert.match(html, /Push preference restore error/)
  assert.match(html, /function repairPushSubscription/)
  assert.match(html, /existing\.unsubscribe\(\)/)
  assert.match(html, /pushRestoreBar/)
  assert.match(html, /通知が切れたので、ここをタップして再開/)
  assert.match(html, /needs-restore/)
  assert.match(html, /savePushSubscription\(pushSubscription, true\)/)
  assert.match(serviceWorker, /addEventListener\('push'/)
  assert.match(serviceWorker, /line-report-chat-v42/)
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
  assert.match(html, /function openScheduleSend/)
  assert.match(html, /chat_schedule_message/)
  assert.match(html, /予約配信/)
  assert.match(html, /type="datetime-local"/)
  assert.match(html, /function askSendModeForFiles/)
  assert.match(html, /今すぐ送る/)
  assert.match(html, /p_kind: 'image'/)
  assert.match(html, /msg-card-line/)
  assert.match(html, /msg-card-field dd.is-bold/)
  assert.match(html, /msg-card-empty.is-xs/)
  assert.match(html, /action\.style === 'primary'/)
  assert.match(html, /composer-menu/)
  assert.match(html, /body\.chat-open \{[\s\S]*?padding: var\(--mobile-safe-top\) 0 0 0 !important;/)
  assert.match(html, /body\.chat-open \.input-area \{/)
  assert.match(html, /position: fixed !important;/)
  assert.doesNotMatch(html, /id="inputArea" style="position:relative;"/)
  assert.match(html, /bottom: calc\(0px - var\(--chat-bottom-gap, 0px\)\);/)
  assert.match(html, /padding: 6px 8px 0 !important;/)
  assert.match(html, /--chat-composer-height/)
  assert.doesNotMatch(html, /measureSafeAreaBottomPx/)
  assert.doesNotMatch(html, /padding: 6px 8px 4px;/)
  assert.doesNotMatch(html, /safe-area-inset-bottom, 0px\) \/ 5/)
  assert.doesNotMatch(html, /\.input-area \{\s+padding: 8px 10px max\(8px, env\(safe-area-inset-bottom/)
  assert.match(html, /function sendSearchFromMenu/)
  assert.match(html, /sendChatText\('検索'/)
  assert.match(html, /function openRoomSettings/)
  assert.match(html, /talkCtxSettings/)
  assert.match(html, /set\('from', 'chat'\)/)
  assert.match(html, /function sendCardCommand/)
  assert.match(html, /data-card-command/)
  assert.match(html, /function snapshotRoomView/)
  assert.match(html, /function applyRoomViewCache/)
  assert.match(html, /mtalk-signed-images-v1/)
  assert.match(html, /selectGroupSeq/)
  assert.match(html, /decoding="async"/)
  assert.match(serviceWorker, /line-report-chat-v42/)
})

test("chat messages can be scheduled for later delivery", async () => {
  const migration = await read("supabase/migrations/20260820090000_chat_scheduled_messages.sql")
  assert.match(migration, /create table if not exists public\.chat_scheduled_messages/)
  assert.match(migration, /create or replace function public\.chat_schedule_message/)
  assert.match(migration, /create or replace function public\.chat_cancel_scheduled_message/)
  assert.match(migration, /create or replace function public\.chat_dispatch_scheduled_messages/)
  assert.match(migration, /chat-scheduled-messages-job/)
  assert.match(migration, /送信日時は現在より後にしてください/)
  const imageMigration = await read("supabase/migrations/20260820120000_chat_schedule_image.sql")
  assert.match(imageMigration, /p_kind text default 'text'/)
  assert.match(imageMigration, /p_payload jsonb default null/)
  assert.match(imageMigration, /画像の保存先が不正です/)
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
  assert.match(fn, /handleStoreRoomReceiptCommand/)
  assert.match(fn, /removeStoreRoomMediaForChatMessage/)
  const flex = await read("supabase/functions/_shared/receipt_flex_reply.ts")
  assert.match(flex, /export function buildReceiptChatCard/)
  assert.match(flex, /客単価/)
  assert.match(flex, /【予算】/)
  assert.match(flex, /この結果を修正/)
  assert.match(flex, /buildReceiptCorrectionCommandTextForReceiptRowId/)
  assert.match(flex, /receiptRowId/)
  assert.match(flex, /correctionCommand/)
  const receipts = await read("supabase/functions/_shared/store_receipt.ts")
  assert.match(receipts, /\.eq\('receipt_date', receiptDate\)/)
  assert.match(receipts, /日付が確定できないため削除しません/)
  assert.match(receipts, /他の日付のデータは消していません/)
  assert.match(receipts, /\.select\('id'\)/)
  assert.doesNotMatch(receipts, /本体に無い＝検索インデックスの幽霊/)
  const duplicate = await read("supabase/functions/_shared/receipt_duplicate.ts")
  assert.match(duplicate, /deleteReceiptsForDateExcludingLineMessageId/)
  assert.match(duplicate, /置き換え対象の日付が確定できないため/)
  assert.doesNotMatch(duplicate, /deleteReceiptsForDateByLineMessageIds/)
  assert.match(duplicate, /同日のレシートが既に登録されています/)
  assert.match(duplicate, /同じ店舗・同じレシート日/)
  assert.match(duplicate, /weight: 'bold'/)
  assert.match(duplicate, /style: 'primary'[\s\S]*4 日付変更/)
  const media = await read("supabase/functions/_shared/line_media_store.ts")
  assert.match(media, /export async function saveMediaBytesToLibrary/)
  const bridge = await read("supabase/functions/_shared/chat_store_file_bridge.ts")
  assert.match(bridge, /saveStoreRoomFileToMediaLibrary/)
  assert.match(bridge, /画像を確認しました/)
  assert.match(bridge, /mtalkCardFromLineReply/)
  assert.match(bridge, /startsWith\('C'\)/)
  assert.match(bridge, /handleStoreReceiptTextMessage/)
  assert.doesNotMatch(bridge, /レシート\(修正\|解析削除\)/)
  assert.match(bridge, /cardHasBody/)
  const flexCard = await read("supabase/functions/_shared/chat_flex_card.ts")
  assert.match(flexCard, /export function mtalkCardFromLineReply/)
  assert.match(flexCard, /else if \(rec\.contents\) walkLineFlex/)
  assert.match(flexCard, /flushFlexFields/)
  assert.match(flexCard, /type === 'separator'/)
  assert.match(flexCard, /!collected.sections.length && !collected.actions.length/)
  assert.match(flexCard, /weight: flexWeight\(right\.weight\)/)
  assert.match(flexCard, /style === 'primary'/)
  assert.doesNotMatch(flexCard, /総売上/)
  const config = await read("supabase/config.toml")
  assert.match(config, /\[functions\.chat-knowledge\][\s\S]*verify_jwt = false/)
  const timeoutMigration = await read("supabase/migrations/20260819240000_chat_knowledge_dispatch_timeout.sql")
  assert.match(timeoutMigration, /timeout_milliseconds := 60000/)
  const bots = await read("supabase/migrations/20260820150000_chat_store_bots.sql")
  assert.match(bots, /add column if not exists is_bot boolean not null default false/)
  assert.match(bots, /chat_store_bot_id/)
  assert.match(bots, /u\.is_bot\s+and u\.store_key is not null/)
  assert.match(bots, /店舗Botは店舗ルームから退出させられません/)
  const chatHtml = await read("public/chat.html")
  assert.match(chatHtml, /isStoreBot/)
  assert.match(chatHtml, /bot-mark/)
  assert.match(chatHtml, /setTalkTab\('bots'\)/)
  assert.match(chatHtml, /talkTab === 'bots'/)
  assert.match(chatHtml, /店舗Botはいません/)
  assert.match(chatHtml, /function storeBotDisplayName/)
  assert.match(chatHtml, /function personName/)
  assert.match(bridge, /\$\{base\} bot/)
  assert.match(chatHtml, /talkTab === 'groups' && \(g\.is_direct \|\| g\.is_store_room\)/)
  assert.match(chatHtml, /talkTab === 'all' && g\.is_store_room && !searchQ/)
  assert.match(chatHtml, /function isStoreBotDirect/)
  assert.match(chatHtml, /Botは新しいグループのメンバーにできません/)
  const botJoin = await read("supabase/migrations/20260820160000_chat_bots_not_auto_join_groups.sql")
  assert.match(botJoin, /if new\.is_bot then/)
  assert.match(botJoin, /g\.is_store_room/)
  assert.match(fn, /resolveRoomStoreKey/)
  assert.match(fn, /loadChatStoreBot/)
  assert.match(fn, /fromDispatch/)
  assert.match(fn, /chat_groups!group_id/)
  assert.doesNotMatch(fn, /chat_users\(is_bot\)/)
  assert.match(bridge, /export async function loadChatStoreBot/)
  assert.match(bridge, /resolveRoomStoreKey members failed/)
  const invitedBot = await read("supabase/migrations/20260820190000_chat_invited_bot_dispatch.sql")
  assert.match(invitedBot, /store_key', v_store_key/)
  assert.match(invitedBot, /u\.is_bot/)
  const settingsDispatch = await read("supabase/migrations/20260820200000_chat_settings_command_dispatch.sql")
  assert.match(settingsDispatch, /v_is_settings/)
  assert.match(settingsDispatch, /せってい/)
  assert.match(fn, /SETTINGS_TRIGGER_WORDS/)
  assert.match(fn, /ensureMtalkRoomSettings/)
  assert.match(fn, /from=chat&group_id=/)
  const mtalkSettings = await read("supabase/functions/_shared/mtalk_room_settings.ts")
  assert.match(mtalkSettings, /export async function ensureMtalkRoomSettings/)
  assert.match(mtalkSettings, /mtalk-group-/)
  assert.match(mtalkSettings, /today_reservation_alert_enabled: false/)
  const adminApi = await read("supabase/functions/admin-api/index.ts")
  assert.match(adminApi, /\/chat-room-config/)
  assert.match(adminApi, /handleChatRoomConfig/)
  assert.match(adminApi, /authenticateChatMember/)
  const roomSettingsPage = await read("public/room_settings.html")
  assert.match(roomSettingsPage, /fromChat/)
  assert.match(roomSettingsPage, /chat-room-config/)
  assert.match(roomSettingsPage, /M-talk に戻る/)
  assert.match(roomSettingsPage, /back-mtalk/)
  assert.match(roomSettingsPage, /\?group=/)
  assert.match(roomSettingsPage, /\.\/chat\.html/)
  const todayCron = await read("supabase/functions/reservation-today-cron/index.ts")
  assert.match(todayCron, /isMtalkSyntheticRoomId/)
  assert.match(todayCron, /loadMtalkStoreBot/)
  const gmailCron = await read("supabase/functions/gmail-alert-cron/index.ts")
  assert.match(gmailCron, /isMtalkSyntheticRoomId/)
  assert.match(fn, /handleMtalkSearchText/)
  assert.match(flexCard, /action\.type === 'postback'/)
  const search = await read("supabase/functions/_shared/mtalk_search.ts")
  assert.match(search, /export async function handleMtalkSearchText/)
  assert.match(search, /mtalk-dm-/)
  assert.match(search, /buildSearchEntryReply/)
})

test("LINE search menu Flex becomes M-talk commands", () => {
  const flex = {
    type: 'flex',
    altText: '検索メニュー',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '過去データの検索（1対1）', weight: 'bold' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'button', style: 'primary', action: { type: 'postback', label: '会話検索', data: 'srch=msg', displayText: '会話検索' } },
          { type: 'button', style: 'primary', action: { type: 'postback', label: '売上検索', data: 'srch=sal', displayText: '売上検索' } },
          { type: 'button', style: 'secondary', action: { type: 'postback', label: '📖 使い方（全機能）', data: 'srch=help', displayText: '使い方' } },
        ],
      },
    },
  }
  const converted = mtalkCardFromLineReply(flex)
  const commands = (converted.card?.actions ?? []).map((action) => action.command)
  assert.deepEqual(commands, ['srch=msg', 'srch=sal', 'srch=help'])
})

test("M-talk room ids map to room_summary_settings keys", () => {
  assert.equal(mtalkSyntheticRoomId(31), "mtalk-group-31")
  assert.equal(parseMtalkSyntheticRoomId("mtalk-group-31"), 31)
  assert.equal(isMtalkSyntheticRoomId("mtalk-group-31"), true)
  assert.equal(isMtalkSyntheticRoomId("Cb508b3d20f2d503739a2b0d30dc7274a"), false)
})

test("duplicate-date LINE Flex keeps explanations, bold values, and primary date-change", () => {
  const flex = {
    type: 'flex',
    altText: 'レシート解析（同日重複の確認） / ビストロ サヴァサヴァ / ¥3,000 / 2026-08-19は登録済み',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: '同日のレシートが既に登録されています。次のいずれかを選んでください。',
            size: 'sm',
            weight: 'bold',
            wrap: true,
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            margin: 'md',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '店名', size: 'sm', color: '#7A7A7A', flex: 4 },
                  { type: 'text', text: 'ビストロ サヴァサヴァ', size: 'sm', color: '#1F1F1F', flex: 6, weight: 'bold' },
                ],
              },
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: '総売上', size: 'sm', color: '#7A7A7A', flex: 4 },
                  { type: 'text', text: '¥3,000', size: 'sm', color: '#1F1F1F', flex: 6, weight: 'bold' },
                ],
              },
            ],
          },
          {
            type: 'text',
            text: '同じ店舗・同じレシート日（2026-08-19）のデータがあります。',
            size: 'xs',
            color: '#B45309',
            weight: 'bold',
            wrap: true,
          },
          {
            type: 'text',
            text: 'ボタンまたは「加算」「中止」「置き換え」「日付変更」、番号 1／2／3／4 で返信できます。',
            size: 'xs',
            color: '#555555',
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'button', style: 'secondary', action: { type: 'message', label: '1 加算', text: '加算' } },
          { type: 'button', style: 'secondary', action: { type: 'message', label: '2 中止', text: '中止' } },
          { type: 'button', style: 'secondary', action: { type: 'message', label: '3 置き換え', text: '置き換え' } },
          { type: 'button', style: 'primary', action: { type: 'message', label: '4 日付変更', text: '日付変更' } },
        ],
      },
    },
  }

  const converted = mtalkCardFromLineReply(flex)
  const card = converted.card
  assert.ok(card)
  assert.equal(card.variant, 'line')
  assert.equal(card.sections[0]?.type, 'note')
  assert.equal(card.sections[0].type === 'note' ? card.sections[0].text : '', '同日のレシートが既に登録されています。次のいずれかを選んでください。')
  assert.equal(card.sections[0].type === 'note' ? card.sections[0].weight : null, 'bold')
  assert.equal(card.sections[1]?.type, 'fields')
  const rows = card.sections[1].type === 'fields' ? card.sections[1].rows : []
  assert.equal(rows[0]?.label, '店名')
  assert.equal(rows[0]?.weight, 'bold')
  assert.equal(rows[1]?.label, '総売上')
  assert.equal(rows[1]?.value, '¥3,000')
  assert.equal(rows[1]?.weight, 'bold')
  assert.equal(card.sections[2]?.type, 'note')
  assert.equal(card.sections[2].type === 'note' ? card.sections[2].color : null, '#B45309')
  assert.equal(card.sections[2].type === 'note' ? card.sections[2].weight : null, 'bold')
  assert.equal(card.sections[3]?.type, 'note')
  const actions = card.actions ?? []
  assert.equal(actions.map((action) => action.label).join(','), '1 加算,2 中止,3 置き換え,4 日付変更')
  assert.equal(actions[0]?.style, 'secondary')
  assert.equal(actions[3]?.style, 'primary')
  assert.equal(actions[3]?.command, '日付変更')
})

test("sales-report Flex still keeps headings, separators, and red values", () => {
  const flex = {
    type: 'flex',
    altText: 'ビストロ サヴァサヴァ 2026年8月19日 売上レポート',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '総売上（税込）', color: '#666666' },
              { type: 'text', text: '¥3,000', color: '#111111' },
            ],
          },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '【予算】', weight: 'bold', color: '#111111' },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '日次予算差', color: '#666666' },
              { type: 'text', text: '-¥1,000', color: '#E53935' },
            ],
          },
        ],
      },
    },
  }
  const converted = mtalkCardFromLineReply(flex)
  const types = (converted.card?.sections ?? []).map((section) => section.type)
  assert.deepEqual(types, ['fields', 'separator', 'heading', 'fields'])
  const last = converted.card?.sections[3]
  assert.equal(last?.type, 'fields')
  assert.equal(last?.type === 'fields' ? last.rows[0]?.color : null, '#E53935')
  assert.equal(converted.card?.sections[2]?.type === 'heading' ? converted.card.sections[2].text : '', '【予算】')
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
