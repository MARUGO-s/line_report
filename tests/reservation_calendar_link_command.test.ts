import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { buildReservationCalendarPageUrl } from '../supabase/functions/_shared/reservation_calendar_link.ts'

const root = new URL('..', import.meta.url)

test('reservation confirmation opens M-talk with its own login before search handling', async () => {
  const [handler, webhook, searchBot, guide] = await Promise.all([
    readFile(new URL('supabase/functions/_shared/reservation_calendar_link_request.ts', root), 'utf8'),
    readFile(new URL('supabase/functions/line-webhook/index.ts', root), 'utf8'),
    readFile(new URL('supabase/functions/_shared/line_search_bot.ts', root), 'utf8'),
    readFile(new URL('supabase/functions/_shared/search_help_guide.ts', root), 'utf8'),
  ])

  assert.match(handler, /TRIGGER_WORDS = new Set\(\['予約確認'\]\)/)
  assert.doesNotMatch(handler, /issueAdminDashboardLoginLinkToken|loginToken|24時間・1回のみ有効/)
  assert.match(handler, /buildReservationCalendarPageUrl\(storeKey\)/)
  assert.match(handler, /M-talkへのログインと、この店舗の閲覧権限が必要/)
  assert.match(webhook, /handleReservationCalendarLinkTextMessage/)
  assert.match(webhook, /!reservationCalendarLinkHandled.*isLineSearchGuideEnabled/s)
  assert.match(searchBot, /buildAllFeaturesGuideFlex/)
  assert.match(guide, /M-talkへのログインと店舗の閲覧権限が必要/)
  assert.match(guide, /「予約確認」と送っても同じカレンダー/)
})

test('all LINE calendar producers use the same token-free M-talk URL', async () => {
  for (const file of ['gmail-alert-cron/index.ts', 'reservation-today-cron/index.ts']) {
    const source = await readFile(new URL(`supabase/functions/${file}`, root), 'utf8')
    assert.match(source, /buildReservationCalendarPageUrl/)
    assert.doesNotMatch(source, /issueAdminDashboardLoginLinkToken|RESERVATION_CALENDAR_SCOPE/)
  }
  const url = new URL(buildReservationCalendarPageUrl(' synthetic_store ', { targetMonth: '2026-10' }))
  assert.equal(url.origin + url.pathname, 'https://marugo-s.github.io/line_report/chat.html')
  assert.deepEqual([...url.searchParams], [['calendar', 'reservations'], ['store_key', 'synthetic_store'], ['month', '2026-10']])
  for (const key of ['', 'x'.repeat(65), '../other', 'x&group_id=99', 'https://example.org']) {
    const result = new URL(buildReservationCalendarPageUrl(key, { targetMonth: '2026-13' }))
    assert.equal(result.search, '?calendar=reservations')
    assert.ok(result.href.length < 1000)
  }
})

test('sent LINE links redirect without exchanging or forwarding old credentials', async () => {
  const html = await readFile(new URL('public/reservation.html', root), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const run = (query) => {
    let target = '', cleaned = ''
    const parsed = new URL(`https://marugo-s.github.io/line_report/reservation.html${query}`)
    const window = {}
    vm.runInNewContext(script, {
      URL, URLSearchParams, window,
      location: { href: parsed.href, search: parsed.search, pathname: parsed.pathname, replace(value) { target = value } },
      navigator: { userAgent: 'test' },
      history: { replaceState(_state, _unused, value) { cleaned = value } },
      localStorage: { getItem() { throw new Error('must not infer another store') } },
    })
    return { target, cleaned, redirected: window.__mtalkReservationRedirect }
  }
  for (const marker of ['from=line', 'line_page=reservation']) {
    const result = run(`?${marker}&store_key=synthetic&month=2026-10&lt=old-secret&group_id=99&return_url=https://example.org#secret`)
    assert.equal(result.target, 'https://marugo-s.github.io/line_report/chat.html?calendar=reservations&store_key=synthetic&month=2026-10')
    assert.equal(result.cleaned, '/line_report/reservation.html')
    assert.equal(result.redirected, true)
  }
  assert.equal(run('?from=line&store_key=../other&month=2026-13').target, 'https://marugo-s.github.io/line_report/chat.html?calendar=reservations')
  assert.equal(run('?store_key=synthetic').target, '')
  assert.match(html, /async function init\(\) \{\s*if \(window\.__mtalkReservationRedirect\) return;/)
})
