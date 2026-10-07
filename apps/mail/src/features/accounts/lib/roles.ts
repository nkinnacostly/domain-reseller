import type { MemberRole } from '@/lib/safe-action'

/**
 * Who may do what in a Mail account (MAIL-SPEC §9 `members`). SQL decides
 * every change; these mirror it so the dashboard offers only what will be
 * allowed, and words the rest. The migration that decides each is named.
 *
 *   owner     — everything, and the one person who manages admins (46)
 *   admin     — a developer's rights, plus the profile, developers and
 *               viewers (46), full-access keys (43), the plan (50),
 *               removing suppressions (49) and the account log (43)
 *   developer — domains (47), sending keys (43), webhooks (49) and sent
 *               emails' bodies while they are kept (44)
 *   viewer    — reads; not bodies, invoices, invites or the account log
 */

export const ROLE_LABEL: Record<MemberRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  developer: 'Developer',
  viewer: 'Viewer',
}

/** What each role may do, as SQL allows it today (migrations 43, 44, 46, 47, 49, 50). */
export const ROLE_SUMMARY: Record<MemberRole, string> = {
  owner: 'Everything an admin can, and also manages admins and can hand the account over.',
  admin:
    'Everything a developer can, and also edits the profile, invites developers and viewers, makes full-access keys, changes the plan, removes suppressions and reads the account log.',
  developer:
    'Adds and removes domains, makes and revokes sending keys, manages webhooks, and reads sent emails’ bodies while they are kept.',
  viewer:
    'Reads the dashboard, but not email bodies, invoices or the account log; changes nothing.',
}

/** Roles an invitation or a role change can give: never owner (that is a transfer). */
export const GRANTABLE_ROLES = ['admin', 'developer', 'viewer'] as const
export type GrantableRole = (typeof GRANTABLE_ROLES)[number]

export const isGrantableRole = (value: unknown): value is GrantableRole =>
  typeof value === 'string' && (GRANTABLE_ROLES as readonly string[]).includes(value)

export const canEditProfile = (role: MemberRole) => role === 'owner' || role === 'admin'

/** Members, invites and the account log are for owners and admins (RLS on invites and the log). */
export const canManageMembers = (role: MemberRole) => role === 'owner' || role === 'admin'

/** The roles `role` may invite someone as, or give to someone. */
export function grantableBy(role: MemberRole): readonly GrantableRole[] {
  if (role === 'owner') return GRANTABLE_ROLES
  if (role === 'admin') return ['developer', 'viewer']
  return []
}

/** Whether `caller` may change `target`'s role or remove them (never the owner, never oneself). */
export function canManage(caller: MemberRole, target: MemberRole, isSelf: boolean): boolean {
  if (isSelf || target === 'owner') return false
  return grantableBy(caller).includes(target as GrantableRole)
}

/** Everyone but the owner may leave; the owner hands the account over first. */
export const canLeave = (role: MemberRole) => role !== 'owner'

export const canTransfer = (role: MemberRole) => role === 'owner'
