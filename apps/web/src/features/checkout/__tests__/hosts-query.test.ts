import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lookupHost } from '@/features/domains/queries/dns'
import type { createServiceClient } from '@/lib/supabase/service'
import { type Host, NEEDS_FIXING, NO_HOST } from '../lib/line-hosts'
import { CHOOSE_HOST } from '../lib/nameservers'

// Public DNS is the network boundary for FR-D4.
vi.mock('@/features/domains/queries/dns', () => ({ lookupHost: vi.fn() }))

const { chooseNameservers, planHosts } = await import('../queries/hosts')

const VERCEL_ID = '0d8f4d8e-5a8b-4c43-9a0f-3a6b1d2e7f10'
const HOSTINGER_ID = '2b0c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d'
const CLOUDFLARE_ID = '7a1e2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b'
const ROW = { assigns_per_zone: false, verified_at: '2026-09-23T09:00:00Z', is_hidden: false }
const PRESETS: Record<string, unknown> = {
  [VERCEL_ID]: {
    ...ROW,
    id: VERCEL_ID,
    provider: 'Vercel',
    nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
  },
  [HOSTINGER_ID]: {
    ...ROW,
    id: HOSTINGER_ID,
    provider: 'Hostinger',
    nameservers: ['ns1.dns-parking.com', 'ns2.dns-parking.com'],
  },
  [CLOUDFLARE_ID]: {
    ...ROW,
    id: CLOUDFLARE_ID,
    provider: 'Cloudflare',
    nameservers: [],
    assigns_per_zone: true,
  },
}
const VERCEL: Host = {
  nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
  presetId: VERCEL_ID,
}
const TYPED: Host = { nameservers: ['ns1.host.com', 'ns2.host.com'], presetId: null }
const DOMAINS = ['getpaid.com', 'getpaid.co']

/** Every preset read, by id — one per preset, however many domains pick it. */
let reads: string[]
let readError: { code: string; message: string } | null

function service() {
  return {
    from: (table: string) => {
      if (table !== 'nameserver_presets') throw new Error(`unexpected table ${table}`)
      let id = ''
      const node = {
        select: () => node,
        eq: (_column: string, value: string) => {
          id = value
          return node
        },
        maybeSingle: async () => {
          reads.push(id)
          return readError
            ? { data: null, error: readError }
            : { data: PRESETS[id] ?? null, error: null }
        },
      }
      return node
    },
  } as unknown as ReturnType<typeof createServiceClient>
}

beforeEach(() => {
  vi.clearAllMocks()
  reads = []
  readError = null
  vi.mocked(lookupHost).mockResolvedValue('resolves')
})

