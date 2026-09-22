import { describe, expect, it } from 'vitest'
import { evaluateTransfer, formatDate, type TransferCheck } from '../lib/eligibility'
import type { RdapLookup, RdapRecord } from '../lib/rdap'

const NOW = new Date('2026-09-22T12:00:00Z')

const record = (overrides: Partial<RdapRecord> = {}): RdapLookup => ({
  kind: 'found',
  record: {
    statuses: ['active'],
    registeredAt: '2015-03-01T10:00:00.000Z',
    lastTransferredAt: null,
    expiresAt: '2027-03-01T10:00:00.000Z',
    registrar: 'Example Registrar Ltd',
    ...overrides,
  },
})

const evaluate = (
  lookup: RdapLookup | null,
  offer: 'offered' | 'not-offered' | 'unknown' = 'offered',
) => evaluateTransfer({ domain: 'getpaid.com', tld: 'com', offer, lookup, now: NOW })

const check = (checks: TransferCheck[], id: TransferCheck['id']) => {
  const found = checks.find((c) => c.id === id)
  if (!found) throw new Error(`no ${id} check`)
  return found
}

describe('evaluateTransfer — what blocks a transfer', () => {
  it('stops at the extension when we cannot take it, without asking the registry', () => {
    const verdict = evaluate(null, 'not-offered')
    expect(verdict.outcome).toBe('unsupported-extension')
    expect(verdict.checks).toHaveLength(1)
    expect(verdict.checks[0]?.detail).toBe("We don't take transfers for .com yet.")
  })

  it('says there is nothing to transfer when nobody has registered the name', () => {
    const verdict = evaluate({ kind: 'not-found' })
    expect(verdict.outcome).toBe('not-registered')
    expect(check(verdict.checks, 'registered').state).toBe('fail')
  })

  it('blocks on a registrar lock and says where to turn it off', () => {
    const verdict = evaluate(record({ statuses: ['client transfer prohibited'] }))
    const lock = check(verdict.checks, 'unlocked')
    expect(verdict.outcome).toBe('blocked')
    expect(lock.state).toBe('fail')
    expect(lock.detail).toMatch(/^Example Registrar Ltd has it locked/)
  })

  it('treats a registry lock as a job for the registrar, and mentions both locks', () => {
    const verdict = evaluate(
      record({ statuses: ['client transfer prohibited', 'server transfer prohibited'] }),
    )
    const lock = check(verdict.checks, 'unlocked')
    expect(lock.state).toBe('fail')
    expect(lock.detail).toContain('Contact Example Registrar Ltd')
    expect(lock.detail).toContain('turn off the transfer lock')
  })

  it('names no registrar it does not know', () => {
    const verdict = evaluate(record({ statuses: ['client transfer prohibited'], registrar: null }))
    expect(check(verdict.checks, 'unlocked').detail).toMatch(
      /^Your current registrar has it locked/,
    )
  })

  it('blocks a new registration and gives the exact date it can move', () => {
    const verdict = evaluate(record({ registeredAt: '2026-09-12T09:00:00.000Z' }))
    const window = check(verdict.checks, 'window')

    expect(verdict.outcome).toBe('blocked')
    expect(window.state).toBe('fail')
    expect(window.unblocksAt).toBe('2026-11-11T09:00:00.000Z')
    expect(window.detail).toContain('12 September 2026')
    expect(window.detail).toContain('11 November 2026')
    // Time is the only blocker, so the headline can promise the date.
    expect(verdict.opensOn).toBe('2026-11-11T09:00:00.000Z')
  })

  it('counts from the last transfer when it is later than the registration', () => {
    const verdict = evaluate(record({ lastTransferredAt: '2026-08-30T00:00:00.000Z' }))
    const window = check(verdict.checks, 'window')
    expect(window.state).toBe('fail')
    expect(window.detail).toMatch(/^It last changed registrar on 30 August 2026/)
  })

  it('gives no date when something other than time is in the way', () => {
    const verdict = evaluate(
      record({
        registeredAt: '2026-09-12T09:00:00.000Z',
        statuses: ['client transfer prohibited'],
      }),
    )
    expect(verdict.outcome).toBe('blocked')
    expect(verdict.opensOn).toBeNull()
  })

  it.each([
    ['redemption period', /redemption period/],
    ['pending restore', /redemption period/],
    ['pending delete', /being deleted cannot be transferred/],
    ['pending transfer', /already in progress/],
  ])('blocks a domain in %s', (status, message) => {
    const verdict = evaluate(record({ statuses: [status] }))
    const state = check(verdict.checks, 'status')
    expect(verdict.outcome).toBe('blocked')
    expect(state.state).toBe('fail')
    expect(state.detail).toMatch(message)
  })
})

describe('evaluateTransfer — what we cannot see', () => {
  it('asks the owner to confirm an expired domain rather than guessing', () => {
    const verdict = evaluate(record({ expiresAt: '2026-09-01T00:00:00.000Z' }))
    const state = check(verdict.checks, 'status')
    expect(state.state).toBe('manual')
    expect(state.detail).toContain('expired on 1 September 2026')
    expect(verdict.outcome).toBe('needs-confirmation')
  })

  it('hands every registry check to the owner when the registry publishes nothing', () => {
    const verdict = evaluateTransfer({
      domain: 'getpaid.co',
      tld: 'co',
      offer: 'offered',
      lookup: { kind: 'unsupported' },
      now: NOW,
    })
    expect(verdict.outcome).toBe('needs-confirmation')
    expect(check(verdict.checks, 'registered').detail).toContain('.co registry does not publish')
    for (const id of ['registered', 'unlocked', 'window', 'status'] as const) {
      expect(check(verdict.checks, id).state).toBe('manual')
    }
  })

  it('says the registry did not answer, not that the domain is fine', () => {
    const verdict = evaluate({ kind: 'unavailable' })
    expect(verdict.outcome).toBe('needs-confirmation')
    expect(check(verdict.checks, 'registered').detail).toMatch(/did not answer/)
  })

  it('does not claim we take an extension when the price list could not be read', () => {
    const verdict = evaluate(record(), 'unknown')
    expect(check(verdict.checks, 'extension').state).toBe('manual')
    expect(verdict.outcome).toBe('needs-confirmation')
  })

  it('asks for the registration date when the registry does not publish it', () => {
    const verdict = evaluate(record({ registeredAt: null }))
    expect(check(verdict.checks, 'window').state).toBe('manual')
  })
})

describe('evaluateTransfer — ready', () => {
  it('is ready when everything the registry shows is in order', () => {
    const verdict = evaluate(record())
    expect(verdict.outcome).toBe('ready')
    expect(verdict.registrar).toBe('Example Registrar Ltd')
    expect(verdict.checks.filter((c) => c.state === 'fail')).toEqual([])
  })

  it('always leaves the auth code to the owner — we cannot see it', () => {
    expect(check(evaluate(record()).checks, 'auth-code').state).toBe('manual')
  })

  it('lets a domain move on the day its waiting period ends', () => {
    const verdict = evaluate(record({ registeredAt: '2026-07-24T12:00:00.000Z' }))
    expect(check(verdict.checks, 'window').state).toBe('pass')
  })
})

describe('formatDate', () => {
  it('shows dates as they fall in Lagos, not in UTC', () => {
    expect(formatDate('2026-09-22T23:30:00Z')).toBe('23 September 2026')
  })
})
