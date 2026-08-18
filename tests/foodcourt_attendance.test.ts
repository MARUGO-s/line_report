import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  actualEventAttendance,
  maxActualEventAttendance,
  resolveEventAttendance,
} from '../supabase/functions/_shared/foodcourt_attendance.ts'

test('actual attendance ignores venue-capacity estimates', () => {
  assert.equal(actualEventAttendance({ expected_attendance: 35512 }), 35512)
  assert.equal(actualEventAttendance({ expected_attendance: 0 }), 0)
  assert.equal(actualEventAttendance({ expected_attendance: null, venue: 'kanadevia', category: 'ライブ' }), null)
  assert.equal(actualEventAttendance({ venue: 'tokyo-dome', category: 'ライブ' }), null)
  assert.equal(actualEventAttendance({ venue: 'korakuen', category: '格闘技' }), null)
})

test('resolveEventAttendance keeps estimates labeled, not as actuals', () => {
  assert.deepEqual(resolveEventAttendance({ expected_attendance: 35512, venue: 'tokyo-dome', category: 'プロ野球' }), {
    mid: 35512,
    low: 35512,
    high: 35512,
    estimated: false,
  })
  const estimated = resolveEventAttendance({ venue: 'tokyo-dome', category: 'ライブ' })
  assert.deepEqual(estimated, { mid: 45000, low: 30000, high: 60000, estimated: true })
  assert.equal(actualEventAttendance({ venue: 'tokyo-dome', category: 'ライブ' }), null)
})

test('numeric max attendance uses stored values only', () => {
  assert.equal(maxActualEventAttendance([
    { venue: 'tokyo-dome', category: 'ライブ' },
    { expected_attendance: 28000, venue: 'tokyo-dome', category: 'プロ野球' },
    { venue: 'kanadevia', category: 'ライブ' },
  ]), 28000)
  assert.equal(maxActualEventAttendance([
    { venue: 'tokyo-dome', category: 'ライブ' },
    { venue: 'kanadevia', category: 'ライブ' },
  ]), null)
})

const page = readFileSync(new URL('../public/foodcourt.html', import.meta.url), 'utf8')

test('event list does not prefill the attendance input from venue capacity', () => {
  assert.match(page, /const actualAtt = actualEventAttendance\(e\)/)
  assert.match(page, /const attVal = actualAtt != null \? String\(actualAtt\) : ''/)
  assert.doesNotMatch(page, /無ければキャパに基づく推定値を初期挿入/)
  assert.doesNotMatch(page, /const resolvedAtt = resolveEventAttendance\(e\)/)
  assert.match(page, /学習・保存には使いません/)
  assert.match(page, /const att = actualEventAttendance\(ev\)/)
})
