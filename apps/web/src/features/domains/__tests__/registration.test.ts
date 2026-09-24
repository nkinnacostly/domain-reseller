import { describe, expect, it } from 'vitest'
import { failureReason, nameserverNote, registrationNote } from '../lib/registration'

const live = { source: 'registration', testMode: false } as const
const test = { source: 'registration', testMode: true } as const
const VERCEL = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']

describe('registrationNote', () => {
  it('says a live order is queued, promising nothing about when', () => {
    expect(registrationNote({ ...live, status: 'pending' })).toMatchObject({
      title: 'Registering.',
    })
  })

  it('says a test order goes to the sandbox and will not work on the internet (N9b)', () => {
    const note = registrationNote({ ...test, status: 'pending' })
    expect(note?.title).toBe('Registering in the sandbox.')
    expect(note?.body).toMatch(/not the live registry/)
  })

  it('keeps labelling a test domain once it is registered', () => {
    expect(registrationNote({ ...test, status: 'active' })?.title).toBe('Sandbox registration.')
  })

  it('has nothing to add for a live active domain', () => {
    expect(registrationNote({ ...live, status: 'active' })).toBeNull()
  })

  it('explains a failure in our words and owes a refund on a live order', () => {
    const note = registrationNote({
      ...live,
      status: 'registration_failed',
      failureCode: 'DOMAIN_TAKEN',
    })
    expect(note?.body).toBe(
      'Someone else registered this name before we could. We’ll refund what you paid for it.',
    )
  })

  it('does not owe a refund on a test order', () => {
    const note = registrationNote({ ...test, status: 'registration_failed', failureCode: null })
    expect(note?.body).toMatch(/no money moved/)
    expect(note?.body).not.toMatch(/refund/)
  })

  it('never registers a demo domain', () => {
    expect(registrationNote({ source: 'demo', testMode: false, status: 'pending' })?.body).toBe(
      'It is never registered.',
    )
  })
})

describe('failureReason (N10)', () => {
  it('never passes a supplier code through', () => {
    expect(failureReason('SUPPLIER_INSUFFICIENT_FUNDS')).toBe('The registry could not complete it.')
    expect(failureReason(undefined)).toBe('The registry could not complete it.')
  })

  it('explains a renewal the registry would not make, in plain words', () => {
    expect(failureReason('NOT_RENEWABLE')).toBe('This domain is not one this account can renew.')
    expect(failureReason('DOMAIN_NOT_FOUND')).toBe(
      'The registry does not list this domain in our account.',
    )
  })
})

describe('nameserverNote', () => {
  it('says nothing when no change is waiting', () => {
    expect(nameserverNote({ ...live, status: 'active', pendingNameservers: null })).toBeNull()
  })

  it('says a change on an active domain has gone to the registry', () => {
    expect(nameserverNote({ ...live, status: 'active', pendingNameservers: VERCEL })).toEqual({
      title: 'Sent to the registry.',
      body: 'Waiting to be applied: ns1.vercel-dns.com, ns2.vercel-dns.com.',
    })
  })

  it('waits for registration on a domain still registering', () => {
    expect(nameserverNote({ ...live, status: 'pending', pendingNameservers: VERCEL })?.title).toBe(
      'Waiting for registration.',
    )
  })

  it('never claims a demo change reached a registry', () => {
    expect(
      nameserverNote({
        source: 'demo',
        testMode: false,
        status: 'active',
        pendingNameservers: VERCEL,
      })?.body,
    ).toMatch(/Nothing is sent to a registry/)
  })
})
