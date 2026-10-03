import { vi } from 'vitest'
import { adminWhoami } from '@/features/admin/queries/session'
import { createServiceClient } from '@/lib/supabase/service'
import { sessionClient, whoami } from '../foundation/fixtures'

/**
 * The network edge the certificate reads cross, faked: PostgREST through the
 * service client — behind the real adminDb, which is not mocked, so its side
 * filter and column checks run — and the session client's rpc. Each read is
 * recorded with its select and filters, and answered by the test's handler.
 */

export type Read = {
  table: string
  select?: string
  options?: { count?: string; head?: boolean }
  filters: [string, ...unknown[]][]
  one: boolean
}

export type Reply = {
  data?: unknown
  error?: { message: string; code?: string }
  count?: number
}

export type Handler = (read: Read) => Reply | undefined

const CHAIN = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not', 'is', 'order', 'range', 'limit']

/** Fakes the service client adminDb builds; returns every read it was asked for. */
export function fakeService(handler: Handler): Read[] {
  const reads: Read[] = []
  const service = {
    from(table: string) {
      const read: Read = { table, filters: [], one: false }
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
      builder.maybeSingle = () => {
        read.one = true
        return builder
      }
      // biome-ignore lint/suspicious/noThenProperty: PostgREST's builder is a thenable
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) => {
        const reply = handler(read) ?? {}
        let data: unknown = reply.error ? null : (reply.data ?? [])
        if (read.one && Array.isArray(data)) data = data[0] ?? null
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

/** The value a recorded read filtered a column by, with one method. */
export function filterOf(read: Read | undefined, method: string, column: string): unknown {
  return read?.filters.find(([name, col]) => name === method && col === column)?.[2]
}

export const ids = {
  certificate: '0c1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
  user: '2a2b2c2d-3e3f-4a4b-8c5d-6e6f7a7b8c8d',
  line: '3a3b3c3d-4e4f-4a5b-8c6d-7e7f8a8b9c9d',
  order: '4d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
  job: '6a6b6c6d-7e7f-4a8b-8c9d-aeafb0b1c2c3',
  refund: '7a7b7c7d-8e8f-4a9b-8cad-bebfc0c1d2d3',
}

export const NOW = new Date('2026-10-03T12:00:00Z')

/** A certificate row as `admin_ssl_certificates_v` answers it, issued, on the test side. */
export function certificateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.certificate,
    user_id: ids.user,
    order_item_id: ids.line,
    product_code: '351',
    product_name: 'Sectigo PositiveSSL Certificate',
    is_wildcard: false,
    included_names: 1,
    common_name: 'shop.example.com',
    test_mode: true,
    status: 'issued',
    supplier_status: 'Active',
    status_unrecognised_since: null,
    supplier_certificate_id: null,
    purchased_at: '2026-10-01T10:00:00Z',
    subscription_ends_at: '2027-10-01T10:00:00Z',
    validation_method: 'email',
    san_names: [],
    web_server: 'apache',
    configured_at: '2026-10-01T11:00:00Z',
    last_error_code: null,
    issued_at: '2026-10-02T10:00:00Z',
    expires_at: '2027-04-20T10:00:00Z',
    certificate_pem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
    ca_bundle_pem: '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----',
    reissue_count: 0,
    last_checked_at: '2026-10-03T09:00:00Z',
    next_check_at: '2026-10-03T21:00:00Z',
    created_at: '2026-10-01T09:59:00Z',
    updated_at: '2026-10-02T10:00:00Z',
    approver_masked: 'a•••@shop.example.com',
    ...overrides,
  }
}
