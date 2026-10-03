import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type NoticeParams,
  type OutboxParams,
  parseEmailsParams,
} from '@/features/admin/lib/emails-params'
import { getEmailStats, listNotices, listOutbox } from '@/features/admin/queries/emails'
import { logger } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { sessionClient } from '../foundation/fixtures'
import { fakeService, filterOf, ids, NOW, outboxViewRow, principal, type Read } from './fake-db'

vi.mock('next/headers', () => ({ headers: vi.fn(), cookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn() }))

/**
 * The emails reads (ADMIN-SPEC §5.2 B11): rows only from the masked views,
 * through adminDb (whose side filter is real here), and never a column that
 * holds an address, the template's data or a provider's raw answer.
 */

const outbox = (search: Record<string, string> = {}) => parseEmailsParams(search) as OutboxParams
const notices = (search: Record<string, string> = {}) =>
  parseEmailsParams({ tab: 'compliance', ...search }) as NoticeParams

/** Whole column names no emails read may name (§8.1, N13). */
const NEVER =
  /(^|[\s,(])(to_email|recipient|data|delivery_detail|last_error|provider_message_id|email|dedupe_key)([\s,)]|$)/

const byTable = (reads: Read[], table: string) => reads.filter((read) => read.table === table)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
})

describe('listOutbox', () => {
  it('narrows to one account by its id when asked (?user=)', async () => {
    const reads = fakeService(() => ({ data: [], count: 0 }))
    const admin = await principal({ role: 'operator' })
    await listOutbox(admin, 'test', outbox({ user: ids.user }), NOW)
    const [read] = byTable(reads, 'admin_email_outbox_v')
    expect(filterOf(read, 'eq', 'user_id')).toBe(ids.user)
    expect(filterOf(read, 'eq', 'test_mode')).toBe(true)
  })

  it('reads one page of the masked outbox on the side asked, newest first', async () => {
    const reads = fakeService((read) =>
      read.table === 'admin_email_outbox_v'
        ? { data: [outboxViewRow()], count: 31 }
        : { data: [{ id: ids.order, order_number: 'ND-001234' }] },
    )
    const admin = await principal({ role: 'operator' })
    const list = await listOutbox(admin, 'live', outbox({ page: '2' }), NOW)

    expect(list).toEqual({
      ok: true,
      total: 31,
      rows: [
        {
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
        },
      ],
    })
    const [read] = byTable(reads, 'admin_email_outbox_v')
    expect(read?.select).toContain('masked_to')
    expect(read?.select).toContain('last_error_safe')
    expect(read?.select).not.toMatch(NEVER)
    expect(read?.options).toEqual({ count: 'exact' })
    expect(filterOf(read, 'eq', 'test_mode')).toBe(false)
    expect(read?.filters).toContainEqual([
      'order',
      'created_at',
      { ascending: false, nullsFirst: false },
    ])
    expect(read?.filters).toContainEqual(['order', 'id', { ascending: true }])
    expect(read?.filters).toContainEqual(['range', 25, 49])
    // Order numbers come from the orders view, by id, on the same side.
    const [orders] = byTable(reads, 'admin_orders_v')
    expect(orders?.select).toBe('id, order_number')
    expect(filterOf(orders, 'in', 'id')).toEqual([ids.order])
  })

  it('keeps a test admin on the test side, whatever was asked (D15)', async () => {
    const reads = fakeService(() => ({ data: [] }))
    const admin = await principal({ role: 'operator', testOnly: true })
    const list = await listOutbox(admin, 'live', outbox(), NOW)
    expect(list).toEqual({ ok: true, rows: [], total: 0 })
    expect(filterOf(reads[0], 'eq', 'test_mode')).toBe(true)
    // No order lookup for a page with no orders.
    expect(byTable(reads, 'admin_orders_v')).toEqual([])
  })

  it('filters a plain status, a category, a kind and Lagos days', async () => {
    const reads = fakeService(() => ({ data: [] }))
    const admin = await principal()
    await listOutbox(
      admin,
      'test',
      outbox({
        status: 'failed',
        category: 'security',
        kind: 'new_sign_in',
        from: '2026-10-01',
        to: '2026-10-02',
        sort: 'sent',
        dir: 'asc',
      }),
      NOW,
    )
    const [read] = reads
    expect(filterOf(read, 'eq', 'status')).toBe('failed')
    expect(filterOf(read, 'eq', 'category')).toBe('security')
    expect(filterOf(read, 'eq', 'kind')).toBe('new_sign_in')
    expect(filterOf(read, 'gte', 'created_at')).toBe('2026-10-01T00:00:00+01:00')
    expect(filterOf(read, 'lt', 'created_at')).toBe('2026-10-03T00:00:00+01:00')
    expect(read?.filters).toContainEqual([
      'order',
      'sent_at',
      { ascending: true, nullsFirst: false },
    ])
  })

  it('reads bounced, reported and unreported emails as the alerts define them', async () => {
    const reads = fakeService(() => ({ data: [] }))
    const admin = await principal()
    await listOutbox(admin, 'test', outbox({ status: 'bounced' }), NOW)
    await listOutbox(admin, 'test', outbox({ status: 'complained' }), NOW)
    await listOutbox(admin, 'test', outbox({ status: 'unconfirmed' }), NOW)
    const [bounced, complained, unconfirmed] = reads

    expect(filterOf(bounced, 'eq', 'delivery_status')).toBe('bounced')
    expect(filterOf(bounced, 'eq', 'status')).toBeUndefined()
    expect(complained?.filters).toContainEqual(['not', 'complained_at', 'is', null])
    // email_unconfirmed: sent security or compliance email, no final report, over 24 h.
    expect(filterOf(unconfirmed, 'eq', 'status')).toBe('sent')
    expect(filterOf(unconfirmed, 'in', 'category')).toEqual(['compliance', 'security'])
    expect(unconfirmed?.filters).toContainEqual([
      'or',
      'delivery_status.is.null,delivery_status.eq.deferred',
    ])
    expect(filterOf(unconfirmed, 'lt', 'sent_at')).toBe('2026-10-02T12:00:00.000Z')
  })

  it('fails without a row or an address in the log, and keeps rows when order numbers fail', async () => {
    fakeService(() => ({ error: { message: 'permission denied for a•••@x.com', code: '42501' } }))
    const admin = await principal()
    expect(await listOutbox(admin, 'test', outbox(), NOW)).toEqual({ ok: false })
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { code: '42501' },
      'admin emails: outbox could not be read',
    )

    fakeService((read) =>
      read.table === 'admin_email_outbox_v'
        ? { data: [outboxViewRow(), outboxViewRow({ id: null })] }
        : { error: { message: 'timeout' } },
    )
    const list = await listOutbox(admin, 'test', outbox(), NOW)
    expect(list.ok && list.rows.map((row) => [row.id, row.orderNumber])).toEqual([
      [ids.email, null],
    ])
  })

  it('reads an empty error as none, and fills what the view left out', async () => {
    fakeService(() => ({
      data: [
        outboxViewRow({
          last_error_safe: '',
          kind: null,
          category: null,
          status: null,
          attempts: null,
          created_at: null,
          test_mode: null,
          order_id: null,
        }),
      ],
      count: undefined,
    }))
    const admin = await principal()
    const list = await listOutbox(admin, 'test', outbox(), NOW)
    expect(list).toMatchObject({
      ok: true,
      total: 1,
      rows: [
        {
          lastErrorSafe: null,
          kind: '',
          category: '',
          status: '',
          attempts: 0,
          createdAt: '',
          testMode: false,
          orderNumber: null,
        },
      ],
    })
  })
})

