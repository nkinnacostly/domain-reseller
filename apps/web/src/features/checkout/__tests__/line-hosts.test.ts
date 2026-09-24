import { describe, expect, it } from 'vitest'
import type { HostLookup } from '@/features/domains/lib/nameserver-check'
import {
  ENTER_NAMESERVERS,
  type Host,
  hostFailure,
  hostRequest,
  isHostFailure,
  judgeTypedSets,
  type LineHost,
  lineField,
  lineHostsSchema,
  NEEDS_FIXING,
  NO_HOST,
  ownNameservers,
  sameHost,
  storedHosts,
  typedHosts,
} from '../lib/line-hosts'
import { CHOOSE_HOST } from '../lib/nameservers'

const VERCEL = {
  id: '0d8f4d8e-5a8b-4c43-9a0f-3a6b1d2e7f10',
  provider: 'Vercel',
  assignsPerZone: false,
}
const CLOUDFLARE = {
  id: '7a1e2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b',
  provider: 'Cloudflare',
  assignsPerZone: true,
}
const PRESETS = [VERCEL, CLOUDFLARE]
const DOMAINS = ['getpaid.com', 'getpaid.co']

/** A form as the checkout reads it: every field by name, empty when absent. */
const form =
  (fields: Record<string, string>) =>
  (name: string): string =>
    fields[name] ?? ''

const typed = (...nameservers: string[]): Host => ({ nameservers, presetId: null })
const preset = (id: string, ...nameservers: string[]): Host => ({ nameservers, presetId: id })

describe('hostRequest — a choice that cannot work is caught before the order is tried', () => {
  it('stops on the order’s own choice first, beside the host picker', () => {
    const result = hostRequest(form({ nameserverMode: 'preset' }), DOMAINS, PRESETS)
    expect(result).toEqual({ ok: false, problem: { field: 'presetId', error: CHOOSE_HOST } })
  })

  it('asks for a host for a domain given “Pick my host” without one', () => {
    const result = hostRequest(
      form({ [lineField('getpaid.co', 'mode')]: 'preset' }),
      DOMAINS,
      PRESETS,
    )
    expect(result).toEqual({
      ok: false,
      problem: { field: 'lineHosts', domain: 'getpaid.co', error: CHOOSE_HOST },
    })
  })

  it('refuses a per-zone host for one domain, as for the order (FR-D3)', () => {
    const result = hostRequest(
      form({
        [lineField('getpaid.com', 'mode')]: 'preset',
        [lineField('getpaid.com', 'presetId')]: CLOUDFLARE.id,
      }),
      DOMAINS,
      PRESETS,
    )
    expect(result).toMatchObject({
      ok: false,
      problem: { field: 'lineHosts', domain: 'getpaid.com', error: /^Choose another option/ },
    })
  })

  it('refuses a domain set to “Enter nameservers” with the box left empty', () => {
    const result = hostRequest(
      form({
        [lineField('getpaid.co', 'mode')]: 'manual',
        [lineField('getpaid.co', 'nameservers')]: '  \n ',
      }),
      DOMAINS,
      PRESETS,
    )
    expect(result).toEqual({
      ok: false,
      problem: { field: 'lineHosts', domain: 'getpaid.co', error: ENTER_NAMESERVERS },
    })
  })
})

describe('hostRequest — what is sent (FR-C10)', () => {
  it('sends the order’s choice alone when every domain follows it', () => {
    const result = hostRequest(
      form({ nameserverMode: 'manual', nameservers: 'ns1.host.com\nns2.host.com' }),
      DOMAINS,
      PRESETS,
    )
    expect(result).toEqual({ ok: true, input: { nameservers: 'ns1.host.com\nns2.host.com' } })
  })

  it('sends each domain given its own, and only the way it chose (N11)', () => {
    const result = hostRequest(
      form({
        nameserverMode: 'preset',
        presetId: VERCEL.id,
        [lineField('getpaid.com', 'mode')]: 'same',
        [lineField('getpaid.co', 'mode')]: 'manual',
        // Picked, then left for typing: the preset is not sent.
        [lineField('getpaid.co', 'presetId')]: VERCEL.id,
        [lineField('getpaid.co', 'nameservers')]: 'ns1.other.com ns2.other.com',
      }),
      DOMAINS,
      PRESETS,
    )
    expect(result).toEqual({
      ok: true,
      input: {
        nameservers: '',
        presetId: VERCEL.id,
        lineHosts: [
          { domain: 'getpaid.co', mode: 'manual', nameservers: 'ns1.other.com ns2.other.com' },
        ],
      },
    })
  })

  it('sends a domain kept on the registrar’s default, and one with its own host', () => {
    const result = hostRequest(
      form({
        [lineField('getpaid.com', 'mode')]: 'default',
        [lineField('getpaid.com', 'nameservers')]: 'ns1.left-behind.com',
        [lineField('getpaid.co', 'mode')]: 'preset',
        [lineField('getpaid.co', 'presetId')]: VERCEL.id,
      }),
      DOMAINS,
      PRESETS,
    )
    expect(result).toEqual({
      ok: true,
      input: {
        nameservers: '',
        lineHosts: [
          { domain: 'getpaid.com', mode: 'default', nameservers: '' },
          { domain: 'getpaid.co', mode: 'preset', nameservers: '', presetId: VERCEL.id },
        ],
      },
    })
  })
})

