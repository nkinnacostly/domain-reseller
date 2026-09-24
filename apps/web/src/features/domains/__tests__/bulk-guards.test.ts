import { describe, expect, it } from 'vitest'
import { guardBulkRenewal } from '@/features/renewals/queries/renewal-guard'
import { guardSensitiveBulkChange } from '../queries/bulk-guard'

/**
 * The account-wide hooks bulk actions ask first. Today they let every
 * signed-in account through — the second factor is `elevatedAction`'s — and
 * they are where a rule such as FR-A2 is added once for every action.
 */
const ctx = { supabase: {} as never, user: { id: 'user-1', email: 'ada@example.com' } }

describe('bulk guards', () => {
  it('let a signed-in account make a sensitive bulk change', async () => {
    expect(await guardSensitiveBulkChange(ctx)).toBeNull()
  })

  it('let a signed-in account renew in bulk', async () => {
    expect(await guardBulkRenewal(ctx)).toBeNull()
  })
})
