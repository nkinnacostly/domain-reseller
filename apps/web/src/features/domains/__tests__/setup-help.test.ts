import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '@/lib/env'
import { withinLimit } from '@/lib/rate-limit'
import { createClient } from '@/lib/supabase/server'
import { server } from '../../../../tests/mocks/server'
import {
  cleanSetupHelp,
  DOMAIN_PLACEHOLDER,
  maskHost,
  setupFacts,
  setupHelpRequest,
} from '../lib/setup-help'
import { delegationViews } from '../queries/dns'
import { getDomain, getNameserverHistory, getNameserverPresets } from '../queries/domains'

vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('../queries/dns', () => ({ delegationViews: vi.fn() }))
vi.mock('../queries/domains', () => ({
  getDomain: vi.fn(),
  getNameserverHistory: vi.fn(),
  getNameserverPresets: vi.fn(),
}))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  withinLimit: vi.fn(),
}))

const { explainSetup } = await import('../actions/setup-help')

const NOW = new Date('2026-11-25T12:00:00Z')

describe('setup facts — the domain never leaves', () => {
  it('masks the domain and a child nameserver under it, and leaves a host’s own names', () => {
    expect(maskHost('getpaid.ng', 'getpaid.ng')).toBe(DOMAIN_PLACEHOLDER)
    expect(maskHost('NS1.GetPaid.ng', 'getpaid.ng')).toBe(`ns1.${DOMAIN_PLACEHOLDER}`)
    expect(maskHost('ns1.vercel-dns.com', 'getpaid.ng')).toBe('ns1.vercel-dns.com')
    expect(maskHost('notgetpaid.ng', 'getpaid.ng')).toBe('notgetpaid.ng')
  })

  it('puts the live checks, the change and the hold into facts, with no domain name in them', () => {
    const facts = setupFacts({
      domain: 'getpaid.ng',
      requested: ['ns1.getpaid.ng', 'ns2.vercel-dns.com'],
      changeWaiting: false,
      delegation: 'pending',
      onHold: false,
      host: 'Vercel',
      lastChangedAt: '2026-11-25T02:30:00Z',
      views: [
        { resolver: 'Cloudflare', state: 'answered', nameservers: ['ns1.getpaid.ng'] },
        { resolver: 'Google', state: 'nxdomain' },
        { resolver: 'Quad9', state: 'no-answer' },
      ],
      now: NOW,
    })
    expect(facts).toEqual({
      requested: [`ns1.${DOMAIN_PLACEHOLDER}`, 'ns2.vercel-dns.com'],
      changeWaiting: false,
      delegation: 'pending',
      onHoldAtRegistry: false,
      host: 'Vercel',
      hoursSinceChange: 9,
      resolvers: [
        { resolver: 'Cloudflare', sees: [`ns1.${DOMAIN_PLACEHOLDER}`] },
        { resolver: 'Google', sees: 'not in DNS' },
        { resolver: 'Quad9', sees: 'no answer' },
      ],
    })
    expect(JSON.stringify(setupHelpRequest(facts, 'hello@mydomainshub.com'))).not.toContain(
      'getpaid',
    )
  })

  it('keeps the registrar default and a domain never changed with us as they are', () => {
    const facts = setupFacts({
      domain: 'a.com',
      requested: null,
      changeWaiting: true,
      delegation: 'undelegated',
      onHold: true,
      host: null,
      lastChangedAt: null,
      views: [],
      now: NOW,
    })
    expect(facts).toMatchObject({ requested: null, hoursSinceChange: null, onHoldAtRegistry: true })
  })

  it('grounds the model in our facts and the support address, and asks for JSON', () => {
    const request = setupHelpRequest(
      setupFacts({
        domain: 'a.com',
        requested: null,
        changeWaiting: false,
        delegation: 'verified',
        onHold: false,
        host: null,
        lastChangedAt: null,
        views: [],
        now: NOW,
      }),
      'hello@mydomainshub.com',
    )
    expect(request.system).toMatch(/json/)
    expect(request.system).toContain('up to 48 hours')
    expect(request.system).toContain('email hello@mydomainshub.com')
    expect(request.system).toContain('Never invent a nameserver, a time, a price or a promise')
  })

  it('keeps an answer short: four steps at most, spaces tidied', () => {
    expect(
      cleanSetupHelp({
        summary: '  Your   domain points at Vercel.  ',
        steps: ['One', ' ', 'Two', 'Three', 'Four', 'Five'],
      }),
    ).toEqual({ summary: 'Your domain points at Vercel.', steps: ['One', 'Two', 'Three', 'Four'] })
  })
})

