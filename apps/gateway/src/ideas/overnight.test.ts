import type { AiAnswer, NameIdeasAnswer } from '@dr/shared/ai'
import { describe, expect, it, vi } from 'vitest'
import {
  createIdeasJob,
  createIdeasStore,
  dueWords,
  ideasJobFor,
  isOffPeak,
  REFRESH_DAYS,
} from './overnight'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
// A Saturday, and a Tuesday at 11:00 UTC: both off-peak.
const SATURDAY = new Date('2026-11-28T08:00:00Z')

const ideas = (labels: string[]): AiAnswer<NameIdeasAnswer> => ({
  ok: true,
  value: { names: labels.map((label) => ({ label, why: `About ${label}` })) },
  usage: { promptTokens: 500, cachedTokens: 400, completionTokens: 300 },
})

function store(generated: Record<string, string> = {}) {
  const saved: { word: string; labels: string[]; model: string }[] = []
  return {
    saved,
    generatedAt: vi.fn(async () => new Map(Object.entries(generated))),
    save: vi.fn(async (word: string, list: { label: string }[], model: string) => {
      saved.push({ word, labels: list.map((idea) => idea.label), model })
    }),
  }
}

describe('isOffPeak', () => {
  it('waits out DeepSeek’s doubled weekday hours, and runs at the weekend', () => {
    expect(isOffPeak(new Date('2026-11-24T02:00:00Z'))).toBe(false)
    expect(isOffPeak(new Date('2026-11-24T07:30:00Z'))).toBe(false)
    expect(isOffPeak(new Date('2026-11-24T04:00:00Z'))).toBe(true)
    expect(isOffPeak(new Date('2026-11-24T11:00:00Z'))).toBe(true)
    expect(isOffPeak(new Date('2026-11-29T02:00:00Z'))).toBe(true)
  })
})

describe('dueWords', () => {
  it('builds words with no ideas first, then the oldest past the refresh age', () => {
    const old = new Date(SATURDAY.getTime() - (REFRESH_DAYS + 5) * 86_400_000).toISOString()
    const older = new Date(SATURDAY.getTime() - (REFRESH_DAYS + 9) * 86_400_000).toISOString()
    const fresh = new Date(SATURDAY.getTime() - 86_400_000).toISOString()
    expect(
      dueWords(
        ['farm', 'bakery', 'pay', 'lagos', 'hub'],
        new Map([
          ['farm', old],
          ['pay', fresh],
          ['lagos', older],
        ]),
        SATURDAY,
        3,
      ),
    ).toEqual(['bakery', 'hub', 'lagos'])
  })
})

describe('the overnight job', () => {
  it('does nothing in peak hours', async () => {
    const ask = vi.fn()
    const job = createIdeasJob({
      store: store(),
      ask,
      words: ['farm'],
      everyMs: 1,
      now: () => new Date('2026-11-24T02:00:00Z'),
      log,
    })
    expect(await job.runOnce()).toEqual({ built: 0, empty: 0, failed: 0, skipped: 'peak' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks around each due word only, keeps the clean labels, and counts the rest', async () => {
    const kept = store()
    const ask = vi
      .fn()
      .mockResolvedValueOnce(ideas(['FarmHub', 'farm hub', 'agrolink']))
      .mockResolvedValueOnce(ideas(['bad label!']))
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' })
    const job = createIdeasJob({
      store: kept,
      ask,
      words: ['farm', 'bakery', 'pay'],
      everyMs: 1,
      now: () => SATURDAY,
      log,
    })
    expect(await job.runOnce()).toEqual({ built: 1, empty: 1, failed: 1 })
    expect(ask.mock.calls[0]?.[0].user).toBe('Names built around the word "farm".')
    expect(kept.saved).toEqual([
      { word: 'farm', labels: ['farmhub', 'agrolink'], model: 'deepseek-v4-pro' },
    ])
  })

  it('stops at a key or balance problem rather than failing every word', async () => {
    const ask = vi.fn().mockResolvedValue({ ok: false, reason: 'balance', status: 402 })
    const job = createIdeasJob({
      store: store(),
      ask,
      words: ['farm', 'bakery', 'pay'],
      everyMs: 1,
      now: () => SATURDAY,
      log,
    })
    expect(await job.runOnce()).toEqual({ built: 0, empty: 0, failed: 1 })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('runs on start, logs a failed run, and stops cleanly', async () => {
    const broken = {
      generatedAt: vi.fn(async () => Promise.reject(new Error('db down'))),
      save: vi.fn(),
    }
    const job = createIdeasJob({
      store: broken,
      ask: vi.fn(),
      everyMs: 60_000,
      now: () => SATURDAY,
      log,
    })
    job.start()
    job.start()
    await job.stop()
    expect(broken.generatedAt).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(expect.anything(), 'name ideas failed')
  })
})

describe('ideasJobFor', () => {
  it('runs only on the live gateway, and only with a DeepSeek key', () => {
    const base = {
      DNA_WRITE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'http://supabase.test',
      SUPABASE_SECRET_KEY: 'secret',
    }
    expect(ideasJobFor({ ...base, DEEPSEEK_API_KEY: undefined } as never, log)).toBeNull()
    expect(
      ideasJobFor({ ...base, DNA_WRITE_ENV: 'ote', DEEPSEEK_API_KEY: 'k' } as never, log),
    ).toBeNull()
    expect(
      ideasJobFor({ ...base, DEEPSEEK_API_KEY: 'k' } as never, log, { client: {} as never }),
    ).not.toBeNull()
  })
})

describe('createIdeasStore', () => {
  it('reads when each word was built, and saves a word’s ideas whole', async () => {
    const upserts: unknown[] = []
    const client = {
      from: () => ({
        select: async () => ({
          data: [{ word: 'farm', generated_at: '2026-11-01T00:00:00Z' }],
          error: null,
        }),
        upsert: async (row: unknown) => {
          upserts.push(row)
          return { error: null }
        },
      }),
    }
    const kept = createIdeasStore(client as never)
    expect(await kept.generatedAt()).toEqual(new Map([['farm', '2026-11-01T00:00:00Z']]))
    await kept.save('farm', [{ label: 'farmhub', why: null }], 'deepseek-v4-pro')
    expect(upserts[0]).toMatchObject({
      word: 'farm',
      ideas: [{ label: 'farmhub', why: null }],
      model: 'deepseek-v4-pro',
    })
  })

  it('throws a database error rather than reading it as no ideas', async () => {
    const client = {
      from: () => ({
        select: async () => ({ data: null, error: { message: 'down' } }),
        upsert: async () => ({ error: { message: 'down' } }),
      }),
    }
    const kept = createIdeasStore(client as never)
    await expect(kept.generatedAt()).rejects.toThrow('down')
    await expect(kept.save('farm', [], 'm')).rejects.toThrow('down')
  })
})
