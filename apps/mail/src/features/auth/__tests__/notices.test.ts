import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { server } from '../../../../tests/mocks/server'
import { mockRpc, SUPABASE_URL } from '../../../../tests/mocks/supabase'
import { noteSignIn, queueAccountNotice, recordResetHold } from '../queries/notices'
import { readResetHold } from '../queries/security'

/**
 * The shop's account-wide security calls, as they reach PostgREST (MAIL-SPEC
 * M5): schema `public`, the secret key, ids only — and none of them ever
 * turns a done change into an error.
 */

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

describe('the shop’s security notices, queued from Mail', () => {
  it('queues the notice in the public schema with the secret key, by user id', async () => {
    const calls = mockRpc({ queue_account_email: () => null })
    await queueAccountNotice('user-1', 'two_factor_off')
    expect(calls).toEqual([
      {
        fn: 'queue_account_email',
        body: { p_user_id: 'user-1', p_kind: 'two_factor_off' },
        schema: 'public',
        auth: 'Bearer sb_test',
      },
    ])
  })

  it('notes a sign-in by the device it came from, never the raw user agent', async () => {
    const calls = mockRpc({ note_sign_in: () => null })
    await noteSignIn(
      'user-1',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1',
    )
    expect(calls[0]?.body).toEqual({ p_user_id: 'user-1', p_device: 'Safari on iOS' })
  })

  it('swallows a refusal or an outage: the change it reports already happened', async () => {
    mockRpc({
      queue_account_email: () => ({ status: 500, body: { message: 'down' } }),
      note_sign_in: () => ({ status: 500, body: { message: 'down' } }),
    })
    await expect(queueAccountNotice('user-1', 'password_changed')).resolves.toBeUndefined()
    await expect(noteSignIn('user-1', null)).resolves.toBeUndefined()
    server.use(http.post(`${SUPABASE_URL}/rest/v1/rpc/:fn`, () => HttpResponse.error()))
    await expect(queueAccountNotice('user-1', 'password_changed')).resolves.toBeUndefined()
    await expect(noteSignIn('user-1', null)).resolves.toBeUndefined()
  })
})

describe('the shop’s 24-hour hold after a reset', () => {
  it('is started on the person’s profile row with the secret key', async () => {
    const seen: { url: string; profile: string | null; body: unknown }[] = []
    server.use(
      http.patch(`${SUPABASE_URL}/rest/v1/profiles`, async ({ request }) => {
        seen.push({
          url: request.url,
          profile: request.headers.get('content-profile'),
          body: await request.json(),
        })
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await recordResetHold('user-1')
    expect(seen).toHaveLength(1)
    expect(new URL(seen[0]?.url ?? '').searchParams.get('id')).toBe('eq.user-1')
    expect(seen[0]?.profile).toBe('public')
    expect(seen[0]?.body).toEqual({ password_reset_at: expect.any(String) })
  })

  it('never throws when it cannot be written', async () => {
    server.use(
      http.patch(`${SUPABASE_URL}/rest/v1/profiles`, () =>
        HttpResponse.json({ message: 'no' }, { status: 500 }),
      ),
    )
    await expect(recordResetHold('user-1')).resolves.toBeUndefined()
    server.use(http.patch(`${SUPABASE_URL}/rest/v1/profiles`, () => HttpResponse.error()))
    await expect(recordResetHold('user-1')).resolves.toBeUndefined()
  })

  it('is read as the person; one that cannot be read counts as just started', async () => {
    const answer = (data: unknown, error: unknown) => ({
      schema: () => ({
        from: () => ({
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }),
        }),
      }),
    })
    expect(
      await readResetHold(
        answer({ password_reset_at: '2026-10-01T00:00:00Z' }, null) as never,
        'u',
      ),
    ).toBe('2026-10-01T00:00:00Z')
    expect(await readResetHold(answer(null, null) as never, 'u')).toBeNull()
    const unreadable = await readResetHold(answer(null, { code: '42501' }) as never, 'u')
    expect(Date.now() - new Date(unreadable ?? 0).getTime()).toBeLessThan(5_000)
    expect(createClient).not.toHaveBeenCalled()
  })
})
