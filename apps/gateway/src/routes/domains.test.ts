import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app'
import { TokenBucket } from '../lib/rate-limit'
import type { AuthCodeReader, Reading } from '../provisioning/registrar'
import { createDomainsRoute } from './domains'

const SECRET = process.env.GATEWAY_SHARED_SECRET as string
const CODE = 'Zx9!secret-code'

function appWith(
  answer: Reading<string>,
  over: Partial<Parameters<typeof createDomainsRoute>[0]> = {},
) {
  const authCode = vi.fn(async () => answer)
  const reader = vi.fn((): AuthCodeReader => ({ authCode }))
  const app = createApp({
    domains: createDomainsRoute({ target: 'ote', reader, ...over }),
  })
  return { app, reader, authCode }
}

async function get(
  app: ReturnType<typeof createApp>,
  path = '/v1/domains/example.com/auth-code?side=sandbox',
  secret = SECRET,
) {
  const response = await app.request(path, { headers: { authorization: `Bearer ${secret}` } })
  return {
    status: response.status,
    cache: response.headers.get('cache-control'),
    body: await response.text(),
  }
}

describe('GET /v1/domains/:name/auth-code (FR-DS5, FR-T5)', () => {
  it('refuses a caller without the shared secret, and reads nothing', async () => {
    const { app, authCode } = appWith({ kind: 'found', data: CODE })
    const { status } = await get(app, undefined, 'wrong-secret-value-xx')
    expect(status).toBe(401)
    expect(authCode).not.toHaveBeenCalled()
  })

  it('refuses to ask the live registry from a sandbox gateway, and the other way round', async () => {
    const sandbox = appWith({ kind: 'found', data: CODE })
    const live = await get(sandbox.app, '/v1/domains/example.com/auth-code?side=live')
    expect(live.status).toBe(409)
    expect(JSON.parse(live.body)).toMatchObject({ ok: false, code: 'WRONG_REGISTRY' })
    expect(sandbox.authCode).not.toHaveBeenCalled()

    const production = appWith({ kind: 'found', data: CODE }, { target: 'production' })
    expect((await get(production.app)).status).toBe(409)
  })

  it('refuses when this gateway reaches no registry at all', async () => {
    const { app, authCode } = appWith({ kind: 'found', data: CODE }, { target: 'off' })
    const { status, body } = await get(app)
    expect(status).toBe(409)
    expect(JSON.parse(body)).toMatchObject({ code: 'WRONG_REGISTRY' })
    expect(authCode).not.toHaveBeenCalled()
  })

  it('refuses a bad name or a missing side', async () => {
    const { app } = appWith({ kind: 'found', data: CODE })
    expect((await get(app, '/v1/domains/not_a_domain/auth-code?side=sandbox')).status).toBe(400)
    expect((await get(app, '/v1/domains/example.com/auth-code')).status).toBe(400)
  })

  it('returns the code from the domain’s own registry, never cached', async () => {
    const { app, reader, authCode } = appWith({ kind: 'found', data: CODE })
    const { status, cache, body } = await get(app, '/v1/domains/Example.COM/auth-code?side=sandbox')
    expect(status).toBe(200)
    expect(cache).toBe('no-store')
    expect(JSON.parse(body)).toEqual({ ok: true, data: { authCode: CODE } })
    expect(reader).toHaveBeenCalledWith('ote')
    expect(authCode).toHaveBeenCalledWith('example.com')
  })

  it('says so when the registry does not list the domain in our account', async () => {
    const { app } = appWith({ kind: 'not_found' })
    const { status, body } = await get(app)
    expect(status).toBe(404)
    expect(JSON.parse(body)).toMatchObject({ code: 'DOMAIN_NOT_FOUND' })
  })

  it('reports an unreadable registry as retryable, and a missing code as unavailable', async () => {
    const down = await get(appWith({ kind: 'unknown', code: 'TIMEOUT', message: 'x' }).app)
    expect(down.status).toBe(502)
    expect(JSON.parse(down.body)).toMatchObject({ code: 'SUPPLIER_UNAVAILABLE', retryable: true })
    expect(down.cache).toBe('no-store')

    const blocked = await get(
      appWith({ kind: 'blocked', code: 'SUPPLIER_AUTH', message: 'HTTP 401' }).app,
    )
    expect(JSON.parse(blocked.body)).toMatchObject({ code: 'SUPPLIER_UNAVAILABLE' })

    const none = await get(appWith({ kind: 'unknown', code: 'NO_AUTH_CODE', message: 'x' }).app)
    expect(JSON.parse(none.body)).toMatchObject({
      code: 'AUTH_CODE_UNAVAILABLE',
      retryable: false,
    })
  })

  it('limits how often one domain’s code is read', async () => {
    const { app, authCode } = appWith(
      { kind: 'found', data: CODE },
      { perDomain: () => new TokenBucket(2, 0) },
    )
    expect((await get(app)).status).toBe(200)
    expect((await get(app)).status).toBe(200)
    const third = await get(app)
    expect(third.status).toBe(429)
    expect(JSON.parse(third.body)).toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    expect(authCode).toHaveBeenCalledTimes(2)
    // Another domain has its own allowance.
    expect((await get(app, '/v1/domains/other.com/auth-code?side=sandbox')).status).toBe(200)
  })

  it('limits reads across every domain', async () => {
    const { app } = appWith({ kind: 'found', data: CODE }, { all: new TokenBucket(1, 0) })
    expect((await get(app)).status).toBe(200)
    expect((await get(app, '/v1/domains/other.com/auth-code?side=sandbox')).status).toBe(429)
  })

  it('answers retryable, never with a code, when its own registry cannot be reached', async () => {
    // The real reader, on a gateway with no sandbox key: nothing to ask with.
    const app = createApp({ domains: createDomainsRoute({ target: 'ote' }) })
    const { status, body } = await get(app)
    expect(status).toBe(500)
    expect(JSON.parse(body)).toMatchObject({ ok: false, retryable: true })
  })

  it('never writes the code to the log', async () => {
    const { logger } = await import('../lib/logger')
    const info = vi.spyOn(logger, 'info')
    await get(appWith({ kind: 'found', data: CODE }).app)
    expect(JSON.stringify(info.mock.calls)).not.toContain(CODE)
    expect(JSON.stringify(info.mock.calls)).not.toContain('example.com')
    info.mockRestore()
  })
})
