import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyBarPelotaSettlementCounts,
  hasValidBarPelotaReceiptCounts,
  isBarPelotaReceiptStore,
  parseBarPelotaSettlementCounts,
  readBarPelotaSettlementCounts,
  verifyBarPelotaSettlementCounts,
} from '../supabase/functions/_shared/barpelota_receipt.ts'
import { normalizeLineImageReceiptAnalysis } from '../supabase/functions/_shared/receipt_parse.ts'
import type { LineImageReceiptAnalysis } from '../supabase/functions/_shared/receipt_types.ts'

const receipt: LineImageReceiptAnalysis = {
  storeName: 'BAR PELOTA',
  storePhone: null,
  date: null,
  netSales: null,
  taxAmount: null,
  grossSales: '¥105,910',
  partyCount: '52',
  guestCount: '37',
  unitPrice: '¥2,862',
  items: [],
}

function settlement(rows: string[]) {
  return { store_name: 'BAR PELOTA', heading: '精算', rows }
}

test('Bar Pelota stores use the printed total, including on a day with a cash payout', () => {
  assert.equal(isBarPelotaReceiptStore(' BARPELOTA '), true)
  assert.equal(isBarPelotaReceiptStore('marugoS'), false)
  assert.deepEqual(
    parseBarPelotaSettlementCounts(settlement(['総取引数 37', '客数 52', '通常取引数 36', '出金取引数 1'])),
    { settlement: true, partyCount: 37, guestCount: 52 },
  )
  assert.deepEqual(
    parseBarPelotaSettlementCounts(settlement(['総取引数：６', '客数 6'])),
    { settlement: true, partyCount: 6, guestCount: 6 },
  )
})

test('A standalone cash payout slip does not become a daily settlement', () => {
  assert.deepEqual(
    parseBarPelotaSettlementCounts({ ...settlement(['総取引数 4', '客数 9']), heading: 'レジ出金' }),
    { settlement: false, partyCount: null, guestCount: null },
  )
  assert.deepEqual(
    parseBarPelotaSettlementCounts({ ...settlement(['総取引数 4', '客数 9']), store_name: '別の店舗' }),
    { settlement: false, partyCount: null, guestCount: null },
  )
})

test('Missing, ambiguous and partial digits are not replaced by neighboring rows', () => {
  assert.deepEqual(
    parseBarPelotaSettlementCounts(settlement(['総取引数', '客数 52', '通常取引数 36'])),
    { settlement: true, partyCount: null, guestCount: 52 },
  )
  assert.deepEqual(
    parseBarPelotaSettlementCounts(settlement(['総取引数 37', '客数 5?', '客数 52'])),
    { settlement: true, partyCount: 37, guestCount: null },
  )
  assert.deepEqual(
    parseBarPelotaSettlementCounts(settlement(['総取引数 -1', '客数 6\n通常取引数 4'])),
    { settlement: true, partyCount: null, guestCount: null },
  )
})

test('Only valid transcriptions set the verification mark and recalculate unit price', () => {
  const counts = parseBarPelotaSettlementCounts(settlement(['総取引数 37', '客数 52']))
  assert.deepEqual(applyBarPelotaSettlementCounts(receipt, counts), {
    ...receipt, partyCount: '37', guestCount: '52', unitPrice: '¥2,037', barPelotaCountsVerified: true,
  })
  assert.equal(applyBarPelotaSettlementCounts(receipt, { settlement: false, partyCount: 37, guestCount: 52 }), null)
  assert.equal(applyBarPelotaSettlementCounts(receipt, { settlement: true, partyCount: 52, guestCount: 37 }), null)
  assert.equal(applyBarPelotaSettlementCounts(receipt, { settlement: true, partyCount: null, guestCount: 37 }), null)
  assert.equal(applyBarPelotaSettlementCounts(receipt, { settlement: true, partyCount: 2, guestCount: null }), null)
  assert.equal(applyBarPelotaSettlementCounts(receipt, { settlement: true, partyCount: 6, guestCount: 6 })?.barPelotaCountsVerified, true)
  assert.equal(applyBarPelotaSettlementCounts(receipt, { settlement: true, partyCount: 0, guestCount: 0 })?.unitPrice, null)
  assert.equal(normalizeLineImageReceiptAnalysis({
    store_name: 'BAR PELOTA', party_count: 37, guest_count: 52, barPelotaCountsVerified: true,
  })?.barPelotaCountsVerified, undefined)
})

