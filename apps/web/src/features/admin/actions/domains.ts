'use server'

import { z } from 'zod'
import { REVEAL } from '@/features/admin/lib/domains-copy'
import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import { optionalReasonSchema, requestKeySchema, uuidSchema } from '@/features/admin/schemas/common'
import { adminAction } from '@/lib/safe-action'

/**
 * The domains page's two buttons (docs/ADMIN-SPEC.md §5.2 B9). Both are the
 * standard tier: SQL's wrapper applies the role, the test-admin rule and the
 * audit row. "Queue a deep sync" only clears `deep_checked_at` — nothing
 * changes at the registry (D14). "Show registrant" reads the registrant and
 * contacts through the audited, rate-limited `admin_reveal_registrant`; they
 * go to the browser and nowhere else — never a log line (N13) — and a
 * replayed request key answers without them.
 */

const domainInput = z.object({
  domainId: uuidSchema,
  reason: optionalReasonSchema,
  requestKey: requestKeySchema,
})

type DomainInput = z.output<typeof domainInput>

/** The wrappers take a null reason as "none given"; only its length is checked. */
const wrapperArgs = (input: DomainInput) => ({
  p_domain_id: input.domainId.toLowerCase(),
  p_reason: (input.reason ?? null) as string,
  p_request_key: input.requestKey,
})

/** Asks the next deep sync to read this domain from the registry (`deep_checked_at = null`). */
export const queueDeepSync = adminAction('domain.deep_sync', domainInput).action(
  async ({ parsedInput, ctx }): Promise<AdminResult> => {
    const { data, error } = await ctx.db.rpc('admin_queue_deep_sync', wrapperArgs(parsedInput))
    // A recognised code is a refusal (new key); anything else may have committed (same key).
    if (error) throw adminAccessError(error.message)
    return toAdminResult(data)
  },
)

/** One contact as the reveal shows it: the Contact fields (`@dr/shared/schemas`), nothing else. */
export type RevealedContact = {
  firstName?: string | undefined
  lastName?: string | undefined
  company?: string | undefined
  email?: string | undefined
  phoneCountryCode?: string | undefined
  phone?: string | undefined
  addressLine1?: string | undefined
  addressLine2?: string | undefined
  addressLine3?: string | undefined
  city?: string | undefined
  state?: string | undefined
  zipCode?: string | undefined
  country?: string | undefined
}

export type RevealedRegistrant = {
  registrant: RevealedContact | null
  /** The administrative, technical and billing contacts held apart from the registrant. */
  contacts: { role: 'administrative' | 'technical' | 'billing'; contact: RevealedContact }[]
}

const field = (max: number) => z.string().trim().max(max).optional().catch(undefined)

/**
 * An allowlist, field by field: whatever else a stored contact carries is
 * dropped here, and a field of the wrong shape is left out, never shown raw.
 */
const contactSchema = z.object({
  firstName: field(64),
  lastName: field(64),
  company: field(128),
  email: field(254),
  phoneCountryCode: field(4),
  phone: field(15),
  addressLine1: field(128),
  addressLine2: field(128),
  addressLine3: field(128),
  city: field(64),
  state: field(64),
  zipCode: field(16),
  country: field(2),
})

const ROLES = ['administrative', 'technical', 'billing'] as const

function toContact(value: unknown): RevealedContact | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const parsed = contactSchema.safeParse(value)
  if (!parsed.success) return null
  const kept = Object.fromEntries(
    Object.entries(parsed.data).filter(([, text]) => typeof text === 'string' && text !== ''),
  ) as RevealedContact
  return Object.keys(kept).length > 0 ? kept : null
}

function revealed(json: unknown): RevealedRegistrant {
  const record = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
  const contacts = (
    typeof record.contacts === 'object' && record.contacts !== null ? record.contacts : {}
  ) as Record<string, unknown>
  return {
    registrant: toContact(record.registrant),
    contacts: ROLES.flatMap((role) => {
      const contact = toContact(contacts[role])
      return contact ? [{ role, contact }] : []
    }),
  }
}

/**
 * The registrant and contacts, shown once to this admin (operator; a test
 * admin only for an e2e account's test domain — SQL's `reserved_target`).
 */
export const revealRegistrant = adminAction('domain.reveal_contacts', domainInput).action(
  async ({ parsedInput, ctx }): Promise<AdminResult<RevealedRegistrant>> => {
    const { data, error } = await ctx.db.rpc('admin_reveal_registrant', wrapperArgs(parsedInput))
    if (error) throw adminAccessError(error.message)
    const result = toAdminResult(data)
    if (!result.ok) return result
    // A replayed key carries no details (§3.1.2): a new key asks again, through the gate and the limit.
    if (result.replayed) {
      return { ok: false, code: 'REPLAYED', message: REVEAL.replayed, auditId: result.auditId }
    }
    return { ok: true, auditId: result.auditId, data: revealed(data) }
  },
)
