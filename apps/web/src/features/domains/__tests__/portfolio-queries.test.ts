import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/public', () => ({ createPublicClient: vi.fn() }))

const { createClient } = await import('@/lib/supabase/server')
const { getLabels } = await import('../queries/labels')
const { getBulkOperation } = await import('../queries/bulk')
const { getNameserverHistory, getPortfolio } = await import('../queries/domains')

type Answer = { data: unknown; error?: unknown }
type Call = [method: string, ...args: unknown[]]

/**
 * The signed-in client (RLS). Each table (and RPC) answers what the test
 * says; every chained call is recorded against its table.
 */
function signedIn(tables: Record<string, Answer>) {
  const calls: Record<string, Call[][]> = {}
  const answer = (name: string) => ({
    data: tables[name]?.data ?? null,
    error: tables[name]?.error ?? null,
  })
  const from = (table: string) => {
    const log: Call[] = []
    calls[table] = [...(calls[table] ?? []), log]
    const query = Object.assign(Promise.resolve(answer(table)), {} as Record<string, unknown>)
    for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
      query[method] = (...args: unknown[]) => {
        log.push([method, ...args])
        return query
      }
    }
    query.maybeSingle = async () => answer(table)
    return query
  }
  const rpc = async (name: string, args: unknown) => {
    calls[name] = [...(calls[name] ?? []), [['rpc', args]]]
    return answer(name)
  }
  vi.mocked(createClient).mockResolvedValue({ from, rpc } as never)
  return calls
}

beforeEach(() => vi.clearAllMocks())

describe('getLabels (FR-P3)', () => {
  it('lists the account’s labels by name, each with how many domains carry it', async () => {
    signedIn({
      domain_labels: {
        data: [
          { id: 'l2', name: 'banks', color: 'green', domain_label_links: [{ count: 0 }] },
          { id: 'l1', name: 'Acme', color: 'purple', domain_label_links: [{ count: 3 }] },
          { id: 'l3', name: 'Old', color: 'teal', domain_label_links: [] },
        ],
      },
    })
    expect(await getLabels()).toEqual([
      { id: 'l1', name: 'Acme', color: 'purple', domainCount: 3 },
      { id: 'l2', name: 'banks', color: 'green', domainCount: 0 },
      { id: 'l3', name: 'Old', color: 'slate', domainCount: 0 },
    ])
  })

  it('says it could not read them, rather than showing none', async () => {
    signedIn({ domain_labels: { data: null, error: { code: '08006' } } })
    expect(await getLabels()).toBeNull()
  })
})

describe('getPortfolio labels (FR-P3)', () => {
  it('gives each domain its labels, by name', async () => {
    signedIn({
      domains: {
        data: [
          {
            id: 'd1',
            domain_name: 'getpaid.com',
            tld: 'com',
            source: 'registration',
            test_mode: false,
            local_status: 'active',
            expires_at: null,
            auto_renew: true,
            privacy_enabled: false,
            transfer_lock: false,
            delegation_status: 'verified',
            nameservers: null,
            pending_nameservers: null,
            domain_label_links: [
              { domain_labels: { id: 'l2', name: 'Zed', color: 'red' } },
              { domain_labels: null },
              { domain_labels: { id: 'l1', name: 'Acme', color: 'blue' } },
            ],
          },
        ],
      },
    })
    const [domain] = await getPortfolio()
    expect(domain?.transferLock).toBe(false)
    expect(domain?.labels).toEqual([
      { id: 'l1', name: 'Acme', color: 'blue' },
      { id: 'l2', name: 'Zed', color: 'red' },
    ])
  })
})

