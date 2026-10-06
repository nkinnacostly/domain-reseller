import { describe, expect, it } from 'vitest'
import { useFakeDoh, useFakeSes } from '../../../../tests/mocks/ses'
import {
  combine,
  createDnsLookup,
  matches,
  PUBLIC_RESOLVERS,
  readView,
  txtText,
} from '../lib/dns-check'
import { DMARC_VALUE, domainRecords, hostLabel, SPF_VALUE } from '../lib/records'

/**
 * The records a domain needs (MAIL-SPEC §5) and what public DNS says of each,
 * asked of Cloudflare and Google over DNS-over-HTTPS (answered by the fake
 * resolver: no test reaches a real one).
 */

const TOKENS = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2', 'ccc3']
const records = domainRecords({
  name: 'acme.example',
  dkimTokens: TOKENS,
  mailFromDomain: 'send.acme.example',
  region: 'eu-west-2',
})
const byId = (id: string) => {
  const record = records.find((r) => r.id === id)
  if (!record) throw new Error(id)
  return record
}

describe('the records to add (§5)', () => {
  it('three DKIM CNAMEs, the MAIL FROM MX and SPF on send., and a suggested DMARC', () => {
    expect(records.map((r) => [r.type, r.name, r.value, r.priority, r.required])).toEqual([
      [
        'CNAME',
        `${TOKENS[0]}._domainkey.acme.example`,
        `${TOKENS[0]}.dkim.amazonses.com`,
        undefined,
        true,
      ],
      [
        'CNAME',
        `${TOKENS[1]}._domainkey.acme.example`,
        `${TOKENS[1]}.dkim.amazonses.com`,
        undefined,
        true,
      ],
      [
        'CNAME',
        `${TOKENS[2]}._domainkey.acme.example`,
        `${TOKENS[2]}.dkim.amazonses.com`,
        undefined,
        true,
      ],
      ['MX', 'send.acme.example', 'feedback-smtp.eu-west-2.amazonses.com', 10, true],
      ['TXT', 'send.acme.example', SPF_VALUE, undefined, true],
      ['TXT', '_dmarc.acme.example', DMARC_VALUE, undefined, false],
    ])
  })

  it('MAIL FROM is send.<domain> when SES has not said yet', () => {
    const plain = domainRecords({
      name: 'acme.example',
      dkimTokens: [],
      mailFromDomain: null,
      region: 'eu-west-2',
    })
    expect(plain.map((r) => r.name)).toEqual([
      'send.acme.example',
      'send.acme.example',
      '_dmarc.acme.example',
    ])
  })

  it('names as DNS editors want them: the part before the zone, or @', () => {
    expect(hostLabel('abc._domainkey.acme.example', 'acme.example')).toBe('abc._domainkey')
    expect(hostLabel('acme.example', 'acme.example')).toBe('@')
    expect(hostLabel('other.example', 'acme.example')).toBe('other.example')
  })
})

