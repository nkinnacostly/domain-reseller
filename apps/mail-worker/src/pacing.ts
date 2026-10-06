/**
 * The send-rate budget (MAIL-SPEC MR8, §4.4): a token bucket refilled at
 * MAIL_MAX_SEND_RATE recipients a second that holds a single token, so sends
 * are spaced evenly and never burst past the rate. An email to several
 * recipients takes them all at once and leaves the bucket in debt: the next
 * send waits until the debt is paid. SES counts recipients, and so do we.
 *
 * After a throttle from SES the bucket is emptied for a moment (`pause`):
 * the account's whole budget is shared with the shop, and SES knows better.
 */

export type Clock = { now(): number; sleep(ms: number): Promise<void> }

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export function createPacer(ratePerSecond: number, clock: Clock = realClock) {
  if (!(ratePerSecond > 0)) throw new Error('pacing: the rate must be positive')
  const capacity = 1
  let tokens = capacity
  let last = clock.now()

  const refill = () => {
    const at = clock.now()
    tokens = Math.min(capacity, tokens + ((at - last) / 1000) * ratePerSecond)
    last = at
  }

  return {
    /** Waits until a send of `recipients` may start, then takes them. */
    async take(recipients: number): Promise<void> {
      refill()
      if (tokens < 1) {
        await clock.sleep(Math.ceil(((1 - tokens) / ratePerSecond) * 1000))
        refill()
      }
      tokens -= Math.max(1, recipients)
    },
    /** Nothing more for `ms`: the bucket starts again from empty after it. */
    pause(ms: number): void {
      refill()
      tokens = Math.min(tokens, 1 - (ms / 1000) * ratePerSecond)
    },
    /** For the heartbeat and tests. */
    tokens(): number {
      refill()
      return tokens
    },
  }
}

export type Pacer = ReturnType<typeof createPacer>
