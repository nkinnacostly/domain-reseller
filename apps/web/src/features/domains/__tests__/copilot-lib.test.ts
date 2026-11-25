import type { PortfolioIntent } from '@dr/shared/ai'
import { describe, expect, it } from 'vitest'
import { type CopilotPreset, findPreset, resolveIntent } from '../lib/copilot'
import type { DomainLabel } from '../lib/labels'
import type { PortfolioDomain } from '../lib/portfolio'

const NOW = new Date('2026-11-25T12:00:00Z')
const clients: DomainLabel = { id: 'l1', name: 'Clients', color: 'blue' } as DomainLabel

function domain(
  id: string,
  name: string,
  days: number,
  labels: DomainLabel[] = [],
): PortfolioDomain {
  return {
    id,
    domainName: name,
    tld: name.slice(name.indexOf('.') + 1),
    source: 'registration',
    testMode: false,
    status: 'active',
    expiresAt: new Date(NOW.getTime() + days * 86_400_000).toISOString(),
    autoRenew: false,
    privacyEnabled: true,
    transferLock: true,
    delegationStatus: 'verified',
    nameservers: null,
    pendingNameservers: null,
    labels,
  } as PortfolioDomain
}

const account = {
  domains: [
    domain('d1', 'getpaid.ng', 20, [clients]),
    domain('d2', 'shopwise.com', 200, [clients]),
    domain('d3', 'mine.ng', 45),
  ],
  labels: [clients],
}
const presets: CopilotPreset[] = [
  {
    id: 'p1',
    provider: 'Vercel',
    nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
    assignsPerZone: false,
  },
  { id: 'p2', provider: 'Cloudflare', nameservers: [], assignsPerZone: true },
]

type IntentInput = Partial<Omit<PortfolioIntent, 'select'>> & {
  select?: Partial<PortfolioIntent['select']>
}

function intent(overrides: IntentInput): PortfolioIntent {
  return {
    action: 'renew',
    on: null,
    host: null,
    nameservers: [],
    question: null,
    ...overrides,
    select: {
      domains: [],
      all: false,
      expiringWithinDays: null,
      label: null,
      extension: null,
      ...overrides.select,
    },
  }
}

describe('resolveIntent — the account picks the domains, never the model', () => {
  it('points a label at a preset, with the preset’s checked nameservers', () => {
    const draft = resolveIntent(
      intent({ action: 'nameservers', host: 'vercel', select: { label: 'client' } }),
      account,
      presets,
      NOW,
    )
    expect(draft).toMatchObject({
      kind: 'draft',
      action: 'nameservers',
      presetId: 'p1',
      nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
      summary: 'Point 2 domains at Vercel (ns1.vercel-dns.com, ns2.vercel-dns.com).',
    })
    if (draft.kind === 'draft')
      expect(draft.domains.map((d) => d.name)).toEqual(['getpaid.ng', 'shopwise.com'])
  })

  it('renews what expires within a window, through the renewal page', () => {
    const draft = resolveIntent(
      intent({ select: { all: true, expiringWithinDays: 60 } }),
      account,
      presets,
      NOW,
    )
    expect(draft).toMatchObject({
      kind: 'draft',
      action: 'renew',
      renewHref: '/app/domains/renew?ids=d1,d3',
    })
  })

  it('takes named domains, extension filters and says which names are not on the account', () => {
    const draft = resolveIntent(
      intent({
        action: 'auto_renew',
        on: true,
        select: { domains: ['getpaid.ng', 'mine.ng', 'other.com'], extension: 'ng' },
      }),
      account,
      presets,
      NOW,
    )
    expect(draft).toMatchObject({
      kind: 'draft',
      summary: 'Turn auto-renew on for 2 domains.',
      notFound: ['other.com'],
    })
  })

  it('uses typed nameservers when no preset matches, and asks when there are none', () => {
    expect(
      resolveIntent(
        intent({
          action: 'nameservers',
          nameservers: ['ns1.host.net', 'ns2.host.net'],
          select: { all: true },
        }),
        account,
        presets,
        NOW,
      ),
    ).toMatchObject({
      kind: 'draft',
      presetId: null,
      summary: 'Set 3 domains to use ns1.host.net, ns2.host.net.',
    })
    expect(
      resolveIntent(
        intent({ action: 'nameservers', select: { all: true } }),
        account,
        presets,
        NOW,
      ),
    ).toEqual({
      kind: 'question',
      question: 'Which host, or which nameservers (at least two)?',
    })
    expect(
      resolveIntent(
        intent({ action: 'nameservers', host: 'Wix', select: { all: true } }),
        account,
        presets,
        NOW,
      ),
    ).toMatchObject({ kind: 'refused' })
  })

  it('refuses a host that assigns nameservers per domain', () => {
    const draft = resolveIntent(
      intent({ action: 'nameservers', host: 'Cloudflare', select: { all: true } }),
      account,
      presets,
      NOW,
    )
    expect(draft).toMatchObject({ kind: 'refused' })
    if (draft.kind === 'refused') expect(draft.reason).toContain('one domain at a time')
  })

  it('asks rather than guesses: no domains named, no on/off, nothing to do', () => {
    expect(resolveIntent(intent({}), account, presets, NOW)).toMatchObject({ kind: 'question' })
    expect(
      resolveIntent(intent({ action: 'privacy', select: { all: true } }), account, presets, NOW),
    ).toEqual({
      kind: 'question',
      question: 'On or off?',
    })
    expect(
      resolveIntent(intent({ action: 'none', question: 'Which host?' }), account, presets, NOW),
    ).toEqual({
      kind: 'question',
      question: 'Which host?',
    })
  })

  it('refuses an unknown label, a selection that matches nothing, or names all off the account', () => {
    expect(resolveIntent(intent({ select: { label: 'Shops' } }), account, presets, NOW)).toEqual({
      kind: 'refused',
      reason: 'You have no label called “Shops”.',
    })
    expect(resolveIntent(intent({ select: { extension: 'org' } }), account, presets, NOW)).toEqual({
      kind: 'refused',
      reason: 'None of your domains match that.',
    })
    expect(
      resolveIntent(intent({ select: { domains: ['x.com'] } }), account, presets, NOW),
    ).toEqual({
      kind: 'refused',
      reason: 'None of those are on your account: x.com.',
    })
  })

  it('words the lock and privacy changes', () => {
    expect(
      resolveIntent(
        intent({ action: 'transfer_lock', on: false, select: { domains: ['mine.ng'] } }),
        account,
        presets,
        NOW,
      ),
    ).toMatchObject({ summary: 'Unlock 1 domain against transfers.' })
    expect(
      resolveIntent(
        intent({ action: 'privacy', on: true, select: { all: true } }),
        account,
        presets,
        NOW,
      ),
    ).toMatchObject({ summary: 'Turn WHOIS privacy on for 3 domains.' })
  })

  it('finds a preset by the start of its name', () => {
    expect(findPreset(presets, 'Vercel DNS')?.id).toBe('p1')
    expect(findPreset(presets, 'nobody')).toBeNull()
  })
})
