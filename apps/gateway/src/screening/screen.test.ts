import type { AiAnswer, AiRequest, ScreeningAnswer } from '@dr/shared/ai'
import { describe, expect, it, vi } from 'vitest'
import {
  createScreeningJob,
  createScreeningStore,
  type Screening,
  screeningJobFor,
  screenLine,
} from './screen'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const usage = { promptTokens: 120, cachedTokens: 100, completionTokens: 20 }
const said = (verdict: 'clear' | 'review', reason: string): AiAnswer<ScreeningAnswer> => ({
  ok: true,
  value: { verdict, reason },
  usage,
})

function store(lines: { orderItemId: string; domain: string }[], taken: string[] = []) {
  const saved: Screening[] = []
  return {
    saved,
    due: vi.fn(async () => lines),
    save: vi.fn(async (screening: Screening) => {
      if (taken.includes(screening.orderItemId)) return false
      saved.push(screening)
      return true
    }),
  }
}

describe('screenLine', () => {
  it('clears a name with no listed brand without asking the model', async () => {
    const ask = vi.fn()
    const { screening, asked } = await screenLine(
      { orderItemId: 'a', domain: 'ibadanbakes.com' },
      false,
      ask,
    )
    expect(screening).toEqual({
      orderItemId: 'a',
      testMode: false,
      domain: 'ibadanbakes.com',
      verdict: 'clear',
      matched: [],
      note: null,
      model: null,
    })
    expect(asked).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('records the model’s opinion on a listed name, sending only the name and its matches', async () => {
    const ask = vi.fn(async (_request: AiRequest) =>
      said('review', ' Imitates a  PayPal sign-in page '),
    )
    const { screening } = await screenLine(
      { orderItemId: 'b', domain: 'paypal-login.com' },
      false,
      ask,
    )
    expect(screening).toMatchObject({
      verdict: 'review',
      matched: ['paypal', 'login'],
      note: 'Imitates a PayPal sign-in page',
      model: 'deepseek-flash',
    })
    expect(ask.mock.calls[0]?.[0].user).toBe('Domain: paypal-login.com\nContains: paypal, login')
  })

  it('lets the model clear an incidental brand word', async () => {
    const ask = vi.fn(async () => said('clear', 'An ordinary farm name'))
    const { screening } = await screenLine(
      { orderItemId: 'c', domain: 'applewoodfarms.com' },
      false,
      ask,
    )
    expect(screening.verdict).toBe('clear')
    expect(screening.matched).toEqual(['apple'])
  })

  it('passes a listed name to a person when the model cannot be asked', async () => {
    const ask = vi.fn(
      async (): Promise<AiAnswer<ScreeningAnswer>> => ({
        ok: false,
        reason: 'balance',
        status: 402,
      }),
    )
    const { screening, failed } = await screenLine(
      { orderItemId: 'd', domain: 'gtbank-verify.com' },
      false,
      ask,
    )
    expect(screening).toMatchObject({ verdict: 'review', model: null })
    expect(screening.note).toBe('The DeepSeek balance has run out, so a person should look.')
    expect(failed).toBe(true)
  })

  it('passes a listed name to a person when no model is set up', async () => {
    const { screening, asked } = await screenLine(
      { orderItemId: 'e', domain: 'uba-refund.com' },
      false,
      null,
    )
    expect(screening).toMatchObject({ verdict: 'review', matched: ['uba', 'refund'], model: null })
    expect(screening.note).toMatch(/no model is set up/)
    expect(asked).toBe(false)
  })
})

describe('createScreeningJob', () => {
  it('screens every due line once and counts what it recorded', async () => {
    const s = store(
      [
        { orderItemId: '1', domain: 'ibadanbakes.com' },
        { orderItemId: '2', domain: 'paypal-login.com' },
        { orderItemId: '3', domain: 'kuda-support.com' },
      ],
      ['3'],
    )
    const ask = vi
      .fn<(request: AiRequest) => Promise<AiAnswer<ScreeningAnswer>>>()
      .mockResolvedValueOnce(said('review', 'Looks like PayPal'))
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' })
    const job = createScreeningJob({ store: s, ask, testMode: false, log })
    expect(await job.runOnce()).toEqual({ clear: 1, review: 1, asked: 2, failed: 1 })
    expect(s.due).toHaveBeenCalledWith(false, 50)
    expect(s.saved.map((row) => [row.orderItemId, row.verdict])).toEqual([
      ['1', 'clear'],
      ['2', 'review'],
    ])
    // Identifiers only, never a name (N13).
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('kuda')
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('paypal')
  })

  it('keeps running after a failed run, and stops when asked', async () => {
    vi.useFakeTimers()
    const due = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue([])
    const job = createScreeningJob({
      store: { due, save: vi.fn() },
      ask: null,
      testMode: false,
      everyMs: 1_000,
      log,
    })
    job.start()
    job.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(due).toHaveBeenCalledTimes(2)
    expect(log.error).toHaveBeenCalled()
    await job.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(due).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe('createScreeningStore', () => {
  it('reads due lines and writes a screening, a duplicate answered as already done', async () => {
    const inserts: unknown[] = []
    const rpc = vi.fn(async () => ({
      data: [{ order_item_id: 'x', domain: 'paypal-login.com' }],
      error: null,
    }))
    let next: { code: string; message: string } | null = null
    const client = {
      rpc,
      from: () => ({
        insert: async (row: unknown) => {
          inserts.push(row)
          return { error: next }
        },
      }),
    }
    const s = createScreeningStore(client as never)
    expect(await s.due(false, 50)).toEqual([{ orderItemId: 'x', domain: 'paypal-login.com' }])
    expect(rpc).toHaveBeenCalledWith('order_lines_to_screen', { p_test_mode: false, p_limit: 50 })
    const row: Screening = {
      orderItemId: 'x',
      testMode: false,
      domain: 'paypal-login.com',
      verdict: 'review',
      matched: ['paypal', 'login'],
      note: 'Looks like PayPal',
      model: 'deepseek-flash',
    }
    expect(await s.save(row)).toBe(true)
    expect(inserts[0]).toEqual({
      order_item_id: 'x',
      test_mode: false,
      domain: 'paypal-login.com',
      verdict: 'review',
      matched: ['paypal', 'login'],
      note: 'Looks like PayPal',
      model: 'deepseek-flash',
    })
    next = { code: '23505', message: 'duplicate' }
    expect(await s.save(row)).toBe(false)
    next = { code: '42501', message: 'denied' }
    await expect(s.save(row)).rejects.toThrow('denied')
  })

  it('throws when the list cannot be read', async () => {
    const client = { rpc: async () => ({ data: null, error: { message: 'nope' } }) }
    await expect(createScreeningStore(client as never).due(false, 5)).rejects.toThrow('nope')
  })
})

describe('screeningJobFor', () => {
  it('runs only on the live gateway, with or without a DeepSeek key', () => {
    const base = {
      DNA_WRITE_ENV: 'production',
      NEXT_PUBLIC_SUPABASE_URL: 'http://supabase.test',
      SUPABASE_SECRET_KEY: 'secret',
    }
    expect(screeningJobFor({ ...base, DNA_WRITE_ENV: 'ote' } as never, log)).toBeNull()
    expect(screeningJobFor({ ...base } as never, log, { client: {} as never })).not.toBeNull()
    expect(
      screeningJobFor({ ...base, DEEPSEEK_API_KEY: 'k' } as never, log, { client: {} as never }),
    ).not.toBeNull()
  })
})
