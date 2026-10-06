import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))

const { googleSignInAvailable } = await import('../queries/providers')
const settings = (body: Record<string, unknown>, status = 200) =>
  server.use(http.get(/\/auth\/v1\/settings$/, () => HttpResponse.json(body, { status })))

describe('googleSignInAvailable (FR-A1)', () => {
  it('offers Google once Supabase Auth has it switched on', async () => {
    settings({ external: { google: true, email: true } })
    expect(await googleSignInAvailable()).toBe(true)
  })

  it('hides the button until then', async () => {
    settings({ external: { google: false, email: true } })
    expect(await googleSignInAvailable()).toBe(false)
  })

  it('hides it when Supabase cannot be asked — a button that fails is worse than none', async () => {
    settings({ message: 'down' }, 503)
    expect(await googleSignInAvailable()).toBe(false)
  })
})
