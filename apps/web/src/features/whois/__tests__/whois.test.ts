import { describe, expect, it } from 'vitest'
import {
  describeStatus,
  formatCheckedAt,
  parseWhoisQuery,
  parseWhoisRecord,
  registeredHeadline,
  type WhoisRecord,
  whoisHref,
} from '../lib/whois'

const NOW = new Date('2026-09-24T12:00:00Z')

const record = (overrides: Partial<WhoisRecord> = {}): WhoisRecord => ({
  statuses: ['active'],
  registeredAt: '2015-03-01T10:00:00.000Z',
  lastTransferredAt: null,
  expiresAt: '2027-03-01T10:00:00.000Z',
  registrar: 'Example Registrar Ltd',
  nameservers: ['ns1.example-dns.net'],
  ...overrides,
})

describe('parseWhoisRecord', () => {
  it('reads the public facts and the nameservers', () => {
    expect(
      parseWhoisRecord({
        objectClassName: 'domain',
        status: ['clientTransferProhibited'],
        events: [{ eventAction: 'registration', eventDate: '2010-04-12T09:30:00Z' }],
        nameservers: [{ ldhName: 'NS1.EXAMPLE-DNS.NET' }],
      }),
    ).toEqual({
      statuses: ['client transfer prohibited'],
      registeredAt: '2010-04-12T09:30:00.000Z',
      lastTransferredAt: null,
      expiresAt: null,
      registrar: null,
      nameservers: ['ns1.example-dns.net'],
    })
  })

  it('carries nothing about the registrant, even when the registry publishes it', () => {
    const parsed = parseWhoisRecord({
      entities: [
        {
          roles: ['registrant'],
          vcardArray: [
            'vcard',
            [
              ['fn', {}, 'text', 'Adaeze Placeholder'],
              ['email', {}, 'text', 'adaeze@example.net'],
            ],
          ],
        },
      ],
    })
    expect(JSON.stringify(parsed)).not.toMatch(/Adaeze|example\.net/)
  })

  it('is null for an answer that is not a domain record', () => {
    expect(parseWhoisRecord('oops')).toBeNull()
  })
})

describe('parseWhoisQuery', () => {
  it('tolerates what people paste, like search does', () => {
    expect(parseWhoisQuery('https://www.GetPaid.com/about')).toEqual({
      ok: true,
      domain: 'getpaid.com',
      tld: 'com',
    })
  })

  it('needs an extension to know which registry to ask', () => {
    expect(parseWhoisQuery('getpaid')).toEqual({ ok: false, reason: 'no-extension' })
    expect(parseWhoisQuery('  ')).toEqual({ ok: false, reason: 'empty' })
  })
})

describe('whoisHref', () => {
  it('lands on the result', () => {
    expect(whoisHref('getpaid.com')).toBe('/whois?domain=getpaid.com#result')
  })
})

describe('describeStatus', () => {
  it('explains the common statuses in plain words', () => {
    expect(describeStatus('client transfer prohibited')).toMatch(/locked it against transfers/)
    expect(describeStatus('redemption period')).toMatch(/restore it/)
  })

  it('has no gloss for a status it does not know', () => {
    expect(describeStatus('vendor special hold')).toBeNull()
  })
})

describe('formatCheckedAt', () => {
  it('gives the time and date in Lagos', () => {
    expect(formatCheckedAt('2026-09-24T13:05:00Z')).toBe('14:05 on 24 September 2026')
  })
})

describe('registeredHeadline', () => {
  it('says who it is registered through, and until when', () => {
    expect(registeredHeadline('getpaid.com', record(), NOW)).toEqual({
      title: 'getpaid.com is registered',
      summary: 'It is registered through Example Registrar Ltd until 1 March 2027.',
    })
  })

  it('leaves out what the registry did not publish', () => {
    expect(
      registeredHeadline('getpaid.com', record({ registrar: null, expiresAt: null }), NOW).summary,
    ).toBe('It is registered.')
  })

  it('says when a domain is being deleted', () => {
    expect(
      registeredHeadline('getpaid.com', record({ statuses: ['pending delete'] }), NOW).title,
    ).toBe('getpaid.com is being deleted')
  })

  it('says when a domain is in its redemption period', () => {
    const { title, summary } = registeredHeadline(
      'getpaid.com',
      record({ statuses: ['redemption period'] }),
      NOW,
    )
    expect(title).toBe('getpaid.com has expired')
    expect(summary).toMatch(/redemption period/)
  })

  it('says when the expiry date has passed', () => {
    const { title, summary } = registeredHeadline(
      'getpaid.com',
      record({ expiresAt: '2026-09-01T00:00:00.000Z' }),
      NOW,
    )
    expect(title).toBe('getpaid.com has expired')
    expect(summary).toMatch(/still registered through Example Registrar Ltd/)
  })
})
