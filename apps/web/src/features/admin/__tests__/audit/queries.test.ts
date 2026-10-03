import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HIDDEN_VALUE } from '@/features/admin/lib/audit-copy'
import { parseAuditParams } from '@/features/admin/lib/audit-params'
import { AuditReadError, listAuditEntries } from '@/features/admin/queries/audit'
import { auditRow, fakeService, filterOf, ids, principal, type Read } from './fake-db'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

/** Columns the log's reads never name: a raw database message, who by uuid, the request key. */
const NEVER = /(^|[\s,])(error|admin_id|request_key)([\s,]|$)/

const isResults = (read: Read) =>
  read.filters.some(([method, column]) => method === 'in' && column === 'parent_id')

beforeEach(() => vi.clearAllMocks())

describe('listAuditEntries', () => {
  it('reads one page of the log, every filter from the URL, newest first by default', async () => {
    const reads = fakeService((read) =>
      isResults(read) ? { data: [] } : { data: [auditRow()], count: 61 },
    )
    const admin = await principal({ role: 'owner' })
    const params = parseAuditParams({
      action: 'ssl_job',
      outcome: 'ok,refused',
      side: 'live',
      who: 'admins',
      admin: 'owner',
      target: ids.refund,
      id: '101',
      from: '2026-10-01',
      to: '2026-10-03',
      page: '2',
      per: '25',
    })
    const page = await listAuditEntries(admin, 'live', params)

    expect(page.total).toBe(61)
    const [read] = reads
    expect(read?.table).toBe('admin_audit_log')
    expect(read?.options).toEqual({ count: 'exact' })
    expect(read?.select).not.toMatch(NEVER)
    expect(read?.select).toContain('detail')
    expect(filterOf(read, 'eq', 'id')).toBe(101)
    expect(filterOf(read, 'like', 'action')).toBe('ssl_job.%')
    expect(filterOf(read, 'in', 'outcome')).toEqual(['ok', 'refused'])
    expect(filterOf(read, 'eq', 'side')).toBe('live')
    expect(filterOf(read, 'eq', 'test_actor')).toBe(false)
    expect(filterOf(read, 'eq', 'admin_label')).toBe('owner')
    expect(filterOf(read, 'eq', 'target_id')).toBe(ids.refund)
    expect(filterOf(read, 'gte', 'created_at')).toBe('2026-10-01T00:00:00+01:00')
    expect(filterOf(read, 'lt', 'created_at')).toBe('2026-10-04T00:00:00+01:00')
    expect(read?.filters).toContainEqual(['order', 'created_at', { ascending: false }])
    expect(read?.filters).toContainEqual(['order', 'id', { ascending: false }])
    expect(read?.filters).toContainEqual(['range', 25, 49])
  })

  it('applies no filter it was not asked for: an admin reads every row, both sides', async () => {
    const reads = fakeService(() => ({ data: [] }))
    const admin = await principal()
    expect(await listAuditEntries(admin, 'test', parseAuditParams({ dir: 'asc' }))).toEqual({
      rows: [],
      total: 0,
    })
    expect(reads).toHaveLength(1)
    const [read] = reads
    for (const column of ['side', 'test_actor', 'admin_label', 'target_id', 'id']) {
      expect(filterOf(read, 'eq', column), column).toBeUndefined()
    }
    expect(read?.filters.some(([method]) => method === 'like')).toBe(false)
    expect(read?.filters).toContainEqual(['order', 'created_at', { ascending: true }])
    expect(read?.filters).toContainEqual(['range', 0, 49])
  })

  it('keeps a test administrator to test administrators’ rows, whatever the URL asks (D15)', async () => {
    const reads = fakeService(() => ({ data: [] }))
    const admin = await principal({ role: 'operator', testOnly: true })
    await listAuditEntries(admin, 'live', parseAuditParams({ who: 'admins' }, true))
    const [read] = reads
    expect(read?.filters.filter(([, column]) => column === 'test_actor')).toEqual([
      ['eq', 'test_actor', true],
    ])
  })

  it('turns each row into an entry: reason masked, detail as safe lines, a session as a hint', async () => {
    fakeService((read) =>
      isResults(read)
        ? { data: [] }
        : {
            data: [
              auditRow({
                reason: 'Asked by ada@example.com',
                detail: { kind: 'email', matched: [ids.user], contact: { email: 'x@y.com' } },
              }),
              auditRow({ id: 102, reason: null, redacted_at: '2026-10-03T12:00:00Z', detail: {} }),
            ],
          },
    )
    const admin = await principal()
    const { rows } = await listAuditEntries(admin, 'live', parseAuditParams({}))
    expect(rows[0]).toMatchObject({
      id: 101,
      createdAt: '2026-10-03T11:05:00Z',
      adminLabel: 'e2e-1a2b3c4d',
      adminRole: 'operator',
      testActor: true,
      session: 'abcdef01',
      action: 'refund.approve',
      side: 'test',
      targetType: 'refund',
      targetId: ids.refund,
      targetTestMode: true,
      reason: 'Asked by a•••@example.com',
      redactedAt: null,
      outcome: 'ok',
      errorCode: null,
      parentId: null,
      requestId: ids.request,
      result: null,
      detail: [
        { label: 'kind', value: 'email', hidden: false },
        { label: 'matched', value: ids.user, hidden: false },
        { label: 'contact', value: HIDDEN_VALUE, hidden: true },
      ],
    })
    expect(JSON.stringify(rows)).not.toContain('ada@example.com')
    expect(JSON.stringify(rows)).not.toContain('x@y.com')
    expect(rows[1]).toMatchObject({ id: 102, reason: null, detail: [] })
  })

  it('reads each intent note’s gateway result, and only for intent notes', async () => {
    const reads = fakeService((read) =>
      isResults(read)
        ? {
            data: [
              {
                id: 205,
                parent_id: 201,
                outcome: 'refused',
                error_code: 'TOO_SOON',
                created_at: '2026-10-03T11:06:00Z',
              },
              { id: 206, parent_id: null, outcome: 'ok', error_code: null, created_at: 'x' },
            ],
          }
        : {
            data: [
              auditRow({ id: 201, action: 'supplier.domain_lookup', outcome: 'intent' }),
              auditRow({ id: 202, action: 'supplier.balance', outcome: 'intent' }),
              auditRow({ id: 203, outcome: 'refused', error_code: 'NOT_HELD' }),
              auditRow({ id: 204, outcome: 'ok', parent_id: 199 }),
            ],
          },
    )
    const admin = await principal({ testOnly: true, role: 'operator' })
    const { rows } = await listAuditEntries(admin, 'test', parseAuditParams({}))

    const results = reads.find(isResults)
    expect(results?.table).toBe('admin_audit_log')
    expect(results?.select).toBe('id, parent_id, outcome, error_code, created_at')
    expect(filterOf(results, 'in', 'parent_id')).toEqual([201, 202])
    // The results are a test administrator's too: adminDb keeps the rule.
    expect(filterOf(results, 'eq', 'test_actor')).toBe(true)
    expect(rows.map((row) => row.result)).toEqual([
      { id: 205, outcome: 'refused', errorCode: 'TOO_SOON', createdAt: '2026-10-03T11:06:00Z' },
      null,
      null,
      null,
    ])
    expect(rows[3]?.parentId).toBe(199)
  })

  it('throws on a failed read, never answering an empty log', async () => {
    fakeService(() => ({ error: { message: 'boom', code: '57014' } }))
    const admin = await principal()
    await expect(listAuditEntries(admin, 'live', parseAuditParams({}))).rejects.toBeInstanceOf(
      AuditReadError,
    )
  })

  it('throws when the gateway results cannot be read', async () => {
    fakeService((read) =>
      isResults(read)
        ? { error: { message: 'boom' } }
        : { data: [auditRow({ outcome: 'intent' })] },
    )
    const admin = await principal()
    await expect(listAuditEntries(admin, 'live', parseAuditParams({}))).rejects.toThrow(
      'audit read failed: gateway results',
    )
  })
})
