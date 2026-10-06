import { isMemberRole } from '@/lib/safe-action'
import { ROLE_LABEL } from './roles'

/**
 * The account's security log in words (MAIL-SPEC §9 `account_audit_log`):
 * who did what, to what. Rows carry ids, roles, field names and key prefixes
 * — never an address or a secret — so a person is named only while they are
 * a member; anyone else is "a former member".
 */

export type AuditRow = {
  id: number
  at: string
  actor: string
  actorUserId: string | null
  action: string
  target: string | null
  detail: Record<string, unknown>
}

export type Named = Map<string, string>

const FIELD_WORDS: Record<string, string> = {
  name: 'name',
  website: 'website',
  use_case: 'what it sends',
  expected_monthly_volume: 'expected volume',
}

const role = (value: unknown) => (isMemberRole(value) ? ROLE_LABEL[value].toLowerCase() : 'member')

function person(id: string | null | undefined, names: Named): string {
  if (!id) return 'someone'
  return names.get(id) ?? 'a former member'
}

/** Who did it: a member by name, our system, an admin of MyDomainsHub, or an API key. */
export function describeActor(row: AuditRow, names: Named): string {
  if (row.actor === 'system') return 'MyDomainsHub Mail'
  if (row.actor === 'admin') return 'MyDomainsHub support'
  if (row.actor === 'api') return 'An API key'
  return person(row.actorUserId, names)
}

/** What happened, in a sentence fragment that follows the actor. */
export function describeAction(row: AuditRow, names: Named): string {
  const detail = row.detail ?? {}
  switch (row.action) {
    case 'account.created':
      return 'created the account'
    case 'account.updated': {
      const fields = Array.isArray(detail.fields)
        ? detail.fields.map((field) => FIELD_WORDS[String(field)] ?? String(field))
        : []
      return fields.length > 0
        ? `changed the account’s ${fields.join(', ')}`
        : 'changed the account profile'
    }
    case 'account.ownership_transferred':
      return `handed the account over to ${person(row.target, names)}`
    case 'member.added':
      return row.target === row.actorUserId
        ? `joined as ${role(detail.role)}`
        : `added ${person(row.target, names)} as ${role(detail.role)}`
    case 'member.removed':
      return `removed a ${role(detail.role)}`
    case 'member.left':
      return `left the account (was ${role(detail.role)})`
    case 'member.role_changed':
      return `changed ${person(row.target, names)} from ${role(detail.from)} to ${role(detail.to)}`
    case 'invite.created':
      return `invited someone as ${role(detail.role)}`
    case 'invite.revoked':
      return `revoked an invite (${role(detail.role)})`
    case 'invite.accepted':
      return `accepted an invite as ${role(detail.role)}`
    case 'key.created':
      return `created API key ${String(detail.prefix ?? '')}…`.replace(' …', '')
    case 'key.revoked':
      return `revoked API key ${String(detail.prefix ?? '')}…`.replace(' …', '')
    case 'domain.removed':
      return 'removed a domain'
    default:
      return (
        describeBilling(row.action, detail) ?? row.action.replaceAll('.', ' ').replaceAll('_', ' ')
      )
  }
}

/** A plan's code as its name reads ("starter" → "Starter"): the log keeps codes only. */
const plan = (value: unknown) => {
  const code = String(value ?? '')
  return code ? `${code[0]?.toUpperCase()}${code.slice(1)}` : 'a'
}

/** Billing's entries (migration 50): plan codes and invoice numbers, never an amount. */
function describeBilling(action: string, detail: Record<string, unknown>): string | null {
  const invoice = typeof detail.invoice === 'string' ? ` (invoice ${detail.invoice})` : ''
  switch (action) {
    case 'billing.subscribed':
      return `recorded a payment and started the ${plan(detail.plan)} plan${invoice}`
    case 'billing.upgraded':
      return `recorded a payment and moved the account up to the ${plan(detail.plan)} plan${invoice}`
    case 'billing.paid':
      return `recorded a payment for the ${plan(detail.plan)} plan${invoice}`
    case 'billing.renewed':
      return `renewed the ${plan(detail.plan)} plan${invoice}`
    case 'billing.renewal_failed':
      return `recorded a renewal payment for the ${plan(detail.plan)} plan that did not go through`
    case 'billing.past_due':
      return `marked the ${plan(detail.plan)} plan past due: its renewal payment had not come through`
    case 'billing.change_scheduled':
      return `scheduled a move from the ${plan(detail.from)} plan to the ${plan(detail.to)} plan at the period’s end`
    case 'billing.change_withdrawn':
      return `kept the ${plan(detail.kept)} plan, withdrawing a scheduled change`
    case 'billing.canceled':
      return `moved the account to the ${plan(detail.to)} plan at the period’s end`
    case 'billing.downgraded':
      return `moved the account to the ${plan(detail.to)} plan at the period’s end, waiting for its first payment`
    case 'billing.lapsed':
      return 'moved the account to the Free plan: its payment was past due'
    default:
      return null
  }
}

/** Reads rows as PostgREST returns them. */
export function readAuditRows(rows: unknown): AuditRow[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const r = row as Record<string, unknown>
    if (typeof r.action !== 'string' || typeof r.at !== 'string') return []
    return [
      {
        id: Number(r.id),
        at: r.at,
        actor: String(r.actor ?? 'user'),
        actorUserId: typeof r.actor_user_id === 'string' ? r.actor_user_id : null,
        action: r.action,
        target: typeof r.target === 'string' ? r.target : null,
        detail:
          r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail)
            ? (r.detail as Record<string, unknown>)
            : {},
      },
    ]
  })
}