describe('planHosts — a domain’s own choice is refused as the order’s would be', () => {
  it('refuses a domain that is no longer in the cart, and looks nothing up', async () => {
    const plan = await planHosts(
      service(),
      NO_HOST,
      [{ domain: 'gone.com', mode: 'default' }],
      DOMAINS,
    )
    expect(plan).toEqual({
      ok: false,
      failure: { field: 'lineHosts', error: expect.stringMatching(/^Your cart changed/) },
    })
    expect(lookupHost).not.toHaveBeenCalled()
  })

  it('asks for a host when “Pick my host” came without one', async () => {
    const plan = await planHosts(
      service(),
      NO_HOST,
      [{ domain: 'getpaid.co', mode: 'preset' }],
      DOMAINS,
    )
    expect(plan).toEqual({
      ok: false,
      failure: { field: 'lineHosts', domain: 'getpaid.co', error: CHOOSE_HOST },
    })
    expect(reads).toEqual([])
  })

  it('refuses a per-zone host with the explanation (FR-D3)', async () => {
    const plan = await planHosts(
      service(),
      NO_HOST,
      [{ domain: 'getpaid.co', mode: 'preset', presetId: CLOUDFLARE_ID }],
      DOMAINS,
    )
    expect(plan).toEqual({
      ok: false,
      failure: {
        field: 'lineHosts',
        domain: 'getpaid.co',
        error: expect.stringMatching(/^Cloudflare gives each domain its own nameservers/),
      },
    })
  })

  it('refuses a preset it cannot find, and one sent with typed nameservers', async () => {
    const missing = await planHosts(
      service(),
      NO_HOST,
      [{ domain: 'getpaid.co', mode: 'preset', presetId: '9f9f9f9f-0000-4000-8000-000000000000' }],
      DOMAINS,
    )
    expect(missing).toMatchObject({ ok: false, failure: { error: /no longer on our list/ } })

    const both = await planHosts(
      service(),
      NO_HOST,
      [
        {
          domain: 'getpaid.co',
          mode: 'preset',
          presetId: VERCEL_ID,
          nameservers: 'ns1.evil.example',
        },
      ],
      DOMAINS,
    )
    expect(both).toMatchObject({
      ok: false,
      failure: { domain: 'getpaid.co', error: 'Choose your host or enter nameservers, not both.' },
    })
  })

  it('says nothing was charged when a preset cannot be read', async () => {
    readError = { code: '08006', message: 'connection lost' }
    const plan = await planHosts(
      service(),
      NO_HOST,
      [{ domain: 'getpaid.co', mode: 'preset', presetId: VERCEL_ID }],
      DOMAINS,
    )
    expect(plan).toMatchObject({
      ok: false,
      failure: { domain: 'getpaid.co', error: /haven't been charged/ },
    })
  })

  it('parses typed nameservers, and refuses an empty box for a domain given its own', async () => {
    const one = await planHosts(
      service(),
      NO_HOST,
      [{ domain: 'getpaid.com', mode: 'manual', nameservers: 'ns1.host.com' }],
      DOMAINS,
    )
    expect(one).toEqual({
      ok: false,
      failure: {
        field: 'lineHosts',
        domain: 'getpaid.com',
        error: 'At least two nameservers are required',
      },
    })

    const empty = await planHosts(
      service(),
      NO_HOST,
      [{ domain: 'getpaid.com', mode: 'manual', nameservers: ' ' }],
      DOMAINS,
    )
    expect(empty).toMatchObject({ ok: false, failure: { error: /^Enter the nameservers/ } })
  })
})

describe('planHosts — FR-D4 before payment, on every typed set', () => {
  it('stops a typo in the order’s box with the details, pointed at that box', async () => {
    vi.mocked(lookupHost).mockImplementation(async (host) =>
      host === 'ns2.host.com' ? 'nxdomain' : 'resolves',
    )
    const plan = await planHosts(service(), TYPED, [], DOMAINS)
    expect(plan).toEqual({
      ok: false,
      failure: {
        field: 'nameservers',
        error: NEEDS_FIXING,
        details: ["ns2.host.com doesn't exist — check the spelling."],
      },
    })
  })

  it('stops a typo in one domain’s own set, pointed at that domain', async () => {
    vi.mocked(lookupHost).mockImplementation(async (host) =>
      host === 'ns2.dns-parkng.com' ? 'nxdomain' : 'resolves',
    )
    const plan = await planHosts(
      service(),
      VERCEL,
      [
        {
          domain: 'getpaid.co',
          mode: 'manual',
          nameservers: 'ns1.dns-parking.com\nns2.dns-parkng.com',
        },
      ],
      DOMAINS,
    )
    expect(plan).toMatchObject({
      ok: false,
      failure: {
        field: 'lineHosts',
        domain: 'getpaid.co',
        details: ["ns2.dns-parkng.com doesn't exist — check the spelling."],
      },
    })
  })

  it('looks each typed host up once, and never a preset’s', async () => {
    await planHosts(
      service(),
      TYPED,
      [
        { domain: 'getpaid.co', mode: 'manual', nameservers: 'ns2.host.com ns3.host.com' },
        { domain: 'getpaid.com', mode: 'preset', presetId: VERCEL_ID },
      ],
      [...DOMAINS, 'getpaid.ng'],
    )
    expect(
      vi
        .mocked(lookupHost)
        .mock.calls.map(([host]) => host)
        .sort(),
    ).toEqual(['ns1.host.com', 'ns2.host.com', 'ns3.host.com'])
  })

  it('skips DNS altogether when nothing was typed', async () => {
    const plan = await planHosts(service(), VERCEL, [], DOMAINS)
    expect(plan.ok).toBe(true)
    expect(lookupHost).not.toHaveBeenCalled()
  })

  it('passes a host that did not answer, with a warning to show before paying', async () => {
    vi.mocked(lookupHost).mockImplementation(async (host) =>
      host === 'ns2.host.com' ? 'no-answer' : 'resolves',
    )
    const plan = await planHosts(service(), TYPED, [], DOMAINS)
    expect(plan).toMatchObject({
      ok: true,
      warnings: [
        "ns2.host.com didn't answer just now. It may be busy; double-check it with your host.",
      ],
    })
  })
})

describe('planHosts — what is stored (migration 29)', () => {
  it('reads a preset once however many domains pick it, and gives each its own', async () => {
    const plan = await planHosts(
      service(),
      TYPED,
      [
        { domain: 'getpaid.com', mode: 'preset', presetId: HOSTINGER_ID },
        { domain: 'getpaid.co', mode: 'preset', presetId: HOSTINGER_ID },
      ],
      [...DOMAINS, 'getpaid.ng'],
    )
    expect(reads).toEqual([HOSTINGER_ID])
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.order).toEqual(TYPED)
    const hostinger = {
      nameservers: ['ns1.dns-parking.com', 'ns2.dns-parking.com'],
      nameserver_preset_id: HOSTINGER_ID,
    }
    expect(plan.columnsFor('getpaid.com')).toEqual(hostinger)
    expect(plan.columnsFor('getpaid.co')).toEqual(hostinger)
    expect(plan.columnsFor('getpaid.ng')).toEqual({ nameservers: null, nameserver_preset_id: null })
    expect(plan.warnings).toEqual([])
  })

  it('keeps one domain on the registrar’s default under an order with a host', async () => {
    const plan = await planHosts(
      service(),
      VERCEL,
      [{ domain: 'getpaid.co', mode: 'default' }],
      DOMAINS,
    )
    if (!plan.ok) throw new Error('expected a plan')
    expect(plan.order).toEqual(NO_HOST)
    expect(plan.columnsFor('getpaid.com')).toEqual({
      nameservers: VERCEL.nameservers,
      nameserver_preset_id: VERCEL_ID,
    })
    expect(plan.columnsFor('getpaid.co')).toEqual({ nameservers: null, nameserver_preset_id: null })
  })
})

describe('chooseNameservers — the order’s choice', () => {
  it('reads the preset from our table, never from the browser (N11)', async () => {
    expect(await chooseNameservers(service(), { presetId: VERCEL_ID })).toEqual({
      ok: true,
      nameservers: VERCEL.nameservers,
      presetId: VERCEL_ID,
    })
    expect(reads).toEqual([VERCEL_ID])
  })

  it('refuses a visible preset whose stored nameservers do not validate', async () => {
    const saved = PRESETS[HOSTINGER_ID]
    PRESETS[HOSTINGER_ID] = { ...(saved as object), nameservers: ['one.only.com'] }
    try {
      const choice = await chooseNameservers(service(), { presetId: HOSTINGER_ID })
      expect(choice).toMatchObject({ ok: false, field: 'presetId' })
    } finally {
      PRESETS[HOSTINGER_ID] = saved
    }
  })
})
