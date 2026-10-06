import type { AccountState } from '@dr/shared/mail'
import { isMemberRole, type MemberRole } from '@/lib/safe-action'
import { isAccountState } from './state'

/**
 * Which of a person's Mail accounts the dashboard shows (MAIL-SPEC §10: "with
 * an account switcher"). The choice is remembered in a cookie that is only a
 * preference: membership is read on every request, and an account the person
 * no longer belongs to is never shown because a cookie names it.
 */
export const CURRENT_ACCOUNT_COOKIE = 'mdm_account'

/** A year: the choice should outlive a session. */
export const CURRENT_ACCOUNT_MAX_AGE = 365 * 24 * 60 * 60

export type AccountSummary = {
  id: string
  name: string
  state: AccountState
  sesStatus: string
  /** Why it is paused or closed: a code (migration 51), worded by the banner. */
  stateReason?: string | null
  planCode: string
  website: string | null
  useCase: string | null
  expectedMonthlyVolume: number | null
  createdAt: string
}

export type Membership = { role: MemberRole; account: AccountSummary }

/** Rows of `members` with their account embedded, as PostgREST answers; odd rows are dropped. */
export function readMemberships(rows: unknown): Membership[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const r = row as { role?: unknown; accounts?: Record<string, unknown> | null }
    const a = r?.accounts
    if (!a || !isMemberRole(r.role) || typeof a.id !== 'string' || !isAccountState(a.state)) {
      return []
    }
    return [
      {
        role: r.role,
        account: {
          id: a.id,
          name: String(a.name ?? ''),
          state: a.state,
          sesStatus: String(a.ses_status ?? 'pending'),
          stateReason: typeof a.state_reason === 'string' ? a.state_reason : null,
          planCode: String(a.plan_code ?? 'free'),
          website: typeof a.website === 'string' ? a.website : null,
          useCase: typeof a.use_case === 'string' ? a.use_case : null,
          expectedMonthlyVolume:
            typeof a.expected_monthly_volume === 'number' ? a.expected_monthly_volume : null,
          createdAt: String(a.created_at ?? ''),
        },
      },
    ]
  })
}

/** The remembered account if the person is still its member; else the first open one; else the first. */
export function pickAccount(
  memberships: readonly Membership[],
  remembered: string | null | undefined,
): Membership | null {
  return (
    memberships.find((m) => m.account.id === remembered) ??
    memberships.find((m) => m.account.state !== 'closed') ??
    memberships[0] ??
    null
  )
}