describe('reading a resolver’s answer', () => {
  it('a CNAME matches with or without its trailing dot, in any case', () => {
    expect(matches(byId('dkim-1'), `${TOKENS[0]}.DKIM.amazonses.com.`)).toBe(true)
    expect(matches(byId('dkim-1'), 'elsewhere.example.')).toBe(false)
  })

  it('an MX matches on its host, whatever its priority', () => {
    expect(matches(byId('mail-from-mx'), '20 feedback-smtp.eu-west-2.amazonses.com.')).toBe(true)
    expect(matches(byId('mail-from-mx'), '10 feedback-smtp.us-east-1.amazonses.com.')).toBe(false)
  })

  it('a TXT is read whole, split strings joined, quotes and spacing aside', () => {
    expect(txtText('"v=spf1 include:" "amazonses.com ~all"')).toBe(
      'v=spf1 include:amazonses.com ~all',
    )
    expect(txtText('"say \\"hi\\""')).toBe('say "hi"')
    expect(txtText('bare')).toBe('bare')
    expect(matches(byId('mail-from-spf'), '"v=spf1  include:amazonses.com ~all"')).toBe(true)
    expect(matches(byId('mail-from-spf'), '"v=spf1 -all"')).toBe(false)
  })

  it('any DMARC policy the owner has counts as theirs', () => {
    expect(matches(byId('dmarc'), '"v=DMARC1; p=reject; rua=mailto:x@acme.example"')).toBe(true)
    expect(matches(byId('dmarc'), '"google-site-verification=1"')).toBe(false)
  })

  it('NXDOMAIN is missing; SERVFAIL or nonsense is unknown; another value is different', () => {
    const spf = byId('mail-from-spf')
    expect(readView(spf, { Status: 3 })).toEqual({ state: 'missing', seen: [] })
    expect(readView(spf, { Status: 2 })).toEqual({ state: 'unknown', seen: [] })
    expect(readView(spf, 'nope')).toEqual({ state: 'unknown', seen: [] })
    expect(
      readView(spf, {
        Status: 0,
        Answer: [
          { name: 'send.acme.example.', type: 16, data: '"v=spf1 -all"' },
          { name: 'send.acme.example.', type: 16, data: '"site-verification=x"' },
          { name: 'other.example.', type: 16, data: `"${SPF_VALUE}"` },
          { name: 'send.acme.example.', type: 5, data: 'x.example.' },
          'junk',
        ],
      }),
    ).toEqual({ state: 'different', seen: ['v=spf1 -all'] })
    expect(readView(spf, { Status: 0 })).toEqual({ state: 'missing', seen: [] })
    expect(
      readView(byId('dkim-1'), {
        Status: 0,
        Answer: [
          { name: `${TOKENS[0]}._domainkey.acme.example.`, type: 5, data: 'wrong.example.' },
        ],
      }),
    ).toEqual({ state: 'different', seen: ['wrong.example'] })
  })

  it('combines the resolvers: all found, some found (spreading), none answering (unknown)', () => {
    const found = { state: 'found' as const, seen: [] }
    const missing = { state: 'missing' as const, seen: [] }
    const unknown = { state: 'unknown' as const, seen: [] }
    expect(combine('x', [found, unknown]).state).toBe('found')
    expect(combine('x', [found, missing]).state).toBe('spreading')
    expect(combine('x', [unknown, unknown]).state).toBe('unknown')
    expect(combine('x', [missing, missing]).state).toBe('missing')
    expect(
      combine('x', [
        { state: 'different', seen: ['a'] },
        { state: 'different', seen: ['a', 'b'] },
      ]),
    ).toEqual({ id: 'x', state: 'different', seen: ['a', 'b'] })
  })
})

describe('the live check, over DNS-over-HTTPS', () => {
  it('asks Cloudflare and Google for each record by name and type', async () => {
    const ses = useFakeSes()
    const asked = useFakeDoh(ses)
    ses.publish(`${TOKENS[0]}._domainkey.acme.example`, 'CNAME', `${TOKENS[0]}.dkim.amazonses.com.`)
    ses.publish('send.acme.example', 'TXT', '"v=spf1 -all"')
    const seen = await createDnsLookup()(records)
    expect(seen.map((r) => [r.id, r.state])).toEqual([
      ['dkim-1', 'found'],
      ['dkim-2', 'missing'],
      ['dkim-3', 'missing'],
      ['mail-from-mx', 'missing'],
      ['mail-from-spf', 'different'],
      ['dmarc', 'missing'],
    ])
    expect(asked).toContain(`CNAME ${TOKENS[0]}._domainkey.acme.example`)
    expect(asked).toHaveLength(records.length * PUBLIC_RESOLVERS.length)
  })

  it('a resolver that fails or cannot be reached counts for nothing', async () => {
    const ses = useFakeSes()
    useFakeDoh(ses, { down: true })
    expect((await createDnsLookup()([byId('dmarc')]))[0]?.state).toBe('unknown')
    const broken = createDnsLookup({
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      },
    })
    expect((await broken([byId('dmarc')]))[0]?.state).toBe('unknown')
  })
})
