import { TRANSFER_LOCK_DAYS, TRANSFER_REFUSALS } from '@dr/shared'
import { describe, expect, it } from 'vitest'
import { evaluateTransfer, type TransferVerdict } from '../lib/eligibility'
import { transferStartHref } from '../lib/href'
import {
  canStartTransfer,
  TRANSFER_REFUSAL_MESSAGE,
  takesTransfers,
  transferCostUsd,
} from '../lib/start'

const NOW = new Date('2026-09-22T12:00:00Z')

const verdictFor = (
  lookup: Parameters<typeof evaluateTransfer>[0]['lookup'],
  offer: Parameters<typeof evaluateTransfer>[0]['offer'] = 'offered',
): TransferVerdict =>
  evaluateTransfer({ domain: 'getpaid.com', tld: 'com', offer, lookup, now: NOW })

const record = (over: Record<string, unknown> = {}) => ({
  kind: 'found' as const,
  record: {
    statuses: ['active'],
    registeredAt: '2015-03-01T10:00:00.000Z',
    lastTransferredAt: null,
    expiresAt: '2027-03-01T10:00:00.000Z',
    registrar: 'Example Registrar Ltd',
    ...over,
  },
})

describe('canStartTransfer (FR-T1)', () => {
  it('refuses a domain inside the 60-day window, with the date it can move (FR-T7)', () => {
    const start = canStartTransfer(verdictFor(record({ registeredAt: '2026-09-01T10:00:00.000Z' })))
    expect(start.ok).toBe(false)
    expect(!start.ok && start.reason).toMatch(/^getpaid\.com can’t be transferred yet\./)
    expect(!start.ok && start.reason).toMatch(/so it can move from 31 October 2026/)
  })

  it('refuses a locked domain, saying who to ask', () => {
    const start = canStartTransfer(verdictFor(record({ statuses: ['client transfer prohibited'] })))
    expect(!start.ok && start.reason).toMatch(/Example Registrar Ltd has it locked/)
  })

  it('refuses a name nobody holds, and an extension we do not take', () => {
    expect(canStartTransfer(verdictFor({ kind: 'not-found' }))).toEqual({
      ok: false,
      reason: expect.stringMatching(/you can register it instead/),
    })
    expect(canStartTransfer(verdictFor(null, 'not-offered'))).toEqual({
      ok: false,
      reason: 'We don’t take transfers for .com yet.',
    })
  })

  it('lets a clean record through, and one only the owner can confirm — the code check covers that', () => {
    expect(canStartTransfer(verdictFor(record()))).toEqual({ ok: true })
    expect(canStartTransfer(verdictFor({ kind: 'unsupported' }))).toEqual({ ok: true })
    expect(canStartTransfer(verdictFor({ kind: 'unavailable' }))).toEqual({ ok: true })
  })
})

describe('TRANSFER_REFUSAL_MESSAGE (N10, UX-7)', () => {
  it('says what to do for every reason the supplier can give', () => {
    for (const reason of TRANSFER_REFUSALS) {
      expect(TRANSFER_REFUSAL_MESSAGE[reason].length).toBeGreaterThan(20)
    }
    expect(TRANSFER_REFUSAL_MESSAGE.AUTH_CODE_INVALID).toMatch(/case-sensitive/)
    expect(TRANSFER_REFUSAL_MESSAGE.TRANSFER_LOCKED).toMatch(/Turn off the transfer lock/)
    expect(TRANSFER_REFUSAL_MESSAGE.NOT_TRANSFERABLE).toMatch(
      new RegExp(`last ${TRANSFER_LOCK_DAYS} days`),
    )
  })
})

describe('takesTransfers (N5b)', () => {
  it('needs the catalogue’s yes and a transfer price', () => {
    expect(takesTransfers({ is_transferable: true, transfer_usd: 10.61 })).toBe(true)
    expect(takesTransfers({ is_transferable: true, transfer_usd: '10.6100' })).toBe(true)
  })

  it('reads a flag not yet synced as no, and a free transfer as not offered', () => {
    expect(takesTransfers({ is_transferable: null, transfer_usd: 10.61 })).toBe(false)
    expect(takesTransfers({ is_transferable: false, transfer_usd: 10.61 })).toBe(false)
    expect(takesTransfers({ is_transferable: true, transfer_usd: 0 })).toBe(false)
    expect(takesTransfers({ is_transferable: true, transfer_usd: null })).toBe(false)
  })
})

describe('transferCostUsd (FR-C8)', () => {
  it('adds the ICANN fee once, on generic extensions only, split out', () => {
    // $10.61 and $0.20 for ICANN: $10.81.
    expect(transferCostUsd({ transferUsd: 10.61, isCountryCode: false }, 0.2)).toEqual({
      supplierCents: 1061,
      icannCents: 20,
    })
    expect(transferCostUsd({ transferUsd: '38.9900', isCountryCode: true }, '0.2000')).toEqual({
      supplierCents: 3899,
      icannCents: 0,
    })
  })
})

describe('transferStartHref', () => {
  it('points at the signed-in transfer checkout, with the name encoded', () => {
    expect(transferStartHref('getpaid.com')).toBe('/app/transfers/new?domain=getpaid.com')
    expect(transferStartHref('a&b.com')).toBe('/app/transfers/new?domain=a%26b.com')
  })
})
