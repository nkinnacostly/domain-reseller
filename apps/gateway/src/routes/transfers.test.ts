import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app'
import { logger } from '../lib/logger'
import { TokenBucket } from '../lib/rate-limit'
import type { TransferCheckAnswer } from '../provisioning/registrar'
import { createTransfersRoute } from './transfers'

const SECRET = process.env.GATEWAY_SHARED_SECRET as string
const CODE = 'Pa55-Tr4nsfer-C0de'

function appWith(
  answer: TransferCheckAnswer,
  {
    target = 'ote',
    bucket = new TokenBucket(10, 0),
  }: { target?: 'ote' | 'production' | null; bucket?: TokenBucket } = {},
) {
  const checkTransfer = vi.fn(async () => answer)
  const registrar = vi.fn(() => ({ checkTransfer }))
  const app = createApp({ transfers: createTransfersRoute({ target, registrar, bucket }) })
  return { app, registrar, checkTransfer }
}

async function post(app: ReturnType<typeof createApp>, body: unknown, secret = SECRET) {
  const response = await app.request('/v1/transfers/check', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

const ASK = { domainName: 'GetPaid.com', authCode: CODE, testMode: true }
const YES: TransferCheckAnswer = { kind: 'ok', data: { transferable: true } }

describe('POST /v1/transfers/check (FR-T1, N4)', () => {
  it('refuses a caller without the shared secret', async () => {
    const { app, checkTransfer } = appWith(YES)
    const { status } = await post(app, ASK, 'wrong-secret-value-xx')
    expect(status).toBe(401)
    expect(checkTransfer).not.toHaveBeenCalled()
  })

  it('refuses a request it cannot read', async () => {
    const { app, checkTransfer } = appWith(YES)
    for (const body of [{}, { ...ASK, authCode: '' }, { ...ASK, testMode: 'yes' }]) {
      const { status, json } = await post(app, body)
      expect(status).toBe(400)
      expect(json).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    }
    expect(checkTransfer).not.toHaveBeenCalled()
  })

  it('answers for a test order from the sandbox, with the domain normalised', async () => {
    const { app, registrar, checkTransfer } = appWith(YES)
    const { status, json } = await post(app, ASK)
    expect(status).toBe(200)
    expect(json).toEqual({ ok: true, data: { transferable: true } })
    expect(registrar).toHaveBeenCalledWith('ote')
    expect(checkTransfer).toHaveBeenCalledWith('getpaid.com', CODE)
  })

  it('passes on a no with its reason — never the code', async () => {
    const { app } = appWith({
      kind: 'ok',
      data: { transferable: false, reason: 'AUTH_CODE_INVALID' },
    })
    const response = await post(app, ASK)
    expect(response.json).toEqual({
      ok: true,
      data: { transferable: false, reason: 'AUTH_CODE_INVALID' },
    })
    expect(JSON.stringify(response.json)).not.toContain(CODE)
  })

  it('never answers for the other side: a live order is not checked in the sandbox', async () => {
    for (const [target, testMode] of [
      ['ote', false],
      ['production', true],
      [null, true],
    ] as const) {
      const { app, checkTransfer } = appWith(YES, { target })
      const { status, json } = await post(app, { ...ASK, testMode })
      expect(status).toBe(409)
      expect(json).toMatchObject({ ok: false, code: 'TRANSFERS_UNAVAILABLE', retryable: false })
      expect(checkTransfer).not.toHaveBeenCalled()
    }
  })

  it('checks a live order on a live gateway', async () => {
    const { app, registrar } = appWith(YES, { target: 'production' })
    const { status } = await post(app, { ...ASK, testMode: false })
    expect(status).toBe(200)
    expect(registrar).toHaveBeenCalledWith('production')
  })

  it('meters checks, since each can confirm a guessed code', async () => {
    const { app, checkTransfer } = appWith(YES, { bucket: new TokenBucket(1, 0) })
    expect((await post(app, ASK)).status).toBe(200)
    const second = await post(app, ASK)
    expect(second.status).toBe(429)
    expect(second.json).toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    expect(checkTransfer).toHaveBeenCalledTimes(1)
  })

  it('reports a check it could not make as retryable, never as a yes or a no', async () => {
    const { app } = appWith({ kind: 'unknown', code: 'TIMEOUT', message: 'No answer' })
    const { status, json } = await post(app, ASK)
    expect(status).toBe(502)
    expect(json).toMatchObject({ ok: false, code: 'SUPPLIER_UNAVAILABLE', retryable: true })
  })

  it('reports refused credentials as our problem, not the customer’s', async () => {
    const { app } = appWith({ kind: 'blocked', code: 'SUPPLIER_AUTH', message: 'HTTP 401' })
    const { status, json } = await post(app, ASK)
    expect(status).toBe(502)
    expect(json).toMatchObject({ ok: false, code: 'SUPPLIER_AUTH', retryable: false })
  })

  it('logs the extension and the verdict — not the name, not the code (N13)', async () => {
    const info = vi.spyOn(logger, 'info')
    const warn = vi.spyOn(logger, 'warn')
    await post(appWith(YES).app, ASK)
    await post(appWith({ kind: 'unknown', code: 'TIMEOUT', message: CODE }).app, ASK)
    const logged = JSON.stringify([info.mock.calls, warn.mock.calls])
    expect(logged).toContain('"tld":"com"')
    expect(logged).not.toContain(CODE)
    expect(logged).not.toContain('getpaid')
    info.mockRestore()
    warn.mockRestore()
  })
})
