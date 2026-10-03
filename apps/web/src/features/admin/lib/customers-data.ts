import { z } from 'zod'

/**
 * What the customers pages read, checked and put in the pages' own shape
 * (docs/ADMIN-SPEC.md §3.1.2, §3.2h, B8). Every answer here is masked — an
 * email as `a•••@gmail.com` — except a reveal's contact, which the page
 * holds in client state only (D4). An answer that does not parse is treated
 * as unreadable rather than half-shown.
 */

const count = z.coerce.number().int().nonnegative().catch(0)
const when = z.string().min(1).nullable().catch(null)

// ── admin_customer_stats (live accounts, test admins refused) ─────────────

const statsSchema = z.object({
  profiles: count,
  confirmed: count,
  liveBuyers: count,
  mfaUsers: count,
  holders: count,
  active30d: count,
  over10NoMfa: count,
  signupsByDay: z
    .array(z.object({ day: z.string().min(1), count }))
    .catch([])
    .default([]),
})

export type CustomerStats = z.infer<typeof statsSchema>

export function parseCustomerStats(json: unknown): CustomerStats | null {
  const parsed = statsSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

// ── admin_customers (one page of the list) ─────────────────────────────────

export type CustomerRowAnswer = {
  user_id: string
  account_type: string | null
  masked_email: string | null
  joined_at: string | null
  domains_held: number | null
  orders_paid: number | null
  total_paid_kobo: number | null
  has_totp: boolean | null
  email_confirmed: boolean | null
  last_sign_in_at: string | null
  is_admin: boolean | null
  total_count: number | null
}

export type CustomerRow = {
  userId: string
  accountType: string | null
  maskedEmail: string
  joinedAt: string | null
  domainsHeld: number
  ordersPaid: number
  totalPaidKobo: number
  hasTotp: boolean
  emailConfirmed: boolean
  lastSignInAt: string | null
  isAdmin: boolean
}

export function toCustomerRow(row: CustomerRowAnswer): CustomerRow {
  return {
    userId: row.user_id,
    accountType: row.account_type,
    maskedEmail: row.masked_email ?? '—',
    joinedAt: row.joined_at,
    domainsHeld: Number(row.domains_held ?? 0),
    ordersPaid: Number(row.orders_paid ?? 0),
    totalPaidKobo: Number(row.total_paid_kobo ?? 0),
    hasTotp: row.has_totp === true,
    emailConfirmed: row.email_confirmed === true,
    lastSignInAt: row.last_sign_in_at,
    isAdmin: row.is_admin === true,
  }
}

// ── admin_customer (one account, counts on the side shown) ─────────────────

const allowanceSchema = z.object({
  ordered: count,
  max: count,
  tier: z.string().catch('new'),
  paid_orders: count,
  account_days: count,
  standard_after_days: count,
  trusted_after_days: count,
  trusted_after_paid_orders: count,
})

export type CustomerAllowance = z.infer<typeof allowanceSchema>

const customerSchema = z.object({
  userId: z.uuid(),
  maskedEmail: z.string().catch('—'),
  accountType: z.string().nullable().catch(null),
  joinedAt: when,
  emailConfirmed: z.boolean().catch(false),
  hasTotp: z.boolean().catch(false),
  lastSignInAt: when,
  isAdmin: z.boolean().catch(false),
  counts: z.object({ domains: count, orders: count, spentKobo: count, refunds: count }),
  allowance: allowanceSchema.nullable().catch(null),
})

export type CustomerDetail = z.infer<typeof customerSchema>

export function parseCustomer(json: unknown): CustomerDetail | null {
  const parsed = customerSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

// ── admin_find_customers (masked rows) ─────────────────────────────────────

const foundSchema = z.object({
  userId: z.uuid(),
  maskedEmail: z.string().catch('—'),
  joinedAt: when,
  domainsHeld: count,
  ordersPaid: count,
})

export type FoundCustomer = z.infer<typeof foundSchema>

/** The rows of a search's answer; none when the answer has no list. */
export function parseFoundCustomers(json: unknown): FoundCustomer[] {
  const rows =
    typeof json === 'object' && json !== null && 'rows' in json
      ? (json as { rows: unknown }).rows
      : []
  const parsed = z.array(foundSchema).safeParse(rows)
  return parsed.success ? parsed.data : []
}

// ── admin_reveal_customer (the one unmasked answer) ────────────────────────

const text = z.string().nullable().catch(null)

const contactSchema = z.object({
  email: text,
  fullName: text,
  phone: text,
  businessName: text,
})

export type CustomerContact = z.infer<typeof contactSchema>

/**
 * The contact a fresh reveal carries. A replayed request key answers with
 * none (D4): the details come only through the gate, the limit and a new
 * audit row, so the page must ask again.
 */
export function parseContact(json: unknown): CustomerContact | null {
  const contact =
    typeof json === 'object' && json !== null && 'contact' in json
      ? (json as { contact: unknown }).contact
      : undefined
  if (contact === undefined || contact === null) return null
  const parsed = contactSchema.safeParse(contact)
  return parsed.success ? parsed.data : null
}