const ai = env as { DEEPSEEK_API_KEY?: string }
let key: string | undefined
let sent: string[] = []

function modelAnswers(content: unknown, status = 200) {
  server.use(
    http.post('https://api.deepseek.com/chat/completions', async ({ request }) => {
      sent.push(await request.text())
      if (status !== 200) return HttpResponse.json({}, { status })
      return HttpResponse.json({
        choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 80 },
      })
    }),
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  sent = []
  key = ai.DEEPSEEK_API_KEY
  ai.DEEPSEEK_API_KEY = 'sk-test'
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: 'aal1', nextLevel: 'aal1' },
          error: null,
        }),
      },
    },
  } as never)
  vi.mocked(withinLimit).mockResolvedValue(true)
  vi.mocked(getDomain).mockResolvedValue({
    id: 'd1',
    domainName: 'getpaid.ng',
    nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
    pendingNameservers: null,
    delegationStatus: 'pending',
    onHold: false,
    presetId: 'p1',
  } as never)
  vi.mocked(getNameserverHistory).mockResolvedValue([
    { changedAt: '2026-11-25T02:00:00Z' },
  ] as never)
  vi.mocked(getNameserverPresets).mockResolvedValue([{ id: 'p1', provider: 'Vercel' }] as never)
  vi.mocked(delegationViews).mockResolvedValue([
    { resolver: 'Cloudflare', state: 'answered', nameservers: ['ns1.vercel-dns.com'] },
  ])
})
afterEach(() => {
  ai.DEEPSEEK_API_KEY = key
})

describe('explainSetup — refusals first', () => {
  it('is off without a key, and reads nothing', async () => {
    ai.DEEPSEEK_API_KEY = undefined
    expect((await explainSetup({ domain: 'getpaid.ng' }))?.data).toEqual({
      ok: false,
      reason: 'off',
    })
    expect(getDomain).not.toHaveBeenCalled()
  })

  it('answers not found for a domain that is not the person’s, before counting', async () => {
    vi.mocked(getDomain).mockResolvedValue(null)
    expect((await explainSetup({ domain: 'someone-else.com' }))?.data).toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect(withinLimit).not.toHaveBeenCalled()
  })

  it('counts per account and stops past the allowance', async () => {
    vi.mocked(withinLimit).mockResolvedValue(false)
    expect((await explainSetup({ domain: 'getpaid.ng' }))?.data).toEqual({
      ok: false,
      reason: 'limited',
    })
    expect(withinLimit).toHaveBeenCalledWith('setup_help:user:user-1', {
      max: 10,
      windowSeconds: 600,
    })
    expect(sent).toHaveLength(0)
  })

  it('answers unavailable when the model cannot answer', async () => {
    modelAnswers({}, 503)
    expect((await explainSetup({ domain: 'getpaid.ng' }))?.data).toEqual({
      ok: false,
      reason: 'unavailable',
    })
  })
})

describe('explainSetup', () => {
  it('sends the live facts without the domain name, and returns the plain steps', async () => {
    modelAnswers({ summary: 'Your change is taking effect.', steps: ['Wait a few hours.'] })
    const result = await explainSetup({ domain: 'getpaid.ng' })

    expect(result?.data).toEqual({
      ok: true,
      help: { summary: 'Your change is taking effect.', steps: ['Wait a few hours.'] },
    })
    expect(sent[0]).not.toContain('getpaid')
    expect(sent[0]).toContain('Vercel')
    expect(sent[0]).toContain('ns1.vercel-dns.com')
  })
})
