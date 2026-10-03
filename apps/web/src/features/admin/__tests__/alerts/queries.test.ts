import { adminHrefForAlertKey } from '@dr/shared/admin'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OPEN_SPEC } from '@/features/admin/lib/alerts-params'
import { parseListParams } from '@/features/admin/lib/list-params'
import {
  getAlertStats,
  getCronHealth,
  getReconcileRuns,
  listAlertHistory,
  listHeartbeats,
  listOpenAlerts,
  listOpenDrift,
} from '@/features/admin/queries/alerts'
import { adminWhoami } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sessionClient, whoami } from '../foundation/fixtures'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

/**
 * The alerts page's reads (ADMIN-SPEC §5.2, B5), against a recording
 * service client: the side adminDb applies, the filters and orders each list
 * sends, and what reaches a page — an alert's link, never its key; a
 * heartbeat's outcome, never its detail; a failed check's code, never its
 * message.
 */

type Answer = { data?: unknown; error?: { code: string; message: string } | null; count?: number }
type Call = { table: string; method: string; args: unknown[] }

/** A service client answering each table's reads in turn, and recording every call. */
function fakeService(answers: Record<string, Answer[]>): Call[] {
  const calls: Call[] = []
  const service = {
    from(table: string) {
      const answer = answers[table]?.shift() ?? { data: [] }
      const builder: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'is', 'not', 'in', 'gte', 'lt', 'order', 'range']) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args })
          return builder
        }
      }
      builder.limit = (...args: unknown[]) => {
        calls.push({ table, method: 'limit', args })
        return builder
      }
      // biome-ignore lint/suspicious/noThenProperty: it stands in for PostgREST's builder, which is awaited
      builder.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        Promise.resolve({
          data: answer.data ?? null,
          error: answer.error ?? null,
          count: answer.count ?? null,
        }).then(resolve, reject)
      return builder
    },
  }
  vi.mocked(createServiceClient).mockReturnValue(service as never)
  return calls
}

const callsOf = (calls: Call[], method: string) =>
  calls.filter((call) => call.method === method).map((call) => call.args)

async function principal(overrides: Record<string, unknown> = {}) {
  const { client } = sessionClient({ rpc: { admin_whoami: { data: whoami(overrides) } } })
  return adminWhoami(client as never, null)
}

function useSessionRpc(rpc: NonNullable<Parameters<typeof sessionClient>[0]>['rpc']) {
  const session = sessionClient({ rpc })
  vi.mocked(createClient).mockResolvedValue(session.client as never)
  return session.rpc
}

const JOB = '0b6a52a1-55c4-4f0e-9a3e-2b8c1d2e3f40'
const alertRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  key: `job:${JOB}`,
  severity: 'critical',
  kind: 'job_needs_attention',
  summary: 'Registration of example.com needs a person',
  first_seen_at: '2026-10-02T08:00:00Z',
  last_seen_at: '2026-10-03T08:00:00Z',
  notify_count: 2,
  resolved_at: null,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createServiceClient).mockReset()
})

