import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))
vi.mock('@/lib/supabase/public', () => ({ createPublicClient: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { cacheTag } = await import('next/cache')
const { createPublicClient } = await import('@/lib/supabase/public')
const { logger } = await import('@/lib/logger')
const { getLengthRules, loadLengthRules } = await import('../queries/length-rules')

type Result = { data: unknown; error: { message: string } | null }

/** The query builder: every chained call returns the same promise of the result. */
function answer(result: Result) {
  const calls: { method: string; args: unknown[] }[] = []
  const chain =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
      return query
    }
  const query: Promise<Result> = Object.assign(Promise.resolve(result), {
    select: chain('select'),
    eq: chain('eq'),
    or: chain('or'),
  })
  const from = vi.fn(() => query)
  vi.mocked(createPublicClient).mockReturnValue({ from } as never)
  return { from, calls }
}

beforeEach(() => vi.clearAllMocks())

describe('getLengthRules (FR-S9)', () => {
  it('falls back to no rules, and says so in the log, when the catalogue cannot be read', async () => {
    answer({ data: null, error: { message: 'TypeError: fetch failed' } })
    expect(await getLengthRules()).toEqual({})
    expect(logger.warn).toHaveBeenCalledWith(
      { err: 'tlds: TypeError: fetch failed' },
      expect.stringContaining('length rules unavailable'),
    )
  })

  it('throws from the cached read, so a failure is never cached as "no rules"', async () => {
    answer({ data: null, error: { message: 'dropped' } })
    await expect(loadLengthRules()).rejects.toThrow('tlds: dropped')
  })

  it('reads only sellable extensions that have a rule, from the public catalogue', async () => {
    const { from, calls } = answer({ data: [], error: null })
    await getLengthRules()
    expect(from).toHaveBeenCalledWith('tlds')
    expect(calls).toEqual([
      { method: 'select', args: ['name, min_chars, max_chars'] },
      { method: 'eq', args: ['is_sellable', true] },
      { method: 'or', args: ['min_chars.not.is.null,max_chars.not.is.null'] },
    ])
    expect(cacheTag).toHaveBeenCalledWith('pricing')
  })

  it('keys each rule by extension, keeping an unknown end as null', async () => {
    answer({
      data: [
        { name: 'io', min_chars: 3, max_chars: 63 },
        { name: 'ng', min_chars: null, max_chars: 63 },
      ],
      error: null,
    })
    expect(await getLengthRules()).toEqual({
      io: { min: 3, max: 63 },
      ng: { min: null, max: 63 },
    })
  })

  it('has no rules when the catalogue returns none', async () => {
    answer({ data: null, error: null })
    expect(await getLengthRules()).toEqual({})
  })
})
