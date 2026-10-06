import type { AccountState } from '@dr/shared/mail'
import type { MemberRole } from '@/lib/safe-action'

/**
 * The Overview's "next steps" (MAIL-SPEC §10: "anything that needs action"):
 * what stands between this account and sending, in order (§7.2: a verified
 * domain, a complete profile, then an admin's approval; then a key to send
 * with). A step's `done` is null when this role cannot see the answer — a
 * viewer cannot read keys (RLS) — so it is never shown as done or undone
 * wrongly.
 */

export type AccountProfile = {
  name: string
  website: string | null
  useCase: string | null
  expectedMonthlyVolume: number | null
}

/** §7.2 (b): the profile §7.1 asks for — name, website, what it sends, its volume. */
export function isProfileComplete(profile: AccountProfile): boolean {
  return (
    profile.name.trim().length > 0 &&
    Boolean(profile.website?.trim()) &&
    Boolean(profile.useCase?.trim()) &&
    profile.expectedMonthlyVolume !== null
  )
}

export type NextStep = {
  id: 'domain' | 'profile' | 'review' | 'key'
  title: string
  detail: string
  href: string | null
  done: boolean | null
}

export function nextSteps(input: {
  state: AccountState
  role: MemberRole
  verifiedDomains: number
  activeKeys: number | null
  profileComplete: boolean
}): NextStep[] {
  const steps: NextStep[] = [
    {
      id: 'domain',
      title: 'Verify a domain',
      detail: 'Add the DNS records for the domain you send from, so receivers trust your email.',
      href: '/dashboard/domains',
      done: input.verifiedDomains > 0,
    },
    {
      id: 'profile',
      title: 'Complete the account profile',
      detail: 'Your website, what you will send, and about how many emails a month.',
      href: '/dashboard/settings',
      done: input.profileComplete,
    },
  ]
  if (input.state === 'sandbox') {
    steps.push({
      id: 'review',
      title: 'Approval by our team',
      detail:
        'Once the two steps above are done, a person at MyDomainsHub reviews the account before it can send to anyone.',
      href: null,
      done: false,
    })
  }
  steps.push({
    id: 'key',
    title: 'Create an API key',
    detail: 'Your app sends with it. It is shown once, so keep it somewhere safe.',
    href: '/dashboard/api-keys',
    done: input.role === 'viewer' || input.activeKeys === null ? null : input.activeKeys > 0,
  })
  return steps
}