describe('open alerts', () => {
  it('reads the side, open rows only, critical first, and links each by its key', async () => {
    const calls = fakeService({ ops_alerts: [{ data: [alertRow()], count: 1 }] })
    const result = await listOpenAlerts(await principal(), 'test', parseListParams({}, OPEN_SPEC))

    expect(result).toEqual({
      ok: true,
      data: {
        total: 1,
        rows: [
          {
            id: 7,
            severity: 'critical',
            kind: 'job_needs_attention',
            summary: 'Registration of example.com needs a person',
            firstSeenAt: '2026-10-02T08:00:00Z',
            lastSeenAt: '2026-10-03T08:00:00Z',
            notifyCount: 2,
            resolvedAt: null,
            href: adminHrefForAlertKey(`job:${JOB}`),
          },
        ],
      },
    })
    // The key built the link and went no further.
    if (result.ok) expect(result.data.rows[0]).not.toHaveProperty('key')
    expect(callsOf(calls, 'eq')).toContainEqual(['test_mode', true])
    expect(callsOf(calls, 'is')).toEqual([['resolved_at', null]])
    expect(callsOf(calls, 'order')).toEqual([
      ['severity', { ascending: true }],
      ['last_seen_at', { ascending: false }],
      ['id', { ascending: false }],
    ])
    expect(callsOf(calls, 'range')).toEqual([[0, 49]])
    expect(callsOf(calls, 'select')[0]?.[1]).toEqual({ count: 'exact' })
  })

  it('reads one severity when asked, for the overview’s critical tile', async () => {
    const calls = fakeService({ ops_alerts: [{ data: [alertRow()], count: 1 }] })
    await listOpenAlerts(await principal(), 'live', parseListParams({}, OPEN_SPEC), 'critical')
    expect(callsOf(calls, 'eq')).toContainEqual(['severity', 'critical'])
  })

  it('keeps a test administrator on the test side, whatever side the page asked for (D15)', async () => {
    const calls = fakeService({ ops_alerts: [{ data: [], count: 0 }] })
    await listOpenAlerts(
      await principal({ testOnly: true }),
      'live',
      parseListParams({}, OPEN_SPEC),
    )
    expect(callsOf(calls, 'eq')).toContainEqual(['test_mode', true])
    expect(callsOf(calls, 'eq')).not.toContainEqual(['test_mode', false])
  })

  it('answers a failed read as an error state, logging the code and nothing else', async () => {
    const warn = vi.spyOn(logger, 'warn')
    fakeService({
      ops_alerts: [{ error: { code: '57014', message: 'canceling statement due to timeout' } }],
    })
    const result = await listOpenAlerts(await principal(), 'live', parseListParams({}, OPEN_SPEC))
    expect(result).toEqual({ ok: false })
    expect(warn).toHaveBeenCalledWith({ code: '57014', what: 'open alerts' }, expect.any(String))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('canceling')
  })

  it('answers an error thrown before the read the same way', async () => {
    vi.mocked(createServiceClient).mockImplementation(() => {
      throw new Error('no key')
    })
    const result = await listOpenAlerts(await principal(), 'live', parseListParams({}, OPEN_SPEC))
    expect(result).toEqual({ ok: false })
  })
})

describe('alert history', () => {
  const history = (query: string) =>
    parseListParams(new URLSearchParams(query), {
      sorts: ['last_seen', 'first_seen', 'notified'] as const,
      defaultSort: 'last_seen' as const,
      statuses: ['open', 'resolved'] as const,
    })

  it('filters by state, kind and the days an alert was seen in', async () => {
    const calls = fakeService({
      ops_alerts: [{ data: [alertRow({ resolved_at: '2026-10-03T09:00:00Z' })], count: 30 }],
    })
    const result = await listAlertHistory(
      await principal(),
      'live',
      history('status=resolved&from=2026-10-01&to=2026-10-02&sort=notified&page=2'),
      'job_needs_attention',
    )
    expect(result.ok && result.data.total).toBe(30)
    expect(callsOf(calls, 'eq')).toEqual([
      ['test_mode', false],
      ['kind', 'job_needs_attention'],
    ])
    expect(callsOf(calls, 'not')).toEqual([['resolved_at', 'is', null]])
    expect(callsOf(calls, 'gte')).toEqual([['last_seen_at', '2026-10-01T00:00:00+01:00']])
    expect(callsOf(calls, 'lt')).toEqual([['first_seen_at', '2026-10-03T00:00:00+01:00']])
    expect(callsOf(calls, 'order')[0]).toEqual(['notify_count', { ascending: false }])
    expect(callsOf(calls, 'range')).toEqual([[25, 49]])
  })

  it('reads open rows for the open chip, and every row with no chip or both', async () => {
    let calls = fakeService({ ops_alerts: [{ data: [] }] })
    await listAlertHistory(await principal(), 'live', history('status=open'), null)
    expect(callsOf(calls, 'is')).toEqual([['resolved_at', null]])

    calls = fakeService({ ops_alerts: [{ data: [] }] })
    await listAlertHistory(await principal(), 'live', history('status=open,resolved'), null)
    expect(callsOf(calls, 'is')).toEqual([])
    expect(callsOf(calls, 'not')).toEqual([])
  })

  it('answers a failed read as an error state', async () => {
    fakeService({ ops_alerts: [{ error: { code: 'PGRST301', message: 'x' } }] })
    expect(await listAlertHistory(await principal(), 'live', history(''), null)).toEqual({
      ok: false,
    })
  })
})

