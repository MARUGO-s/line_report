import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { loadReservationImagePermission, reservationImportMatchesSource } from '../supabase/functions/_shared/reservation_image_registration.ts'

const root = new URL('..', import.meta.url)
const webhook = await readFile(new URL('supabase/functions/line-webhook/index.ts', root), 'utf8')

// 本番ハンドラをそのまま実行する。外部LINE送信・実データ・実DBは使わない。
function handlers(db) {
  const context = vm.createContext({
    console: { error() {} }, Date, Number, String,
    loadReservationImagePermission, reservationImportMatchesSource,
    buildSimpleNoticeFlex: text => ({ text }),
    buildReservationUpdatedFlex: () => ({ text: 'updated' }),
    buildReservationRegisteredFlex: () => ({ text: 'registered' }),
    combineReservationVisitAtIso: () => '2026-10-10T10:00:00Z',
    buildReservationImportDetailJson: () => '{}',
    findSameDayManualReservationMatch: async () => null,
    buildReservationConfirmFlex: () => ({ text: 'confirm' }),
    webhookReplyLog: () => ({}),
    replyLineFlex: async () => { db.replies++ },
  })
  for (const [name, end] of [
    ['handleReservationImageDetected', 'function buildSimpleNoticeFlex'],
    ['handleReservationImportPostback', '// ───────── 月次日別売上管理表'],
  ]) {
    const start = webhook.indexOf(`async function ${name}(`)
    const source = webhook.slice(start, webhook.indexOf(end, start))
    vm.runInContext(stripTypeScriptTypes(source), context)
  }
  return {
    image: () => context.handleReservationImageDetected(db, { store_partition_key: 'store_a' }, 'room_a', 'reply', 'access', 'fake_image', { date: '2026-10-10' }, ''),
    postback: data => context.handleReservationImportPostback(db, data, 'room_a', 'store_a'),
  }
}

function client(options = {}) {
  const db = {
    enabled: options.enabled ?? true, reads: 0, writes: [], replies: 0, queries: [],
    pending: {
      id: 1, status: 'pending', room_id: 'room_a', store_partition_key: 'store_a', existing_event_id: 2,
      payload: { visit_at: '2026-10-10T10:00:00Z', manual_store_key: 'store_a', customer_name: 'test' },
      ...options.pending,
    },
    from(table) {
      let write = null, filters = [], value
      const finish = () => {
        db.queries.push({ table, filters })
        if (table === 'room_summary_settings') {
          db.reads++
          if (options.throw) throw new Error('offline')
          if (options.error) return { data: null, error: { message: 'offline' } }
          return { data: options.missing ? null : { reservation_image_registration_enabled: db.enabled }, error: null }
        }
        if (write) {
          db.writes.push({ table, write, value, filters })
          if (options.disableOnInsert && table === 'pending_reservation_imports') db.enabled = false
          return { data: options.noUpdateMatch && table === 'manual_reservation_visit_events' ? null : { id: 2 }, error: null }
        }
        return { data: table === 'pending_reservation_imports' ? db.pending : null, error: null }
      }
      const query = {
        select() { return query }, eq(k, v) { filters.push([k, v]); return query },
        order() { return query }, limit() { return query },
        insert(v) { write = 'insert'; value = v; return query },
        update(v) { write = 'update'; value = v; return query },
        async maybeSingle() { return finish() }, async single() { return finish() },
        then(resolve, reject) { return Promise.resolve().then(finish).then(resolve, reject) },
      }
      return query
    },
    async rpc() { return { data: null, error: null } },
  }
  return db
}

test('permission is room-bound, fresh and fail-closed; no row preserves the default ON', async () => {
  const db = client()
  assert.equal(await loadReservationImagePermission(db, 'room_a'), 'allowed')
  db.enabled = false
  assert.equal(await loadReservationImagePermission(db, 'room_a'), 'disabled')
  assert.deepEqual(db.queries[0].filters, [['room_id', 'room_a']])
  assert.equal(db.reads, 2)
  for (const options of [{ error: true }, { throw: true }]) {
    assert.equal(await loadReservationImagePermission(client(options), 'room_a'), 'unavailable')
  }
  assert.equal(await loadReservationImagePermission(client({ missing: true }), 'room_a'), 'allowed')
  assert.equal(await loadReservationImagePermission(db, ''), 'unavailable')
  db.enabled = null
  assert.equal(await loadReservationImagePermission(db, 'room_a'), 'disabled')
})

test('OFF or setting failure sends no reservation card and creates no draft', async () => {
  for (const options of [{ enabled: false }, { error: true }, { throw: true }]) {
    const db = client(options)
    const result = await handlers(db).image()
    assert.equal(result.replied, false)
    assert.equal(db.writes.length, 0)
    assert.equal(db.replies, 0)
  }
})

test('ON sends the usual card; switching OFF during draft creation suppresses the card', async () => {
  for (const disabled of [false, true]) {
    const db = client({ disableOnInsert: disabled })
    // Force creation of a new pending draft instead of reuse.
    db.pending = null
    const result = await handlers(db).image()
    assert.equal(result.replied, !disabled)
    assert.equal(db.replies, disabled ? 0 : 1)
    assert.equal(db.writes[0].table, 'pending_reservation_imports')
    assert.equal(db.writes[0].value.room_id, 'room_a')
    assert.equal(db.reads, 2)
  }
})

