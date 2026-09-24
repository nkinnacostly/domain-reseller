import { describe, expect, it } from 'vitest'
import { describeEvent } from '../lib/activity'
import {
  failureReason,
  isTransferInProgress,
  nameserverNote,
  registrationNote,
  transferExpiryText,
} from '../lib/registration'

/** What a domain being transferred in says about itself (PRD E9, FR-T3). */

const transfer = { source: 'transfer' as const, testMode: false }

describe('registrationNote — transfers in', () => {
  it('says a paid transfer is queued, and in the sandbox for a test payment', () => {
    expect(registrationNote({ ...transfer, status: 'transfer_requested' })?.title).toBe(
      'Transfer starting.',
    )
    expect(registrationNote({ ...transfer, testMode: true, status: 'transfer_requested' })).toEqual(
      {
        title: 'Transfer starting in the sandbox.',
        body: expect.stringMatching(/not the live registry/),
      },
    )
  })

  it('says who a transfer in progress waits on, and when the registry steps in', () => {
    const note = registrationNote({ ...transfer, status: 'transfer_pending' })
    expect(note?.title).toBe('Transfer in progress.')
    expect(note?.body).toMatch(/current registrar may email the domain’s owner/)
    expect(note?.body).toMatch(/after five days/)
  })

  it('says why a transfer failed, in our words, and what happens to the money', () => {
    expect(
      registrationNote({
        ...transfer,
        status: 'transfer_cancelled',
        failureCode: 'AUTH_CODE_INVALID',
      }),
    ).toEqual({
      title: 'Transfer cancelled.',
      body: 'The current registrar did not accept the transfer code. We’ll refund what you paid for it.',
    })
    expect(
      registrationNote({
        ...transfer,
        testMode: true,
        status: 'transfer_rejected',
        failureCode: 'TRANSFER_REJECTED',
      }),
    ).toEqual({
      title: 'Transfer refused.',
      body: 'The transfer was refused or cancelled before it completed. This was a test payment, so no money moved.',
    })
  })

  it('labels a sandbox transfer once it lands, and says nothing of a live one', () => {
    expect(registrationNote({ ...transfer, testMode: true, status: 'active' })?.title).toBe(
      'Sandbox transfer.',
    )
    expect(registrationNote({ ...transfer, status: 'active' })).toBeNull()
  })
})

describe('the rest of a transfer’s page', () => {
  it('knows which states are still moving', () => {
    expect(isTransferInProgress('transfer_requested')).toBe(true)
    expect(isTransferInProgress('transfer_pending')).toBe(true)
    expect(isTransferInProgress('transfer_rejected')).toBe(false)
    expect(isTransferInProgress('active')).toBe(false)
  })

  it('never shows a registration date where a transfer has none yet', () => {
    expect(transferExpiryText({ ...transfer, status: 'transfer_pending' })).toBe(
      'After the transfer',
    )
    expect(transferExpiryText({ ...transfer, status: 'transfer_cancelled' })).toBe(
      'Not transferred',
    )
    expect(transferExpiryText({ source: 'registration', status: 'pending' })).toBeNull()
  })

  it('says nameservers wait for the transfer to finish', () => {
    expect(
      nameserverNote({ ...transfer, status: 'transfer_pending', pendingNameservers: null }),
    ).toEqual({
      title: 'Transfer in progress.',
      body: expect.stringMatching(/once the transfer completes/),
    })
  })

  it('explains every transfer failure code in words, never the supplier’s (N10)', () => {
    for (const code of [
      'AUTH_CODE_INVALID',
      'AUTH_CODE_MISSING',
      'TRANSFER_LOCKED',
      'NOT_TRANSFERABLE',
      'TRANSFER_REJECTED',
      'ALREADY_HERE',
    ]) {
      expect(failureReason(code)).not.toBe('The registry could not complete it.')
    }
  })
})

describe('describeEvent — transfers in', () => {
  it('says the request went to the registry, and who it waits on', () => {
    expect(describeEvent('transfer_submitted', {})).toBe(
      'Transfer request sent to the registry — waiting on the current registrar',
    )
  })

  it('says it transferred in, with the expiry the registry holds', () => {
    expect(
      describeEvent('transferred_in', { expires_at: '2027-03-01T10:00:00Z', sandbox: false }),
    ).toBe('Transferred in — expires 1 March 2027')
    expect(describeEvent('transferred_in', { sandbox: true })).toBe(
      'Transferred into the registrar’s test system',
    )
  })

  it('explains a failed or delayed transfer in our words', () => {
    expect(describeEvent('transfer_failed', { code: 'TRANSFER_LOCKED' })).toBe(
      'Transfer failed: The domain is locked at its current registrar.',
    )
    expect(describeEvent('transfer_delayed', {})).toBe('Transfer delayed — waiting on the registry')
  })
})