describe('getNameserverHistory (FR-N5)', () => {
  it('reads the domain’s changes newest first, each with where it came from', async () => {
    const calls = signedIn({
      domain_nameserver_history: {
        data: [
          {
            before: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
            after: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
            changed_at: '2026-09-24T10:05:00Z',
          },
        ],
      },
      domain_events: {
        data: [
          {
            event_type: 'nameservers_requested',
            actor_type: 'user',
            payload: { after: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'] },
            created_at: '2026-09-24T10:00:00Z',
          },
        ],
      },
    })
    expect(await getNameserverHistory('d1')).toEqual([
      {
        before: ['ns1.domainnameapi.com', 'ns2.domainnameapi.com'],
        after: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
        changedAt: '2026-09-24T10:05:00Z',
        source: { kind: 'request', by: 'you', requestedAt: '2026-09-24T10:00:00Z' },
      },
    ])
    expect(calls.domain_nameserver_history?.[0]).toContainEqual(['eq', 'domain_id', 'd1'])
    expect(calls.domain_nameserver_history?.[0]).toContainEqual([
      'order',
      'changed_at',
      { ascending: false },
    ])
    expect(calls.domain_events?.[0]).toContainEqual([
      'in',
      'event_type',
      ['nameservers_requested', 'nameservers_synced'],
    ])
  })

  it('copes with no events, and a null payload', async () => {
    signedIn({
      domain_nameserver_history: {
        data: [
          { before: null, after: ['ns1.a.com', 'ns2.a.com'], changed_at: '2026-09-01T00:00:00Z' },
        ],
      },
      domain_events: {
        data: [
          {
            event_type: 'nameservers_synced',
            actor_type: 'system',
            payload: null,
            created_at: '2026-08-01T00:00:00Z',
          },
        ],
      },
    })
    expect((await getNameserverHistory('d1'))?.[0]?.source).toEqual({ kind: 'first' })
  })

  it('says it could not read the history', async () => {
    signedIn({ domain_nameserver_history: { data: null, error: { code: '08006' } } })
    expect(await getNameserverHistory('d1')).toBeNull()
  })
})

describe('getBulkOperation (FR-P4)', () => {
  const OP = '00000000-0000-4000-8000-0000000000b1'
  const LINES = [
    {
      domain_id: 'd1',
      domain_name: 'getpaid.com',
      outcome: 'queued',
      reason: null,
      job_status: 'running',
      job_error_code: null,
    },
    {
      domain_id: 'd2',
      domain_name: 'sample.com',
      outcome: 'surprise',
      reason: 'demo',
      job_status: null,
      job_error_code: null,
    },
  ]

  it('is not found for anything that is not an id, without asking', async () => {
    const calls = signedIn({})
    expect(await getBulkOperation('not-an-id')).toBeNull()
    expect(calls).toEqual({})
  })

  it('is not found when the operation is not the account’s (RLS)', async () => {
    signedIn({ bulk_operations: { data: null }, my_bulk_operation: { data: [] } })
    expect(await getBulkOperation(OP)).toBeNull()
  })

  it('is not found for a kind this page does not know', async () => {
    signedIn({
      bulk_operations: { data: { id: OP, kind: 'teleport', params: {}, created_at: 'x' } },
      my_bulk_operation: { data: [] },
    })
    expect(await getBulkOperation(OP)).toBeNull()
  })

  it('throws when it cannot be read, so the page shows its error state', async () => {
    signedIn({
      bulk_operations: { data: null, error: { code: '08006' } },
      my_bulk_operation: { data: null },
    })
    await expect(getBulkOperation(OP)).rejects.toThrow()
  })

  it('reads the lines, each domain as it is now, and a label’s name', async () => {
    const calls = signedIn({
      bulk_operations: {
        data: {
          id: OP,
          kind: 'label',
          params: { label_id: 'l1' },
          created_at: '2026-09-24T10:00:00Z',
        },
      },
      my_bulk_operation: { data: LINES },
      domains: {
        data: [
          { id: 'd1', source: 'registration', local_status: 'active' },
          { id: 'd2', source: 'demo', local_status: 'active' },
        ],
      },
      domain_labels: { data: { name: 'Acme' } },
    })
    expect(await getBulkOperation(OP)).toEqual({
      id: OP,
      kind: 'label',
      params: { label_id: 'l1' },
      createdAt: '2026-09-24T10:00:00Z',
      lines: [
        {
          domainId: 'd1',
          domainName: 'getpaid.com',
          outcome: 'queued',
          reason: null,
          jobStatus: 'running',
          jobErrorCode: null,
        },
        {
          domainId: 'd2',
          domainName: 'sample.com',
          // An outcome this page does not know is shown as skipped, never as done.
          outcome: 'skipped',
          reason: 'demo',
          jobStatus: null,
          jobErrorCode: null,
        },
      ],
      domains: {
        d1: { source: 'registration', status: 'active' },
        d2: { source: 'demo', status: 'active' },
      },
      labelName: 'Acme',
    })
    expect(calls.my_bulk_operation?.[0]).toEqual([['rpc', { p_operation_id: OP }]])
  })

  it('has no label name for a deleted label, or for another kind', async () => {
    signedIn({
      bulk_operations: {
        data: { id: OP, kind: 'unlabel', params: { label_id: 'gone' }, created_at: 'x' },
      },
      my_bulk_operation: { data: [] },
      domain_labels: { data: null },
    })
    expect((await getBulkOperation(OP))?.labelName).toBeNull()

    signedIn({
      bulk_operations: { data: { id: OP, kind: 'privacy', params: null, created_at: 'x' } },
      my_bulk_operation: { data: null },
    })
    expect(await getBulkOperation(OP)).toMatchObject({ params: {}, lines: [], labelName: null })
  })
})
