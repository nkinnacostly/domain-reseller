import { vi } from 'vitest'
import { adminWhoami } from '@/features/admin/queries/session'
import { createServiceClient } from '@/lib/supabase/service'
import { sessionClient, whoami } from '../foundation/fixtures'

/**
 * The network edge the audit reads cross, faked: PostgREST through the
 * service client — behind the real adminDb, which is not mocked, so its
 * `test_actor` rule and column checks run. Each read is recorded with its
 * select and filters, and answered by the test's handler.
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

export type Handler = (read: Read) => Reply | undefined

const CHAIN = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'like',
  'not',
  'is',
  'order',
  'range',
  'limit',
]

/** Fakes the service client adminDb builds; returns every read it was asked for. */
export function fakeService(handler: Handler): Read[] {
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

/** The value a recorded read filtered a column by, with one method. */
export function filterOf(read: Read | undefined, method: string, column: string): unknown {
  return read?.filters.find(([name, col]) => name === method && col === column)?.[2]
}

export const ids = {
  refund: '7a7b7c7d-8e8f-4a9b-8cad-bebfc0c1d2d3',
  user: '2a2b2c2d-3e3f-4a4b-8c5d-6e6f7a7b8c8d',
  request: '5e5f6a6b-7c7d-4e8f-9a0b-1c2d3e4f5a6b',
}

/** An audit row as `admin_audit_log` answers it: an approved test refund. */
export function auditRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    created_at: '2026-10-03T11:05:00Z',
    admin_label: 'e2e-1a2b3c4d',
    admin_role: 'operator',
    test_actor: true,
    session_hash: 'abcdef0123456789'.repeat(4),
    action: 'refund.approve',
    side: 'test',
    target_type: 'refund',
    target_id: ids.refund,
    target_test_mode: true,
    reason: 'Customer asked by email about the failed name',
    redacted_at: null,
    outcome: 'ok',
    error_code: null,
    detail: {
      before: { status: 'held', amount_kobo: 1_250_000, last_error_code: null },
      limits: { single_kobo: 10_000_000, daily_kobo: 50_000_000 },
      after: { status: 'queued', approved_by: 'e2e-1a2b3c4d' },
    },
    parent_id: null,
    request_id: ids.request,
    ...overrides,
  }
}
