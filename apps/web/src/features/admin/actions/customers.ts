'use server'

import {
  type CustomerContact,
  type FoundCustomer,
  parseContact,
  parseFoundCustomers,
} from '@/features/admin/lib/customers-data'
import { type AdminResult, adminAccessError, toAdminResult } from '@/features/admin/lib/errors'
import { findCustomersSchema, revealCustomerSchema } from '@/features/admin/schemas/customers'
import { adminAction } from '@/lib/safe-action'

/**
 * Customer search and reveal (docs/ADMIN-SPEC.md §3.1.2, §5.2 B8). Both are
 * POSTs to audited SQL functions, limited together to 30 an hour per admin
 * and gated by `admin_tier` (operator; a test admin, e2e accounts only). A
 * search answers masked rows; a reveal answers the contact once, for a fresh
 * request key. Nothing here logs what was searched for or shown (N13): the
 * audit row holds what SQL keeps, and the answer goes to the page alone.
 */

type Answer = { data: unknown; error: { message: string } | null }

/** The wrapper's answer; an error that is not a refusal is thrown, so the outcome reads as unknown. */
function answered({ data, error }: Answer): AdminResult {
  if (error) throw adminAccessError(error.message)
  return toAdminResult(data)
}

/** `customer.search`: an exact email, order number or domain → at most 20 masked rows. */
export const findCustomers = adminAction('customer.search', findCustomersSchema).action(
  async ({ parsedInput, ctx }): Promise<AdminResult<FoundCustomer[]>> => {
    const answer = await ctx.db.rpc('admin_find_customers', { p_query: parsedInput.query })
    const result = answered(answer)
    if (!result.ok) return result
    return { ...result, data: parseFoundCustomers(answer.data) }
  },
)

/**
 * `customer.reveal`: one account's email, name, phone and business name, for
 * this view. A replayed key answers without them (D4); the page asks again
 * with a new key, which is gated, limited and recorded again.
 */
export const revealCustomer = adminAction('customer.reveal', revealCustomerSchema).action(
  async ({ parsedInput, ctx }): Promise<AdminResult<CustomerContact>> => {
    const answer = await ctx.db.rpc('admin_reveal_customer', {
      p_user_id: parsedInput.userId,
      // SQL stores an empty reason as none.
      p_reason: parsedInput.reason ?? '',
      p_request_key: parsedInput.requestKey,
    })
    const result = answered(answer)
    if (!result.ok) return result
    const contact = parseContact(answer.data)
    return contact ? { ...result, data: contact } : result
  },
)
