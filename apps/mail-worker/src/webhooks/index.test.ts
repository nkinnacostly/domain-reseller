import { describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../env'
import type { MailClient } from '../store'
import { webhookLoop } from '.'

/** The webhook loop starts only with a key that can open sealed secrets (MR6). */

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const db = { rpc: vi.fn(async () => ({ data: [], error: null })) } as unknown as MailClient

describe('the webhook loop in the worker', () => {
  it('stays off, and says so, without MAIL_WEBHOOK_SECRET_KEY', () => {
    const env = parseEnv({ ...process.env, MAIL_WEBHOOK_SECRET_KEY: undefined })
    expect(webhookLoop(env, db, log, vi.fn())).toBeNull()
    expect(log.warn).toHaveBeenCalledWith({}, expect.stringContaining('MAIL_WEBHOOK_SECRET_KEY'))
  })

  it('stays off with a key that is not 32 bytes', () => {
    const env = parseEnv({ ...process.env, MAIL_WEBHOOK_SECRET_KEY: 'A'.repeat(44) })
    expect(webhookLoop(env, db, log, vi.fn())).toBeNull()
  })

  it('runs with one, beating under its own name', async () => {
    const env = parseEnv({
      ...process.env,
      MAIL_WEBHOOK_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    })
    const heartbeat = vi.fn(async () => undefined)
    const loop = webhookLoop(env, db, log, heartbeat)
    expect(loop).not.toBeNull()
    expect(await loop?.runOnce()).toEqual({ claimed: 0, delivered: 0, failed: 0, unreadable: 0 })
    expect(heartbeat).toHaveBeenCalledWith('mail-worker:webhooks', expect.any(Object))
    expect(env).toMatchObject({
      MAIL_WEBHOOK_BATCH: 20,
      MAIL_WEBHOOK_CONCURRENCY: 5,
      MAIL_WEBHOOK_POLL_MS: 2000,
    })
  })
})
