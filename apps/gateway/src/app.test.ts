import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from './app'
import { logger } from './lib/logger'

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

  it('logs the route template on an error, never the filled path (N13)', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    try {
      const exploding = new Hono().get('/supplier/domains/:name', () => {
        throw new Error('boom')
      })
      const response = await createApp({ admin: exploding }).request(
        '/v1/admin/supplier/domains/secret-client.com',
        { headers: { authorization: `Bearer ${process.env.GATEWAY_SHARED_SECRET}` } },
      )
      expect(response.status).toBe(500)
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ route: '/v1/admin/supplier/domains/:name' }),
        'unhandled gateway error',
      )
      expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-client')
    } finally {
      spy.mockRestore()
    }
  })

  it('mounts the admin routes, off until an admin secret is set', async () => {
    const response = await createApp().request('/v1/admin/supplier/balance?side=test', {
      headers: { authorization: `Bearer ${process.env.GATEWAY_SHARED_SECRET}` },
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'ADMIN_DISABLED' })
  })
})
