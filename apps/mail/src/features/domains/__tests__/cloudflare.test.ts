import { beforeEach, describe, expect, it } from 'vitest'
import { type FakeCloudflare, useFakeCloudflare } from '../../../../tests/mocks/cloudflare'
import { type FakeSes, useFakeSes } from '../../../../tests/mocks/ses'
import {
  addCloudflareRecords,
  cloudflareTokenPage,
  decide,
  recordBody,
  zoneCandidates,
} from '../lib/cloudflare'
import { domainRecords } from '../lib/records'

/**
 * "Add to Cloudflare" with a pasted token (MAIL-SPEC §5.3), against a fake
 * Cloudflare API: every record added once, nothing of the customer's changed
 * or removed, the token sent only as the bearer, and each failure in its own
 * kind.
 */

const TOKEN = 'cf-test-token-not-a-secret-0123456789abcd'
const TOKENS = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]

const recordsFor = (name: string) =>
  domainRecords({ name, dkimTokens: TOKENS, mailFromDomain: `send.${name}`, region: 'eu-west-2' })

let cf: FakeCloudflare
let ses: FakeSes

beforeEach(() => {
  ses = useFakeSes()
  cf = useFakeCloudflare(ses)
})

function run(name = 'acme.example', token = TOKEN) {
  return addCloudflareRecords({ token, domain: name, records: recordsFor(name) })
}

