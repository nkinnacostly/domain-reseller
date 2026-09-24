import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { createClient } = await import('@/lib/supabase/server')
const { getDomainSettings } = await import('../queries/settings')

type Call = [method: string, ...args: unknown[]]

/** Records each chained call per table and resolves to that table's row. */
function supabase(tables: Record<string, unknown>) {
  const calls: Record<string, Call[]> = {}
  const from = vi.fn((table: string) => {
    const log: Call[] = []
    calls[table] = log
    const query: Record<string, unknown> = Object.assign(
      Promise.resolve({ data: tables[table] ?? null, error: null }),
      Object.fromEntries(
        ['select', 'eq', 'order', 'limit', 'maybeSingle'].map((method) => [
          method,
          (...args: unknown[]) => {
            log.push([method, ...args])
            return query
          },
        ]),
      ),
    )
    return query
  })
  vi.mocked(createClient).mockResolvedValue({ from } as never)
  return calls
}

beforeEach(() => vi.mocked(createClient).mockReset())

describe('getDomainSettings (migration 26, FR-T7)', () => {
  it('reads what is waiting for the registry, and the latest transfer in, as the user', async () => {
    const calls = supabase({
      domains: {
        pending_transfer_lock: false,
        pending_privacy: null,
        pending_registrant: { firstName: 'Bayo' },
      },
      domain_events: { created_at: '2026-09-01T10:00:00Z' },
    })
    await expect(getDomainSettings('dom-1')).resolves.toEqual({
      pendingTransferLock: false,
      pendingPrivacy: null,
      pendingRegistrant: { firstName: 'Bayo' },
      transferredInAt: '2026-09-01T10:00:00Z',
    })
    expect(calls.domains).toContainEqual(['eq', 'id', 'dom-1'])
    expect(calls.domain_events).toEqual(
      expect.arrayContaining([
        ['eq', 'domain_id', 'dom-1'],
        ['eq', 'event_type', 'transferred_in'],
        ['order', 'created_at', { ascending: false }],
      ]),
    )
  })

  it('reads nothing waiting when there is no row to see', async () => {
    supabase({})
    await expect(getDomainSettings('dom-1')).resolves.toEqual({
      pendingTransferLock: null,
      pendingPrivacy: null,
      pendingRegistrant: null,
      transferredInAt: null,
    })
  })
})