test('old register/update cards cannot write after OFF or during DB failure', async () => {
  for (const data of ['resv_imp=1', 'resv_update=1']) {
    for (const options of [{ enabled: false }, { error: true }, { throw: true }]) {
      const db = client(options)
      const result = await handlers(db).postback(data)
      assert.match(result.text, /許可されていません|設定を確認できない/)
      assert.equal(db.writes.length, 0)
    }
  }
})

test('ON permits registration/update; discard is still available while OFF', async () => {
  for (const data of ['resv_imp=1', 'resv_update=1', 'resv_imp_skip=1']) {
    const db = client({ enabled: data !== 'resv_imp_skip=1' })
    const result = await handlers(db).postback(data)
    assert.match(result.text, /registered|updated|取りやめ/)
    assert.ok(db.writes.length > 0)
    if (data === 'resv_imp=1') assert.equal(db.writes[0].value.manual_store_key, 'store_a')
    if (data === 'resv_update=1') assert.deepEqual(db.writes[0].filters, [['id', 2], ['manual_store_key', 'store_a']])
  }
})

test('foreign room/store/payload and dismissed cards cannot register or update', async () => {
  for (const pending of [{ room_id: 'room_b' }, { store_partition_key: 'store_b' }, { payload: { manual_store_key: 'store_b' } }, { status: 'dismissed' }]) {
    for (const data of ['resv_imp=1', 'resv_update=1']) {
      const db = client({ pending })
      const result = await handlers(db).postback(data)
      assert.match(result.text, /操作できません|終了しています/)
      assert.equal(db.writes.length, 0)
    }
  }
  assert.equal(reservationImportMatchesSource(client().pending, '', 'store_a'), false)
  const db = client({ noUpdateMatch: true })
  assert.match((await handlers(db).postback('resv_update=1')).text, /更新に失敗/)
  assert.equal(db.writes.length, 1) // history/status must not be updated if the target belongs to another store.
})

test('schema, both settings surfaces and API persist the dedicated permission without widening scope', async () => {
  const [migration, admin, page, selfPage] = await Promise.all([
    'supabase/migrations/20261004000000_room_reservation_image_registration_gate.sql',
    'supabase/functions/admin-api/index.ts', 'public/index.html', 'public/room_settings.html',
  ].map(path => readFile(new URL(path, root), 'utf8')))
  assert.match(migration, /reservation_image_registration_enabled boolean not null default true/)
  assert.doesNotMatch(migration, /update public\./i)
  assert.match(admin, /ROOM_CONFIG_SAFE_BOOL_FIELDS = \[[\s\S]*?"reservation_image_registration_enabled"[\s\S]*?\]/)
  assert.match(admin, /reservation_image_registration_enabled: payload\.reservation_image_registration_enabled/)
  assert.match(admin, /reservation_image_registration_enabled: reservationImageRegistrationEnabled/)
  assert.match(admin, /reservationImageRegistrationEnabledRaw != null[\s\S]*?: undefined/)
  assert.match(page, /roomConfigReservationImageWrap\.hidden = !activeRoomIndividualSave/)
  assert.match(page, /#roomConfigReservationImageWrap\[hidden\] \{\s*display: none;/)
  assert.match(page, /reservation_image_registration_enabled: activeRoomIndividualSave/)
  assert.match(page, /reservation_image_registration_enabled: parseDatasetBoolean\(tr\.dataset\.roomReservationImageRegistration, true\)/)
  assert.match(page, /reservation_image_registration_enabled: roomConfig\.reservation_image_registration_enabled !== false/)
  assert.match(page, /typeof config\.reservation_image_registration_enabled === 'boolean'/)
  assert.match(page, /typeof opts\.overrideConfig\.reservation_image_registration_enabled === 'boolean'/)
  assert.match(selfPage, /key:'reservation_image_registration_enabled'/)
  assert.match(webhook, /handleReservationImportPostback\(\s*supabase, postbackData, eventRoomIdForPostback/)

  // 実際の管理画面の行→保存値の経路で、個別OFFが一括保存によりONへ戻らないことを確認。
  const context = vm.createContext({
    parseDatasetBoolean: (value, fallback) => value == null ? fallback : value === 'true',
    parseDatasetScheduleInt: () => null,
    computeRoomEnabledFromFeatureConfig: () => true,
  })
  for (const [name, end] of [
    ['getRoomConfigStateFromRow', 'function applyRoomConfigStateToRow'],
    ['applyRoomConfigStateToRow', 'function getRoomConfigEnabledCount'],
  ]) {
    const start = page.indexOf(`function ${name}(`)
    vm.runInContext(page.slice(start, page.indexOf(end, start)), context)
  }
  const row = { dataset: {}, querySelector: () => null }
  context.applyRoomConfigStateToRow(row, { reservation_image_registration_enabled: false })
  assert.equal(context.getRoomConfigStateFromRow(row).reservation_image_registration_enabled, false)
  context.applyRoomConfigStateToRow(row, { reservation_image_registration_enabled: undefined })
  assert.equal(context.getRoomConfigStateFromRow(row).reservation_image_registration_enabled, false)
  context.applyRoomConfigStateToRow(row, { reservation_image_registration_enabled: true })
  assert.equal(context.getRoomConfigStateFromRow(row).reservation_image_registration_enabled, true)
})
