import { describe, expect, it } from 'vitest'
import {
  normaliseStatus,
  parseBootstrap,
  parseRdapDomain,
  rdapBaseFor,
  rdapDomainUrl,
} from '../lib/rdap'

/** Trimmed from a real rdap.verisign.com response for google.com. */
const GOOGLE_COM = {
  objectClassName: 'domain',
  ldhName: 'GOOGLE.COM',
  status: ['client delete prohibited', 'client transfer prohibited', 'server transfer prohibited'],
  events: [
    { eventAction: 'registration', eventDate: '1997-09-15T04:00:00Z' },
    { eventAction: 'expiration', eventDate: '2028-09-14T04:00:00Z' },
    { eventAction: 'last changed', eventDate: '2019-09-09T15:39:04Z' },
  ],
  entities: [
    {
      objectClassName: 'entity',
      roles: ['registrar'],
      vcardArray: [
        'vcard',
        [
          ['version', {}, 'text', '4.0'],
          ['fn', {}, 'text', 'MarkMonitor Inc.'],
        ],
      ],
    },
  ],
}

describe('parseBootstrap', () => {
  it('refuses a file that is not an RDAP bootstrap', () => {
    expect(() => parseBootstrap({ services: 'nope' })).toThrow()
    expect(() => parseBootstrap(null)).toThrow()
  })

  it('keeps only HTTPS endpoints, so no decision rests on a plain-HTTP answer', () => {
    const table = parseBootstrap({
      services: [
        [['org'], ['http://insecure.test/', 'https://secure.test/']],
        [['plain'], ['http://only-http.test/']],
      ],
    })
    expect(table.org).toBe('https://secure.test/')
    expect(table.plain).toBeUndefined()
  })

  it('maps every suffix a service lists', () => {
    const table = parseBootstrap({ services: [[['COM', 'net'], ['https://verisign.test/']]] })
    expect(table).toEqual({ com: 'https://verisign.test/', net: 'https://verisign.test/' })
  })
})

describe('rdapBaseFor', () => {
  const table = { uk: 'https://uk.test/', 'co.uk': 'https://co-uk.test/', com: 'https://com.test/' }

  it('prefers the longest matching suffix (RFC 9224)', () => {
    expect(rdapBaseFor(table, 'getpaid.co.uk')).toBe('https://co-uk.test/')
    expect(rdapBaseFor(table, 'getpaid.org.uk')).toBe('https://uk.test/')
  })

  it('returns null when no registry runs RDAP for the extension', () => {
    expect(rdapBaseFor(table, 'getpaid.co')).toBeNull()
  })

  it('never matches the whole name as if it were an extension', () => {
    expect(rdapBaseFor(table, 'com')).toBeNull()
  })
})

describe('rdapDomainUrl', () => {
  it('joins the base and domain whether or not the base ends in a slash', () => {
    expect(rdapDomainUrl('https://r.test/v1/', 'GetPaid.com')).toBe(
      'https://r.test/v1/domain/getpaid.com',
    )
    expect(rdapDomainUrl('https://r.test/v1', 'getpaid.com')).toBe(
      'https://r.test/v1/domain/getpaid.com',
    )
  })
})

describe('parseRdapDomain', () => {
  it('returns null for anything that is not a domain object', () => {
    expect(parseRdapDomain('<html>')).toBeNull()
    expect(parseRdapDomain(null)).toBeNull()
    expect(parseRdapDomain({ status: 'active' })).toBeNull()
  })

  it('reads statuses, dates and the registrar from a real response', () => {
    expect(parseRdapDomain(GOOGLE_COM)).toEqual({
      statuses: [
        'client delete prohibited',
        'client transfer prohibited',
        'server transfer prohibited',
      ],
      registeredAt: '1997-09-15T04:00:00.000Z',
      lastTransferredAt: null,
      expiresAt: '2028-09-14T04:00:00.000Z',
      registrar: 'MarkMonitor Inc.',
    })
  })

  it('takes the most recent transfer when a registry lists several', () => {
    const record = parseRdapDomain({
      events: [
        { eventAction: 'transfer', eventDate: '2012-03-09T00:00:00Z' },
        { eventAction: 'transfer', eventDate: '2024-06-01T00:00:00Z' },
      ],
    })
    expect(record?.lastTransferredAt).toBe('2024-06-01T00:00:00.000Z')
  })

  it('ignores an event date it cannot read rather than inventing one', () => {
    const record = parseRdapDomain({
      events: [{ eventAction: 'registration', eventDate: 'not a date' }],
    })
    expect(record?.registeredAt).toBeNull()
  })

  it('copes with a registry that publishes no events, status or registrar', () => {
    expect(parseRdapDomain({ objectClassName: 'domain' })).toEqual({
      statuses: [],
      registeredAt: null,
      lastTransferredAt: null,
      expiresAt: null,
      registrar: null,
    })
  })
})

describe('normaliseStatus', () => {
  it('reads the EPP spelling and the RFC 8056 spelling as the same status', () => {
    expect(normaliseStatus('clientTransferProhibited')).toBe('client transfer prohibited')
    expect(normaliseStatus('Client Transfer Prohibited ')).toBe('client transfer prohibited')
  })
})
