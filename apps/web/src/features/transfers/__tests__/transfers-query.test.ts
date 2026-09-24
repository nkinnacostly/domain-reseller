import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const { getTransfers } = await import('../queries/transfers')

let calls: unknown[][]
function answer(result: { data: unknown; error: { message: string } | null }) {
  calls = []
  const query: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order']) {
    query[method] = (...args: unknown[]) => {
      calls.push([method, ...args])
      return query
    }
  }
  query.limit = async (...args: unknown[]) => {
    calls.push(['limit', ...args])
    return result
  }
  vi.mocked(createClient).mockResolvedValue({ from: () => query } as never)
}

beforeEach(() => vi.clearAllMocks())

describe('getTransfers', () => {
  it('reads the account’s transferred domains, with when the registry took each', async () => {
    answer({
      data: [
        {
          id: 'd1',
          domain_name: 'getpaid.com',
          local_status: 'transfer_pending',
          test_mode: true,
          created_at: '2026-09-24T09:00:00Z',
          order_items: { order_id: 'o1', orders: { order_number: 'ND-001050' } },
          domain_events: [{ event_type: 'transfer_submitted', created_at: '2026-09-24T09:20:00Z' }],
        },
        {
          id: 'd2',
          domain_name: 'old.com',
          local_status: 'transfer_requested',
          test_mode: false,
          created_at: '2026-09-23T09:00:00Z',
          order_items: null,
          domain_events: [],
        },
      ],
      error: null,
    })

    expect(await getTransfers()).toEqual([
      {
        id: 'd1',
        domainName: 'getpaid.com',
        status: 'transfer_pending',
        testMode: true,
        startedAt: '2026-09-24T09:00:00Z',
        submittedAt: '2026-09-24T09:20:00Z',
        orderId: 'o1',
        orderNumber: 'ND-001050',
      },
      {
        id: 'd2',
        domainName: 'old.com',
        status: 'transfer_requested',
        testMode: false,
        startedAt: '2026-09-23T09:00:00Z',
        submittedAt: null,
        orderId: null,
        orderNumber: null,
      },
    ])
    expect(calls).toContainEqual(['eq', 'source', 'transfer'])
    expect(calls).toContainEqual(['eq', 'domain_events.event_type', 'transfer_submitted'])
  })

  it('is empty when there are none', async () => {
    answer({ data: null, error: null })
    expect(await getTransfers()).toEqual([])
  })

  it('throws on a failed read, so the page shows its error', async () => {
    answer({ data: null, error: { message: 'timeout' } })
    await expect(getTransfers()).rejects.toThrow('transfers: timeout')
  })
})
