import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FOODCOURT_ANALYSIS_METHODS, foodCourtAnalysisMethodPrompt } from '../supabase/functions/_shared/foodcourt_qa_methods.ts'
import { FOODCOURT_MANAGEMENT_PACKS } from '../supabase/functions/_shared/foodcourt_management_packs.ts'

const warehouseDir = fileURLToPath(new URL('../docs/management-warehouse/', import.meta.url))

function packFromWarehouse(id: string): string {
  const md = readFileSync(new URL(`../docs/management-warehouse/${id}.md`, import.meta.url), 'utf8')
  const match = md.match(/## 分析パック\n([\s\S]*?)$/)
  assert.ok(match, `${id}.md に分析パックが無い`)
  return match[1].trim()
}

test('every analysis method has a warehouse file and a short runtime pack', () => {
  const files = readdirSync(warehouseDir).filter((name) => name.endsWith('.md') && name !== 'README.md')
  assert.deepEqual(files.sort(), FOODCOURT_ANALYSIS_METHODS.map((row) => `${row.id}.md`).sort())
  for (const row of FOODCOURT_ANALYSIS_METHODS) {
    const pack = FOODCOURT_MANAGEMENT_PACKS[row.id]
    assert.ok(pack, row.id)
    assert.equal(pack, packFromWarehouse(row.id))
    assert.ok(pack.length <= 900, `${row.id} pack too long: ${pack.length}`)
    assert.doesNotMatch(pack, /55|60|62|15,000|30%|50%|5,000/)
  }
})

test('analysis prompt loads only the selected method packs', () => {
  const mix = foodCourtAnalysisMethodPrompt(['mix'])
  assert.match(mix, /知識パック・売上構成・主力商品/)
  assert.match(mix, /累積寄与/)
  assert.doesNotMatch(mix, /CSF/)
  assert.doesNotMatch(mix, /損益分岐/)
  assert.match(mix, /選ばれていない手法の知識パックは読まない/)

  const kpi = foodCourtAnalysisMethodPrompt(['kpi'])
  assert.match(kpi, /知識パック・目標・損益分岐・撤退/)
  assert.match(kpi, /CSF/)
  assert.doesNotMatch(kpi, /累積寄与/)
  assert.doesNotMatch(kpi, /同時購入をセット率/)

  const both = foodCourtAnalysisMethodPrompt(['decompose', 'kpi'])
  assert.match(both, /何円の商品がいくつ売れたか/)
  assert.match(both, /最重要プロセス/)
  assert.doesNotMatch(both, /知識パック・時間帯・曜日/)
})
