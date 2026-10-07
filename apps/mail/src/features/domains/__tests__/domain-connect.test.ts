import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HttpResponse, http } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { useFakeCloudflare } from '../../../../tests/mocks/cloudflare'
import { server } from '../../../../tests/mocks/server'
import { useFakeSes } from '../../../../tests/mocks/ses'
import { CLOUDFLARE_API } from '../lib/cloudflare'
import { findDnsHost, readNameservers, templateSupported } from '../lib/dns-host'
import {
  applyUrl,
  DOMAIN_CONNECT,
  fitsTemplate,
  publicKeyRecords,
  signingKey,
} from '../lib/domain-connect'

/**
 * Domain Connect's one-click flow (MAIL-SPEC §5.3): a signed address that
 * Cloudflare can verify with the key published at _dck1.mydomainshub.com,
 * carrying exactly our template's variables; and which DNS host serves a
 * domain, from its nameservers in public DNS.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KEY_B64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
const TOKENS = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]

function build(zone: string, name: string) {
  return applyUrl({
    zone,
    name,
    dkimTokens: TOKENS,
    region: 'eu-west-2',
    redirectUri: 'https://emails.mydomainshub.com/dashboard/domains/d1?from=cloudflare',
    key: signingKey(KEY_B64),
  })
}

/** As Cloudflare checks it: the query without `key` and `sig`, against the published key. */
function verifies(url: string, records: string[]): boolean {
  const query = url.split('?')[1] ?? ''
  const signed = query.replace(/&key=[^&]*&sig=[^&]*$/, '')
  const signature = decodeURIComponent(/&sig=([^&]*)$/.exec(query)?.[1] ?? '')
  const parts = records
    .map((r) =>
      Object.fromEntries(
        r.split(',').map((kv) => [kv.split('=')[0], kv.slice(kv.indexOf('=') + 1)]),
      ),
    )
    .sort((x, y) => Number(x.p) - Number(y.p))
  const key = createPublicKey({
    key: Buffer.from(parts.map((p) => p.d).join(''), 'base64'),
    format: 'der',
    type: 'spki',
  })
  return createVerify('RSA-SHA256').update(signed).verify(key, signature, 'base64')
}

const published = publicKeyRecords(
  publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
)

describe('the apply address', () => {
  it('goes to Cloudflare’s apply page for our template, signed, key then sig last', () => {
    const url = build('acme.example', 'acme.example')
    expect(url).toMatch(
      /^https:\/\/dash\.cloudflare\.com\/domainconnect\/v2\/domainTemplates\/providers\/mydomainshub\.com\/services\/mail\/apply\?/,
    )
    const query = new URL(url).searchParams
    expect([...query.keys()]).toEqual([
      'domain',
      'dkim1',
      'dkim2',
      'dkim3',
      'region',
      'redirect_uri',
      'key',
      'sig',
    ])
    expect(query.get('domain')).toBe('acme.example')
    expect(query.get('key')).toBe('_dck1')
    expect(verifies(url, published)).toBe(true)
  })

  it('a subdomain is the zone plus host', () => {
    const query = new URL(build('acme.example', 'mail.acme.example')).searchParams
    expect(query.get('domain')).toBe('acme.example')
    expect(query.get('host')).toBe('mail')
  })

  it('a changed variable no longer verifies', () => {
    const url = build('acme.example', 'acme.example').replace(
      `dkim1=${TOKENS[0]}`,
      `dkim1=${'z'.repeat(32)}`,
    )
    expect(verifies(url, published)).toBe(false)
  })

  it('refuses a domain outside the zone, or without three DKIM tokens', () => {
    expect(() => build('other.example', 'acme.example')).toThrow('not in the zone')
    expect(() =>
      applyUrl({
        zone: 'acme.example',
        name: 'acme.example',
        dkimTokens: TOKENS.slice(0, 2),
        region: 'eu-west-2',
        redirectUri: 'https://emails.mydomainshub.com/',
        key: signingKey(KEY_B64),
      }),
    ).toThrow('three DKIM tokens')
  })

  it('the template only fits MAIL FROM on send.', () => {
    expect(fitsTemplate('acme.example', 'send.acme.example')).toBe(true)
    expect(fitsTemplate('acme.example', null)).toBe(true)
    expect(fitsTemplate('acme.example', 'bounce.acme.example')).toBe(false)
  })

  it('the public key is published in parts Domain Connect reads', () => {
    expect(published.length).toBeGreaterThan(1)
    for (const [index, record] of published.entries()) {
      expect(record.startsWith(`p=${index + 1},a=RS256,d=`)).toBe(true)
      expect(record.length).toBeLessThanOrEqual(255)
    }
  })
})