describe('open drift', () => {
  const RUN = '6f1d3a2b-1c4d-4e5f-8a9b-0c1d2e3f4a5b'
  const DOMAIN = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
  const list = parseListParams(
    {},
    { sorts: ['last_seen', 'first_seen'] as const, defaultSort: 'last_seen' as const },
  )

  it('reads open rows on the side, says ours against the registry, and finds each last check', async () => {
    const calls = fakeService({
      registry_drift: [
        {
          count: 2,
          data: [
            {
              id: 3,
              domain_id: DOMAIN,
              domain_name: 'example.com',
              kind: 'status_mismatch',
              detail: { local_status: 'active', registry_status: 'clientHold' },
              first_seen_at: '2026-10-01T00:00:00Z',
              last_seen_at: '2026-10-03T00:00:00Z',
              last_run_id: RUN,
            },
            {
              id: 4,
              domain_id: null,
              domain_name: 'stranger.com',
              kind: 'unknown_domain',
              detail: { registry_status: 'Active' },
              first_seen_at: '2026-10-01T00:00:00Z',
              last_seen_at: '2026-10-03T00:00:00Z',
              last_run_id: null,
            },
          ],
        },
      ],
      reconcile_runs: [
        {
          data: [
            {
              id: RUN,
              started_at: '2026-10-03T00:00:00Z',
              finished_at: '2026-10-03T00:00:02Z',
              error: null,
            },
          ],
        },
      ],
    })
    const result = await listOpenDrift(await principal(), 'live', list)
    if (!result.ok) throw new Error('drift failed')
    expect(result.data.total).toBe(2)
    expect(result.data.rows[0]).toMatchObject({
      domainName: 'example.com',
      domainHref: `/admin/domains/${DOMAIN}`,
      ours: 'Status active',
      registry: 'Status clientHold',
      lastRun: { at: '2026-10-03T00:00:02Z', failed: false },
    })
    expect(result.data.rows[0]).not.toHaveProperty('detail')
    expect(result.data.rows[1]).toMatchObject({
      domainHref: null,
      ours: 'No record',
      lastRun: null,
    })
    expect(calls.filter((c) => c.table === 'registry_drift' && c.method === 'is')).toHaveLength(1)
    expect(calls.find((c) => c.table === 'registry_drift' && c.method === 'eq')?.args).toEqual([
      'test_mode',
      false,
    ])
    expect(calls.find((c) => c.table === 'reconcile_runs' && c.method === 'in')?.args).toEqual([
      'id',
      [RUN],
    ])
  })

  it('asks for no runs when no row names one', async () => {
    const calls = fakeService({ registry_drift: [{ data: [], count: 0 }] })
    const result = await listOpenDrift(await principal(), 'live', list)
    expect(result).toEqual({ ok: true, data: { rows: [], total: 0 } })
    expect(calls.some((c) => c.table === 'reconcile_runs')).toBe(false)
  })

  it('answers a failed read of the drift or of its runs as an error state', async () => {
    fakeService({ registry_drift: [{ error: { code: '500', message: 'x' } }] })
    expect(await listOpenDrift(await principal(), 'live', list)).toEqual({ ok: false })
    fakeService({
      registry_drift: [
        {
          data: [
            {
              id: 1,
              domain_id: null,
              domain_name: 'a.com',
              kind: 'unknown_domain',
              detail: {},
              first_seen_at: '2026-10-01T00:00:00Z',
              last_seen_at: '2026-10-01T00:00:00Z',
              last_run_id: RUN,
            },
          ],
        },
      ],
      reconcile_runs: [{ error: { code: '500', message: 'x' } }],
    })
    expect(await listOpenDrift(await principal(), 'live', list)).toEqual({ ok: false })
  })
})