describe('adding the records with a token', () => {
  it('adds all six to an empty zone, DKIM as DNS only, TXT quoted, MX with its priority', async () => {
    cf.addZone('acme.example')
    cf.addToken(TOKEN, ['acme.example'])
    const answer = await run()
    expect(answer).toEqual({
      ok: true,
      zone: 'acme.example',
      results: recordsFor('acme.example').map((r) => ({ id: r.id, outcome: 'added', seen: [] })),
    })
    const made = cf.zones.get('acme.example')?.records ?? []
    expect(made).toHaveLength(6)
    expect(made.find((r) => r.type === 'CNAME')).toMatchObject({
      name: `${TOKENS[0]}._domainkey.acme.example`,
      content: `${TOKENS[0]}.dkim.amazonses.com`,
      proxied: false,
      ttl: 1,
      comment: 'MyDomainsHub Mail',
    })
    expect(made.find((r) => r.type === 'MX')).toMatchObject({
      name: 'send.acme.example',
      content: 'feedback-smtp.eu-west-2.amazonses.com',
      priority: 10,
    })
    expect(made.filter((r) => r.type === 'TXT').map((r) => r.content)).toEqual([
      '"v=spf1 include:amazonses.com ~all"',
      '"v=DMARC1; p=none;"',
    ])
    // The live check now finds them.
    expect(ses.resolve(`${TOKENS[0]}._domainkey.acme.example`, 'CNAME').Answer).toHaveLength(1)
  })

  it('a second run changes nothing', async () => {
    cf.addZone('acme.example')
    cf.addToken(TOKEN, ['acme.example'])
    await run()
    const posts = cf.calls.filter((c) => c.method === 'POST').length
    const again = await run()
    expect(again.ok && again.results.map((r) => r.outcome)).toEqual(Array(6).fill('present'))
    expect(cf.calls.filter((c) => c.method === 'POST')).toHaveLength(posts)
  })

  it('sends the token only as the bearer, never in an address or a body', async () => {
    cf.addZone('acme.example')
    cf.addToken(TOKEN, ['acme.example'])
    await run()
    for (const call of cf.calls) {
      expect(call.authorization).toBe(`Bearer ${TOKEN}`)
      expect(call.path).not.toContain(TOKEN)
      expect(JSON.stringify(call.body ?? {})).not.toContain(TOKEN)
    }
  })

  it('finds the parent zone for a subdomain, and names records in full', async () => {
    cf.addZone('acme.example')
    cf.addToken(TOKEN, ['acme.example'])
    const answer = await run('mail.acme.example')
    expect(answer.ok && answer.zone).toBe('acme.example')
    const names = (cf.zones.get('acme.example')?.records ?? []).map((r) => r.name)
    expect(names).toContain('send.mail.acme.example')
    expect(names).toContain(`${TOKENS[1]}._domainkey.mail.acme.example`)
  })

  it('leaves the customer’s own records alone and says which need them', async () => {
    cf.addZone('acme.example')
    cf.addToken(TOKEN, ['acme.example'])
    cf.addRecord('acme.example', {
      type: 'MX',
      name: 'send.acme.example',
      content: 'mx.other.example',
      priority: 5,
    })
    cf.addRecord('acme.example', {
      type: 'TXT',
      name: 'send.acme.example',
      content: '"v=spf1 include:other.example -all"',
    })
    cf.addRecord('acme.example', {
      type: 'TXT',
      name: '_dmarc.acme.example',
      content: '"v=DMARC1; p=reject; rua=mailto:d@acme.example"',
    })
    const answer = await run()
    if (!answer.ok) throw new Error('expected ok')
    const by = Object.fromEntries(answer.results.map((r) => [r.id, r]))
    expect(by['mail-from-mx']).toEqual({
      id: 'mail-from-mx',
      outcome: 'conflict',
      seen: ['MX 5 mx.other.example'],
    })
    expect(by['mail-from-spf']).toEqual({
      id: 'mail-from-spf',
      outcome: 'conflict',
      seen: ['v=spf1 include:other.example -all'],
    })
    expect(by.dmarc?.outcome).toBe('kept_yours')
    expect(by['dkim-1']?.outcome).toBe('added')
    const zone = cf.zones.get('acme.example')?.records ?? []
    expect(zone.filter((r) => r.name === '_dmarc.acme.example')).toHaveLength(1)
    expect(zone.filter((r) => r.name === 'send.acme.example')).toHaveLength(2)
  })

  it('sets a proxied DKIM record to DNS only, and nothing else', async () => {
    cf.addZone('acme.example')
    cf.addToken(TOKEN, ['acme.example'])
    const proxied = cf.addRecord('acme.example', {
      type: 'CNAME',
      name: `${TOKENS[0]}._domainkey.acme.example`,
      content: `${TOKENS[0]}.dkim.amazonses.com`,
      proxied: true,
    })
    const answer = await run()
    expect(answer.ok && answer.results[0]).toEqual({ id: 'dkim-1', outcome: 'updated', seen: [] })
    expect(proxied.proxied).toBe(false)
    expect(cf.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
  })

  it('an unknown token is refused, and nothing is changed', async () => {
    cf.addZone('acme.example')
    expect(await run()).toEqual({ ok: false, code: 'bad_token' })
    expect(cf.calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('a token for another zone finds no zone', async () => {
    cf.addZone('acme.example')
    cf.addZone('other.example')
    cf.addToken(TOKEN, ['other.example'])
    expect(await run()).toEqual({ ok: false, code: 'no_zone' })
  })

  it('a token without DNS Edit is not allowed, before anything changes', async () => {
    cf.addZone('acme.example')
    cf.addToken(TOKEN, ['acme.example'], { dnsEdit: false })
    expect(await run()).toEqual({ ok: false, code: 'not_allowed' })
  })

  it('Cloudflare going away part-way stops the run and marks the rest not added', async () => {
    cf.addZone('acme.example')
    cf.addToken(TOKEN, ['acme.example'])
    // Zone lookup, then a lookup and a create per record: two records in.
    cf.failAfter(5)
    const answer = await run()
    if (!answer.ok) throw new Error('expected ok')
    expect(answer.stopped).toBe('unreachable')
    expect(answer.results.map((r) => r.outcome)).toEqual([
      'added',
      'added',
      'failed',
      'failed',
      'failed',
      'failed',
    ])
  })

  it('Cloudflare away from the start is unreachable, with nothing changed', async () => {
    cf.addZone('acme.example')
    cf.addToken(TOKEN, ['acme.example'])
    cf.failAfter(0)
    expect(await run()).toEqual({ ok: false, code: 'unreachable' })
  })

  it('a network failure is unreachable', async () => {
    const answer = await addCloudflareRecords({
      token: TOKEN,
      domain: 'acme.example',
      records: recordsFor('acme.example'),
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      },
    })
    expect(answer).toEqual({ ok: false, code: 'unreachable' })
  })
})

describe('deciding one record', () => {
  const [dkim, , , mx, spf, dmarc] = recordsFor('acme.example')
  const rec = (type: string, name: string, content: string, extra = {}) => ({
    id: 'x',
    type,
    name,
    content,
    ...extra,
  })

  it('a CNAME cannot share its name, so anything there is a conflict', () => {
    if (!dkim) throw new Error('no dkim')
    expect(decide(dkim, [rec('TXT', dkim.name, '"x"')])).toMatchObject({
      action: 'none',
      outcome: 'conflict',
    })
    expect(decide(dkim, [rec('CNAME', `${dkim.name}.`, `${dkim.value.toUpperCase()}.`)])).toEqual({
      action: 'none',
      outcome: 'present',
      seen: [],
    })
  })

  it('an MX behind a CNAME is a conflict; the same MX host is present', () => {
    if (!mx) throw new Error('no mx')
    expect(decide(mx, [rec('CNAME', mx.name, 'elsewhere.example')])).toMatchObject({
      outcome: 'conflict',
      seen: ['CNAME elsewhere.example'],
    })
    expect(decide(mx, [rec('MX', mx.name, mx.value, { priority: 20 })])).toMatchObject({
      outcome: 'present',
    })
  })

  it('SPF compares as text, quotes and spacing aside; other TXT is no conflict', () => {
    if (!spf) throw new Error('no spf')
    expect(
      decide(spf, [rec('TXT', spf.name, '"v=spf1  include:amazonses.com ~all"')]),
    ).toMatchObject({ outcome: 'present' })
    expect(decide(spf, [rec('TXT', spf.name, '"google-site-verification=x"')])).toEqual({
      action: 'create',
    })
  })

  it('a DMARC delegated by CNAME is the customer’s too', () => {
    if (!dmarc) throw new Error('no dmarc')
    expect(decide(dmarc, [rec('CNAME', dmarc.name, 'dmarc.vendor.example')])).toMatchObject({
      outcome: 'kept_yours',
    })
  })

  it('bodies: an MX keeps its priority, TXT is quoted', () => {
    if (!mx || !spf) throw new Error('missing')
    expect(recordBody(mx)).toMatchObject({ type: 'MX', priority: 10, ttl: 1 })
    expect(recordBody(spf)).toMatchObject({ content: '"v=spf1 include:amazonses.com ~all"' })
  })
})

describe('zones and the token page', () => {
  it('a name’s zones, longest first, never a bare suffix', () => {
    expect(zoneCandidates('Mail.Acme.com.ng.')).toEqual([
      'mail.acme.com.ng',
      'acme.com.ng',
      'com.ng',
    ])
    expect(zoneCandidates('acme.ng')).toEqual(['acme.ng'])
  })

  it('the token page asks for Zone Read and DNS Edit, and nothing else', () => {
    const url = new URL(cloudflareTokenPage())
    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/profile/api-tokens')
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys') ?? '')).toEqual([
      { key: 'dns', type: 'edit' },
      { key: 'zone', type: 'read' },
    ])
    expect(url.searchParams.get('name')).toBe('MyDomainsHub Mail DNS')
  })
})
