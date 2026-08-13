import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../public/foodcourt-evolution.html', import.meta.url), 'utf8')

test('AI evolution page follows the five-tab design handoff with overview as default', () => {
  const tabs = [...page.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual(tabs, ['overview', 'curve', 'records', 'settings', 'evolution'])
  assert.match(page, /id="tabOverview"[^>]*data-panel="overview">/)
  for (const panel of ['tabCurve', 'tabRecords', 'tabSettings', 'tabEvolution']) {
    assert.match(page, new RegExp(`id="${panel}"[^>]*hidden`))
  }
  assert.match(page, /selectTab\('overview', false\)/)
})

test('each existing live-data block remains assigned to the intended tab', () => {
  assert.match(page, /id="tabOverview"[\s\S]*id="kpiGrid"[\s\S]*<\/section>/)
  assert.match(page, /id="tabCurve"[\s\S]*id="mapeSvg"[\s\S]*<\/section>/)
  assert.match(page, /id="tabRecords"[\s\S]*id="histTbody"[\s\S]*<\/section>/)
  assert.match(page, /id="tabSettings"[\s\S]*id="passingScoreRange"[\s\S]*<\/section>/)
  assert.match(page, /id="tabEvolution"[\s\S]*id="readinessCard"[\s\S]*id="ragCard"[\s\S]*id="loopCard"[\s\S]*<\/section>/)
  assert.match(page, /\/foodcourt\/evolution-history\?store_key=marugoS/)
  assert.match(page, /\/foodcourt\/prompt-evaluation-sets\/bootstrap/)
})

test('records default to twelve rows and can expand to all rows', () => {
  assert.match(page, /let showAllHistory = false/)
  assert.match(page, /allRows\.slice\(0,12\)/)
  assert.match(page, /直近12件だけ表示/)
})

test('prediction confidence stars stay inside their KPI card', () => {
  assert.match(page, /\.overview-secondary \.highlight-trust \.kpi-v\{[^}]*font-size:26px[^}]*white-space:nowrap[^}]*overflow:hidden/)
  assert.match(page, /stars = '★★★★☆'/)
  assert.doesNotMatch(page, /⭐⭐⭐⭐☆/)
})

test('page ids remain unique after the layout reorganization', () => {
  const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map(match => match[1])
  assert.equal(new Set(ids).size, ids.length)
})
