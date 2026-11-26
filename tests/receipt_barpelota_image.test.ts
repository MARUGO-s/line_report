import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cropBarPelotaCountsDetail,
  estimateBarPelotaReceiptSkew,
  prepareBarPelotaReceiptImage,
} from '../supabase/functions/_shared/receipt_barpelota_image.ts'

function receiptWithRows(angle: number, valuesPresent = true) {
  const width = 360
  const height = 640
  const data = new Uint8Array(width * height * 4).fill(245)
  const slope = Math.tan(angle * Math.PI / 180)
  const columns = valuesPresent ? [[44, 136], [249, 323]] : [[44, 136]]

  for (const row of [388, 411, 441, 477, 502, 543, 574]) {
    for (const [left, right] of columns) {
      for (let x = left; x < right; x++) {
        // Gaps between strokes keep the fixture like ink on paper.
        if ((x - left) % 8 === 0) continue
        const top = Math.round(row + slope * (x - width / 2))
        for (let y = top; y < top + 3; y++) {
          const offset = (y * width + x) * 4
          data.fill(52, offset, offset + 3)
        }
      }
    }
  }
  return { data, width, height }
}

test('finds the local slope with either direction of skew', () => {
  for (const inputAngle of [3.25, -2.25]) {
    const estimated = estimateBarPelotaReceiptSkew(receiptWithRows(inputAngle))
    assert.ok(Math.abs(estimated - inputAngle) < 0.35, `expected ${inputAngle}, got ${estimated}`)
  }
})

test('leaves upright rows and unpaired label ink unchanged', () => {
  assert.equal(estimateBarPelotaReceiptSkew(receiptWithRows(0)), 0)
  assert.equal(estimateBarPelotaReceiptSkew(receiptWithRows(4, false)), 0)
})

test('provides a detail image with the full width and unchanged pixels', () => {
  const width = 8
  const height = 128
  const stride = width * 4
  const data = Uint8Array.from({ length: stride * height }, (_, i) => Math.floor(i / width) % 256)
  const cropped = cropBarPelotaCountsDetail({ data, width, height })
  assert.equal(cropped.width, width)
  assert.equal(cropped.height, 55)
  assert.deepEqual(cropped.data, data.subarray(72 * stride, 127 * stride))
})

test('preserves an unsupported or over-budget input without a replacement', async () => {
  const unsupported = new Uint8Array([1, 2, 3])
  const big = new Uint8Array(8 * 1024 * 1024 + 1)
  assert.deepEqual(await prepareBarPelotaReceiptImage(unsupported, 'image/gif'), {
    bytes: unsupported,
    contentType: 'image/gif',
    correctionDegrees: 0,
  })
  assert.equal((await prepareBarPelotaReceiptImage(big, 'image/jpeg')).bytes, big)
})
