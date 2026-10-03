/**
 * The admin action map, mirrored from SQL `admin_tier()` (migration 40,
 * docs/ADMIN-SPEC.md §2.2). Used to hide what a role cannot do and to refuse
 * early with the right words. SQL is the authority: every wrapper and
 * admin_note applies its own copy, and a test holds this one to it.
 */

export type AdminRole = 'owner' | 'operator' | 'viewer'

/**
 * - `test_target`: a test admin acts only on a test-mode target or the test side.
 * - `reserved_target`: only on an e2e user's profile (`e2e-*@example.com`,
 *   SQL `admin_e2e_email`), or a test-mode domain or email that belongs to one.
 * - `never`: a test admin is always refused.
 */
export type TestRule = 'test_target' | 'reserved_target' | 'never'

export type AdminTier = Readonly<{ minRole: AdminRole; money: boolean; testRule: TestRule }>

const tier = (minRole: AdminRole, money: boolean, testRule: TestRule): AdminTier => ({
  minRole,
  money,
  testRule,
})

export const ADMIN_TIERS = {
  'refund.approve': tier('operator', true, 'test_target'),
  'refund.retry': tier('operator', true, 'test_target'),
  'refund.record_manual': tier('operator', true, 'test_target'),
  'refund.cancel': tier('owner', true, 'never'),
  'refund.flw_check': tier('operator', false, 'test_target'),
  'incident.resolve': tier('operator', false, 'test_target'),
  'incident.resolve_money': tier('operator', true, 'test_target'),
  'job.retry': tier('operator', true, 'test_target'),
  'job.fail': tier('operator', true, 'test_target'),
  'ssl_job.retry': tier('operator', true, 'test_target'),
  'ssl_job.fail': tier('operator', true, 'test_target'),
  'email.requeue': tier('operator', false, 'reserved_target'),
  'domain.deep_sync': tier('operator', false, 'test_target'),
  'domain.reveal_contacts': tier('operator', false, 'reserved_target'),
  'customer.search': tier('operator', false, 'reserved_target'),
  'customer.reveal': tier('operator', false, 'reserved_target'),
  'fx.activate': tier('owner', true, 'never'),
  'fx.reject': tier('owner', true, 'never'),
  'pricing.update': tier('owner', true, 'never'),
  'settings.update': tier('owner', true, 'never'),
  'settings.refund_limit_raise': tier('owner', true, 'never'),
  'extension.flags': tier('owner', true, 'never'),
  'ssl_product.sellable': tier('owner', true, 'never'),
  'preset.draft_save': tier('owner', true, 'never'),
  'preset.publish': tier('owner', true, 'never'),
  'preset.show': tier('owner', true, 'never'),
  'preset.draft_check': tier('owner', false, 'never'),
  'preset.draft_discard': tier('owner', false, 'never'),
  'preset.hide': tier('operator', false, 'never'),
  'topup.record': tier('owner', true, 'never'),
  'topup.correct': tier('owner', true, 'never'),
  'audit.redact': tier('owner', true, 'never'),
  'supplier.balance': tier('viewer', false, 'test_target'),
  'supplier.ledger_live': tier('viewer', false, 'test_target'),
  'supplier.domain_lookup': tier('operator', false, 'test_target'),
  'supplier.domains_page': tier('operator', false, 'test_target'),
  'supplier.verification': tier('operator', false, 'test_target'),
  'supplier.ssl_lookup': tier('operator', false, 'test_target'),
  'supplier.transfer_query': tier('operator', false, 'test_target'),
  'supplier.renew_check': tier('operator', false, 'test_target'),
  'supplier.price_check': tier('operator', false, 'never'),
  'supplier.catalogue_preview': tier('owner', false, 'never'),
  'supplier.ssl_catalogue_preview': tier('owner', false, 'never'),
  'supplier.catalogue_apply': tier('owner', true, 'never'),
  'supplier.ssl_catalogue_apply': tier('owner', true, 'never'),
} as const satisfies Record<string, AdminTier>

export type AdminTierAction = keyof typeof ADMIN_TIERS

/**
 * Every action an admin server action may name. `side.switch` is the web's
 * own (the Live/Test cookie): not audited and not in admin_tier, so the
 * client skips the tier lookup for it.
 */
export const ADMIN_ACTION_IDS = [
  ...(Object.keys(ADMIN_TIERS) as AdminTierAction[]),
  'side.switch',
] as unknown as readonly [AdminTierAction | 'side.switch', ...(AdminTierAction | 'side.switch')[]]

export type AdminActionId = (typeof ADMIN_ACTION_IDS)[number]

/** Every action's tier; `side.switch` is open to any admin and never money. */
export const ADMIN_ACTIONS: Readonly<Record<AdminActionId, AdminTier>> = {
  ...ADMIN_TIERS,
  'side.switch': tier('viewer', false, 'test_target'),
}

const RANK: Record<AdminRole, number> = { viewer: 1, operator: 2, owner: 3 }

export function rank(role: AdminRole): number {
  return RANK[role]
}

/** Whether a role may take an action — for showing a button. SQL still decides. */
export function canAct(
  admin: { role: AdminRole; testOnly: boolean },
  action: AdminActionId,
): boolean {
  const needed = ADMIN_ACTIONS[action]
  if (admin.testOnly && needed.testRule === 'never') return false
  return rank(admin.role) >= rank(needed.minRole)
}

export function isMoneyAction(action: AdminActionId): boolean {
  return ADMIN_ACTIONS[action].money
}
