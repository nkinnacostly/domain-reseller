import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getNameserverPresets } from '@/features/domains/queries/domains'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { searchAllowance } from '@/features/search/queries/allowance'
import { checkAvailability } from '@/features/search/queries/availability'
import { getLengthRules } from '@/features/search/queries/length-rules'
import { env } from '@/lib/env'
import { addressKey, withinLimit } from '@/lib/rate-limit'
import { server } from '../../../../tests/mocks/server'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('@/features/search/queries/availability', () => ({ checkAvailability: vi.fn() }))
vi.mock('@/features/search/queries/length-rules', () => ({ getLengthRules: vi.fn() }))
vi.mock('@/features/search/queries/allowance', () => ({ searchAllowance: vi.fn() }))
vi.mock('@/features/domains/queries/domains', () => ({ getNameserverPresets: vi.fn() }))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  addressKey: vi.fn(),
  withinLimit: vi.fn(),
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/ai', async (original) => ({
  ...(await original<typeof import('@/lib/ai')>()),
  noteAiUsage: vi.fn(),
}))

const { askAssistant } = await import('../actions/ask-assistant')
const { noteAiUsage } = await import('@/lib/ai')
const { LIMITS } = await import('@/lib/rate-limit')

const DEEPSEEK = 'https://api.deepseek.com/chat/completions'
const INPUTS: PricingInputs = { fxRate: 1333.76, fxBufferPct: 0, marginNgn: 3000, icannFeeUsd: 0.2 }
const record = (name: string): TldRecord => ({
  name,
  registerUsd: 11.31,
  renewUsd: 12.5,
  transferUsd: null,
  restoreUsd: null,
  isCountryCode: false,
  minPeriod: 1,
  maxPeriod: 10,
  redemptionDays: 30,
  requiresExtraFields: false,
})
const ai = env as { DEEPSEEK_API_KEY?: string }

type Sent = { system: string; user: string }
let sent: Sent[] = []

/**
 * DeepSeek, scripted: the routing call answers `route`; a name-ideas call
 * (another system prompt) answers `names`. What each was sent is kept.
 */
