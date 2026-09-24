import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { getAccount } from '../queries/account'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

type Profile = { full_name: string | null; phone: string | null; password_reset_at: string | null }

/** A session Supabase client shaped like the reads the settings panel makes. */
function client({
  user = { id: 'user-1', email: 'ada@example.com' } as { id: string; email?: string } | null,
  profile = null as Profile | null,
  factors = null as { totp: { id: string; status: string }[] } | null,
  aal = null as { currentLevel: string; currentAuthenticationMethods: unknown[] } | null,
} = {}) {
  const eq = vi.fn(() => ({ single: async () => ({ data: profile }) }))
  const select = vi.fn(() => ({ eq }))
  const fake = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user } })),
      mfa: {
        listFactors: vi.fn(async () => ({ data: factors })),
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: aal })),
      },
    },
    from: vi.fn(() => ({ select })),
  }
  vi.mocked(createClient).mockResolvedValue(fake as never)
  return { fake, select, eq }
}

beforeEach(() => vi.clearAllMocks())

describe('getAccount', () => {
  it('has no account for a signed-out visitor, and reads nothing else', async () => {
    const { fake } = client({ user: null })
    expect(await getAccount()).toBeNull()
    expect(fake.from).not.toHaveBeenCalled()
    expect(fake.auth.mfa.listFactors).not.toHaveBeenCalled()
  })

  it('reads the signed-in person’s own profile row', async () => {
    const { fake, select, eq } = client()
    await getAccount()
    expect(fake.from).toHaveBeenCalledWith('profiles')
    expect(select).toHaveBeenCalledWith('full_name, phone, password_reset_at')
    expect(eq).toHaveBeenCalledWith('id', 'user-1')
  })

  it('brings together the profile, the verified authenticator and the session strength', async () => {
    const methods = [{ method: 'password', timestamp: 1 }]
    client({
      profile: {
        full_name: 'Ada Okafor',
        phone: '+234 803 123 4567',
        password_reset_at: '2026-09-22T09:00:00Z',
      },
      factors: {
        totp: [
          { id: 'abandoned', status: 'unverified' },
          { id: 'factor-1', status: 'verified' },
        ],
      },
      aal: { currentLevel: 'aal2', currentAuthenticationMethods: methods },
    })

    expect(await getAccount()).toEqual({
      id: 'user-1',
      email: 'ada@example.com',
      fullName: 'Ada Okafor',
      phone: '+234 803 123 4567',
      passwordResetAt: '2026-09-22T09:00:00Z',
      totpFactor: { id: 'factor-1', status: 'verified' },
      assurance: 'aal2',
      methods,
    })
  })

  it('treats a half-finished authenticator set-up as two-factor off', async () => {
    client({ factors: { totp: [{ id: 'abandoned', status: 'unverified' }] } })
    expect((await getAccount())?.totpFactor).toBeNull()
  })

  it('fills safe blanks when the profile, factors and assurance cannot be read', async () => {
    client({ user: { id: 'user-2' } })
    expect(await getAccount()).toEqual({
      id: 'user-2',
      email: '',
      fullName: '',
      phone: '',
      passwordResetAt: null,
      totpFactor: null,
      assurance: 'aal1',
      methods: [],
    })
  })

  it('shows empty fields rather than "null" for a profile with gaps', async () => {
    client({
      profile: { full_name: null, phone: null, password_reset_at: null },
      aal: { currentLevel: 'aal1', currentAuthenticationMethods: [] },
    })
    const account = await getAccount()
    expect(account?.fullName).toBe('')
    expect(account?.phone).toBe('')
  })
})