describe('heartbeats', () => {
  it('are not read at all for a test administrator (§2.3)', async () => {
    const result = await listHeartbeats(await principal({ testOnly: true }), 'test')
    expect(result).toEqual({ ok: true, hidden: true })
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('come from both sides, each with its outcome and nothing else from its detail', async () => {
    const calls = fakeService({
      service_heartbeats: [
        {
          data: [
            {
              name: 'gateway:production',
              test_mode: false,
              beat_at: '2026-10-03T09:00:00Z',
              detail: { checkedAt: '2026-10-03T09:00:00Z' },
            },
            {
              name: 'supplier_ledger:ote',
              test_mode: true,
              beat_at: '2026-10-03T08:00:00Z',
              detail: { outcome: 'failed', reason: 'API_301: your address 1.2.3.4' },
            },
          ],
        },
      ],
    })
    const result = await listHeartbeats(await principal(), 'live')
    expect(result).toEqual({
      ok: true,
      data: [
        {
          name: 'gateway:production',
          side: 'live',
          beatAt: '2026-10-03T09:00:00Z',
          outcome: null,
        },
        {
          name: 'supplier_ledger:ote',
          side: 'test',
          beatAt: '2026-10-03T08:00:00Z',
          outcome: 'failed',
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('1.2.3.4')
    // service_heartbeats has no side filter: all of them, in name order.
    expect(calls.some((c) => c.method === 'eq')).toBe(false)
    expect(callsOf(calls, 'order')).toEqual([['name', { ascending: true }]])
  })

  it('answer a failed read as an error state', async () => {
    fakeService({ service_heartbeats: [{ error: { code: '500', message: 'x' } }] })
    expect(await listHeartbeats(await principal(), 'live')).toEqual({ ok: false })
  })
})

describe('registry checks', () => {
  const now = new Date('2026-10-03T12:00:00Z')
  const run = (index: number, overrides: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    started_at: new Date(now.getTime() - index * 3_600_000).toISOString(),
    finished_at: new Date(now.getTime() - index * 3_600_000 + 2_000).toISOString(),
    domains_seen: 4,
    findings: 0,
    error: null,
    ...overrides,
  })

  it('counts the last 7 days, averages the finished ones, and keeps the last 20', async () => {
    const rows = Array.from({ length: 24 }, (_, index) => run(index))
    rows[1] = run(1, {
      error: 'API_301: Your IP 1.2.3.4 is not allowed',
      finished_at: new Date(now.getTime() - 3_600_000 + 6_000).toISOString(),
    })
    rows[2] = run(2, { finished_at: null })
    const calls = fakeService({ reconcile_runs: [{ data: rows }] })
    const result = await getReconcileRuns(await principal(), 'live', now)
    if (!result.ok) throw new Error('runs failed')
    expect(result.data.runs).toBe(24)
    expect(result.data.failed).toBe(1)
    // 22 runs of 2 s and one of 6 s; the unfinished one is not counted.
    expect(result.data.averageSeconds).toBeCloseTo((22 * 2 + 6) / 23)
    expect(result.data.recent).toHaveLength(20)
    expect(result.data.recent[1]?.outcome).toEqual({ label: 'Failed (API_301)', tone: 'danger' })
    expect(result.data.recent[2]).toMatchObject({ seconds: null, outcome: { label: 'Running' } })
    expect(JSON.stringify(result)).not.toContain('1.2.3.4')
    expect(callsOf(calls, 'gte')).toEqual([['started_at', '2026-09-26T12:00:00.000Z']])
    expect(callsOf(calls, 'eq')).toEqual([['test_mode', false]])
  })

  it('has no average when nothing ran, and fails as an error state', async () => {
    fakeService({ reconcile_runs: [{ data: [] }] })
    expect(await getReconcileRuns(await principal(), 'test', now)).toEqual({
      ok: true,
      data: { runs: 0, failed: 0, averageSeconds: null, recent: [] },
    })
    fakeService({ reconcile_runs: [{ error: { code: '500', message: 'x' } }] })
    expect(await getReconcileRuns(await principal(), 'test', now)).toEqual({ ok: false })
  })
})

describe('alert stats', () => {
  it('asks admin_alert_stats for the side and window, and reads what it answers', async () => {
    const rpc = useSessionRpc({
      admin_alert_stats: {
        data: {
          byKind: [{ kind: 'refund_held', severity: 'warning', open: 1, resolved: '20' }],
          reconcile: { runs: 3, failed: 0, lastFinishedAt: '2026-10-03T08:00:00Z' },
          drift: [],
          presets: { hidden: 0, failing: 1, stale: 2, drafts: 0 },
        },
      },
    })
    const result = await getAlertStats('test', 7)
    expect(rpc).toHaveBeenCalledWith('admin_alert_stats', { p_test_mode: true, p_days: 7 })
    expect(result).toEqual({
      ok: true,
      data: {
        byKind: [{ kind: 'refund_held', severity: 'warning', open: 1, resolved: 20 }],
        reconcile: { runs: 3, failed: 0, lastFinishedAt: '2026-10-03T08:00:00Z' },
        drift: [],
        presets: { hidden: 0, failing: 1, stale: 2, drafts: 0 },
      },
    })
  })

  it('answers a refusal or an unreadable answer as an error state', async () => {
    useSessionRpc({ admin_alert_stats: { error: { message: 'admin:test_admin' } } })
    expect(await getAlertStats('live')).toEqual({ ok: false })
    useSessionRpc({ admin_alert_stats: { data: 'not an object' } })
    expect(await getAlertStats('live')).toEqual({ ok: false })
  })
})

describe('scheduled jobs', () => {
  it('are not asked for a test administrator, who sees no cron panel (§5.2)', async () => {
    const rpc = useSessionRpc({})
    expect(await getCronHealth(await principal({ testOnly: true }), 'test')).toEqual({
      ok: true,
      hidden: true,
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('keep only health.cron from the overview', async () => {
    const rpc = useSessionRpc({
      admin_overview: {
        data: {
          sales: { d1: { netKobo: 100 } },
          health: {
            heartbeats: [],
            cron: [
              {
                job: 'email-notices',
                schedule: '5 6 * * *',
                lastRunAt: '2026-10-03T05:05:00Z',
                lastStatus: 'succeeded',
                lastSuccessAt: '2026-10-03T05:05:01Z',
              },
              { job: 'admin-metrics-daily', schedule: '20 23 * * *', lastRunAt: null },
            ],
          },
        },
      },
    })
    const result = await getCronHealth(await principal(), 'live')
    expect(rpc).toHaveBeenCalledWith('admin_overview', { p_test_mode: false })
    expect(result).toEqual({
      ok: true,
      data: [
        {
          job: 'email-notices',
          schedule: '5 6 * * *',
          lastRunAt: '2026-10-03T05:05:00Z',
          lastStatus: 'succeeded',
          lastSuccessAt: '2026-10-03T05:05:01Z',
        },
        {
          job: 'admin-metrics-daily',
          schedule: '20 23 * * *',
          lastRunAt: null,
          lastStatus: null,
          lastSuccessAt: null,
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('netKobo')
  })

  it('are an empty list when SQL leaves them out, and an error state on a refusal', async () => {
    useSessionRpc({ admin_overview: { data: { health: {} } } })
    expect(await getCronHealth(await principal(), 'live')).toEqual({ ok: true, data: [] })
    useSessionRpc({ admin_overview: { error: { message: 'admin:needs_code' } } })
    expect(await getCronHealth(await principal(), 'live')).toEqual({ ok: false })
    useSessionRpc({ admin_overview: { data: null } })
    expect(await getCronHealth(await principal(), 'live')).toEqual({ ok: false })
  })
})