function model(route: unknown, names: { label: string; why?: string }[] = [], status = 200) {
  server.use(
    http.post(DEEPSEEK, async ({ request }) => {
      const body = (await request.json()) as { messages: { role: string; content: string }[] }
      const system = body.messages.find((message) => message.role === 'system')?.content ?? ''
      const user = body.messages.find((message) => message.role === 'user')?.content ?? ''
      sent.push({ system, user })
      if (status !== 200) return HttpResponse.json({ error: {} }, { status })
      const routing = system.startsWith('You are the assistant on MyDomainsHub')
      return HttpResponse.json({
        choices: [
          {
            message: { content: JSON.stringify(routing ? route : { names }) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 4000, prompt_cache_hit_tokens: 3800, completion_tokens: 60 },
      })
    }),
  )
}

const ask = async (
  message: string,
  history: { role: 'person' | 'assistant'; text: string }[] = [],
) => (await askAssistant({ message, history }))?.data

let key: string | undefined
beforeEach(() => {
  vi.resetAllMocks()
  sent = []
  key = ai.DEEPSEEK_API_KEY
  ai.DEEPSEEK_API_KEY = 'sk-test'
  vi.mocked(addressKey).mockImplementation(async (scope: string) => `${scope}:hashed`)
  vi.mocked(withinLimit).mockResolvedValue(true)
  vi.mocked(searchAllowance).mockResolvedValue('ok')
  vi.mocked(getLengthRules).mockResolvedValue({})
  vi.mocked(getNameserverPresets).mockResolvedValue([
    {
      id: 'p1',
      provider: 'Vercel',
      nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
      assignsPerZone: false,
      notes: null,
      sourceUrl: 'https://vercel.com/docs/domains',
    },
  ])
  vi.mocked(getPricedCatalogue).mockResolvedValue({
    tlds: priceCatalogue([record('com'), record('io')], INPUTS),
    featured: [],
    effectiveRate: 1334,
    rateSource: 'test',
    rateUpdatedAt: new Date(),
    rateId: 'rate-1',
    vatPct: 7.5,
    version: 'test',
  })
  vi.mocked(checkAvailability).mockImplementation(async (names, extensions) => ({
    ok: true,
    results: names.flatMap((name) =>
      extensions.map((tld) => ({
        name,
        tld,
        domain: `${name}.${tld}`,
        status: name === 'taken' ? ('registered' as const) : ('available' as const),
      })),
    ),
  }))
})
afterEach(() => {
  ai.DEEPSEEK_API_KEY = key
})

describe('askAssistant — refusals first (AI phase 5)', () => {
  it('says it is off without a key, and asks nobody', async () => {
    ai.DEEPSEEK_API_KEY = undefined
    expect(await ask('Is lagosbakes.com free?')).toEqual({ ok: false, reason: 'off' })
    expect(sent).toHaveLength(0)
    expect(withinLimit).not.toHaveBeenCalled()
  })

  it('counts each message against the address and stops past the allowance', async () => {
    vi.mocked(withinLimit).mockResolvedValue(false)
    expect(await ask('Is lagosbakes.com free?')).toEqual({ ok: false, reason: 'limited' })
    expect(withinLimit).toHaveBeenCalledWith('assistant:hashed', LIMITS.assistant)
    expect(sent).toHaveLength(0)
  })

  it('answers unavailable when the model is down, counts the failure, and checks nothing', async () => {
    model(null, [], 503)
    expect(await ask('Is lagosbakes.com free?')).toEqual({ ok: false, reason: 'unavailable' })
    expect(checkAvailability).not.toHaveBeenCalled()
    expect(noteAiUsage).toHaveBeenCalledWith(
      'site_assistant',
      expect.anything(),
      expect.objectContaining({ ok: false }),
    )
  })

  it('treats an answer of no known kind as no answer', async () => {
    model({ kind: 'register', domain: 'lagosbakes.com' })
    expect(await ask('Register lagosbakes.com for me')).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it('refuses a message too short or too long, before anything', async () => {
    expect((await askAssistant({ message: 'x' }))?.validationErrors).toBeDefined()
    expect((await askAssistant({ message: 'x'.repeat(501) }))?.validationErrors).toBeDefined()
    expect(sent).toHaveLength(0)
  })

  it('sends DeepSeek no email address or phone number, from the message or the history', async () => {
    model({ kind: 'other' })
    await ask('Email me at ada@example.com or call 08031234567', [
      { role: 'person', text: 'I am ada@example.com' },
    ])
    expect(sent[0]?.user).not.toMatch(/ada@example\.com|08031234567/)
  })
})

describe('askAssistant — names', () => {
  it('asks the name finder, checks only on a sold extension, and counts the line as the assistant’s', async () => {
    model({ kind: 'names', description: 'A bakery in Ibadan', extension: 'io', language: 'en' }, [
      { label: 'ibadanbakes', why: 'Place and trade' },
      { label: 'taken' },
    ])
    const result = await ask('Names for my bakery in Ibadan, .io please')
    expect(result).toMatchObject({
      ok: true,
      reply: { kind: 'names', tld: 'io', checked: 2, notSold: null },
    })
    const reply = result?.ok ? result.reply : null
    expect(reply?.kind === 'names' && reply.ideas.map((idea) => idea.row.domain)).toEqual([
      'ibadanbakes.io',
    ])
    expect(checkAvailability).toHaveBeenCalledWith(['ibadanbakes', 'taken'], ['io'])
    // The routing call, then the name finder's own call, each counted as its own.
    expect(sent).toHaveLength(2)
    expect(vi.mocked(noteAiUsage).mock.calls.map((call) => call[0])).toEqual([
      'name_finder',
      'site_assistant',
    ])
    expect(withinLimit).toHaveBeenCalledWith('name_ideas:hashed', LIMITS.nameIdeas)
  })

  it('offers .com when the extension asked for is not sold, and says so', async () => {
    model({ kind: 'names', description: 'A tailor', extension: 'ng', language: 'pcm' }, [
      { label: 'tailorwey' },
    ])
    const result = await ask('Pidgin names for my tailor shop on .ng')
    expect(result).toMatchObject({
      ok: true,
      reply: { kind: 'names', tld: 'com', notSold: 'ng', language: 'pcm' },
    })
    expect(sent[1]?.user).toContain('Language: Nigerian Pidgin')
  })

  it('passes on the name finder’s refusal', async () => {
    model({ kind: 'names', description: 'A tailor', extension: null, language: 'en' })
    vi.mocked(withinLimit).mockImplementation(async (key) => key !== 'name_ideas:hashed')
    expect(await ask('Names for my tailor shop')).toEqual({ ok: false, reason: 'limited' })
  })
})

describe('askAssistant — checking named domains', () => {
  it('checks them with the registry and prices them from the tables (N5b, N8)', async () => {
    model({ kind: 'check', domains: ['lagosbakes.com', 'taken.com', 'lagosbakes', 'x.zz'] })
    const result = await ask('Are lagosbakes.com, taken.com and x.zz free?')
    if (!result?.ok || result.reply.kind !== 'check') throw new Error('expected a check')
    expect(result.reply.rows.map((row) => [row.domain, row.status])).toEqual([
      ['lagosbakes.com', 'available'],
      ['taken.com', 'registered'],
    ])
    expect(result.reply.rows[0]?.price?.renew).toMatch(/^₦/)
    expect(result.reply.notSold).toEqual(['.zz'])
    // One call per extension, each name once.
    expect(checkAvailability).toHaveBeenCalledTimes(1)
    expect(checkAvailability).toHaveBeenCalledWith(['lagosbakes', 'taken'], ['com'])
    expect(result.memo).toBe('Checked: lagosbakes.com is free, taken.com is not free.')
  })

  it('sends a person past the search allowance to the search page, checking nothing (SEC-9)', async () => {
    model({ kind: 'check', domains: ['lagosbakes.com'] })
    vi.mocked(searchAllowance).mockResolvedValue('challenge')
    expect(await ask('Is lagosbakes.com free?')).toMatchObject({
      ok: true,
      reply: { kind: 'search', query: 'lagosbakes.com' },
    })
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it('passes on a busy registry as busy', async () => {
    model({ kind: 'check', domains: ['lagosbakes.com'] })
    vi.mocked(checkAvailability).mockResolvedValue({ ok: false, reason: 'rate-limited' })
    expect(await ask('Is lagosbakes.com free?')).toEqual({ ok: false, reason: 'busy' })
  })
})

describe('askAssistant — prices, setup, help and the rest', () => {
  it('quotes prices from the tables only, each with its renewal (N8)', async () => {
    model({ kind: 'prices', extensions: ['com', 'zz'] })
    const result = await ask('How much is .com and .zz?')
    if (!result?.ok || result.reply.kind !== 'prices') throw new Error('expected prices')
    expect(result.reply.prices).toHaveLength(1)
    expect(result.reply.prices[0]?.words).toMatch(
      /^₦[\d,]+ for the first year, then ₦[\d,]+ a year$/,
    )
    expect(result.reply.notSold).toEqual(['.zz'])
    expect(result.reply.vatPct).toBe(7.5)
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it('gives a host’s nameservers only from a checked preset (N11)', async () => {
    model({ kind: 'setup', host: 'vercel' })
    expect(await ask('How do I point my domain at vercel?')).toMatchObject({
      ok: true,
      reply: {
        kind: 'setup',
        preset: { provider: 'Vercel', nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'] },
      },
    })
    model({ kind: 'setup', host: 'Wix' })
    expect(await ask('And at Wix?')).toMatchObject({
      ok: true,
      reply: { kind: 'setup', host: 'Wix', preset: null },
    })
  })

  it('shows a help answer only from known pages, and never one that states a price', async () => {
    model({
      kind: 'help',
      answered: true,
      answer: 'Renew from the domain’s page in your panel.',
      sources: ['/help#renewals', '/somewhere-else'],
    })
    expect(await ask('How do I renew?')).toMatchObject({
      ok: true,
      reply: {
        kind: 'help',
        help: {
          answered: true,
          sources: [{ path: '/help#renewals', title: 'Help: Renewals and expiry' }],
        },
      },
    })
    model({ kind: 'help', answered: true, answer: 'A .com is ₦18,300.', sources: [] })
    expect(await ask('What does a .com cost to renew?')).toMatchObject({
      ok: true,
      reply: { kind: 'help', help: { answered: false } },
    })
    // An answer that could not help is counted as declined.
    expect(noteAiUsage).toHaveBeenLastCalledWith(
      'site_assistant',
      expect.anything(),
      expect.objectContaining({ ok: true }),
      true,
    )
  })

  it('says what it can do for anything else', async () => {
    model({ kind: 'other' })
    expect(await ask('Write me a poem about rain')).toEqual({
      ok: true,
      reply: { kind: 'other' },
      memo: 'Said what the assistant can help with.',
    })
  })
})
