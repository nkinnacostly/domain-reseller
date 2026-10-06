import type { SesQuota, SesResult } from '@dr/shared/ses'
import { describe, expect, it, vi } from 'vitest'
import { createQuotaWatch } from './quota'

const log = { info: vi.fn(), warn: vi.fn() }

const quota = (
  sentLast24Hours: number | null,
  max24HourSend: number | null = 50000,
): SesResult<{ quota: SesQuota }> => ({
  ok: true,
  quota: { max24HourSend, sentLast24Hours, maxSendRate: 14, sendingEnabled: true },
})

function watch(...answers: SesResult<{ quota: SesQuota }>[]) {
  const heartbeat = vi.fn(async () => {})
  const read = vi.fn(async () => answers.shift() ?? quota(0))
  return {
    w: createQuotaWatch({ read, holdFreeAt: 0.8, everyMs: 60_000, log, heartbeat }),
    heartbeat,
    read,
  }
}

describe('the SES account’s day (§4.4)', () => {
  it('holds free and sandbox accounts at 80% of the 24-hour quota, and lets them go below it', async () => {
    const { w, heartbeat } = watch(quota(39_999), quota(40_000), quota(10_000))
    expect(await w.check()).toBe(false)
    expect(await w.check()).toBe(true)
    expect(w.holdFree()).toBe(true)
    expect(await w.check()).toBe(false)
    expect(heartbeat).toHaveBeenLastCalledWith({
      max24HourSend: 50000,
      sentLast24Hours: 10_000,
      maxSendRate: 14,
      share: 0.2,
      holdFree: false,
    })
  })

  it('keeps the last answer when SES cannot be read, and holds nobody without one', async () => {
    const failed = {
      ok: false as const,
      status: 503,
      code: null,
      retryable: true,
      error: 'HTTP 503',
    }
    const { w } = watch(failed, quota(45_000), failed)
    expect(await w.check()).toBe(false)
    expect(await w.check()).toBe(true)
    expect(await w.check()).toBe(true)
    const { w: unknown } = watch(quota(null), quota(10, null))
    expect(await unknown.check()).toBe(false)
    expect(await unknown.check()).toBe(false)
  })

  it('checks on a timer until stopped, and survives a check that throws', async () => {
    vi.useFakeTimers()
    const { w, read } = watch()
    read.mockRejectedValueOnce(new Error('network'))
    w.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(2)
    w.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledWith({ err: 'network' }, 'SES quota check failed')
    vi.useRealTimers()
  })
})
