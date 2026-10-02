import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../app'
import { createAdminRouter } from './routes'
import { ADMIN_SECRET, adminHeaders, fakeDeps, fakeSupplier, GATEWAY_SECRET } from './test-kit'

// biome-ignore lint/suspicious/noExplicitAny: answers are JSON, read field by field by the tests
type Json = any
const read = async (response: Response): Promise<Json> => response.json()

/**
 * ADMIN-SPEC §4.1, §4.6: the shared secret is not enough, the admin secret is
 * not enough, and nothing upstream is called before a note is claimed.
 */

const BALANCE = { status: 200, body: { usdBalance: 43.38, resellerGroupName: 'Reseller' } }

function app(over: Parameters<typeof fakeDeps>[0] = {}) {
  const { supplier, calls } = fakeSupplier({ '/deposit/accounts/me': BALANCE })
  const kit = fakeDeps({ targetSupplier: () => supplier, ...over })
  return { app: createApp({ admin: createAdminRouter(kit.deps) as never }), calls, ...kit }
}

const get = (a: ReturnType<typeof app>['app'], headers: Record<string, string>) =>
  a.request('/v1/admin/supplier/balance?side=test', { headers })

describe('the admin door', () => {
  it('turns every admin route off when no admin secret is configured', async () => {
    const { app: a, calls } = app({ secret: undefined })
    const response = await get(a, adminHeaders())
    expect(response.status).toBe(503)
    expect(await read(response)).toMatchObject({ ok: false, code: 'ADMIN_DISABLED' })
    expect(calls).toHaveLength(0)
  })

  it('refuses the gateway secret alone, or a wrong admin secret', async () => {
    const { app: a, calls, claims } = app()
    const alone = await get(a, { authorization: `Bearer ${GATEWAY_SECRET}` })
    expect(alone.status).toBe(401)
    const wrong = await get(a, { ...adminHeaders(), 'x-admin-secret': 'b'.repeat(40) })
    expect(wrong.status).toBe(401)
    const short = await get(a, { ...adminHeaders(), 'x-admin-secret': 'short' })
    expect(short.status).toBe(401)
    expect(calls).toHaveLength(0)
    expect(claims).toHaveLength(0)
  })

  it('refuses the admin secret without the gateway secret', async () => {
    const { app: a } = app()
    const response = await get(a, {
      'x-admin-secret': ADMIN_SECRET,
      'x-admin-audit-id': '1',
      'x-admin-label': 'owner',
    })
    expect(response.status).toBe(401)
  })

  it('needs a well-formed note id and admin label', async () => {
    const { app: a, claims } = app()
    for (const [id, label] of [
      ['abc', 'owner'],
      ['1'.repeat(20), 'owner'],
      ['', 'owner'],
      ['12', 'Owner'],
      ['12', 'o'],
      ['12', 'owner@example.com'],
      ['99999999999999999999'.slice(0, 19), 'owner'],
    ] as const) {
      const response = await get(a, adminHeaders(id, label))
      expect(response.status).toBe(400)
    }
    expect(claims).toHaveLength(0)
  })

  it('calls nothing when the note is refused, and says why', async () => {
    const { app: a, calls, deps } = app()
    deps.notes.claim = vi.fn(async () => ({ ok: false as const, code: 'EXPIRED' }))
    const response = await get(a, adminHeaders())
    expect(response.status).toBe(403)
    expect(await read(response)).toMatchObject({
      ok: false,
      code: 'ADMIN_NOTE_REFUSED',
      reason: 'EXPIRED',
    })
    expect(calls).toHaveLength(0)
    expect(deps.notes.result).not.toHaveBeenCalled()
  })

  it('claims the note for the route’s own action, then records exactly one result', async () => {
    const { app: a, claims, results } = app()
    const response = await get(a, adminHeaders('41', 'owner'))
    expect(response.status).toBe(200)
    expect(claims).toEqual([[41, 'supplier.balance', 'owner', 'test', 'test']])
    expect(results).toEqual([[41, 'ok', null, { cents: 4338 }]])
  })

  it('still answers when the result cannot be recorded, and says so in the log', async () => {
    const { app: a, deps, log } = app()
    deps.notes.result = vi.fn(async () => {
      throw new Error('db down')
    })
    const response = await get(a, adminHeaders())
    expect(response.status).toBe(200)
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ auditId: 41 }),
      'admin result not recorded',
    )
  })
})
