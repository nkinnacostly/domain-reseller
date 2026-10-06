import { describe, expect, it } from 'vitest'
import { createPacer } from './pacing'

/** A clock that only moves when the pacer sleeps. */
function fakeClock() {
  let now = 0
  const sleeps: number[] = []
  return {
    sleeps,
    advance: (ms: number) => {
      now += ms
    },
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        now += ms
      },
    },
  }
}

describe('pacing at MAIL_MAX_SEND_RATE (MR8)', () => {
  it('spaces sends evenly at the rate and never bursts past it', async () => {
    const { clock, sleeps } = fakeClock()
    const pacer = createPacer(10, clock)
    for (let i = 0; i < 5; i++) await pacer.take(1)
    expect(sleeps).toEqual([100, 100, 100, 100])
  })

  it('counts recipients: after an email to five, the next waits for all five', async () => {
    const { clock, sleeps } = fakeClock()
    const pacer = createPacer(10, clock)
    await pacer.take(5)
    await pacer.take(1)
    expect(sleeps).toEqual([500])
  })

  it('does not wait when time has already passed, and never saves up a burst', async () => {
    const { clock, sleeps, advance } = fakeClock()
    const pacer = createPacer(10, clock)
    await pacer.take(1)
    advance(60_000)
    expect(pacer.tokens()).toBe(1)
    await pacer.take(1)
    await pacer.take(1)
    expect(sleeps).toEqual([100])
  })

  it('pauses after a throttle: nothing for that long', async () => {
    const { clock, sleeps } = fakeClock()
    const pacer = createPacer(10, clock)
    pacer.pause(1000)
    await pacer.take(1)
    expect(sleeps).toEqual([1000])
  })

  it('refuses a rate that is not positive', () => {
    expect(() => createPacer(0)).toThrow('positive')
  })
})
