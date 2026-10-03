import { vi } from 'vitest'
import { adminWhoami } from '@/features/admin/queries/session'
import { createServiceClient } from '@/lib/supabase/service'
import { sessionClient, whoami } from '../foundation/fixtures'

/**
 * The network edge the customers reads cross, faked: PostgREST through the
 * service client (behind adminDb, which is not mocked), recording each read's
 * select and filters and answering it from the test's handler.
 */

export type Read = {
  table: string
  select?: string
  options?: { count?: string; head?: boolean }
  filters: [string, ...unknown[]][]
}

export type Reply = {
  data?: unknown
  error?: { message: string; code?: string }
  count?: number
}

const CHAIN = ['eq', 'neq', 'in', 'is', 'not', 'order', 'range', 'limit', 'gte', 'lte']

export function fakeService(handler: (read: Read) => Reply | undefined): Read[] {
  const reads: Read[] = []
  const service = {
    from(table: string) {
      const read: Read = { table, filters: [] }
      reads.push(read)
      const builder: Record<string, unknown> = {}
      for (const method of CHAIN) {
        builder[method] = (...args: unknown[]) => {
          read.filters.push([method, ...args])
          return builder
        }
      }
      builder.select = (columns: string, options?: Read['options']) => {
        read.select = columns
        read.options = options
        return builder
      }
      // biome-ignore lint/suspicious/noThenProperty: PostgREST's builder is a thenable
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) => {
        const reply = handler(read) ?? {}
        const data: unknown = reply.error ? null : (reply.data ?? [])
        return Promise.resolve({
          data,
          error: reply.error ?? null,
          count: reply.count ?? (Array.isArray(data) ? data.length : null),
        }).then(resolve, reject)
      }
      return builder
    },
  }
  vi.mocked(createServiceClient).mockReturnValue(service as never)
  return reads
}

/** A principal adminDb accepts: issued from an admin_whoami answer. */
export async function principal(overrides: Record<string, unknown> = {}) {
  const session = sessionClient({ rpc: { admin_whoami: { data: whoami(overrides) } } })
  return adminWhoami(session.client as never, null)
}

/** The value a read filtered a column by, with one method. */
export function filterOf(read: Read | undefined, method: string, column: string): unknown {
  return read?.filters.find(([name, col]) => name === method && col === column)?.[2]
}

export const ids = {
  user: '2a2b2c2d-3e3f-4a4b-8c5d-6e6f7a7b8c8d',
  other: '3b2b2c2d-3e3f-4a4b-8c5d-6e6f7a7b8c8d',
  order: '0d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
  order2: '1d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
  line: '3a3b3c3d-4e4f-4a5b-8c6d-7e7f8a8b9c9d',
  line2: '4a3b3c3d-4e4f-4a5b-8c6d-7e7f8a8b9c9d',
  line3: '5a3b3c3d-4e4f-4a5b-8c6d-7e7f8a8b9c9d',
  domain: '5a5b5c5d-6e6f-4a7b-8c8d-9e9fa0a1b2b3',
  key: '0f0e0d0c-0b0a-4908-8706-050403020100',
}

/** What admin_customer answers for one account. */
export function customerJson(overrides: Record<string, unknown> = {}) {
  return {
    userId: ids.user,
    maskedEmail: 'a•••@gmail.com',
    accountType: 'individual',
    joinedAt: '2026-09-01T10:00:00Z',
    emailConfirmed: true,
    hasTotp: false,
    lastSignInAt: '2026-10-02T09:00:00Z',
    isAdmin: false,
    counts: { domains: 3, orders: 2, spentKobo: 2_010_250, refunds: 1 },
    allowance: {
      ordered: 2,
      max: 10,
      tier: 'standard',
      paid_orders: 1,
      account_days: 32,
      standard_after_days: 7,
      trusted_after_days: 90,
      trusted_after_paid_orders: 3,
    },
    ...overrides,
  }
}

/** One row of admin_customers. */
export function customerRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: ids.user,
    account_type: 'individual',
    masked_email: 'a•••@gmail.com',
    joined_at: '2026-09-01T10:00:00Z',
    domains_held: 2,
    orders_paid: 1,
    total_paid_kobo: 1_870_000,
    has_totp: true,
    email_confirmed: true,
    last_sign_in_at: '2026-10-02T09:00:00Z',
    is_admin: false,
    total_count: 1,
    ...overrides,
  }
}