describe('listNotices', () => {
  const view = {
    id: ids.notice,
    test_mode: true,
    domain_id: ids.domain,
    user_id: ids.user,
    domain_name: 'expiring.com',
    notice_type: 'errp_post',
    expires_at: '2026-09-30T10:00:00Z',
    channel: 'email',
    masked_recipient: 'a•••@gmail.com',
    template_version: 'expiry_notice@2',
    sent_at: '2026-10-02T08:00:00Z',
    delivery_status: 'bounced',
    checked_at: '2026-10-02T09:00:00Z',
  }

  it('reads the masked notices on the side asked, filtered and sorted from the URL', async () => {
    const reads = fakeService(() => ({ data: [view], count: 1 }))
    const admin = await principal({ testOnly: true })
    const list = await listNotices(
      admin,
      'test',
      notices({
        status: 'bounced',
        type: 'errp_post',
        from: '2026-10-01',
        to: '2026-10-02',
        sort: 'expires',
      }),
    )
    expect(list).toEqual({
      ok: true,
      total: 1,
      rows: [
        {
          id: ids.notice,
          testMode: true,
          domainId: ids.domain,
          userId: ids.user,
          domainName: 'expiring.com',
          noticeType: 'errp_post',
          expiresAt: '2026-09-30T10:00:00Z',
          channel: 'email',
          maskedRecipient: 'a•••@gmail.com',
          templateVersion: 'expiry_notice@2',
          sentAt: '2026-10-02T08:00:00Z',
          deliveryStatus: 'bounced',
          checkedAt: '2026-10-02T09:00:00Z',
        },
      ],
    })
    const [read] = reads
    expect(read?.table).toBe('admin_compliance_notices_v')
    expect(read?.select).toContain('masked_recipient')
    expect(read?.select).not.toMatch(NEVER)
    expect(filterOf(read, 'eq', 'test_mode')).toBe(true)
    expect(filterOf(read, 'eq', 'delivery_status')).toBe('bounced')
    expect(filterOf(read, 'eq', 'notice_type')).toBe('errp_post')
    expect(filterOf(read, 'gte', 'sent_at')).toBe('2026-10-01T00:00:00+01:00')
    expect(filterOf(read, 'lt', 'sent_at')).toBe('2026-10-03T00:00:00+01:00')
    expect(read?.filters).toContainEqual([
      'order',
      'expires_at',
      { ascending: false, nullsFirst: false },
    ])
  })

  it('applies no filter it was not asked for, and fails quietly', async () => {
    const reads = fakeService(() => ({
      data: [{ ...view, domain_name: null, notice_type: null, test_mode: null }, { id: null }],
    }))
    const admin = await principal()
    const list = await listNotices(admin, 'live', notices())
    expect(list).toMatchObject({
      ok: true,
      total: 2,
      rows: [{ domainName: '', noticeType: '', testMode: false }],
    })
    expect(reads[0]?.filters.map(([method, column]) => `${method}:${String(column)}`)).toEqual([
      'eq:test_mode',
      'order:sent_at',
      'order:id',
      'range:0',
    ])

    fakeService(() => ({ error: { message: 'boom', code: 'XX000' } }))
    expect(await listNotices(admin, 'live', notices())).toEqual({ ok: false })
  })
})