describe('lineHostsSchema', () => {
  it('refuses two choices for one domain', () => {
    const parsed = lineHostsSchema.safeParse([
      { domain: 'getpaid.com', mode: 'default' },
      { domain: 'getpaid.com', mode: 'manual', nameservers: 'ns1.a.com ns2.a.com' },
    ])
    expect(parsed.success).toBe(false)
  })

  it('refuses a preset id that is not one, and “same”, which is never sent', () => {
    expect(
      lineHostsSchema.safeParse([{ domain: 'getpaid.com', mode: 'preset', presetId: 'vercel' }])
        .success,
    ).toBe(false)
    expect(lineHostsSchema.safeParse([{ domain: 'getpaid.com', mode: 'same' }]).success).toBe(false)
  })
})

describe('hostFailure — a refusal shown where it belongs', () => {
  it('shows nothing for an answer that is not about nameservers', () => {
    expect(hostFailure(null, undefined)).toBeUndefined()
    expect(hostFailure({ error: 'Your cart is empty.' }, undefined)).toBeUndefined()
    expect(hostFailure({ error: 'x', field: 'registrant' }, undefined)).toBeUndefined()
  })

  it('says the FR-D4 details in full, beside the order’s box', () => {
    expect(
      hostFailure(
        {
          error: NEEDS_FIXING,
          field: 'nameservers',
          details: ["ns2.host.com doesn't exist — check the spelling."],
        },
        undefined,
      ),
    ).toEqual({
      field: 'nameservers',
      error: `${NEEDS_FIXING} ns2.host.com doesn't exist — check the spelling.`,
    })
  })

  it('keeps the domain a problem belongs to', () => {
    expect(
      hostFailure({ error: CHOOSE_HOST, field: 'lineHosts', domain: 'getpaid.co' }, undefined),
    ).toEqual({ field: 'lineHosts', domain: 'getpaid.co', error: CHOOSE_HOST })
    expect(hostFailure({ error: 'Cart changed', field: 'lineHosts' }, undefined)).toEqual({
      field: 'lineHosts',
      error: 'Cart changed',
    })
  })

  it('reads malformed fields from the validation errors, before any refusal', () => {
    expect(hostFailure(null, { nameservers: { _errors: ['Too long'] } })).toEqual({
      field: 'nameservers',
      error: 'Too long',
    })
    expect(hostFailure(null, { presetId: { _errors: ['Invalid UUID'] } })).toEqual({
      field: 'presetId',
      error: 'Invalid UUID',
    })
    expect(hostFailure(null, { lineHosts: { 0: { presetId: { _errors: ['x'] } } } })).toEqual({
      field: 'lineHosts',
      error: 'Check the host chosen for each domain.',
    })
  })

  it('tells nameserver refusals from the rest', () => {
    expect(isHostFailure({ error: 'x', field: 'presetId' })).toBe(true)
    expect(isHostFailure({ error: 'x' })).toBe(false)
  })
})

describe('sameHost', () => {
  it('matches a set in any order from the same preset, and two defaults', () => {
    expect(sameHost(preset('p', 'a.x.com', 'b.x.com'), preset('p', 'b.x.com', 'a.x.com'))).toBe(
      true,
    )
    expect(sameHost(NO_HOST, NO_HOST)).toBe(true)
  })

  it('tells a typed set from the same set picked as a preset, and a host from none', () => {
    expect(sameHost(typed('a.x.com', 'b.x.com'), preset('p', 'a.x.com', 'b.x.com'))).toBe(false)
    expect(sameHost(typed('a.x.com', 'b.x.com'), NO_HOST)).toBe(false)
    expect(sameHost(NO_HOST, typed('a.x.com', 'b.x.com'))).toBe(false)
  })
})

