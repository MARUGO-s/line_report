import test from 'node:test'
import assert from 'node:assert/strict'
import { isReceiptDeletionConfirmation } from '../supabase/functions/_shared/receipt_delete_confirmation.ts'

test('requires the exact deletion confirmation word', () => {
  assert.equal(isReceiptDeletionConfirmation('削除'), true)
  assert.equal(isReceiptDeletionConfirmation(' 削除 '), true)
  assert.equal(isReceiptDeletionConfirmation('削除します'), false)
  assert.equal(isReceiptDeletionConfirmation('はい'), false)
})

