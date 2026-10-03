import { vi } from 'vitest'
import { adminWhoami } from '@/features/admin/queries/session'
import { createServiceClient } from '@/lib/supabase/service'
import { sessionClient, whoami } from '../foundation/fixtures'

/**
 * The network edge the Settings reads cross, faked: PostgREST through the
 * service client (behind adminDb, which is not mocked), recording each
 * read's select and filters and answering it from the test's handler.
 */

export type Read = {
  table: string
  select?: string
  options?: { count?: string; head?: boolean }
  filters: [string, ...unknown[]][]
  single?: boolean
}

export type Reply = {
  data?: unknown
  error?: { message: string; code?: string }
  count?: number
}

const CHAIN = ['eq', 'neq', 'in', 'is', 'not', 'or', 'ilike', 'order', 'range', 'limit']

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
      builder.maybeSingle = () => {
        read.single = true
        return builder
      }
      // biome-ignore lint/suspicious/noThenProperty: PostgREST's builder is a thenable
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) => {
        const reply = handler(read) ?? {}
        const fallback = read.single ? null : []
        const data: unknown = reply.error ? null : (reply.data ?? fallback)
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
  preset: 'd97320b5-50a9-44d4-a881-7b4bc1a5e077',
  other: 'ab79206f-d735-4d5b-9f02-dc10f69fc8de',
  draft: '5e1f0a9c-1111-4222-8333-444455556666',
  newDraft: '6e1f0a9c-1111-4222-8333-444455556666',
  key: '0f0e0d0c-0b0a-4908-8706-050403020100',
}

/** One `ops_settings` row: non-default values, the float alert in dollars as stored. */
export function opsRow(overrides: Record<string, unknown> = {}) {
  return {
    auto_refund_max_kobo: 31_250_050,
    auto_refund_daily_max_kobo: 123_400_000,
    refund_delay_minutes: 17,
    stuck_order_minutes: 23,
    max_domains_per_account_day: 37,
    velocity_new_max: 4,
    velocity_trusted_max: 211,
    velocity_standard_after_days: 9,
    velocity_trusted_after_days: 41,
    velocity_trusted_after_paid_orders: 6,
    float_alert_usd: 43.21,
    ...overrides,
  }
}

export function tldRow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'africa',
    is_sellable: true,
    is_paused: false,
    paused_reason: null,
    featured_rank: 4,
    featured_tagline: 'For the continent',
    is_country_code: false,
    is_transferable: true,
    synced_at: '2026-10-01T09:00:00Z',
    ...overrides,
  }
}

export function presetRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.preset,
    provider: 'Example Host',
    nameservers: ['ns1.example-host.test', 'ns2.example-host.test'],
    assigns_per_zone: false,
    source_url: 'https://docs.example-host.test/nameservers',
    notes: null,
    verified_at: '2026-09-23T00:01:00Z',
    last_checked_at: '2026-10-03T13:05:00Z',
    check_failed_since: null,
    auto_hidden_at: null,
    is_hidden: false,
    registrar_default_for: null,
    last_check: {
      unresolved: [],
      hosts: [
        { host: 'ns1.example-host.test', verdict: 'resolves', views: [] },
        { host: 'ns2.example-host.test', verdict: 'resolves', views: [] },
      ],
    },
    ...overrides,
  }
}

export function draftRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.draft,
    preset_id: ids.preset,
    provider: 'Example Host',
    nameservers: ['ns3.example-host.test', 'ns4.example-host.test'],
    source_url: 'https://docs.example-host.test/nameservers',
    notes: 'Moved in October',
    assigns_per_zone: false,
    saved_by: 'owner',
    saved_at: '2026-10-03T12:00:00Z',
    check_ok: null,
    checked_at: null,
    check_detail: null,
    published_at: null,
    discarded_at: null,
    ...overrides,
  }
}