describe('storedHosts — what migration 29 can say', () => {
  const V = preset('vercel', 'ns1.vercel-dns.com', 'ns2.vercel-dns.com')
  const T = typed('ns1.host.com', 'ns2.host.com')
  const line = (domain: string, host: Host, own = false): LineHost => ({ domain, host, own })

  it('stores the order’s host alone when every domain follows it', () => {
    const stored = storedHosts(V, [line('a.com', V), line('b.com', V)])
    expect(stored.order).toEqual(V)
    expect([...stored.own]).toEqual([])
  })

  it('gives only the domain with its own host a value of its own', () => {
    const stored = storedHosts(T, [line('a.com', T), line('b.com', V, true)])
    expect(stored.order).toEqual(T)
    expect([...stored.own]).toEqual([['b.com', V]])
  })

  it('keeps a domain on the registrar’s default under an order with a host', () => {
    // A line without nameservers follows the order, so the order keeps none.
    const stored = storedHosts(V, [line('a.com', V), line('b.com', NO_HOST, true)])
    expect(stored.order).toEqual(NO_HOST)
    expect([...stored.own]).toEqual([['a.com', V]])
  })

  it('stores no order host that no domain uses', () => {
    const stored = storedHosts(T, [line('a.com', V, true), line('b.com', NO_HOST, true)])
    expect(stored.order).toEqual(NO_HOST)
    expect([...stored.own]).toEqual([['a.com', V]])
  })

  it('stores a domain’s own host under an order left on the default', () => {
    const stored = storedHosts(NO_HOST, [line('a.com', NO_HOST), line('b.com', V, true)])
    expect(stored.order).toEqual(NO_HOST)
    expect([...stored.own]).toEqual([['b.com', V]])
  })
})

describe('judgeTypedSets (FR-D4 on every typed set)', () => {
  const T = typed('ns1.host.com', 'ns2.hots.com')
  const lookups = (entries: Record<string, HostLookup>) => new Map(Object.entries(entries))

  it('looks each typed host up once, and leaves presets and defaults alone', () => {
    expect(
      typedHosts([
        { domain: 'a.com', host: T, own: false },
        { domain: 'b.com', host: typed('ns1.host.com', 'ns3.host.com'), own: true },
        {
          domain: 'c.com',
          host: preset('v', 'ns1.vercel-dns.com', 'ns2.vercel-dns.com'),
          own: true,
        },
        { domain: 'd.com', host: NO_HOST, own: true },
      ]),
    ).toEqual(['ns1.host.com', 'ns2.hots.com', 'ns3.host.com'])
  })

  it('blocks a typo in the order’s box once, however many domains use it', () => {
    const verdict = judgeTypedSets(
      [
        { domain: 'a.com', host: T, own: false },
        { domain: 'b.com', host: T, own: false },
      ],
      lookups({ 'ns1.host.com': 'resolves', 'ns2.hots.com': 'nxdomain' }),
    )
    expect(verdict).toEqual({
      failure: {
        field: 'nameservers',
        error: NEEDS_FIXING,
        details: ["ns2.hots.com doesn't exist — check the spelling."],
      },
      warnings: [],
    })
  })

  it('points a typo in one domain’s own set at that domain', () => {
    const verdict = judgeTypedSets(
      [
        { domain: 'a.com', host: NO_HOST, own: false },
        { domain: 'b.com', host: T, own: true },
      ],
      lookups({ 'ns1.host.com': 'resolves', 'ns2.hots.com': 'nxdomain' }),
    )
    expect(verdict.failure).toEqual({
      field: 'lineHosts',
      domain: 'b.com',
      error: NEEDS_FIXING,
      details: ["ns2.hots.com doesn't exist — check the spelling."],
    })
  })

  it('blocks a nameserver inside the domain it would serve — it needs glue', () => {
    const verdict = judgeTypedSets(
      [{ domain: 'getpaid.com', host: typed('ns1.getpaid.com', 'ns2.host.com'), own: false }],
      lookups({ 'ns1.getpaid.com': 'resolves', 'ns2.host.com': 'resolves' }),
    )
    expect(verdict.failure?.details).toEqual([
      expect.stringMatching(/^ns1\.getpaid\.com is inside getpaid\.com itself/),
    ])
  })

  it('warns, without blocking, about a host that did not answer', () => {
    const verdict = judgeTypedSets(
      [
        { domain: 'a.com', host: T, own: false },
        { domain: 'b.com', host: T, own: false },
      ],
      lookups({ 'ns1.host.com': 'resolves', 'ns2.hots.com': 'no-answer' }),
    )
    expect(verdict).toEqual({
      failure: null,
      warnings: [
        "ns2.hots.com didn't answer just now. It may be busy; double-check it with your host.",
      ],
    })
  })

  it('treats a host it has no answer for as one that did not answer', () => {
    const verdict = judgeTypedSets([{ domain: 'a.com', host: T, own: false }], lookups({}))
    expect(verdict.failure).toBeNull()
    expect(verdict.warnings).toHaveLength(2)
  })
})

describe('ownNameservers — the order page', () => {
  it('shows a domain’s own set only where it differs from the order’s', () => {
    expect(ownNameservers(null, ['a.x.com', 'b.x.com'])).toBeNull()
    expect(ownNameservers([], null)).toBeNull()
    expect(ownNameservers(['b.x.com', 'a.x.com'], ['a.x.com', 'b.x.com'])).toBeNull()
    expect(ownNameservers(['a.y.com', 'b.y.com'], ['a.x.com', 'b.x.com'])).toEqual([
      'a.y.com',
      'b.y.com',
    ])
    expect(ownNameservers(['a.y.com', 'b.y.com'], null)).toEqual(['a.y.com', 'b.y.com'])
  })
})
