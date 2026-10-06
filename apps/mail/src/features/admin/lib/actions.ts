/**
 * Mail's admin actions, mirrored from SQL `admin_tier()` (migration 51,
 * MAIL-SPEC §10, MR5). Used to hide what a role cannot do and to refuse early
 * with the right words. SQL is the authority: every `admin_mail_*` wrapper
 * applies its own copy, and a test holds this one to it.
 */

export type AdminRole = 'owner' | 'operator' | 'viewer'

/**
 * - `test_target`: a test admin acts only on an e2e account.
 * - `never`: a test admin is always refused.
 */
export type TestRule = 'test_target' | 'never'

export type AdminTier = Readonly<{ minRole: AdminRole; money: boolean; testRule: TestRule }>

const tier = (minRole: AdminRole, money: boolean, testRule: TestRule): AdminTier => ({
  minRole,
  money,
  testRule,
})

export const MAIL_ADMIN_TIERS = {
  'mail.approve': tier('operator', false, 'test_target'),
  'mail.reject': tier('operator', false, 'test_target'),
  'mail.pause': tier('operator', false, 'test_target'),
  'mail.resume': tier('owner', true, 'never'),
  'mail.cap_override': tier('owner', true, 'never'),
} as const satisfies Record<string, AdminTier>

export type AdminActionId = keyof typeof MAIL_ADMIN_TIERS

export const ADMIN_ACTION_IDS = Object.keys(MAIL_ADMIN_TIERS) as unknown as readonly [
  AdminActionId,
  ...AdminActionId[],
]

const RANK: Record<AdminRole, number> = { viewer: 1, operator: 2, owner: 3 }

export function rank(role: AdminRole): number {
  return RANK[role]
}

/** Whether a role may take an action — for showing a button. SQL still decides. */
export function canAct(
  admin: { role: AdminRole; testOnly: boolean },
  action: AdminActionId,
): boolean {
  const needed = MAIL_ADMIN_TIERS[action]
  if (admin.testOnly && needed.testRule === 'never') return false
  return rank(admin.role) >= rank(needed.minRole)
}

export const ROLE_LABEL: Record<AdminRole, string> = {
  owner: 'Owner',
  operator: 'Operator',
  viewer: 'Viewer',
}
