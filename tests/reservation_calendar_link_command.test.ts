import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('..', import.meta.url)

test('reservation confirmation command issues a new store-scoped login link before search handling', async () => {
  const [handler, webhook, guide] = await Promise.all([
    readFile(new URL('supabase/functions/_shared/reservation_calendar_link_request.ts', root), 'utf8'),
    readFile(new URL('supabase/functions/line-webhook/index.ts', root), 'utf8'),
    readFile(new URL('supabase/functions/_shared/line_search_bot.ts', root), 'utf8'),
  ])

  assert.match(handler, /TRIGGER_WORDS = new Set\(\['予約確認'\]\)/)
  assert.match(handler, /issueAdminDashboardLoginLinkToken/)
  assert.match(handler, /store_partition_key: storeKey/)
  assert.match(handler, /buildReservationCalendarPageUrl\(storeKey, \{ loginToken: issued\.token \}\)/)
  assert.match(handler, /24時間・1回のみ有効/)
  assert.match(webhook, /handleReservationCalendarLinkTextMessage/)
  assert.match(webhook, /!reservationCalendarLinkHandled.*isLineSearchGuideEnabled/s)
  assert.match(guide, /予約カレンダーのログインリンクが期限切れ・使用済みになった場合/)
  assert.match(guide, /「予約確認」と送ると新しいリンクが届きます/)
})
