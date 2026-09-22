import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'

describe('gateway app', () => {
  it('answers the health check without the shared secret', async () => {
    const response = await createApp().request('/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, data: { status: 'healthy' } })
  })

  it('returns a typed 404 for an unknown route', async () => {
    const response = await createApp().request('/nope')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Unknown route',
    })
  })

  it('turns an unexpected error into a retryable envelope, never a stack trace', async () => {
    const exploding = new Hono().post('/', () => {
      throw new Error('internal detail that must not leak')
    })
    const response = await createApp({ availability: exploding }).request('/v1/availability', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.GATEWAY_SHARED_SECRET}` },
    })
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(JSON.parse(body)).toEqual({
      ok: false,
      code: 'SUPPLIER_UNAVAILABLE',
      message: 'Gateway error',
      retryable: true,
    })
    expect(body).not.toContain('internal detail')
  })
})
