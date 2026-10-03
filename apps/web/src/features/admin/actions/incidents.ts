'use server'

import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import { resolveIncidentSchema, resolveMoneyIncidentSchema } from '@/features/admin/schemas/refunds'
import { adminAction, adminMoneyAction } from '@/lib/safe-action'

/**
 * Marking a payment incident resolved (ADMIN-SPEC §3.1.2, §5.2 B3). One
 * wrapper, two tiers: the wrapper reads the incident's kind and gates it as
 * `incident.resolve` (nothing owed: standard) or `incident.resolve_money`
 * (money owed: a fresh code and the evidence of what settled it). The page
 * picks the action by kind; SQL picks again and is the one that counts.
 */

type Answer = { data: unknown; error: { message: string } | null }

function answered({ data, error }: Answer): AdminResult {
  if (error) throw adminAccessError(error.message)
  return toAdminResult(data)
}

/**
 * SQL takes null for evidence an outcome does not use (a refund id for a
 * Flutterwave check, say); the generated types do not say a SQL argument
 * may be null.
 */
const orNull = <T>(value: T | undefined): T => (value ?? null) as T

/** An incident where nothing is owed: recorded as looked at. */
export const resolveIncident = adminAction('incident.resolve', resolveIncidentSchema).action(
  async ({ parsedInput, ctx }) =>
    answered(
      await ctx.db.rpc('admin_resolve_payment_incident', {
        p_incident_id: parsedInput.incidentId,
        p_outcome: 'reviewed',
        p_refund_id: orNull<string>(undefined),
        p_check_id: orNull<number>(undefined),
        p_confirmed: false,
        p_reason: parsedInput.reason,
        p_request_key: parsedInput.requestKey,
      }),
    ),
)

/** An incident where money is owed, with what settled it. */
export const resolveMoneyIncident = adminMoneyAction(
  'incident.resolve_money',
  resolveMoneyIncidentSchema,
).action(async ({ parsedInput, ctx }) =>
  answered(
    await ctx.db.rpc('admin_resolve_payment_incident', {
      p_incident_id: parsedInput.incidentId,
      p_outcome: parsedInput.outcome,
      p_refund_id: orNull(
        parsedInput.outcome === 'refund_completed' ? parsedInput.refundId : undefined,
      ),
      p_check_id: orNull(
        parsedInput.outcome === 'flw_refund_verified' ? parsedInput.checkId : undefined,
      ),
      p_confirmed: parsedInput.outcome === 'handled_outside' && parsedInput.confirmed,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    }),
  ),
)