describe('getEmailStats', () => {
  function use(answer: { data?: unknown; error?: { message: string; code?: string } }) {
    const session = sessionClient({ rpc: { admin_email_stats: answer } })
    vi.mocked(createClient).mockResolvedValue(session.client as never)
    return session
  }

  it('asks SQL for 30 days of the side, as the admin', async () => {
    const session = use({
      data: {
        byKind: [
          {
            kind: 'order_receipt',
            category: 'transactional',
            status: 'sent',
            deliveryStatus: null,
            count: '2',
          },
        ],
        notices: [{ noticeType: 'errp_pre_7', deliveryStatus: 'delivered', count: 1 }],
      },
    })
    expect(await getEmailStats('test')).toEqual({
      days: 30,
      byKind: [
        {
          kind: 'order_receipt',
          category: 'transactional',
          status: 'sent',
          deliveryStatus: null,
          count: 2,
        },
      ],
      notices: [{ noticeType: 'errp_pre_7', deliveryStatus: 'delivered', count: 1 }],
    })
    expect(session.rpc).toHaveBeenCalledWith('admin_email_stats', {
      p_test_mode: true,
      p_days: 30,
    })
  })

  it('reads a broken list as empty, and a refusal or a bad shape as no figures', async () => {
    use({ data: { byKind: 'nope', notices: [{ noticeType: 'errp_post', count: 'x' }] } })
    expect(await getEmailStats('live')).toEqual({
      days: 30,
      byKind: [],
      notices: [{ noticeType: 'errp_post', deliveryStatus: null, count: 0 }],
    })

    use({ error: { message: 'admin:test_admin', code: 'P0001' } })
    expect(await getEmailStats('live')).toBeNull()

    use({ data: 'not an object' })
    expect(await getEmailStats('live')).toBeNull()
  })
})