describe('the template we give Cloudflare', () => {
  const template = JSON.parse(
    readFileSync(
      join(__dirname, '../../../../../../infra/domain-connect/mydomainshub.com.mail.json'),
      'utf8',
    ),
  ) as Record<string, unknown> & { records: Record<string, unknown>[] }

  it('names what the code sends: provider, service, key domain, the four variables', () => {
    expect(template.providerId).toBe(DOMAIN_CONNECT.providerId)
    expect(template.serviceId).toBe(DOMAIN_CONNECT.serviceId)
    expect(template.syncPubKeyDomain).toBe('mydomainshub.com')
    expect(template.syncBlock).toBe(false)
    const variables = new Set(JSON.stringify(template.records).match(/%[a-z0-9]+%/g))
    expect([...variables].sort()).toEqual(['%dkim1%', '%dkim2%', '%dkim3%', '%region%'])
  })

  it('adds the records the page asks for, and no DMARC (it would replace the customer’s)', () => {
    const kinds = template.records.map((r) => `${r.type} ${r.host}`)
    expect(kinds).toEqual([
      'CNAME %dkim1%._domainkey',
      'CNAME %dkim2%._domainkey',
      'CNAME %dkim3%._domainkey',
      'MX send',
      'SPFM send',
    ])
  })

  it('the key file in the repo is the one in the published records’ shape', () => {
    const file = readFileSync(
      join(__dirname, '../../../../../../infra/domain-connect/public-key.txt'),
      'utf8',
    ).trim()
    expect(() =>
      createPublicKey({ key: Buffer.from(file, 'base64'), format: 'der', type: 'spki' }),
    ).not.toThrow()
  })
})

describe('which DNS host serves a domain', () => {
  const RESOLVERS = [{ name: 'Test', url: 'https://cloudflare-dns.com/dns-query' }]

  function dohFrom(ses: ReturnType<typeof useFakeSes>, { down = false } = {}) {
    server.use(
      http.get('https://cloudflare-dns.com/dns-query', ({ request }) => {
        if (down) return HttpResponse.json({}, { status: 502 })
        const q = new URL(request.url).searchParams
        return HttpResponse.json(ses.resolve(q.get('name') ?? '', q.get('type') ?? ''))
      }),
    )
  }

  let ses: ReturnType<typeof useFakeSes>
  beforeEach(() => {
    ses = useFakeSes()
  })

  it('a zone with Cloudflare’s nameservers is on Cloudflare', async () => {
    useFakeCloudflare(ses).addZone('acme.example')
    dohFrom(ses)
    expect(await findDnsHost('acme.example', { resolvers: RESOLVERS })).toEqual({
      provider: 'cloudflare',
      zone: 'acme.example',
    })
  })

  it('a subdomain is found in its parent zone', async () => {
    useFakeCloudflare(ses).addZone('acme.example')
    ses.publish('send.mail.acme.example', 'MX', '10 x.example.')
    dohFrom(ses)
    expect(await findDnsHost('mail.acme.example', { resolvers: RESOLVERS })).toEqual({
      provider: 'cloudflare',
      zone: 'acme.example',
    })
  })

  it('anyone else’s nameservers are another host', async () => {
    ses.publish('acme.example', 'NS', 'ns1.truehost.example.')
    ses.publish('acme.example', 'NS', 'kelly.ns.cloudflare.com.')
    dohFrom(ses)
    expect(await findDnsHost('acme.example', { resolvers: RESOLVERS })).toEqual({
      provider: 'other',
      zone: 'acme.example',
    })
  })

  it('a resolver that cannot answer says nothing', async () => {
    dohFrom(ses, { down: true })
    expect(await findDnsHost('acme.example', { resolvers: RESOLVERS })).toEqual({
      provider: 'unknown',
    })
  })

  it('reads only NS answers owned by the name asked', () => {
    expect(
      readNameservers('acme.example', {
        Status: 0,
        Answer: [
          { name: 'acme.example.', type: 2, data: 'Kelly.NS.Cloudflare.com.' },
          { name: 'other.example.', type: 2, data: 'x.example.' },
          { name: 'acme.example.', type: 5, data: 'y.example.' },
        ],
      }),
    ).toEqual({ answered: true, nameservers: ['kelly.ns.cloudflare.com'] })
    expect(readNameservers('acme.example', { Status: 2 })).toEqual({ answered: false })
    expect(readNameservers('acme.example', null)).toEqual({ answered: false })
  })
})

describe('whether Cloudflare has our template', () => {
  it('404 until it does, 200 after', async () => {
    const cf = useFakeCloudflare()
    expect(await templateSupported({ apiBase: CLOUDFLARE_API })).toBe(false)
    cf.supportTemplate()
    expect(await templateSupported({ apiBase: CLOUDFLARE_API })).toBe(true)
  })

  it('a failure is no', async () => {
    expect(
      await templateSupported({
        apiBase: CLOUDFLARE_API,
        fetchImpl: async () => {
          throw new TypeError('fetch failed')
        },
      }),
    ).toBe(false)
  })
})
