import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/auth/queries/two-factor', () => ({ mustTurnOnTwoFactor: vi.fn() }))

const { mustTurnOnTwoFactor } = await import('@/features/auth/queries/two-factor')
const { guardBulkRenewal } = await import('@/features/renewals/queries/renewal-guard')
const { guardSensitiveBulkChange } = await import('../queries/bulk-guard')

/**
 * The account-wide hooks bulk actions ask first — where FR-A2's two-factor
 * requirement holds for every sensitive bulk change, and never for renewals.
 */
const ctx = { supabase: {} as never, user: { id: 'user-1', email: 'ada@example.com' } }

beforeEach(() => vi.clearAllMocks())

describe('bulk guards', () => {
  it('let an account that meets the two-factor rule make a sensitive bulk change', async () => {
    vi.mocked(mustTurnOnTwoFactor).mockResolvedValue(false)
    expect(await guardSensitiveBulkChange(ctx)).toBeNull()
    expect(mustTurnOnTwoFactor).toHaveBeenCalledWith(ctx.supabase, 'user-1')
  })

  it('stop a sensitive bulk change until two-factor is on, above ten domains (FR-A2)', async () => {
    vi.mocked(mustTurnOnTwoFactor).mockResolvedValue(true)
    expect(await guardSensitiveBulkChange(ctx)).toEqual({
      error: expect.stringMatching(/need two-factor authentication/),
    })
  })

  it('start nothing when the rule cannot be read', async () => {
    vi.mocked(mustTurnOnTwoFactor).mockResolvedValue(null)
    expect(await guardSensitiveBulkChange(ctx)).toEqual({ error: expect.any(String) })
  })

  it('never hold back a bulk renewal, whatever the two-factor rule says', async () => {
    vi.mocked(mustTurnOnTwoFactor).mockResolvedValue(true)
    expect(await guardBulkRenewal(ctx)).toBeNull()
  })
})
