import type { MemberRole } from '@/lib/safe-action'

/**
 * Who may do what in a Mail account (MAIL-SPEC §9 `members`; migration 46).
 * SQL decides every change; these mirror it so the dashboard offers only
 * what will be allowed, and words the rest.
 *
 *   owner     — everything, and the one person who manages admins
 *   admin     — the profile, developers and viewers, keys and domains
 *   developer — keys, domains and the log
 *   viewer    — reads
 */

export const ROLE_LABEL: Record<MemberRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  developer: 'Developer',
  viewer: 'Viewer',
}

/** What each role may do, as SQL allows it today (migrations 43, 44, 46). */
export const ROLE_SUMMARY: Record<MemberRole, string> = {
  owner: 'Everything an admin can, and also manages admins and can hand the account over.',
  admin:
    'Edits the profile, invites developers and viewers, makes full-access keys and reads the account log.',
  developer: 'Makes and revokes sending keys, and reads sent emails’ bodies while they are kept.',
  viewer: 'Reads the dashboard; changes nothing.',
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
