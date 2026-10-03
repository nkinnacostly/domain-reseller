import { vi } from 'vitest'
import type { NoticeRow, OutboxRow } from '@/features/admin/queries/emails'
import { adminWhoami } from '@/features/admin/queries/session'
import { createServiceClient } from '@/lib/supabase/service'
import { sessionClient, whoami } from '../foundation/fixtures'

/**
 * The network edge the emails reads cross, faked: PostgREST through the
 * service client — behind the real adminDb, which is not mocked, so its side
 * filter and column checks run — and the session client's rpc. Each read is
 * recorded with its select and filters, and answered by the test's handler.
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

const CHAIN = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not', 'is', 'or', 'order', 'range']

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
  email: '0e1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
  other: '1e1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6',
  user: '2a2b2c2d-3e3f-4a4b-8c5d-6e6f7a7b8c8d',
  order: '3a3b3c3d-4e4f-4a5b-8c6d-7e7f8a8b9c9d',
  domain: '5a5b5c5d-6e6f-4a7b-8c8d-9e9fa0a1b2b3',
  notice: '6a6b6c6d-7e7f-4a8b-8c9d-aeafb0b1c2c3',
}

export const NOW = new Date('2026-10-03T12:00:00Z')

/** One outbox row as the view answers it. */
export function outboxViewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.email,
    test_mode: true,
    kind: 'order_receipt',
    category: 'transactional',
    status: 'failed',
    delivery_status: null,
    attempts: 3,
    template_version: null,
    created_at: '2026-10-03T09:00:00Z',
    sent_at: null,
    next_attempt_at: '2026-10-03T09:30:00Z',
    complained_at: null,
    skip_reason: null,
    user_id: ids.user,
    domain_id: null,
    order_id: ids.order,
    masked_to: 'e•••@example.com',
    last_error_safe: 'e2e: a seeded failure for [address]',
    ...overrides,
  }
}

/** One outbox row as the page holds it. */
export function outboxRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: ids.email,
    testMode: true,
    kind: 'order_receipt',
    category: 'transactional',
    status: 'failed',
    deliveryStatus: null,
    attempts: 3,
    templateVersion: null,
    createdAt: '2026-10-03T09:00:00Z',
    sentAt: null,
    nextAttemptAt: '2026-10-03T09:30:00Z',
    complainedAt: null,
    skipReason: null,
    userId: ids.user,
    domainId: null,
    orderId: ids.order,
    orderNumber: 'ND-001234',
    maskedTo: 'e•••@example.com',
    lastErrorSafe: 'e2e: a seeded failure for [address]',
    ...overrides,
  }
}

/** One compliance notice as the page holds it. */
export function noticeRow(overrides: Partial<NoticeRow> = {}): NoticeRow {
  return {
    id: ids.notice,
    testMode: true,
    domainId: ids.domain,
    userId: ids.user,
    domainName: 'expiring.com',
    noticeType: 'errp_pre_35',
    expiresAt: '2026-11-05T10:00:00Z',
    channel: 'email',
    maskedRecipient: 'a•••@gmail.com',
    templateVersion: 'expiry_notice@2',
    sentAt: '2026-10-03T08:00:00Z',
    deliveryStatus: 'delivered',
    checkedAt: '2026-10-03T09:00:00Z',
    ...overrides,
  }
}