test('The numerical guard refuses non-integer, absent and reversed counts', () => {
  assert.equal(hasValidBarPelotaReceiptCounts({ partyCount: '6', guestCount: '6' }), true)
  assert.equal(hasValidBarPelotaReceiptCounts({ partyCount: '0', guestCount: '0' }), true)
  assert.equal(hasValidBarPelotaReceiptCounts({ partyCount: '36', guestCount: '35' }), false)
  assert.equal(hasValidBarPelotaReceiptCounts({ partyCount: null, guestCount: '36' }), false)
  assert.equal(hasValidBarPelotaReceiptCounts({ partyCount: '5?', guestCount: '36' }), false)
  assert.equal(hasValidBarPelotaReceiptCounts({ partyCount: '36', guestCount: '7/37' }), false)
  assert.equal(hasValidBarPelotaReceiptCounts({ partyCount: '-1', guestCount: '36' }), false)
})

test('The focused Gemini request reads the label evidence through the shared image transport', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /models\/test-model:generateContent$/)
    const body = JSON.parse(String(init?.body))
    assert.match(body.system_instruction.parts[0].text, /「総取引数」と「客数」の2行/)
    assert.equal(body.generationConfig.maxOutputTokens, 2_048)
    assert.equal(body.contents[0].parts[1].inline_data.mime_type, 'image/jpeg')
    return Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify(settlement(['総取引数 12', '客数 25'])) }] } }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12, totalTokenCount: 42 },
    })
  }
  try {
    const result = await readBarPelotaSettlementCounts(new Uint8Array([1]), 'image/jpeg', 'fixture', 'test-key', 'test-model')
    assert.equal(result.settlement, true)
    assert.equal(result.providerFailed, false)
    assert.equal(result.partyCount, 12)
    assert.equal(result.guestCount, 25)
    assert.equal(result.usage?.totalTokens, 42)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('A failed focused request is distinguishable from unreadable printed values', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('unavailable') }
  try {
    const result = await readBarPelotaSettlementCounts(new Uint8Array([1]), 'image/jpeg', 'fixture', 'test-key', 'test-model')
    assert.equal(result.providerFailed, true)
    assert.equal(applyBarPelotaSettlementCounts(receipt, result), null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('A close-up is included and conflicting, plausible row readings are held', async () => {
  const originalFetch = globalThis.fetch
  const responses = [
    ['総取引数 32', '客数 71'],
    ['純売上 ¥100,000', '販売点数 89', '返品点数 0', '総取引数 33', '客数 71'],
  ]
  const image = {
    bytes: new Uint8Array([1]),
    contentType: 'image/jpeg',
    countsDetail: { bytes: new Uint8Array([2]), contentType: 'image/jpeg' },
  }
  const generalReceipt = { ...receipt, partyCount: null, guestCount: '74' }
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    const parts = body.contents[0].parts
    const images = parts.slice(1).map((part: { inline_data: { data: string } }) => part.inline_data.data)
    if (responses.length === 2) {
      assert.match(body.system_instruction.parts[0].text, /2枚目は同じ精算票の下部/)
      assert.deepEqual(images, ['AQ==', 'Ag=='])
    } else {
      assert.deepEqual(images, ['AQ=='])
      assert.match(body.system_instruction.parts[0].text, /右列だけを上から順番に/)
    }
    return Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify(settlement(responses.shift()!)) }] } }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12, totalTokenCount: 42 },
    })
  }
  try {
    const result = await verifyBarPelotaSettlementCounts(generalReceipt, image, 'fixture', 'test-key', 'test-model')
    assert.equal(responses.length, 0)
    assert.equal(result.settlement, true)
    assert.equal(result.partyCount, null)
    assert.equal(result.guestCount, null)
    assert.equal(result.usages.length, 2)
    assert.equal(applyBarPelotaSettlementCounts(generalReceipt, result), null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('A second focused reading can confirm a correction to the general OCR', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json({
      candidates: [{
        content: { parts: [{ text: JSON.stringify(settlement([
          '純売上 ¥250,000', '販売点数 109', '返品点数 0', '総取引数 13', '客数 66',
        ])) }] },
      }],
    })
  }
  try {
    const generalReceipt = { ...receipt, partyCount: '13', guestCount: '13' }
    const image = { bytes: new Uint8Array([1]), contentType: 'image/jpeg' }
    const result = await verifyBarPelotaSettlementCounts(generalReceipt, image, 'fixture', 'test-key', 'test-model')
    assert.equal(calls, 2)
    assert.equal(applyBarPelotaSettlementCounts(generalReceipt, result)?.partyCount, '13')
    assert.equal(applyBarPelotaSettlementCounts(generalReceipt, result)?.guestCount, '66')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('The printed sequence keeps counts tied to their rows and rejects misordered evidence', () => {
  const ordered = ['純売上 ¥200,000', '販売点数 122', '返品点数 0', '総取引数 37', '客数 77']
  assert.deepEqual(parseBarPelotaSettlementCounts(settlement(ordered), true), {
    settlement: true, partyCount: 37, guestCount: 77,
  })
  assert.deepEqual(parseBarPelotaSettlementCounts(settlement([...ordered.slice(0, 3), ordered[4], ordered[3]]), true), {
    settlement: true, partyCount: null, guestCount: null,
  })
})
