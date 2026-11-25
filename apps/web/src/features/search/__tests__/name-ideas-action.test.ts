import { type PricingInputs, priceCatalogue, type TldRecord } from '@dr/shared'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPricedCatalogue } from '@/features/pricing/queries/pricing'
import { env } from '@/lib/env'
import { addressKey, withinLimit } from '@/lib/rate-limit'
import { server } from '../../../../tests/mocks/server'
import { checkAvailability } from '../queries/availability'
import { getLengthRules } from '../queries/length-rules'

vi.mock('@/features/pricing/queries/pricing', () => ({ getPricedCatalogue: vi.fn() }))
vi.mock('../queries/availability', () => ({ checkAvailability: vi.fn() }))
vi.mock('../queries/length-rules', () => ({ getLengthRules: vi.fn() }))
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  addressKey: vi.fn(),
  withinLimit: vi.fn(),
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))

const { findNameIdeas } = await import('../actions/name-ideas')
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

/** What DeepSeek is sent, kept for the assertions; what it answers, scripted. */
let sent: { authorization: string | null; body: Record<string, unknown> }[] = []
function modelAnswers(names: { label: string; why?: string }[], status = 200) {
  server.use(
    http.post(DEEPSEEK, async ({ request }) => {
      sent.push({
        authorization: request.headers.get('authorization'),
        body: (await request.json()) as Record<string, unknown>,
      })
      if (status !== 200) return HttpResponse.json({ error: {} }, { status })
      return HttpResponse.json({
        choices: [{ message: { content: JSON.stringify({ names }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 300, prompt_cache_hit_tokens: 256, completion_tokens: 90 },
      })
    }),
  )
}

const ask = async (description = 'A bakery in Ibadan that delivers bread', tld = 'com') =>
  (await findNameIdeas({ description, tld }))?.data

let key: string | undefined
beforeEach(() => {
  vi.resetAllMocks()
  sent = []
  key = ai.DEEPSEEK_API_KEY
  ai.DEEPSEEK_API_KEY = 'sk-test'
  vi.mocked(addressKey).mockImplementation(async (scope: string) => `${scope}:hashed`)
  vi.mocked(withinLimit).mockResolvedValue(true)
  vi.mocked(getLengthRules).mockResolvedValue({})
  vi.mocked(getPricedCatalogue).mockResolvedValue({
    tlds: priceCatalogue([record('com')], INPUTS),
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
        status: name === 'breadhub' ? ('registered' as const) : ('available' as const),
      })),
    ),
  }))
})
afterEach(() => {
  ai.DEEPSEEK_API_KEY = key
})

describe('findNameIdeas — refusals first', () => {
  it('says the finder is off without a key, and asks nobody', async () => {
    ai.DEEPSEEK_API_KEY = undefined
    expect(await ask()).toEqual({ ok: false, reason: 'off' })
    expect(sent).toHaveLength(0)
    expect(withinLimit).not.toHaveBeenCalled()
  })

  it('refuses an extension the catalogue does not price, before counting', async () => {
    expect(await ask(undefined, 'xyz')).toEqual({ ok: false, reason: 'unavailable' })
    expect(withinLimit).not.toHaveBeenCalled()
  })

  it('counts each request against the address and stops past the allowance', async () => {
    vi.mocked(withinLimit).mockResolvedValue(false)
    expect(await ask()).toEqual({ ok: false, reason: 'limited' })
    expect(withinLimit).toHaveBeenCalledWith('name_ideas:hashed', LIMITS.nameIdeas)
    expect(sent).toHaveLength(0)
  })

  it('answers unavailable when the model refuses or is down, and checks nothing', async () => {
    modelAnswers([], 503)
    expect(await ask()).toEqual({ ok: false, reason: 'unavailable' })
    expect(checkAvailability).not.toHaveBeenCalled()
  })

  it('passes on a busy registry as busy', async () => {
    modelAnswers([{ label: 'ibadanbakes' }])
    vi.mocked(checkAvailability).mockResolvedValue({ ok: false, reason: 'rate-limited' })
    expect(await ask()).toEqual({ ok: false, reason: 'busy' })
  })

  it('refuses a description too short to work from, before anything', async () => {
    const result = await findNameIdeas({ description: 'bread', tld: 'com' })
    expect(result?.validationErrors).toBeDefined()
    expect(sent).toHaveLength(0)
  })
})

describe('findNameIdeas', () => {
  it('sends the description without contact details, checks the ideas, and returns the free ones priced', async () => {
    modelAnswers([
      { label: 'IbadanBakes', why: 'Says the city and the trade' },
      { label: 'breadhub', why: 'Short' },
      { label: 'bad label!' },
      { label: 'freshloaf' },
    ])
    const result = await ask('Ada’s bakery in Ibadan, call 0803 123 4567 or ada@bakes.ng')

    expect(sent[0]?.authorization).toBe('Bearer sk-test')
    const messages = (sent[0]?.body.messages ?? []) as { content: string }[]
    const user = messages[1]?.content
    expect(user).toContain('Ada’s bakery in Ibadan, call [phone] or [email]')
    expect(user).not.toMatch(/0803|ada@bakes/)
    expect(checkAvailability).toHaveBeenCalledWith(
      ['ibadanbakes', 'breadhub', 'freshloaf'],
      ['com'],
    )

    expect(result).toMatchObject({ ok: true, checked: 3 })
    if (!result?.ok) throw new Error('expected ideas')
    expect(result.ideas.map(({ row, why }) => [row.domain, why])).toEqual([
      ['ibadanbakes.com', 'Says the city and the trade'],
      ['freshloaf.com', null],
    ])
    // Priced from the catalogue, with the renewal beside it (N5b, N8).
    expect(result.ideas[0]?.row.price).toMatchObject({ registerYears: 1, renewYears: 1 })
    expect(result.ideas[0]?.row.price?.register).toMatch(/^₦/)
    expect(result.ideas[0]?.row.price?.renew).toMatch(/^₦/)
  })

  it('leaves out names the extension’s length rule refuses, and checks nothing when none are left', async () => {
    vi.mocked(getLengthRules).mockResolvedValue({ com: { min: 12, max: 63 } } as never)
    modelAnswers([{ label: 'shortname' }])
    expect(await ask()).toEqual({ ok: true, ideas: [], checked: 0 })
    expect(checkAvailability).not.toHaveBeenCalled()
  })
})
