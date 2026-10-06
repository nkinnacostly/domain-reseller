import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { parseEnv } from './env'
import { healthStatus, startHealthServer } from './health'

let close: (() => void) | null = null
afterEach(() => close?.())

describe('health (§11)', () => {
  it('is healthy while the loop runs, and not once it has been silent too long', () => {
    expect(healthStatus(null, 1000, 60_000)).toBe(503)
    expect(healthStatus(1000, 61_000, 60_000)).toBe(200)
    expect(healthStatus(1000, 61_001, 60_000)).toBe(503)
  })

  it('answers GET /health and nothing else', async () => {
    let status = 200
    const server = startHealthServer(0, () => status)
    close = () => server.close()
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const healthy = await fetch(`${base}/health`)
    expect(healthy.status).toBe(200)
    expect(await healthy.json()).toEqual({ ok: true })
    status = 503
    expect((await fetch(`${base}/health`)).status).toBe(503)
    expect((await fetch(`${base}/other`)).status).toBe(404)
  })
})

describe('the worker’s environment', () => {
  const base = {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SECRET_KEY: 'sb_test',
    MAIL_SES_SENDER_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    MAIL_SES_SENDER_SECRET_ACCESS_KEY: 'test secret, not a real key',
  }

  it('paces at 10 a second in eu-west-2 unless told otherwise (MR8)', () => {
    const env = parseEnv(base)
    expect(env.MAIL_MAX_SEND_RATE).toBe(10)
    expect(env.MAIL_SES_REGION).toBe('eu-west-2')
    expect(env.MAIL_QUOTA_HOLD_FREE_AT).toBe(0.8)
    expect(env.MAIL_WORKER_ID).toMatch(/^mail-worker:/)
    expect(parseEnv({ ...base, MAIL_MAX_SEND_RATE: '4' }).MAIL_MAX_SEND_RATE).toBe(4)
  })

  it('will not start without the sending key, or with a rate that is not a rate', () => {
    const { MAIL_SES_SENDER_ACCESS_KEY_ID: _id, ...withoutKey } = base
    expect(() => parseEnv(withoutKey)).toThrow()
    expect(() => parseEnv({ ...base, MAIL_MAX_SEND_RATE: '0' })).toThrow()
    expect(() => parseEnv({ ...base, MAIL_SES_REGION: 'evil.example' })).toThrow()
  })
})
