import type DomainNameApi from 'nodejs-dna'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app'
import { Semaphore } from '../lib/semaphore'
import { createAccountRoute } from './account'

const SECRET = process.env.GATEWAY_SHARED_SECRET as string

function appWith(GetCurrentBalance: () => Promise<unknown>) {
  const client = { GetCurrentBalance: vi.fn(GetCurrentBalance) } as unknown as DomainNameApi
  return createApp({
    account: createAccountRoute({ client: () => client, slots: new Semaphore(2) }),
  })
}

async function get(app: ReturnType<typeof createApp>, secret = SECRET) {
  const response = await app.request('/v1/account/balance', {
    headers: { authorization: `Bearer ${secret}` },
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

describe('GET /v1/account/balance', () => {
  it('refuses a caller without the shared secret', async () => {
    const { status } = await get(
      appWith(async () => ({})),
      'wrong-secret-value-xx',
    )
    expect(status).toBe(401)
  })

  it('reads the balance the supplier sends as a string', async () => {
    const { json } = await get(
      appWith(async () => ({ OperationResult: 'SUCCESS', Balance: '152.40', CurrencyName: 'USD' })),
    )
    expect(json).toEqual({ ok: true, data: { balanceUsd: 152.4 } })
  })

  it('reports a failed read as retryable, never as a zero balance', async () => {
    const { status, json } = await get(appWith(async () => ({ OperationResult: 'FAILED' })))
    expect(status).toBe(502)
    expect(json).toMatchObject({ ok: false, retryable: true })
  })

  it('reports a supplier that throws as retryable', async () => {
    const { status, json } = await get(
      appWith(async () => {
        throw new Error('socket hang up')
      }),
    )
    expect(status).toBe(502)
    expect(json).toMatchObject({ ok: false, retryable: true })
  })
})
