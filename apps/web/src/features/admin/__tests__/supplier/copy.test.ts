import { describe, expect, it } from 'vitest'
import { ADMIN_ERROR_WORDS } from '@/features/admin/lib/errors'
import {
  APPLY_PRICE_LIST,
  APPLY_SSL_LIST,
  CORRECT_TOPUP,
  notOfferedWords,
  OWNER_ONLY,
  RECORD_TOPUP,
  TOPUP_CODE_WORDS,
  TOPUP_FIELDS,
} from '@/features/admin/lib/supplier-copy'

describe('the owner’s dialogs, word for word (§5.2 B6)', () => {
  it('Apply price list', () => {
    expect(APPLY_PRICE_LIST.body).toBe(
      'This is the weekly sync, run early: it writes only changes it trusts, refuses a listing that looks broken, and reports the rest. Site prices update on the next refresh.',
    )
    expect(APPLY_PRICE_LIST.confirm).toBe('Apply price list')
    expect(APPLY_PRICE_LIST.cancel).toBe('Not now')
  })

  it('Apply the SSL product list says it never changes what is on sale', () => {
    expect(APPLY_SSL_LIST.body).toContain('It never changes which products are on sale.')
    expect(APPLY_SSL_LIST.cancel).toBe('Not now')
  })

  it('Record top-up cost', () => {
    expect(RECORD_TOPUP.rows).toEqual({
      credit: 'Ledger credit',
      paid: 'NGN paid',
      reference: 'Reference',
      rate: 'Effective rate',
    })
    expect(RECORD_TOPUP.confirm).toBe('Record top-up')
    expect(RECORD_TOPUP.cancel).toBe('Cancel')
    expect(RECORD_TOPUP.trigger).toBe('Record what it cost')
  })

  it('Correct a top-up', () => {
    expect(CORRECT_TOPUP.title).toBe('Correct what this top-up cost?')
    expect(CORRECT_TOPUP.body).toBe('The first record stays in history, marked as corrected.')
    expect(CORRECT_TOPUP.trigger).toBe('Correct')
  })

  it('words the wrapper’s shared codes for a top-up, not a refund', () => {
    expect(TOPUP_CODE_WORDS.BAD_REFERENCE).toBe(TOPUP_FIELDS.referenceInvalid)
    expect(TOPUP_CODE_WORDS.BAD_REFERENCE).not.toBe(ADMIN_ERROR_WORDS.BAD_REFERENCE)
    expect(TOPUP_CODE_WORDS.OUT_OF_RANGE).toBe(TOPUP_FIELDS.paidInvalid)
  })
})

describe('why a control is not offered', () => {
  const owner = { role: 'owner' as const, testOnly: false }
  const operator = { role: 'operator' as const, testOnly: false }
  const viewer = { role: 'viewer' as const, testOnly: false }
  const testOperator = { role: 'operator' as const, testOnly: true }

  it('gives a test administrator SQL’s own words for an action never open to one', () => {
    expect(notOfferedWords(testOperator, 'supplier.price_check')).toBe(
      "Test administrators can't do this on live records.",
    )
    expect(notOfferedWords(testOperator, 'supplier.catalogue_preview', OWNER_ONLY.catalogue)).toBe(
      "Test administrators can't do this on live records.",
    )
    expect(notOfferedWords(testOperator, 'supplier.balance')).toBeNull()
  })

  it('gives the owner-only words, else the role words, to a role below the action', () => {
    expect(notOfferedWords(operator, 'supplier.catalogue_preview', OWNER_ONLY.catalogue)).toBe(
      'Only the owner previews and applies the price list.',
    )
    expect(notOfferedWords(operator, 'topup.record', OWNER_ONLY.topups)).toBe(
      'Only the owner records and corrects what a top-up cost.',
    )
    expect(notOfferedWords(viewer, 'supplier.domain_lookup')).toBe(
      "Your admin role can't do this. Ask the owner.",
    )
    expect(notOfferedWords(operator, 'supplier.catalogue_apply')).toBe(
      "Your admin role can't do this. Ask the owner.",
    )
  })

  it('offers each action to the roles it is for', () => {
    expect(notOfferedWords(owner, 'supplier.catalogue_apply')).toBeNull()
    expect(notOfferedWords(operator, 'supplier.price_check')).toBeNull()
    expect(notOfferedWords(viewer, 'supplier.ledger_live')).toBeNull()
  })
})
